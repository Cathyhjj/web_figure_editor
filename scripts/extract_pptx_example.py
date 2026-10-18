#!/usr/bin/env python3
"""Convert the selected, inspected PPTX slide into Figure Editor v1.

Uses only the Python standard library, with lossless PNG crop copies.
This is a reproducible extraction for slide 4, not a general PPTX importer.
"""
import argparse, base64, datetime, hashlib, json, math, shutil, struct, zlib, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
EMU = 9525
ROOT = Path(__file__).resolve().parents[1]

def sha(data): return hashlib.sha256(data).hexdigest()
def jwrite(path, value): path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
def png_dimensions(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'Only PNG source media is expected on this slide.'
    return struct.unpack('>II', data[16:24])
def png_rgba(width, height, rows, ancillary=()):
    def chunk(kind, value): return struct.pack('>I', len(value))+kind+value+struct.pack('>I', zlib.crc32(kind+value)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+b''.join(chunk(k,v) for k,v in ancillary)+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+r for r in rows)))+chunk(b'IEND',b'')

def decode_png_rgba(data):
    """Decode the non-interlaced RGBA8 PNGs inspected in this source deck."""
    w,h,depth,color,compression,filter_method,interlace=struct.unpack('>IIBBBBB',data[16:29])
    assert (depth,color,compression,filter_method,interlace)==(8,6,0,0,0)
    pos=8; compressed=bytearray(); ancillary=[]
    while pos<len(data):
        length=struct.unpack('>I',data[pos:pos+4])[0];kind=data[pos+4:pos+8];value=data[pos+8:pos+8+length];pos+=12+length
        if kind==b'IDAT':compressed.extend(value)
        elif kind in (b'gAMA',b'cHRM',b'sRGB',b'iCCP',b'pHYs'):ancillary.append((kind,value))
    raw=zlib.decompress(compressed);stride=w*4;prior=bytearray(stride);rows=[]
    for y in range(h):
        start=y*(stride+1);f=raw[start];row=bytearray(raw[start+1:start+1+stride])
        for x in range(stride):
            a=row[x-4] if x>=4 else 0;b=prior[x];c=prior[x-4] if x>=4 else 0
            if f==1:predict=a
            elif f==2:predict=b
            elif f==3:predict=(a+b)//2
            elif f==4:
                p=a+b-c;pa,pb,pc=abs(p-a),abs(p-b),abs(p-c);predict=a if pa<=pb and pa<=pc else b if pb<=pc else c
            elif f==0:predict=0
            else:raise ValueError('Unsupported PNG filter')
            row[x]=(row[x]+predict)&255
        rows.append(bytes(row));prior=row
    return w,h,rows,ancillary

