"""Bounded, read-only OOXML slide import. No extraction, Office automation or network IO."""
import base64
import binascii
import copy
import hashlib
import io
import math
import posixpath
import re
import zipfile
import zlib
from xml.etree import ElementTree as ET

MAX_PPTX_BYTES = 100 * 1024 * 1024
MAX_PPTX_BODY = 4 * ((MAX_PPTX_BYTES + 2) // 3) + 4096
MAX_EXPANDED = 240 * 1024 * 1024
MAX_PART = 25 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
EMU = 9525
NS = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
RID = '{' + NS['r'] + '}'


class PptxImportError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def find(el, path):
    return el.find(path, NS) if el is not None else None


def children(el, path):
    return el.findall(path, NS) if el is not None else []


def first(*values):
    return next((v for v in values if v is not None), None)


def num(el, key, default=0):
    try:
        value = float(el.get(key, default)) if el is not None else default
        if not math.isfinite(value) or abs(value) > 1e12:
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise PptxImportError(422, 'The slide contains invalid numeric properties.')


def flag(el, key):
    return el is not None and el.get(key) in ('1', 'true')


def tag(el):
    return el.tag.rsplit('}', 1)[-1]


def multiply(a, b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])


def point(m, x, y):
    return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])


IDENTITY = (1, 0, 0, 1, 0, 0)


class Package:
    def __init__(self, data):
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
        except (zipfile.BadZipFile, OSError):
            raise PptxImportError(422, 'This is not a readable PPTX file. Save it as .pptx in PowerPoint first.')
        infos = self.zip.infolist()
        if len(infos) > 10000 or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise PptxImportError(413, 'The PPTX expands to too much data. Save just the slides you need in a smaller file.')
        self.names = set()
        for info in infos:
            if (info.filename in self.names or info.flag_bits & 1 or info.file_size > MAX_PART
                    or info.filename.startswith('/') or '\\' in info.filename
                    or '..' in info.filename.split('/') or info.compress_type not in (0, 8)):
                raise PptxImportError(422, 'The PPTX contains duplicate, encrypted, oversized or unsupported ZIP entries.')
            self.names.add(info.filename)
        self.xml_cache = {}

    def read(self, path):
        if path not in self.names:
            raise PptxImportError(422, 'The PPTX is missing a referenced part: ' + path[:200])
        try:
            return self.zip.read(path)
        except (zipfile.BadZipFile, RuntimeError, OSError, ValueError, zlib.error):
            raise PptxImportError(422, 'A PPTX part is damaged: ' + path[:200])

    def xml(self, path):
        if path in self.xml_cache:
            return self.xml_cache[path]
        data = self.read(path)
        if len(data) > MAX_XML:
            raise PptxImportError(413, 'A slide XML part is too large.')
        # Also catches UTF-16 declarations before handing data to the XML parser.
        if re.search(br'<!\s*(DOCTYPE|ENTITY)', data.replace(b'\x00', b''), re.I):
            raise PptxImportError(422, 'PPTX XML entity and document type declarations are unsupported.')
        try:
            root = ET.fromstring(data)
        except (ET.ParseError, LookupError):
            raise PptxImportError(422, 'The PPTX contains invalid XML.')
        stack, count = [(root, 0)], 0
        while stack:
            el, depth = stack.pop()
            count += 1
            if count > 100000 or depth > 80:
                raise PptxImportError(413, 'The slide XML is too complex.')
            stack.extend((c, depth + 1) for c in el)
        self.xml_cache[path] = root
        return root

    def relationships(self, path):
        relpath = posixpath.join(posixpath.dirname(path), '_rels', posixpath.basename(path) + '.rels')
        if relpath not in self.names:
            return {}
        result = {}
        for rel in self.xml(relpath):
            if rel.get('TargetMode') == 'External':
                result[rel.get('Id')] = (None, rel.get('Type', ''))
                continue
            target = rel.get('Target', '')
            if '\\' in target or ':' in target or '?' in target or '#' in target:
                raise PptxImportError(422, 'The PPTX contains an unsupported relationship target.')
            resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(path), target))
            if resolved.startswith('../') or resolved in ('.', '..'):
                raise PptxImportError(422, 'A PPTX relationship escapes its package.')
            result[rel.get('Id')] = (resolved, rel.get('Type', ''))
        return result

    def related(self, path, kind):
        return next((p for p, t in self.relationships(path).values() if t.endswith('/' + kind) and p), None)


