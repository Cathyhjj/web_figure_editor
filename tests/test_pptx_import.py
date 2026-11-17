"""Synthetic OOXML tests: no Office installation or private presentation required."""
import base64
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pptx_import import import_pptx, PptxImportError, Package, NS, EMU

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC')
HEADER = f'xmlns:p="{NS["p"]}" xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}"'


def xfrm(x=40, y=50, w=100, h=80, attrs=''):
    return f'<a:xfrm {attrs}><a:off x="{x*EMU}" y="{y*EMU}"/><a:ext cx="{w*EMU}" cy="{h*EMU}"/></a:xfrm>'


def text_shape(name='Label', text='Editable label', geometry=None, ph='', style='', extra=''):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="{name}"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr>{xfrm() if geometry is None else geometry}</p:spPr>{style}<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>{extra}<a:p><a:r><a:rPr sz="1800" b="1"><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'


def picture(crop='', geometry=None):
    return f'<p:pic><p:nvPicPr><p:cNvPr id="3" name="Panel"/></p:nvPicPr><p:blipFill><a:blip r:embed="img"/>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm(200,100,240,180) if geometry is None else geometry}<a:prstGeom prst="rect"/></p:spPr></p:pic>'


def slide(content, attrs=''):
    return f'<p:sld {HEADER} {attrs}><p:cSld><p:spTree>{content}</p:spTree></p:cSld></p:sld>'


def relations(entries):
    return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="{id}" Type="{NS["r"]}/{kind}" Target="{target}" {extra}/>' for id,kind,target,extra in entries)+'</Relationships>'


def fixture(slides=None, extra=None):
    slides=slides or [slide(text_shape()+picture()),slide(text_shape(text='Second slide'))]
    parts={'ppt/presentation.xml':f'<p:presentation {HEADER}><p:sldIdLst>'+''.join(f'<p:sldId id="{n+256}" r:id="s{n}"/>' for n in range(len(slides)))+f'</p:sldIdLst><p:sldSz cx="{960*EMU}" cy="{640*EMU}"/></p:presentation>',
           'ppt/_rels/presentation.xml.rels':relations([(f's{n}','slide',f'slides/slide{n+1}.xml','') for n in range(len(slides))]),'ppt/media/panel.png':PNG}
    for n,xml in enumerate(slides,1):
        parts[f'ppt/slides/slide{n}.xml']=xml
        parts[f'ppt/slides/_rels/slide{n}.xml.rels']=relations([('img','image','../media/panel.png','')])
    parts.update(extra or {})
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
        for path,data in parts.items():archive.writestr(path,data)
    return {'name':'synthetic.pptx','data':base64.b64encode(stream.getvalue()).decode()}