def crop_png(data, left, top, right, bottom):
    w,h,rows,ancillary=decode_png_rgba(data)
    assert 0<=left<right<=w and 0<=top<bottom<=h
    result=png_rgba(right-left,bottom-top,[row[left*4:right*4] for row in rows[top:bottom]],ancillary)
    assert png_dimensions(result)==(right-left,bottom-top)
    return result

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('source',type=Path,help='Local PPTX for the inspected slide-4 conversion'); args=parser.parse_args()
    source=args.source.expanduser().resolve(); out=ROOT/'examples'; detail=out/'slide-04'
    (detail/'original-media').mkdir(parents=True,exist_ok=True); (detail/'derived-media').mkdir(exist_ok=True)
    data=source.read_bytes(); meta=source.stat(); copied=out/source.name
    if copied.resolve()!=source.resolve(): shutil.copy2(source,copied)
    assert sha(copied.read_bytes())==sha(data)
    z=zipfile.ZipFile(copied); xmlpath='ppt/slides/slide4.xml'; slide=ET.fromstring(z.read(xmlpath))
    (detail/'source-slide4.xml').write_bytes(z.read(xmlpath)); (detail/'source-slide4.xml.rels').write_bytes(z.read('ppt/slides/_rels/slide4.xml.rels'))
    rels={r.attrib['Id']:r.attrib['Target'] for r in ET.fromstring(z.read('ppt/slides/_rels/slide4.xml.rels'))}
    pres=ET.fromstring(z.read('ppt/presentation.xml')); sz=pres.find('p:sldSz',NS); cw,ch=int(sz.attrib['cx'])/EMU,int(sz.attrib['cy'])/EMU
    project={'format':'figure-editor','version':1,'id':'paper-figure-20261011-slide04','name':'XAS paper figure · PPT slide 4','canvas':{'width':cw,'height':ch,'background':'#ffffff'},'assets':[],'items':[]}
    report={'source':{'localPath':str(source),'copiedPath':str(copied.relative_to(ROOT)),'bytes':len(data),'lastModifiedUTC':datetime.datetime.fromtimestamp(meta.st_mtime,datetime.timezone.utc).isoformat(),'sha256':sha(data),'copySha256':sha(copied.read_bytes()),'verification':'Current local file checked and copied byte-for-byte. Remote Drive synchronization was not independently checked.'},'slide':4,'slideCount':len(pres.find('p:sldIdLst',NS)),'reason':'First scientific multi-panel page in the deck with independently editable image panels and text labels. Slides 1–3 are heading/single-scene material.','canvasCSSPixels':{'width':cw,'height':ch},'objects':[],'excludedOffCanvas':[],'limitations':['This is a single-page extraction, not a general PPTX import feature.','The source page is a draft; the original 20261012 version unfinished note is retained.','Raster plot internals, ticks, curves and equations embedded in images remain raster and cannot be edited as text/data.','Three gradient overlays are separate raster assets. Their gradient stops and placement are preserved; their subtle outer shadows are omitted.','Groups are ungrouped to independent children. Original stacking order and transformed positions are retained.','Picture cropping is baked into a derived PNG copy, rounded to source pixels; original PNGs are retained alongside it.','Text uses one font style per source text box. PowerPoint font metrics, baseline and text box insets may differ slightly in browsers. Fonts are referenced and not embedded.','Off-canvas pasteboard items, including an extended caption, are excluded from the visible example and listed in this manifest. They remain in the unchanged PPTX.','The chosen visible page has no native charts, tables, SmartArt, equations or unsupported custom geometry. No such objects are silently flattened.','This example embeds portable image copies and does not have ongoing permission to read the original local PPTX.']}
    asset_cache={}
    def asset(name, raw, relative, original_info=None):
        key=sha(raw)
        if key in asset_cache:return asset_cache[key]
        aid='asset-'+key[:16]; w,h=png_dimensions(raw)
        obj={'id':aid,'name':name,'mime':'image/png','dataUrl':'data:image/png;base64,'+base64.b64encode(raw).decode(),'width':w,'height':h,'size':len(raw),'lastModified':int(meta.st_mtime*1000),'sourceKind':'copy','relativePath':relative,'fingerprint':'sha256:'+key}
        project['assets'].append(obj); asset_cache[key]=aid; return aid
    def parse_geometry(el, tr):
        xf=el.find('p:spPr/a:xfrm',NS)
        if xf is None: xf=el.find('p:grpSpPr/a:xfrm',NS)
        if xf is None: raise ValueError('Source object missing explicit geometry')
        off,ext=xf.find('a:off',NS),xf.find('a:ext',NS); sx,sy,ox,oy=tr
        x,y=(int(off.attrib['x'])*sx+ox)/EMU,(int(off.attrib['y'])*sy+oy)/EMU
        w,h=int(ext.attrib['cx'])*sx/EMU,int(ext.attrib['cy'])*sy/EMU
        return xf,{'x':x,'y':y,'width':w,'height':h,'rotation':int(xf.attrib.get('rot','0'))/60000}
    def inside(g):
        rad=math.radians(g['rotation']); bw=abs(g['width']*math.cos(rad))+abs(g['height']*math.sin(rad)); bh=abs(g['width']*math.sin(rad))+abs(g['height']*math.cos(rad)); cx,cy=g['x']+g['width']/2,g['y']+g['height']/2
        return cx+bw/2>0 and cy+bh/2>0 and cx-bw/2<cw and cy-bh/2<ch
    def walk(parent,tr=(1,1,0,0),groups=()):
        for el in parent:
            typ=el.tag.rsplit('}',1)[-1]
            if typ not in ('grpSp','pic','sp','cxnSp'):continue
            nv=el.find('.//p:cNvPr',NS); sid=nv.attrib['id']; name=nv.attrib['name']; xf,g=parse_geometry(el,tr)
            if typ=='grpSp':
                off,ext,co,ce=(xf.find('a:'+k,NS) for k in ('off','ext','chOff','chExt')); sx,sy,ox,oy=tr
                nsx,nsy=sx*int(ext.attrib['cx'])/int(ce.attrib['cx']),sy*int(ext.attrib['cy'])/int(ce.attrib['cy'])
                ntr=(nsx,nsy,ox+int(off.attrib['x'])*sx-int(co.attrib['x'])*nsx,oy+int(off.attrib['y'])*sy-int(co.attrib['y'])*nsy)
                assert not xf.attrib.get('rot'), 'Selected source has no rotated groups'
                walk(el,ntr,groups+(sid,));continue
            text='\n'.join(''.join(t.text or '' for t in p.findall('.//a:t',NS)) for p in el.findall('p:txBody/a:p',NS))
            rec={'pptShapeId':sid,'pptName':name,'pptType':typ,'groupIds':list(groups),'geometry':g}
            if text:rec['text']=text
            if not inside(g):report['excludedOffCanvas'].append(rec);continue
            item={'id':'ppt4-'+sid,'name':name,**g,'rotation':g['rotation'],'opacity':1,'locked':False,'hidden':False}
            if typ=='pic':
                blip=el.find('p:blipFill/a:blip',NS); rid=blip.attrib['{'+NS['r']+'}embed']; path='ppt/'+rels[rid].removeprefix('../'); raw=z.read(path); original=detail/'original-media'/Path(path).name; original.write_bytes(raw)
                crop=el.find('p:blipFill/a:srcRect',NS); crop={k:int(v) for k,v in crop.attrib.items()} if crop is not None else {}
                used=original
                if any(crop.values()):
                    w,h=png_dimensions(raw); left=round(w*crop.get('l',0)/100000); top=round(h*crop.get('t',0)/100000); right=round(w*(1-crop.get('r',0)/100000)); bottom=round(h*(1-crop.get('b',0)/100000)); used=detail/'derived-media'/('shape-'+sid+'-crop.png')
                    used.write_bytes(crop_png(raw,left,top,right,bottom))
                    rec['cropPixels']={'left':left,'top':top,'right':right,'bottom':bottom}
                item.update(type='image',assetId=asset('PPT slide 4 · '+name,used.read_bytes(),str(used.relative_to(ROOT))))
                rec.update(conversion='independent raster image',sourceMedia=path,sourceMediaSha256=sha(raw),originalCopy=str(original.relative_to(ROOT)),cropPercent1000=crop,derivedCopy=str(used.relative_to(ROOT)))
            elif text:
                body=el.find('p:txBody/a:bodyPr',NS); p=el.find('p:txBody/a:p',NS); rp=el.find('p:txBody/a:p/a:r/a:rPr',NS); rp=rp if rp is not None else ET.Element('empty'); pp=p.find('a:pPr',NS)
                font=rp.find('a:latin',NS); family=font.attrib['typeface'] if font is not None else 'Aptos'; fs=int(rp.attrib.get('sz','1800'))/100*96/72*tr[1]
                color=rp.find('a:solidFill/a:srgbClr',NS); col='#'+color.attrib['val'] if color is not None else '#000000'
                left=int(body.attrib.get('lIns','91440'))/EMU*tr[0]; top=int(body.attrib.get('tIns','45720'))/EMU*tr[1]; right=int(body.attrib.get('rIns','91440'))/EMU*tr[0]
                item.update(type='text',name=text if len(text)<80 else name,text=text,fontFamily=family,fontSize=fs,fontWeight=700 if rp.attrib.get('b')=='1' else 400,fontStyle='italic' if rp.attrib.get('i')=='1' else 'normal',color=col,align={'ctr':'center','r':'right'}.get(pp.attrib.get('algn') if pp is not None else None,'left'))
                item['x']+=left;item['y']+=top;item['width']=max(.01,item['width']-left-right)
                highlights=el.findall('.//a:highlight/a:srgbClr',NS)
                if highlights:
                    highlight={'id':'ppt4-'+sid+'-highlight','type':'rect','name':'Original draft-note highlight',**g,'opacity':1,'locked':False,'hidden':False,'fill':'#'+highlights[0].attrib['val'],'stroke':'none','strokeWidth':0}; project['items'].append(highlight);rec['highlight']='Separate editable rectangle approximates original text highlight.'
                rec['conversion']='editable text'; rec['fontPointSize']=int(rp.attrib.get('sz','1800'))/100
            else:
                grad=el.find('p:spPr/a:gradFill',NS)
                if grad is None:raise ValueError('Unexpected visible non-text geometry '+sid)
                assert el.find('p:spPr/a:prstGeom',NS).attrib['prst']=='rect'
                stops=[]
                for stop in grad.findall('a:gsLst/a:gs',NS):
                    c=stop.find('a:srgbClr',NS); a=c.find('a:alpha',NS); stops.append((int(stop.attrib['pos'])/100000,[int(c.attrib['val'][i:i+2],16) for i in (0,2,4)]+[255*(int(a.attrib['val'])/100000 if a is not None else 1)]))
                stops.sort(); w,h=max(1,round(g['width']*4)),max(1,round(g['height']*4)); row=bytearray()
                for x in range(w):
                    t=x/max(1,w-1); a,b=stops[0],stops[-1]
                    for lo,hi in zip(stops,stops[1:]):
                        if lo[0]<=t<=hi[0]: a,b=lo,hi;break
                    f=max(0,min(1,(t-a[0])/(b[0]-a[0] or 1)));row.extend(round(av+(bv-av)*f) for av,bv in zip(a[1],b[1]))
                raw=png_rgba(w,h,[bytes(row)]*h); derived=detail/'derived-media'/('shape-'+sid+'-gradient.png');derived.write_bytes(raw)
                item.update(type='image',name=name+' (gradient image)',assetId=asset('PPT gradient · '+name,raw,str(derived.relative_to(ROOT))))
                rec.update(conversion='separate gradient raster image; outer shadow omitted',gradientStops=stops,derivedCopy=str(derived.relative_to(ROOT)))
            project['items'].append(item);rec['itemId']=item['id'];report['objects'].append(rec)
    walk(slide.find('p:cSld/p:spTree',NS))
    report['summary']={'imagePanels':sum(r['pptType']=='pic' for r in report['objects']),'editableTextObjects':sum(r['conversion']=='editable text' for r in report['objects']),'gradientImageObjects':sum('gradient raster' in r['conversion'] for r in report['objects']),'editableHighlightShapes':sum('highlight' in r for r in report['objects']),'totalEditorItems':len(project['items']),'assetCount':len(project['assets']),'excludedOffCanvasObjects':len(report['excludedOffCanvas'])}
    jwrite(out/'20261011_paper_figure_slide04.figure.json',project);jwrite(detail/'conversion-manifest.json',report)
    print(json.dumps(report['summary']));print('source sha256:',sha(data));print('project:',out/'20261011_paper_figure_slide04.figure.json')

if __name__=='__main__':main()