class Converter:
    def __init__(self, package, presentation, name, source_hash, presentation_path='ppt/presentation.xml'):
        self.pkg, self.presentation, self.name = package, presentation, name
        self.source_hash = source_hash
        self.presentation_path = presentation_path
        self.warnings, self.items, self.media = [], [], {}
        self.colors = {'dk1': '000000', 'lt1': 'FFFFFF', 'dk2': '44546A', 'lt2': 'E7E6E6',
                       'accent1': '4472C4', 'accent2': 'ED7D31', 'accent3': 'A5A5A5',
                       'accent4': 'FFC000', 'accent5': '5B9BD5', 'accent6': '70AD47'}
        self.color_map = {'tx1': 'dk1', 'tx2': 'dk2', 'bg1': 'lt1', 'bg2': 'lt2'}
        self.fonts = {'major': 'Arial', 'minor': 'Arial'}
        self.theme = None

    def warn(self, message, name=''):
        value = (name + ': ' if name else '') + message
        if value not in self.warnings and len(self.warnings) < 150:
            self.warnings.append(value)

    def color(self, parent, default='#000000'):
        if parent is None:
            return default
        node = next((c for c in parent if tag(c) in ('srgbClr', 'schemeClr', 'sysClr', 'prstClr')), None)
        if node is None:
            return default
        kind, value = tag(node), node.get('val', '')
        if kind == 'schemeClr':
            value = self.colors.get(self.color_map.get(value, value), default.lstrip('#')[:6])
        elif kind == 'sysClr':
            value = node.get('lastClr', '000000')
        elif kind == 'prstClr':
            value = {'black': '000000', 'white': 'FFFFFF', 'red': 'FF0000', 'blue': '0000FF', 'green': '008000'}.get(value, '000000')
        if not re.fullmatch('[a-fA-F0-9]{6}', value):
            return default
        rgb, alpha = [int(value[i:i+2], 16) / 255 for i in (0, 2, 4)], 1
        for transform in node:
            v = num(transform, 'val') / 100000
            typ = tag(transform)
            if typ == 'tint': rgb = [c + (1-c)*v for c in rgb]
            elif typ == 'shade': rgb = [c*v for c in rgb]
            elif typ == 'lumMod': rgb = [c*v for c in rgb]
            elif typ == 'lumOff': rgb = [c+v for c in rgb]
            elif typ == 'alpha': alpha = v
        rgb = ''.join(f'{round(max(0, min(1, c))*255):02x}' for c in rgb)
        return '#' + rgb + (f'{round(max(0, min(1, alpha))*255):02x}' if alpha != 1 else '')

    def geometry(self, xfrm, matrix, name):
        off, ext = find(xfrm, 'a:off'), find(xfrm, 'a:ext')
        x, y, w, h = num(off, 'x')/EMU, num(off, 'y')/EMU, num(ext, 'cx')/EMU, num(ext, 'cy')/EMU
        r = math.radians(num(xfrm, 'rot')/60000)
        cs, sn = math.cos(r), math.sin(r)
        rotation = (cs, sn, -sn, cs, x+w/2-cs*w/2+sn*h/2, y+h/2-sn*w/2-cs*h/2)
        m = multiply(matrix, rotation)
        sx, sy = math.hypot(m[0], m[1]), math.hypot(m[2], m[3])
        if sx*sy and abs(m[0]*m[2]+m[1]*m[3])/(sx*sy) > .001:
            self.warn('Skew from a stretched, rotated group is approximated.', name)
        cx, cy = point(m, w/2, h/2)
        mirrored = m[0]*m[3]-m[1]*m[2] < 0
        return {'x': cx-w*sx/2, 'y': cy-h*sy/2, 'width': max(.01, w*sx), 'height': max(.01, h*sy),
                'rotation': math.degrees(math.atan2(m[1], m[0])),
                '_flipX': flag(xfrm, 'flipH'), '_flipY': flag(xfrm, 'flipV') != mirrored,
                '_scaleX': sx, '_scaleY': sy, '_rawWidth': max(0,w*sx), '_rawHeight': max(0,h*sy)}

    def base(self, name, g, kind):
        return {'id': 'ppt-' + str(len(self.items)+1), 'type': kind, 'name': name[:1000],
                **{k: v for k, v in g.items() if not k.startswith('_')},
                'opacity': 1, 'hidden': False, 'locked': False}

    def placeholder(self, shape, parent, by_type=False):
        ph = find(shape, './/p:ph')
        if ph is None or parent is None:
            return None
        candidates = [s for s in children(parent, 'p:cSld/p:spTree/p:sp') if find(s, './/p:ph') is not None]
        if by_type:
            normalized = lambda t: {'ctrTitle':'title','subTitle':'body','obj':'body'}.get(t,t)
            kind = normalized(ph.get('type','obj'))
            return next((s for s in candidates if normalized(find(s,'.//p:ph').get('type','obj')) == kind), None)
        return next((s for s in candidates if find(s, './/p:ph').get('idx', '0') == ph.get('idx', '0')), None)

    def theme_style(self, shape, chain, kind):
        ref = first(*(find(s, 'p:style/a:'+kind+'Ref') for s in [shape,*chain]))
        if ref is None or num(ref,'idx') <= 0:
            return None
        index = int(num(ref,'idx'))
        collection = 'effectStyleLst' if kind == 'effect' else 'lnStyleLst' if kind == 'ln' else 'bgFillStyleLst' if index>=1001 else 'fillStyleLst'
        styles = children(self.theme,'a:themeElements/a:fmtScheme/a:'+collection+'/*')
        index -= 1001 if index>=1001 else 1
        if index < len(styles):
            result = copy.deepcopy(styles[index])
            color = self.color(ref)
            for node in result.iter():
                if tag(node)=='schemeClr' and node.get('val')=='phClr':
                    node.tag='{'+NS['a']+'}srgbClr';node.set('val',color[1:7])
            return result
        if kind == 'effect':
            return None
        # A missing theme still has a usable reference color.
        solid=ET.Element('{'+NS['a']+'}solidFill');ET.SubElement(solid,'{'+NS['a']+'}srgbClr',val=self.color(ref)[1:7])
        if kind=='ln':
            line=ET.Element('{'+NS['a']+'}ln',w='12700');line.append(solid);return line
        return solid

    def shadow_style(self, shape, chain, name, scale=1):
        """Nearest explicit effect list (including an empty list) overrides the theme."""
        containers = [el if el is not None and tag(el) in ('rPr','defRPr','endParaRPr') else first(find(el,'p:spPr'), find(el,'p:grpSpPr')) for el in [shape,*chain]]
        containers.append(self.theme_style(shape,chain,'effect'))
        effects = first(*(first(find(el,'a:effectLst'),find(el,'a:effectDag')) for el in containers))
        if effects is None:
            return None
        node = find(effects,'a:outerShdw')
        if any(tag(child) != 'outerShdw' for child in effects):
            self.warn('Effects other than outer shadow are not retained.',name)
        if node is None:
            return None
        color = self.color(node)
        alpha = int(color[7:9],16)/255 if len(color)==9 else 1
        # Keep exact DrawingML alpha, rather than its 8-bit display-color approximation.
        color_node = next(iter(node),None)
        if color_node is not None and find(color_node,'a:alpha') is not None:
            alpha = max(0,min(1,num(find(color_node,'a:alpha'),'val')/100000))
        sx,sy = num(node,'sx',100000)/1000,num(node,'sy',100000)/1000
        blur,distance = num(node,'blurRad')/12700*scale,num(node,'dist')/12700*scale
        if sx != sy or num(node,'kx') or num(node,'ky'):
            self.warn('Nonuniform or skewed shadow transform is approximated.',name)
        if not (0 <= sx <= 200 and 0 <= blur <= 100 and 0 <= distance <= 200):
            self.warn('Shadow size, blur or distance exceeds editable limits and is clamped.',name)
        return {'enabled':True,'color':color[:7],'transparency':(1-alpha)*100,
                'size':max(0,min(200,sx)),'blur':max(0,min(100,blur)),
                'distance':max(0,min(200,distance)),'angle':num(node,'dir')/60000%360,
                'alignment':node.get('algn','b'),'rotateWithShape':node.get('rotWithShape','1') not in ('0','false')}

    def line_style(self, shape, chain):
        # A local line often sets only width; paint still comes from layout/theme.
        candidates = [find(shape,'p:spPr/a:ln'), *(find(el,'p:spPr/a:ln') for el in chain), self.theme_style(shape,chain,'ln')]
        result = None
        paints = {'noFill','solidFill','gradFill','pattFill','blipFill'}
        for source in reversed(candidates):
            if source is None:
                continue
            if result is None:
                result = ET.Element('{'+NS['a']+'}ln')
            result.attrib.update(source.attrib)
            for child in source:
                for old in list(result):
                    if tag(old) == tag(child) or tag(old) in paints and tag(child) in paints:
                        result.remove(old)
                result.append(copy.deepcopy(child))
        return result

    def stroke_gradient(self, node, geometry, name):
        if node is None:
            return None
        try:
            return self.fill_gradient(node,geometry,name,border=True)
        except ValueError:
            self.warn('Unsupported border gradient stops; the first color is used.', name)
            return None

    def fill_gradient_stop(self, node):
        # Keep the final PowerPoint brightness transform editable. Earlier color
        # transforms are still resolved by color(), and alpha stays in the color.
        source = copy.deepcopy(node)
        color = next((child for child in source if tag(child) in ('srgbClr','schemeClr','sysClr','prstClr')),None)
        brightness = 0
        if color is not None:
            transforms = [child for child in color if tag(child) != 'alpha']
            if transforms and tag(transforms[-1]) == 'lumMod':
                modulation = num(transforms[-1],'val')
                if 0 <= modulation <= 100000:
                    brightness = modulation / 1000 - 100
                    color.remove(transforms[-1])
            elif len(transforms) >= 2 and [tag(child) for child in transforms[-2:]] == ['lumMod','lumOff']:
                modulation, offset = (num(child,'val') for child in transforms[-2:])
                if 0 <= offset <= 100000 and abs(modulation + offset - 100000) < .001:
                    brightness = offset / 1000
                    for child in transforms[-2:]:
                        color.remove(child)
        return {'offset':max(0,min(1,num(node,'pos')/100000)),'color':self.color(source),
                **({'brightness':brightness} if brightness else {})}

    def fill_gradient(self, node, geometry, name, border=False):
        stops = [self.fill_gradient_stop(stop) for stop in sorted(children(node,'a:gsLst/a:gs'),key=lambda stop:num(stop,'pos'))]
        if not 2 <= len(stops) <= 16:
            raise ValueError('Unsupported gradient stops')
        linear, path = find(node,'a:lin'), find(node,'a:path')
        angle = num(linear,'ang')/60000
        if geometry['_flipX']:angle=180-angle
        if geometry['_flipY']:angle=-angle
        result = {'angle':angle%360,'stops':stops}
        if node.get('rotWithShape') in ('0','false'):
            result['rotateWithShape'] = False
        if path is not None and path.get('path') == 'circle':
            rect = find(path,'a:fillToRect')
            if rect is None:
                center_x = center_y = .5
            else:
                left, top, right, bottom = (num(rect,key)/100000 for key in ('l','t','r','b'))
                center_x, center_y = (left+1-right)/2, (top+1-bottom)/2
                if abs(left+right-1) > .00001 or abs(top+bottom-1) > .00001:
                    self.warn('Radial gradient focus rectangle is approximated by its center.',name)
                if not (0 <= center_x <= 1 and 0 <= center_y <= 1):
                    self.warn('Out-of-bounds radial gradient center is clamped.',name)
                center_x, center_y = max(0,min(1,center_x)), max(0,min(1,center_y))
            if geometry['_flipX']:center_x=1-center_x
            if geometry['_flipY']:center_y=1-center_y
            result.update(type='radial',center={'x':center_x,'y':center_y})
        elif linear is None:
            self.warn('Nonlinear '+('border ' if border else '')+'gradient is approximated as a linear gradient.',name)
        elif linear.get('scaled') in ('0','false'):
            self.warn('Unscaled '+('border' if border else 'fill')+' gradient direction is approximated.',name)
        return result

    def run_style(self, nodes, scale):
        props = {}
        fill, font = None, None
        for node in nodes:
            if node is not None:
                props.update(node.attrib)
                fill = first(find(node, 'a:solidFill'), fill)
                font = first(find(node, 'a:latin'), find(node, 'a:ea'), font)
        family = font.get('typeface', 'Arial') if font is not None else self.fonts['minor']
        if family.startswith('+mj'): family = self.fonts['major']
        elif family.startswith('+mn'): family = self.fonts['minor']
        size = num(ET.Element('r', props), 'sz', 1800)/100*96/72*scale
        baseline = num(ET.Element('r', props), 'baseline') / 100000
        if baseline:
            size *= .65
        shadow = self.shadow_style(nodes[-1],list(reversed(nodes[:-1])),'Text',scale) if nodes else None
        return {**({'shadow':shadow} if shadow else {}), 'fontFamily': family[:200] or 'Arial', 'fontSize': max(1, min(2000, size)),
                'fontWeight': 700 if props.get('b') in ('1', 'true') else 400,
                'fontStyle': 'italic' if props.get('i') in ('1', 'true') else 'normal',
                'color': self.color(fill), 'baseline': baseline,
                'spacing': num(ET.Element('r', props), 'spc')/100*96/72*scale}

    def text(self, shape, chain, g, name):
        tx = find(shape, 'p:txBody')
        if tx is None:
            return
        body = {}
        for ancestor in reversed(chain):
            b = find(ancestor, 'p:txBody/a:bodyPr')
            if b is not None: body.update(b.attrib)
        b = find(tx, 'a:bodyPr')
        if b is not None: body.update(b.attrib)
        if body.get('vert', 'horz') != 'horz':
            self.warn('Vertical text is imported horizontally.', name)
        if g['_flipX'] or g['_flipY']:
            self.warn('Mirrored text is imported without reflection.', name)
        placeholders = [find(s,'.//p:ph') for s in [shape,*chain]]
        role = next((ph.get('type') for ph in placeholders if ph is not None and ph.get('type')), 'body' if any(ph is not None for ph in placeholders) else 'other')
        style_type = 'titleStyle' if role in ('title', 'ctrTitle') else 'bodyStyle' if role in ('body', 'obj', 'subTitle') else 'otherStyle'
        font_ref=first(*(find(s,'p:style/a:fontRef') for s in [shape,*chain]))
        font_default=ET.Element('{'+NS['a']+'}defRPr')
        if font_ref is not None:
            ET.SubElement(font_default,'{'+NS['a']+'}latin',typeface=self.fonts['major' if font_ref.get('idx')=='major' else 'minor'])
            solid=ET.SubElement(font_default,'{'+NS['a']+'}solidFill')
            ET.SubElement(solid,'{'+NS['a']+'}srgbClr',val=self.color(font_ref)[1:7])
        paragraphs = []
        if any(tag(node) in ('oMath','oMathPara') for node in tx.iter()):
            self.warn('Office equations are not retained; use an image to preserve them.',name)
        total_text = sum(len(t.text or '') for t in children(tx,'.//a:t'))
        if total_text > 100000 or len(children(tx,'a:p')) > 2000:
            raise PptxImportError(413,'A text box is too large to import (100,000 characters or 2,000 paragraphs).')
        font_scale = num(find(b, 'a:normAutofit'), 'fontScale', 100000)/100000
        for p in children(tx, 'a:p'):
            pp = find(p, 'a:pPr')
            level = max(0, min(8, int(num(pp, 'lvl')))) + 1
            defaults = [find(self.presentation, f'p:defaultTextStyle/a:lvl{level}pPr'),
                        find(self.master, f'p:txStyles/p:{style_type}/a:lvl{level}pPr')]
            for ancestor in reversed(chain):
                defaults.extend([find(ancestor, f'p:txBody/a:lstStyle/a:lvl{level}pPr'), find(ancestor, 'p:txBody/a:p/a:pPr')])
            defaults.extend([find(tx, f'a:lstStyle/a:lvl{level}pPr'), pp])
            attributes = {}
            for node in defaults:
                if node is not None: attributes.update(node.attrib)
            runs = []
            for run in p:
                if tag(run) not in ('r', 'fld', 'br'):
                    continue
                value = '\n' if tag(run) == 'br' else ''.join(t.text or '' for t in children(run, 'a:t'))
                style = self.run_style([font_default] + [find(n, 'a:defRPr') for n in defaults] + [find(run, 'a:rPr')], g['_scaleY']*font_scale)
                if style['spacing']:
                    self.warn('Character spacing is approximated.', name)
                if any(find(run, path) is not None for path in ('a:rPr/a:hlinkClick', 'a:rPr/a:highlight')) or (find(run, 'a:rPr') is not None and find(run, 'a:rPr').get('u', 'none') != 'none'):
                    self.warn('Links, highlighting and underlining are not retained.', name)
                runs.append({'text': value, **style})
            if not runs:
                runs = [{'text': '', **self.run_style([font_default] + [find(n, 'a:defRPr') for n in defaults] + [find(p, 'a:endParaRPr')], g['_scaleY']*font_scale)}]
            bullet = None
            for n in defaults:
                if find(n, 'a:buNone') is not None: bullet = None
                if find(n, 'a:buChar') is not None: bullet = find(n, 'a:buChar').get('char', '•')
                if find(n, 'a:buAutoNum') is not None:
                    bullet = str(len(paragraphs)+1)+'.'
                    self.warn('Numbered bullets are imported as editable text.', name)
            if bullet: runs[0]['text'] = bullet + ' ' + runs[0]['text']
            spacing = {}
            for key in ('lnSpc', 'spcBef', 'spcAft'):
                node = first(*(find(n, 'a:'+key) for n in reversed(defaults)))
                if node is not None and len(node):
                    spacing[key] = {'kind': tag(node[0]), 'value': num(node[0], 'val')}
            paragraphs.append({'runs': runs, 'align': {'ctr': 'center', 'r': 'right'}.get(attributes.get('algn'), 'left'),
                               'marginLeft': float(attributes.get('marL', 0))/EMU*g['_scaleX'],
                               'marginRight': float(attributes.get('marR', 0))/EMU*g['_scaleX'],
                               'indent': float(attributes.get('indent', 0))/EMU*g['_scaleX'], 'spacing': spacing})
        if not any(r['text'] for p in paragraphs for r in p['runs']):
            return
        item = self.base(name, g, 'textBlock')
        item.update(paragraphs=paragraphs, insets={key: float(body.get(attr, default))/EMU*g[scale]
                    for key, attr, default, scale in [('left','lIns',91440,'_scaleX'),('right','rIns',91440,'_scaleX'),('top','tIns',45720,'_scaleY'),('bottom','bIns',45720,'_scaleY')]},
                    anchor=body.get('anchor', 't'), wrap=body.get('wrap', 'square') != 'none', scaleY=g['_scaleY'])
        self.items.append(item)

    def add_media(self, path, raw=None, mime=None):
        if path in self.media:
            return self.media[path]['id']
        raw = self.pkg.read(path) if raw is None else raw
        mime = mime or {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'}.get(posixpath.splitext(path)[1].lower())
        if not mime:
            return None
        mid = 'media-' + str(len(self.media)+1)
        self.media[path] = {'id': mid, 'name': posixpath.basename(path), 'mime': mime,
                            'dataUrl': f'data:{mime};base64,' + base64.b64encode(raw).decode(),
                            'relativePath': self.name + '/' + path, 'fingerprint': hashlib.sha256(raw).hexdigest()}
        return mid

    def shape(self, shape, path, matrix, inherited=True):
        typ = tag(shape)
        if typ not in ('sp', 'pic', 'cxnSp', 'graphicFrame', 'grpSp', 'AlternateContent'):
            return
        if typ == 'AlternateContent':
            branch = find(shape, '{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback')
            if branch is None:
                self.warn('An alternate Office drawing without a fallback was omitted.')
            else:
                for child in branch: self.shape(child, path, matrix, inherited)
            return
        nv = find(shape, './/p:cNvPr')
        name = nv.get('name', 'Object') if nv is not None else 'Object'
        if flag(nv, 'hidden'):
            return
        if typ == 'grpSp':
            xf = find(shape, 'p:grpSpPr/a:xfrm')
            if xf is None:
                self.warn('Group without coordinates was omitted.', name)
                return
            off, ext, co, ce = [find(xf, 'a:'+t) for t in ('off','ext','chOff','chExt')]
            ew, eh, cw, ch = [num(el, key) for el, key in ((ext,'cx'),(ext,'cy'),(ce,'cx'),(ce,'cy'))]
            if min(ew, eh, cw, ch) <= 0:
                self.warn('Group with empty bounds was omitted.', name)
                return
            x, y, w, h = num(off,'x')/EMU, num(off,'y')/EMU, ew/EMU, eh/EMU
            sx, sy = ew/cw, eh/ch
            mapping = (sx,0,0,sy,x-num(co,'x')/EMU*sx,y-num(co,'y')/EMU*sy)
            r = math.radians(num(xf,'rot')/60000); c, s = math.cos(r), math.sin(r)
            fx, fy = -1 if flag(xf,'flipH') else 1, -1 if flag(xf,'flipV') else 1
            rot = (c*fx,s*fx,-s*fy,c*fy,0,0)
            cx, cy = x+w/2,y+h/2
            rot = (*rot[:4],cx-rot[0]*cx-rot[2]*cy,cy-rot[1]*cx-rot[3]*cy)
            group_geometry = self.geometry(xf,matrix,name)
            group_shadow = self.shadow_style(shape,[],name,group_geometry['_scaleY'])
            if group_shadow and group_shadow['transparency'] < 100:
                # Keep the composited group alpha, including each child's own effects.
                # The browser stores this bounded group as an editable SVG asset.
                start = len(self.items)
                gx,gy=group_geometry['_scaleX']*sx,group_geometry['_scaleY']*sy
                local=(gx,0,0,gy,-num(co,'x')/EMU*gx,-num(co,'y')/EMU*gy)
                for child in shape:self.shape(child,path,local,inherited)
                group_items=self.items[start:];del self.items[start:]
                for child in group_items:
                    if child.get('shadow',{}).get('rotateWithShape') is False:
                        angle=child['shadow']['angle']-group_geometry['rotation']
                        if group_geometry['_flipX']:angle=180-angle
                        if group_geometry['_flipY']:angle=-angle
                        child['shadow']['angle']=angle%360
                if group_items:
                    item=self.base(name,group_geometry,'shadowGroup')
                    item.update(items=group_items,shadow=group_shadow,_flipX=group_geometry['_flipX'],_flipY=group_geometry['_flipY'])
                    self.items.append(item)
                return
            for child in shape: self.shape(child,path,multiply(matrix,multiply(rot,mapping)),inherited)
            return
        chain = []
        if inherited:
            lp = self.placeholder(shape, self.layout)
            mp = self.placeholder(lp if lp is not None else shape, self.master, by_type=True)
            chain = [el for el in (lp,mp) if el is not None]
        xf = first(find(shape,'p:spPr/a:xfrm'),find(shape,'p:xfrm'),*(find(el,'p:spPr/a:xfrm') for el in chain))
        if xf is None:
            self.warn('Object without usable coordinates was omitted.', name)
            return
        g = self.geometry(xf,matrix,name)
        native_shadow = self.shadow_style(shape,chain,name,g['_scaleY'])
        if typ == 'graphicFrame':
            self.warn('Chart, table, SmartArt or embedded object was omitted. Export it as an image in PowerPoint to include it.', name)
            return
        if typ == 'pic':
            if find(shape,'.//a:videoFile') is not None or find(shape,'.//a:audioFile') is not None:
                self.warn('Embedded media is imported as its static preview image.',name)
            blip = find(shape, 'p:blipFill/a:blip')
            svg_blip = find(blip, './/{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip')
            fallback_ref = blip.get(RID+'embed') if blip is not None else None
            fallback_target = self.pkg.relationships(path).get(fallback_ref, (None,''))[0]
            svg_target = self.pkg.relationships(path).get(svg_blip.get(RID+'embed'), (None,''))[0] if svg_blip is not None else None
            target = svg_target or fallback_target
            if svg_blip is not None and not svg_target:
                self.warn('SVG source is missing; its preview image is used.', name)
            if not target or target not in self.pkg.names:
                self.warn('Linked or missing image was omitted; embed it in PowerPoint first.', name)
                return
            mid = self.add_media(target)
            if mid is None:
                self.warn('Unsupported image format (' + posixpath.splitext(target)[1] + ') was omitted. Use PNG, JPEG, WebP or SVG.',name)
                return
            if svg_target and fallback_target and fallback_target != svg_target:
                fallback_mid = self.add_media(fallback_target)
                if fallback_mid:
                    self.media[target]['fallbackId'] = fallback_mid
            item = self.base(name,g,'image'); item['assetId'] = mid
            if native_shadow:item['shadow']=native_shadow
            border=self.line_style(shape,chain)
            if border is not None and find(border,'a:noFill') is None:
                gradient=self.stroke_gradient(find(border,'a:gradFill'),g,name)
                stroke=self.color(find(border,'a:solidFill'),'none')
                if gradient:stroke=gradient['stops'][0]['color']
                if stroke!='none' or gradient:
                    dash=find(border,'a:prstDash')
                    item.update(stroke=stroke,strokeWidth=num(border,'w',12700)/EMU*g['_scaleY'],
                                strokeDash={'dash':'dash','sysDash':'dash','lgDash':'dash','dot':'dot','sysDot':'dot'}.get(dash.get('val') if dash is not None else '', 'solid'))
                    if gradient:item['strokeGradient']=gradient
            crop = find(shape,'p:blipFill/a:srcRect')
            l,t,r,b = [num(crop,k)/100000 for k in ('l','t','r','b')]
            if min(l,t,r,b) < 0 or l+r >= 1 or t+b >= 1:
                self.warn('Out-of-bounds image crop was not retained.',name)
            elif any((l,t,r,b)):
                item['crop'] = {'x':l,'y':t,'width':1-l-r,'height':1-t-b}
            item['_flipX'], item['_flipY'] = g['_flipX'], g['_flipY']
            alpha = find(blip, 'a:alphaModFix')
            if alpha is not None: item['opacity'] = max(0,min(1,num(alpha,'amt',100000)/100000))
            if find(shape, 'p:spPr/a:prstGeom') is not None and find(shape,'p:spPr/a:prstGeom').get('prst') != 'rect':
                self.warn('Image shape mask is approximated by a rectangular crop.',name)
            self.items.append(item)
        else:
            sp = find(shape,'p:spPr')
            fill_node=first(*(next((c for c in s if tag(c) in ('solidFill','noFill','gradFill','blipFill','pattFill')),None) if s is not None else None for s in [sp,*(find(el,'p:spPr') for el in chain)]),self.theme_style(shape,chain,'fill'))
            solid=fill_node if fill_node is not None and tag(fill_node)=='solidFill' else None
            fill=self.color(solid,'none')
            line = self.line_style(shape,chain)
            stroke = 'none' if line is None or find(line,'a:noFill') is not None else self.color(find(line,'a:solidFill'))
            stroke_gradient_node = find(line,'a:gradFill')
            stroke_gradient = self.stroke_gradient(stroke_gradient_node,g,name)
            if stroke_gradient_node is not None:
                stroke = self.color(find(stroke_gradient_node,'a:gsLst/a:gs'))
            width = num(line,'w',12700)/EMU*g['_scaleY'] if line is not None else 0
            dash_node = find(line,'a:prstDash')
            dash_value = dash_node.get('val','solid') if dash_node is not None else 'solid'
            stroke_dash = {'dash':'dash','sysDash':'dash','lgDash':'dash','dot':'dot','sysDot':'dot'}.get(dash_value,'solid')
            prst = find(sp,'a:prstGeom'); preset = prst.get('prst','rect') if prst is not None else 'rect'
            gradient = fill_node if fill_node is not None and tag(fill_node)=='gradFill' else None
            if fill_node is not None and tag(fill_node) in ('blipFill','pattFill'):
                self.warn('Picture or pattern shape fill is not retained.',name)
            first_shape_index = len(self.items)
            if preset in ('line', 'bentConnector3', 'curvedConnector3') or (typ == 'cxnSp' and preset in ('rect', 'straightConnector1')):
                item = self.base(name,g,'line')
                item.update(fill='none',stroke=stroke,strokeWidth=width,strokeDash=stroke_dash)
                # Convert flipped endpoints to a positive-length rotated line.
                w,h=g['_rawWidth'],g['_rawHeight']; dx=(-w if g['_flipX'] else w); dy=(-h if g['_flipY'] else h)
                if preset in ('bentConnector3', 'curvedConnector3'):
                    item.update(width=w,height=h,connector='elbow' if preset == 'bentConnector3' else 'curved',
                                connectorFlipX=g['_flipX'], connectorFlipY=g['_flipY'])
                    if children(prst, 'a:avLst/a:gd'):
                        self.warn('Connector bend adjustments use the default midpoint.', name)
                else:
                    item.update(width=math.hypot(dx,dy),height=0,rotation=g['rotation']+math.degrees(math.atan2(dy,dx)),x=g['x']+w/2-math.hypot(dx,dy)/2,y=g['y']+h/2)
                head,tail=find(line,'a:headEnd'),find(line,'a:tailEnd')
                start=head.get('type','none') if head is not None else 'none'
                end=tail.get('type','none') if tail is not None else 'none'
                if start == 'arrow' or end == 'arrow':
                    item['type']='doubleArrow' if start == end == 'arrow' else 'arrow'
                    if start == 'arrow' and end != 'arrow': item['rotation'] += 180
                if any(value not in ('none','arrow') for value in (start,end)):
                    self.warn('Unsupported line arrowhead style is not retained.',name)
                self.items.append(item)
            elif fill != 'none' or stroke != 'none' or gradient is not None or stroke_gradient is not None:
                if preset in ('rect','ellipse','roundRect') and gradient is None and find(sp,'a:custGeom') is None:
                    item=self.base(name,g,preset); item.update(fill=fill,stroke=stroke,strokeWidth=width,strokeDash=stroke_dash)
                    if preset == 'roundRect':
                        adjustment=next((node.get('fmla','') for node in children(prst,'a:avLst/a:gd') if node.get('name') == 'adj'),'val 16667')
                        match=re.fullmatch(r'val\s+(-?\d+)',adjustment)
                        item['cornerRadius']=max(0,min(.5,int(match.group(1))/100000)) if match else 1/6
                    self.items.append(item)
                else:
                    from pptx_geometry import geometry_paths
                    geom=first(find(sp,'a:custGeom'),prst)
                    try:
                        paths=geometry_paths(geom,g['width']/g['_scaleX'],g['height']/g['_scaleY'])
                        for layer in paths:
                            for command in layer['commands']:
                                for j in range(1,len(command),2):
                                    if g['_flipX']:command[j]=1-command[j]
                                    if g['_flipY']:command[j+1]=1-command[j+1]
                        item=self.base(name,g,'shape')
                        item.update(paths=paths,fill=fill,stroke=stroke,strokeWidth=width,strokeDash=stroke_dash)
                        if gradient is not None:
                            item['fillGradient']=self.fill_gradient(gradient,g,name)
                        self.items.append(item)
                    except (ValueError,ZeroDivisionError):
                        self.warn('Unsupported shape geometry or gradient was omitted; its text is retained.',name)
            if stroke_gradient is not None:
                for imported in self.items[first_shape_index:]:
                    paint = copy.deepcopy(stroke_gradient)
                    if imported['type'] in ('line','arrow','doubleArrow') and 'connector' not in imported:
                        # Geometry normalization/arrow direction already rotates this line.
                        delta = imported['rotation'] - g['rotation']
                        if paint.get('rotateWithShape') is False:
                            if abs(delta % 360) > .00001:
                                self.warn('Fixed-orientation border gradient coordinates on a normalized line are approximated.',name)
                        else:
                            paint['angle'] = (paint['angle'] - delta) % 360
                            if paint.get('type') == 'radial':
                                # Express the original focus in the new line coordinate
                                # frame, including its stroke-sized zero-area dimension.
                                cx,cy = paint['center']['x']-.5, paint['center']['y']-.5
                                x,y = cx*max(g['_rawWidth'],width,.01), cy*max(g['_rawHeight'],width,.01)
                                cs,sn = math.cos(math.radians(delta)), math.sin(math.radians(delta))
                                paint['center'] = {'x':max(0,min(1,.5+(x*cs+y*sn)/max(imported['width'],width,.01))),
                                                   'y':max(0,min(1,.5+(-x*sn+y*cs)/max(imported['height'],width,.01)))}
                        if g['_rawWidth'] and g['_rawHeight']:
                            self.warn('Diagonal line border gradient projection is approximated.',name)
                    imported['strokeGradient'] = paint
            text_start=len(self.items)
            self.text(shape,chain,g,name)
            if native_shadow:
                # Filled geometry already casts the shape shadow; an unfilled text box
                # instead casts its visible glyphs. Run-level shadows remain independent.
                targets=self.items[first_shape_index:text_start] or self.items[text_start:]
                for imported in targets:
                    imported['shadow']=copy.deepcopy(native_shadow)
                    if native_shadow['rotateWithShape']:
                        imported['shadow']['angle']=(native_shadow['angle']+g['rotation']-imported['rotation'])%360
        if len(self.items)>2000:
            raise PptxImportError(413,'This slide contains too many objects to import.')

    def convert(self, path, number):
        slide=self.pkg.xml(path)
        lp=self.pkg.related(path,'slideLayout');mp=self.pkg.related(lp,'slideMaster') if lp else None
        self.layout=self.pkg.xml(lp) if lp else None;self.master=self.pkg.xml(mp) if mp else None
        tp=self.pkg.related(mp,'theme') if mp else self.pkg.related(self.presentation_path,'theme')
        if tp:
            self.theme=self.pkg.xml(tp)
            for c in children(self.theme,'a:themeElements/a:clrScheme/*'):
                self.colors[tag(c)]=self.color(c).lstrip('#')[:6]
            for key in self.fonts:
                f=find(self.theme,f'a:themeElements/a:fontScheme/a:{key}Font/a:latin')
                if f is not None and f.get('typeface'):self.fonts[key]=f.get('typeface')
        for owner in (self.master,self.layout,slide):
            cm=first(find(owner,'p:clrMap'),find(owner,'p:clrMapOvr/a:overrideClrMapping'))
            if cm is not None:self.color_map.update(cm.attrib)
        background='#ffffff'
        for owner in (self.master,self.layout,slide):
            bg=find(owner,'p:cSld/p:bg/p:bgPr')
            ref=find(owner,'p:cSld/p:bg/p:bgRef')
            if ref is not None:
                background=self.color(ref,background)
                self.warn('Theme background is approximated by its reference color.')
            if bg is not None:
                background=self.color(find(bg,'a:solidFill'),background)
                if find(bg,'a:gradFill') is not None or find(bg,'a:blipFill') is not None:self.warn('Gradient or picture background was not retained.')
        # Static master/layout decoration is behind slide content; placeholder text belongs to the slide.
        if slide.get('showMasterSp','1') not in ('0','false'):
            decorations = [(self.layout,lp)] if self.layout is not None and self.layout.get('showMasterSp','1') in ('0','false') else [(self.master,mp),(self.layout,lp)]
            for owner, owner_path in decorations:
                for shape in children(owner,'p:cSld/p:spTree/*'):
                    if find(shape,'.//p:ph') is None:self.shape(shape,owner_path,IDENTITY,False)
        for shape in children(slide,'p:cSld/p:spTree/*'):self.shape(shape,path,IDENTITY)
        size=find(self.presentation,'p:sldSz');w,h=num(size,'cx')/EMU,num(size,'cy')/EMU
        if not 1<=w<=16000 or not 1<=h<=16000:raise PptxImportError(422,'The slide size is outside the editor range (1–16,000 px).')
        self.warn('Fonts must be installed on this computer; PowerPoint and browser text metrics may differ.')
        return {'name':f'{self.name.rsplit(".",1)[0]} · Slide {number}'[:300], 'canvas':{'width':w,'height':h,'background':background},
                'items':self.items,'media':list(self.media.values()),'warnings':self.warnings,
                'source':{'name':self.name,'sha256':self.source_hash,'slide':number}}


def import_pptx(payload, *, single_slide=False):
    if not isinstance(payload,dict) or set(payload)-{'name','data','slide'} or not isinstance(payload.get('data'),str):
        raise PptxImportError(400,'Send a PPTX filename, base64 data, and optional slide number.')
    name=payload.get('name','presentation.pptx')
    if not isinstance(name,str) or len(name)>250 or not name.lower().endswith('.pptx') or '/' in name or '\\' in name:
        raise PptxImportError(400,'Choose a .pptx file. Legacy .ppt files must first be saved as .pptx.')
    if len(payload['data'])>4*((MAX_PPTX_BYTES+2)//3):raise PptxImportError(413,'PPTX files must be 100 MB or smaller.')
    try:raw=base64.b64decode(payload['data'],validate=True)
    except (ValueError,binascii.Error):raise PptxImportError(400,'The PPTX data is not valid base64.')
    if not raw or len(raw)>MAX_PPTX_BYTES:raise PptxImportError(413,'Choose a nonempty PPTX file of 100 MB or less.')
    pkg=Package(raw)
    try:
        presentation_path=pkg.related('','officeDocument') or 'ppt/presentation.xml'
        presentation=pkg.xml(presentation_path);rels=pkg.relationships(presentation_path)
        ids=children(presentation,'p:sldIdLst/p:sldId')
        if not ids or len(ids)>500:raise PptxImportError(413,'Choose a presentation with 1–500 slides.')
        if single_slide and len(ids)!=1:raise PptxImportError(422,'Copy exactly one slide in PowerPoint, or use Import PPTX to choose a page.')
        paths=[rels.get(el.get(RID+'id'),(None,''))[0] for el in ids]
        if any(not p for p in paths):raise PptxImportError(422,'A slide relationship is missing.')
        source_hash=hashlib.sha256(raw).hexdigest()
        if 'slide' not in payload and not single_slide:
            slides=[]
            for n,path in enumerate(paths,1):
                root=pkg.xml(path)
                texts=[t.text or '' for t in children(root,'.//a:t')]
                slides.append({'number':n,'title':' '.join(texts)[:100] or f'Slide {n}'})
            return {'slides':slides,'source':{'name':name,'sha256':source_hash}}
        number=1 if single_slide else payload['slide']
        if type(number) is not int or not 1<=number<=len(paths):raise PptxImportError(400,'Select a slide number from this presentation.')
        return Converter(pkg,presentation,name,source_hash,presentation_path).convert(paths[number-1],number)
    except (ValueError,OverflowError,KeyError,RecursionError) as error:
        raise PptxImportError(422,'The PPTX contains unsupported or malformed slide properties.') from error
    finally:
        pkg.zip.close()