class PptxImportTests(unittest.TestCase):
    def test_blank_template_inherits_text_fields_and_keeps_picture_frames_separate(self):
        def field(name, ph, geometry='', text_body=''):
            return (f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="{name}"/><p:cNvSpPr/>'
                    f'<p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr><p:spPr>{geometry}</p:spPr>{text_body}</p:sp>')

        blue = '<a:solidFill><a:srgbClr val="003399"/></a:solidFill>'
        body = ('<p:txBody><a:bodyPr lIns="95250" anchor="ctr"/>'
                '<a:lstStyle><a:lvl1pPr algn="ctr"><a:buChar char="§"/><a:defRPr sz="3150" b="1">'
                '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/>'
                '</a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:t>Click to add text</a:t></a:r></a:p></p:txBody>')
        layout_shapes = (field('Heading layout', 'type="body" idx="3"', xfrm(11,22,200,50) + blue, body)
                         + field('Photo layout', 'type="pic" idx="4"', xfrm(20,90,80,80) + blue, body))
        extra = {
            'ppt/slides/_rels/slide1.xml.rels': relations([('layout', 'slideLayout', '../slideLayouts/layout.xml', '')]),
            'ppt/slideLayouts/layout.xml': f'<p:sldLayout {HEADER}><p:cSld><p:spTree>{layout_shapes}</p:spTree></p:cSld></p:sldLayout>',
        }
        empty = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr i="1"/></a:p></p:txBody>'
        for text_body in (empty, ''):
            with self.subTest(explicit_text_body=bool(text_body)):
                shapes = field('Blank heading', 'idx="3"', text_body=text_body) + field('Blank photo', 'idx="4"', text_body=empty)
                result = import_pptx({**fixture([slide(shapes)], extra), 'slide': 1})
                self.assertEqual([(i['type'], i['name']) for i in result['items']],
                                 [('rect', 'Blank heading'), ('textBlock', 'Blank heading'), ('rect', 'Blank photo')])
                field_item = result['items'][1]
                self.assertTrue(field_item['emptyPlaceholder'])
                self.assertEqual((field_item['x'], field_item['y'], field_item['width'], field_item['height']),
                                 (11, 22, 200, 50))
                self.assertEqual((field_item['anchor'], field_item['insets']['left']), ('ctr', 10))
                paragraph = field_item['paragraphs'][0]
                self.assertEqual(paragraph['align'], 'center')
                run = paragraph['runs'][0]
                self.assertEqual((run['text'], run['fontFamily'], run['fontSize'], run['fontWeight'], run['color']),
                                 ('', 'Arial', 42, 700, '#ffffff'))
                self.assertEqual(run['fontStyle'], 'italic' if text_body else 'normal')

    def test_only_marked_pictures_treat_symmetric_negative_crop_as_contain_padding(self):
        ext = ('<a:extLst><a:ext uri="{9B18E286-D535-4B91-B568-9A25B57E38F3}">'
               '<fe:imageFit xmlns:fe="urn:figure-editor:image-fit:1" mode="contain"/></a:ext></a:extLst>')
        for marker, right, contained in [(ext, -10000, True), (ext, -5000, False), ('', -10000, False),
                                         (ext.replace('mode="contain"', 'mode=""'), -10000, False),
                                         (ext.replace('urn:figure-editor:', 'urn:unrelated:'), -10000, False)]:
            with self.subTest(marker=marker, right=right):
                pic = picture(f'<a:srcRect l="-10000" r="{right}"/>')
                pic = pic.replace('name="Panel"/>', 'name="Panel">'+marker+'</p:cNvPr>')
                result = import_pptx({**fixture([slide(pic)]), 'slide':1})
                self.assertEqual(result['items'][0].get('imageFit'), 'contain' if contained else None)
                self.assertNotIn('crop', result['items'][0])
                self.assertEqual(any('Out-of-bounds image crop' in warning for warning in result['warnings']), not contained)

    def test_edited_or_incompletely_marked_contain_groups_keep_their_native_children(self):
        def group(pic_x=20, marker_extra='', extra_child='', frame_fill='<a:noFill/>'):
            width, height = 200*EMU, 100*EMU
            marker = (f'<a:extLst><a:ext uri="{{9B18E286-D535-4B91-B568-9A25B57E38F3}}">'
                      f'<fe:imageFit xmlns:fe="urn:figure-editor:image-fit:1" mode="contain" {marker_extra}/></a:ext></a:extLst>')
            xf = xfrm(60, 30, 200, 100).replace('</a:xfrm>', f'<a:chOff x="0" y="0"/><a:chExt cx="{width}" cy="{height}"/></a:xfrm>')
            pic = picture('<a:srcRect l="25000" r="25000"/>', xfrm(pic_x,0,160,100)).replace('</p:spPr>','<a:ln><a:noFill/></a:ln></p:spPr>')
            frame = (f'<p:sp><p:nvSpPr><p:cNvPr id="5" name="Frame"/></p:nvSpPr><p:spPr>{xfrm(0,0,200,100)}'
                     f'<a:prstGeom prst="rect"/>{frame_fill}<a:ln w="9525"><a:solidFill><a:srgbClr val="ff0000"/></a:solidFill></a:ln></p:spPr></p:sp>')
            return (f'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group">{marker}</p:cNvPr></p:nvGrpSpPr>'
                    f'<p:grpSpPr>{xf}</p:grpSpPr>{pic}{frame}{extra_child}</p:grpSp>')

        guard = f'picX="{20*EMU}" picY="0" picCX="{160*EMU}" picCY="{100*EMU}" cropL="25000" cropT="0" cropR="25000" cropB="0"'
        for xml in [group(), group(30, guard), group(marker_extra=guard.replace('cropR="25000"', 'cropR="0"')),
                    group(marker_extra=guard, extra_child=text_shape(text='Added caption')),
                    group(marker_extra=guard, frame_fill='<a:solidFill><a:srgbClr val="bb0000"/></a:solidFill>')]:
            result = import_pptx({**fixture([slide(xml)]), 'slide':1})
            self.assertGreaterEqual(len(result['items']), 2)
            pic = result['items'][0]
            self.assertEqual(pic['name'], 'Panel')
            self.assertNotIn('imageFit', pic)
            self.assertEqual(pic['width'], 160)
            self.assertEqual(pic['crop']['width'], .5)
            if 'Added caption' in xml:
                self.assertTrue(any(item['type'] == 'textBlock' for item in result['items']))

    def test_luminance_transforms_preserve_hue_saturation_order_and_alpha(self):
        # Hand-calculated HSL examples distinguish luminance from per-channel RGB
        # arithmetic. Import the actual text style so this also covers consumers.
        cases = [
            ('800000', '<a:lumMod val="50000"/><a:lumOff val="50000"/>', '#ff4040'),
            ('800000', '<a:lumOff val="50000"/><a:lumMod val="50000"/>', '#c00000'),
            ('FF8080', '<a:lumMod val="50000"/>', '#c00000'),
            ('008000', '<a:lumOff val="50000"/>', '#80ff80'),
            ('000080', '<a:alpha val="50000"/><a:lumMod val="50000"/><a:lumOff val="50000"/>', '#4040ff80'),
            ('800000', '<a:lumMod val="50000"/><a:alpha val="50000"/><a:lumOff val="50000"/>', '#ff404080'),
            ('FF0000', '<a:lumMod val="50000"/><a:shade val="50000"/><a:lumOff val="50000"/>', '#ff4040'),
            ('FF0000', '<a:lumMod val="50000"/><a:tint val="50000"/>', '#bf8080'),
            ('808080', '<a:lumMod val="50000"/>', '#404040'),
        ]
        for source, transforms, expected in cases:
            with self.subTest(source=source, transforms=transforms):
                content = text_shape().replace('<a:srgbClr val="123456"/>',
                    f'<a:srgbClr val="{source}">{transforms}</a:srgbClr>')
                result = import_pptx({**fixture([slide(content)]), 'slide':1})
                self.assertEqual(result['items'][0]['paragraphs'][0]['runs'][0]['color'], expected)

    def test_saturation_modulation_preserves_hsl_transform_order_and_alpha(self):
        cases = [
            ('D2D4F3', '<a:shade val="100000"/><a:satMod val="115000"/>', '#d0d2f5'),
            ('FF0000', '<a:satMod val="50000"/>', '#bf4040'),
            ('FF0000', '<a:lumMod val="50000"/><a:satMod val="50000"/><a:alpha val="50000"/>', '#60202080'),
            ('800000', '<a:satMod val="200000"/><a:tint val="50000"/>', '#c08080'),
            ('800000', '<a:tint val="50000"/><a:satMod val="200000"/>', '#e06060'),
            ('FF0000', '<a:lumOff val="100000"/><a:satMod val="50000"/><a:lumMod val="50000"/>', '#bf4040'),
        ]
        for source, transforms, expected in cases:
            with self.subTest(source=source, transforms=transforms):
                content = text_shape().replace('<a:srgbClr val="123456"/>',
                    f'<a:srgbClr val="{source}">{transforms}</a:srgbClr>')
                result = import_pptx({**fixture([slide(content)]), 'slide':1})
                self.assertEqual(result['items'][0]['paragraphs'][0]['runs'][0]['color'], expected)

    def test_saturation_modulated_gradient_matches_native_powerpoint_endpoint(self):
        gradient = ('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>'
                    '<a:gs pos="72000"><a:srgbClr val="D2D4F3"><a:shade val="100000"/>'
                    '<a:satMod val="115000"/></a:srgbClr></a:gs></a:gsLst>'
                    '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/>'
                    '</a:path></a:gradFill>')
        content = text_shape(geometry=xfrm()+'<a:prstGeom prst="ellipse"/>'+gradient)
        result = import_pptx({**fixture([slide(content)]), 'slide':1})
        stop = result['items'][0]['fillGradient']['stops'][1]
        # Matches the native PDF's sampled shading endpoint, not an RGB multiplier.
        self.assertEqual(stop, {'offset':.72, 'color':'#d0d2f5'})

    def test_luminance_clamps_each_step_without_losing_hue_at_endpoints(self):
        cases = [
            ('<a:lumOff val="100000"/><a:lumMod val="50000"/>', '#ff0000'),
            ('<a:lumOff val="-100000"/><a:lumOff val="50000"/>', '#ff0000'),
            ('<a:lumMod val="300000"/>', '#ffffff'),
            ('<a:lumOff val="-100000"/>', '#000000'),
        ]
        for transforms, expected in cases:
            with self.subTest(transforms=transforms):
                paint = f'<a:solidFill><a:srgbClr val="FF0000">{transforms}</a:srgbClr></a:solidFill>'
                content = text_shape(geometry=xfrm()+'<a:prstGeom prst="rect"/>'+paint)
                result = import_pptx({**fixture([slide(content)]), 'slide':1})
                self.assertEqual(result['items'][0]['fill'], expected)

    def test_tint_uses_input_fraction_and_shade_keeps_its_rgb_semantics(self):
        # DrawingML tint=10% means 10% input plus 90% white, unlike lumOff.
        cases = [
            ('<a:tint val="0"/>', '#ffffff'),
            ('<a:tint val="100000"/>', '#000000'),
            ('<a:tint val="10000"/>', '#e6e6e6'),
            ('<a:tint val="100000"/><a:lumOff val="50000"/>', '#808080'),
        ]
        for transforms, expected in cases:
            with self.subTest(transforms=transforms):
                content = text_shape().replace('<a:srgbClr val="123456"/>',
                    f'<a:srgbClr val="000000">{transforms}</a:srgbClr>')
                result = import_pptx({**fixture([slide(content)]), 'slide':1})
                self.assertEqual(result['items'][0]['paragraphs'][0]['runs'][0]['color'], expected)
        content = text_shape().replace('<a:srgbClr val="123456"/>',
            '<a:srgbClr val="FF8080"><a:shade val="50000"/><a:alpha val="25000"/></a:srgbClr>')
        result = import_pptx({**fixture([slide(content)]), 'slide':1})
        self.assertEqual(result['items'][0]['paragraphs'][0]['runs'][0]['color'], '#80404040')

    def test_svg_extension_prefers_vector_and_retains_png_fallback(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
        extension = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/></a:ext></a:extLst>'
        content = picture().replace('<a:blip r:embed="img"/>', '<a:blip r:embed="img">'+extension+'</a:blip>')
        extra = {'ppt/media/vector.svg':svg, 'ppt/slides/_rels/slide1.xml.rels':relations([('img','image','../media/panel.png',''),('vector','image','../media/vector.svg','')])}
        result = import_pptx({**fixture([slide(content)], extra), 'slide':1})
        media = {m['id']:m for m in result['media']}
        vector = media[result['items'][0]['assetId']]
        self.assertEqual(vector['mime'], 'image/svg+xml')
        self.assertEqual(media[vector['fallbackId']]['mime'], 'image/png')
        missing = import_pptx({**fixture([slide(content)]), 'slide':1})
        self.assertEqual(missing['media'][0]['mime'], 'image/png')
        self.assertTrue(any('SVG source is missing' in w for w in missing['warnings']))

    def test_missing_svg_part_uses_embedded_preview_without_losing_picture_properties(self):
        extension = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/></a:ext></a:extLst>'
        content = picture('<a:srcRect l="10000" r="20000"/>').replace('<a:blip r:embed="img"/>',
            '<a:blip r:embed="img"><a:alphaModFix amt="50000"/>'+extension+'</a:blip>')
        extra = {'ppt/slides/_rels/slide1.xml.rels':relations([
            ('img','image','../media/panel.png',''), ('vector','image','../media/missing.svg','')])}
        result = import_pptx({**fixture([slide(content)], extra), 'slide':1})
        self.assertEqual(len(result['items']), 1)
        item = result['items'][0]
        self.assertEqual((item['x'], item['y'], item['width'], item['height']), (200,100,240,180))
        self.assertEqual(item['opacity'], .5)
        self.assertEqual(item['crop'], {'x':.1,'y':0,'width':.7,'height':1})
        self.assertEqual(result['media'][0]['mime'], 'image/png')
        self.assertEqual(item['assetId'], result['media'][0]['id'])
        self.assertTrue(any('SVG source is missing; its preview image is used.' in w for w in result['warnings']))

    def test_existing_svg_survives_missing_optional_preview_part_or_relationship(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
        extension = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/></a:ext></a:extLst>'
        content = picture().replace('<a:blip r:embed="img"/>', '<a:blip r:embed="img">'+extension+'</a:blip>')
        for preview_rel in ([('img','image','../media/missing.png','')], []):
            with self.subTest(preview_rel=preview_rel):
                extra = {'ppt/media/vector.svg':svg, 'ppt/slides/_rels/slide1.xml.rels':relations([
                    *preview_rel, ('vector','image','../media/vector.svg','')])}
                result = import_pptx({**fixture([slide(content)], extra), 'slide':1})
                self.assertEqual(len(result['items']), 1)
                self.assertEqual(len(result['media']), 1)
                vector = result['media'][0]
                self.assertEqual(vector['mime'], 'image/svg+xml')
                self.assertNotIn('fallbackId', vector)
                self.assertEqual(base64.b64decode(vector['dataUrl'].split(',')[1]), svg)
                self.assertTrue(any('Preview image is missing; the SVG source was retained.' in w for w in result['warnings']))

    def test_missing_svg_and_preview_report_omission_and_keep_other_content(self):
        extension = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/></a:ext></a:extLst>'
        content = picture().replace('<a:blip r:embed="img"/>', '<a:blip r:embed="img">'+extension+'</a:blip>')
        extra = {'ppt/slides/_rels/slide1.xml.rels':relations([
            ('img','image','../media/missing.png',''), ('vector','image','../media/missing.svg','')])}
        result = import_pptx({**fixture([slide(content+text_shape())], extra), 'slide':1})
        self.assertEqual([item['type'] for item in result['items']], ['textBlock'])
        self.assertEqual(result['media'], [])
        self.assertTrue(any('SVG source and preview image are missing' in w for w in result['warnings']))
        self.assertFalse(any('preview image is used' in w for w in result['warnings']))

    def test_gradient_arrows_are_independent_vectors_with_editable_text(self):
        gradient='<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>'
        content=text_shape(geometry=xfrm()+f'<a:prstGeom prst="curvedDownArrow"><a:avLst/></a:prstGeom>{gradient}')
        result=import_pptx({**fixture([slide(content)]),'slide':1})
        shape,text=result['items']
        self.assertEqual((shape['type'],text['type']),('shape','textBlock'))
        self.assertEqual(len(shape['paths']),3)
        self.assertTrue(any(c[0]=='C' for p in shape['paths'] for c in p['commands']))
        self.assertEqual(shape['fillGradient']['stops'][0]['color'],'#ff000080')
        self.assertEqual(result['media'],[])

    def test_mac_clipboard_root_resolves_and_requires_one_slide(self):
        source=fixture([slide(text_shape()+picture())])
        output=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(source['data']))) as old, zipfile.ZipFile(output,'w') as new:
            for name in old.namelist():new.writestr(name.replace('ppt/','clipboard/',1),old.read(name))
            new.writestr('_rels/.rels',relations([('document','officeDocument','clipboard/presentation.xml','')]))
        result=import_pptx({'data':base64.b64encode(output.getvalue()).decode()},single_slide=True)
        self.assertEqual([item['type'] for item in result['items']],['textBlock','image'])
        with self.assertRaisesRegex(PptxImportError,'exactly one'):import_pptx(fixture(),single_slide=True)

    def test_inspect_follows_presentation_order_and_does_not_return_images(self):
        data=fixture()
        result=import_pptx(data)
        self.assertEqual([s['number'] for s in result['slides']],[1,2])
        self.assertEqual(result['slides'][1]['title'],'Second slide')
        self.assertNotIn('media',result)
        selected=import_pptx({**data,'slide':2})
        self.assertEqual(selected['media'],[])
        self.assertEqual(selected['source']['slide'],2)

    def test_independent_text_and_original_image_crop_geometry(self):
        result=import_pptx({**fixture([slide(text_shape()+picture('<a:srcRect l="10000" t="20000" r="30000" b="10000"/>'))]),'slide':1})
        self.assertEqual(result['canvas'],{'width':960,'height':640,'background':'#ffffff'})
        text,image=result['items']
        self.assertEqual((text['type'],text['x'],text['y']),('textBlock',40,50))
        self.assertEqual(text['paragraphs'][0]['runs'][0]['fontSize'],24)
        self.assertEqual(text['paragraphs'][0]['runs'][0]['color'],'#123456')
        self.assertEqual((image['x'],image['y'],image['width'],image['height']),(200,100,240,180))
        self.assertAlmostEqual(image['crop']['width'],.6)
        self.assertEqual(base64.b64decode(result['media'][0]['dataUrl'].split(',')[1]),PNG)

    def test_theme_styled_rectangle_does_not_disappear(self):
        shape=f'<p:sp><p:nvSpPr><p:cNvPr id="4" name="Rectangle"/></p:nvSpPr><p:spPr>{xfrm()}<a:prstGeom prst="rect"/></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent2"/></a:fillRef></p:style></p:sp>'
        result=import_pptx({**fixture([slide(shape)]),'slide':1})
        self.assertEqual(len(result['items']),1)
        self.assertEqual(result['items'][0]['fill'],'#ed7d31')
        self.assertEqual(result['items'][0]['stroke'],'#4472c4')

    def test_placeholder_geometry_inherits_by_index_then_master_type(self):
        content=text_shape(geometry='',ph='<p:ph type="body" idx="2"/>')
        layout=f'<p:sldLayout {HEADER}><p:cSld><p:spTree>{text_shape(geometry="",ph="<p:ph type=\"body\" idx=\"2\"/>")}</p:spTree></p:cSld></p:sldLayout>'
        master=f'<p:sldMaster {HEADER}><p:cSld><p:spTree>{text_shape(geometry=xfrm(11,22),ph="<p:ph type=\"title\"/>")}{text_shape(geometry=xfrm(99,111),ph="<p:ph type=\"body\" idx=\"1\"/>")}</p:spTree></p:cSld></p:sldMaster>'
        extra={'ppt/slides/_rels/slide1.xml.rels':relations([('layout','slideLayout','../slideLayouts/layout.xml','')]),'ppt/slideLayouts/layout.xml':layout,
               'ppt/slideLayouts/_rels/layout.xml.rels':relations([('master','slideMaster','../slideMasters/master.xml','')]),'ppt/slideMasters/master.xml':master}
        result=import_pptx({**fixture([slide(content)],extra),'slide':1})
        self.assertEqual((result['items'][0]['x'],result['items'][0]['y']),(99,111))

    def test_rotated_scaled_group_and_stacking(self):
        xf=f'<a:xfrm rot="5400000"><a:off x="{100*EMU}" y="{200*EMU}"/><a:ext cx="{400*EMU}" cy="{200*EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="{200*EMU}" cy="{100*EMU}"/></a:xfrm>'
        group=f'<p:grpSp><p:grpSpPr>{xf}</p:grpSpPr>{picture(geometry=xfrm(0,0,100,50))}{text_shape(geometry=xfrm(100,0,100,50))}</p:grpSp>'
        result=import_pptx({**fixture([slide(group)]),'slide':1})
        first,second=result['items']
        self.assertEqual([first['type'],second['type']],['image','textBlock'])
        self.assertAlmostEqual(first['rotation'],90)
        self.assertEqual((first['width'],first['height']),(200,100))
        self.assertAlmostEqual(first['x'],250)
        self.assertAlmostEqual(first['y'],150)

    def test_group_geometry_does_not_rescale_physical_text_metrics(self):
        xf = (f'<a:xfrm rot="5400000"><a:off x="{100*EMU}" y="{200*EMU}"/>'
              f'<a:ext cx="{100*EMU}" cy="{100*EMU}"/><a:chOff x="0" y="0"/>'
              f'<a:chExt cx="{400*EMU}" cy="{200*EMU}"/></a:xfrm>')
        label = text_shape(geometry=xfrm(0, 0, 300, 100)).replace(
            '<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/>',
            f'<a:bodyPr lIns="{10*EMU}" tIns="{5*EMU}" rIns="{8*EMU}" bIns="0">'
            '<a:normAutofit fontScale="75000"/></a:bodyPr>').replace(
            '<a:p><a:r>', f'<a:p><a:pPr marL="{4*EMU}" marR="{2*EMU}" indent="{3*EMU}">'
            '<a:lnSpc><a:spcPts val="2400"/></a:lnSpc></a:pPr><a:r>')
        group = f'<p:grpSp><p:grpSpPr>{xf}</p:grpSpPr>{label}</p:grpSp>'
        item = import_pptx({**fixture([slide(group)]), 'slide': 1})['items'][0]
        self.assertEqual((item['width'], item['height']), (75, 50))
        self.assertEqual(item['paragraphs'][0]['runs'][0]['fontSize'], 18)
        self.assertEqual(item['insets'], {'left': 10, 'top': 5, 'right': 8, 'bottom': 0})
        self.assertEqual(item['paragraphs'][0]['marginLeft'], 4)
        self.assertEqual(item['paragraphs'][0]['marginRight'], 2)
        self.assertEqual(item['paragraphs'][0]['indent'], 3)
        self.assertEqual(item['scaleY'], 1)

    def test_group_scaling_preserves_physical_shape_and_picture_stroke_width(self):
        xf = (f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{100*EMU}" cy="{100*EMU}"/>'
              f'<a:chOff x="0" y="0"/><a:chExt cx="{400*EMU}" cy="{200*EMU}"/></a:xfrm>')
        border = '<a:ln w="38100"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>'
        content = text_shape(text='').replace('</p:spPr>', border + '</p:spPr>')
        content += picture().replace('</p:spPr>', border + '</p:spPr>')
        result = import_pptx({**fixture([slide(f'<p:grpSp><p:grpSpPr>{xf}</p:grpSpPr>{content}</p:grpSp>')]), 'slide': 1})
        self.assertEqual([item['strokeWidth'] for item in result['items']], [4, 4])
        self.assertEqual([item['width'] for item in result['items']], [25, 60])

    def test_empty_mirrored_text_does_not_report_missing_visible_text(self):
        for value in ('', 'Visible label'):
            with self.subTest(value=value):
                result = import_pptx({**fixture([slide(text_shape(text=value, geometry=xfrm(attrs='flipH="1"')))]), 'slide': 1})
                self.assertEqual(any('Mirrored text' in warning for warning in result['warnings']), bool(value))

    def test_external_images_and_charts_report_omissions(self):
        chart=f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr name="Chart"/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="{EMU}" cy="{EMU}"/></p:xfrm></p:graphicFrame>'
        extra={'ppt/slides/_rels/slide1.xml.rels':relations([('img','image','https://example.invalid/image.png','TargetMode="External"')])}
        result=import_pptx({**fixture([slide(picture()+chart)],extra),'slide':1})
        self.assertEqual(result['items'],[])
        self.assertTrue(any('Linked or missing' in w for w in result['warnings']))
        self.assertTrue(any('Chart, table' in w for w in result['warnings']))

    def test_file_errors_and_invalid_selection_are_actionable(self):
        for data in ({'name':'x.pptx','data':'!!!'}, {'name':'x.ppt','data':'YWJj'}, {'name':'x.pptx','data':'YWJj'}, {**fixture(),'slide':0}, {**fixture(),'slide':True}, {**fixture(),'path':'/etc/passwd'}):
            with self.subTest(data=list(data)),self.assertRaises(PptxImportError):import_pptx(data)

    def test_dtd_unknown_encoding_bad_zip_targets_and_size_are_rejected(self):
        for xml in ('<!DOCTYPE p:sld [<!ENTITY x "bad">]>'+slide(''), '<?xml version="1.0" encoding="not-an-encoding"?>'+slide('')):
            with self.assertRaises(PptxImportError):import_pptx(fixture([xml]))
        data=fixture(extra={'ppt/_rels/presentation.xml.rels':relations([('s0','slide','../../outside.xml','')])})
        with self.assertRaises(PptxImportError):import_pptx(data)
        with mock.patch('pptx_import.MAX_EXPANDED',1),self.assertRaises(PptxImportError):import_pptx(fixture())
        pkg=Package(base64.b64decode(fixture()['data']))
        with mock.patch.object(pkg.zip,'read',side_effect=zlib.error('bad deflate')),self.assertRaises(PptxImportError):pkg.read('ppt/presentation.xml')
        pkg.zip.close()


