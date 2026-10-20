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


if __name__=='__main__':unittest.main()