# Saved SmartArt layouts are synthetic: no private deck or Office installation.
def smartart_transform(x, y, w, h, attrs='', prefix='a'):
    return (f'<{prefix}:xfrm {attrs}><a:off x="{x*EMU}" y="{y*EMU}"/>'
            f'<a:ext cx="{w*EMU}" cy="{h*EMU}"/></{prefix}:xfrm>')


SMARTART_HEADER = ' '.join(f'xmlns:{key}="{value}"' for key, value in NS.items())


def smartart_relationships(entries):
    return ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + ''.join(f'<Relationship Id="{rid}" Type="{NS["r"]}/{kind}" Target="{target}" {attrs}/>'
                      for rid, kind, target, attrs in entries) + '</Relationships>')


def smartart_cached_shape(text='Editable node', with_text_transform=True):
    text_xf = smartart_transform(50, 40, 60, 60).replace('a:xfrm', 'dsp:txXfrm') if with_text_transform else ''
    return (f'<dsp:sp modelId="node-1"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/>'
            f'<dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>{smartart_transform(40,30,80,80)}'
            '<a:prstGeom prst="ellipse"/><a:gradFill><a:gsLst>'
            '<a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>'
            '<a:gs pos="100000"><a:srgbClr val="7777AA"/></a:gs>'
            '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/>'
            '</a:path></a:gradFill><a:ln><a:noFill/></a:ln></dsp:spPr>'
            '<dsp:txBody><a:bodyPr anchor="ctr" lIns="0" tIns="0" rIns="0" bIns="0"/>'
            '<a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1200">'
            '<a:latin typeface="Arial"/><a:solidFill><a:srgbClr val="123456"/></a:solidFill>'
            f'</a:rPr><a:t>{text}</a:t></a:r></a:p></dsp:txBody>{text_xf}</dsp:sp>')


def smartart_fixture(*, group=False, frame_attrs='', overrides=None, data_owner=False, body=None):
    frame = ('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Diagram 7"/>'
             f'</p:nvGraphicFramePr>{smartart_transform(200,100,400,300,frame_attrs,"p")}'
             f'<a:graphic><a:graphicData uri="{NS["dgm"]}"><dgm:relIds r:dm="data"/>'
             '</a:graphicData></a:graphic></p:graphicFrame>')
    if group:
        group_xf = smartart_transform(100,200,400,150).replace('</a:xfrm>',
            f'<a:chOff x="0" y="0"/><a:chExt cx="{800*EMU}" cy="{600*EMU}"/></a:xfrm>')
        frame = f'<p:grpSp><p:grpSpPr>{group_xf}</p:grpSpPr>{frame}</p:grpSp>'
    slide_rels = [('data', 'diagramData', '../diagrams/data.xml', '')]
    draw_rel = ('drawing', 'diagramDrawing', '../diagrams/layout.xml', '')
    if not data_owner:
        slide_rels.append(draw_rel)
    parts = {
        'ppt/presentation.xml': f'<p:presentation {SMARTART_HEADER}><p:sldIdLst><p:sldId id="256" r:id="slide"/>'
            f'</p:sldIdLst><p:sldSz cx="{960*EMU}" cy="{640*EMU}"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels': smartart_relationships([('slide','slide','slides/slide1.xml','')]),
        'ppt/slides/slide1.xml': f'<p:sld {SMARTART_HEADER}><p:cSld><p:spTree>{frame}</p:spTree></p:cSld></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels': smartart_relationships(slide_rels),
        'ppt/diagrams/data.xml': f'<dgm:dataModel {SMARTART_HEADER}><dgm:extLst><a:ext uri="{NS["dsp"]}">'
            '<dsp:dataModelExt relId="drawing"/></a:ext></dgm:extLst></dgm:dataModel>',
        'ppt/diagrams/layout.xml': f'<dsp:drawing {SMARTART_HEADER}><dsp:spTree><dsp:nvGrpSpPr/>'
            f'<dsp:grpSpPr/>{smartart_cached_shape() if body is None else body}</dsp:spTree></dsp:drawing>',
    }
    if data_owner:
        parts['ppt/diagrams/_rels/data.xml.rels'] = smartart_relationships([draw_rel])
    parts.update(overrides or {})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, data in parts.items():
            if data is not None:
                archive.writestr(path, data)
    return {'name': 'smartart.pptx', 'data': base64.b64encode(stream.getvalue()).decode(), 'slide': 1}


class SmartArtImportTests(unittest.TestCase):
    def test_hidden_cached_root_does_not_reveal_its_children(self):
        root = ('<dsp:nvGrpSpPr><dsp:cNvPr id="1" name="Hidden diagram" hidden="1"/>'
                '<dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>')
        drawing = f'<dsp:drawing {SMARTART_HEADER}><dsp:spTree>{root}{smartart_cached_shape()}</dsp:spTree></dsp:drawing>'
        result = import_pptx(smartart_fixture(overrides={'ppt/diagrams/layout.xml':drawing}))
        self.assertEqual(result['items'], [])
        self.assertFalse(any('omitted' in warning for warning in result['warnings']))

    def test_cached_root_effects_without_transform_are_preserved_as_a_group(self):
        root = ('<dsp:nvGrpSpPr><dsp:cNvPr id="1" name="Diagram effects"/></dsp:nvGrpSpPr>'
                '<dsp:grpSpPr><a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="2700000">'
                '<a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:outerShdw>'
                '<a:softEdge rad="25400"/></a:effectLst></dsp:grpSpPr>')
        drawing = f'<dsp:drawing {SMARTART_HEADER}><dsp:spTree>{root}{smartart_cached_shape()}</dsp:spTree></dsp:drawing>'
        result = import_pptx(smartart_fixture(overrides={'ppt/diagrams/layout.xml':drawing}))
        self.assertEqual(len(result['items']), 1)
        group = result['items'][0]
        self.assertEqual(group['type'], 'shadowGroup')
        self.assertEqual((group['x'],group['y'],group['width'],group['height']), (200,100,400,300))
        self.assertEqual((group['shadow']['blur'],group['shadow']['distance']), (5,3))
        self.assertEqual(group['softEdge'], 2)
        self.assertEqual([item['type'] for item in group['items']], ['shape','textBlock'])
        self.assertEqual((group['items'][0]['x'],group['items'][0]['y']), (40,30))
        self.assertEqual((group['items'][1]['x'],group['items'][1]['y']), (50,40))

    def test_saved_layout_imports_editable_geometry_and_separate_text_rectangle(self):
        result = import_pptx(smartart_fixture())
        self.assertEqual([item['type'] for item in result['items']], ['shape', 'textBlock'])
        shape, text = result['items']
        self.assertEqual((shape['x'], shape['y'], shape['width'], shape['height']), (240,130,80,80))
        self.assertEqual(shape['fillGradient']['type'], 'radial')
        self.assertEqual((text['x'], text['y'], text['width'], text['height']), (250,140,60,60))
        self.assertEqual(text['anchor'], 'ctr')
        run = text['paragraphs'][0]['runs'][0]
        self.assertEqual((run['text'], run['fontSize'], run['color']), ('Editable node',16,'#123456'))
        self.assertEqual(result['media'], [])
        self.assertTrue(any('automatic SmartArt layout is not retained' in w for w in result['warnings']))
        self.assertFalse(any('omitted' in w for w in result['warnings']))

    def test_group_scaling_is_not_applied_twice_to_cached_diagram(self):
        result = import_pptx(smartart_fixture(group=True))
        shape, text = result['items']
        self.assertEqual((shape['x'], shape['y'], shape['width'], shape['height']), (240,255,80,80))
        self.assertEqual((text['x'], text['y'], text['width'], text['height']), (250,265,60,60))
        self.assertEqual(text['paragraphs'][0]['runs'][0]['fontSize'],16)

    def test_frame_rotation_and_reflection_are_retained(self):
        for attrs, expected in [('rot="5400000"',(440,90,90)), ('flipH="1"',(480,130,180))]:
            with self.subTest(attrs=attrs):
                shape = import_pptx(smartart_fixture(frame_attrs=attrs))['items'][0]
                self.assertAlmostEqual(shape['x'],expected[0])
                self.assertAlmostEqual(shape['y'],expected[1])
                self.assertAlmostEqual(abs(shape['rotation']),expected[2])
                self.assertEqual((shape['width'],shape['height']),(80,80))

    def test_data_part_relationship_and_absent_text_transform_are_supported(self):
        result = import_pptx(smartart_fixture(data_owner=True,body=smartart_cached_shape(with_text_transform=False)))
        self.assertEqual(len(result['items']),2)
        text = result['items'][1]
        self.assertEqual((text['x'],text['y'],text['width'],text['height']),(240,130,80,80))

    def test_missing_external_and_unsupported_layouts_are_reported(self):
        variants = [
            {'ppt/diagrams/data.xml':None},
            {'ppt/diagrams/layout.xml':None},
            {'ppt/slides/_rels/slide1.xml.rels':smartart_relationships([
                ('data','diagramData','../diagrams/data.xml',''),
                ('drawing','diagramDrawing','https://example.invalid/layout.xml','TargetMode="External"')])},
            {'ppt/diagrams/layout.xml':f'<dsp:drawing {SMARTART_HEADER}><dsp:spTree><dsp:pic/></dsp:spTree></dsp:drawing>'},
            {'ppt/diagrams/layout.xml':f'<p:spTree {SMARTART_HEADER}/>'},
        ]
        for overrides in variants:
            with self.subTest(overrides=overrides):
                result = import_pptx(smartart_fixture(overrides=overrides))
                self.assertEqual(result['items'],[])
                self.assertTrue(any('SmartArt was omitted:' in w for w in result['warnings']))

    def test_multiple_saved_nodes_keep_order_and_independent_editable_text(self):
        result=import_pptx(smartart_fixture(body=smartart_cached_shape('First')+smartart_cached_shape('Second')))
        self.assertEqual([item['type'] for item in result['items']],['shape','textBlock','shape','textBlock'])
        self.assertEqual([item['paragraphs'][0]['runs'][0]['text'] for item in result['items'] if item['type']=='textBlock'],['First','Second'])
        self.assertEqual(len({item['id'] for item in result['items']}),4)

    def test_layout_object_limit_still_applies(self):
        with self.assertRaises(PptxImportError) as caught:
            import_pptx(smartart_fixture(body=smartart_cached_shape()*1001))
        self.assertEqual(caught.exception.status,413)



if __name__=='__main__':unittest.main()
