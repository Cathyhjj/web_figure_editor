"""Native PPTX soft edges preserve editable points and inherited effects."""
import unittest
from test_native_shadow import convert, rectangle, SHADOW
from test_pptx_import import HEADER, relations, picture

SOFT = '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>'

class SoftEdgeTests(unittest.TestCase):
    def test_pictures_shapes_and_combined_shadow(self):
        for content in (picture().replace('</p:spPr>',SOFT+'</p:spPr>'), rectangle(SOFT), rectangle(SHADOW.replace('</a:effectLst>','<a:softEdge rad="63500"/></a:effectLst>'))):
            result=convert(content)
            self.assertEqual(result['items'][0]['softEdge'],5)
            self.assertFalse(any('not retained' in w for w in result['warnings']))
        self.assertEqual(convert(rectangle(SHADOW.replace('</a:effectLst>','<a:softEdge rad="63500"/></a:effectLst>')))['items'][0]['shadow']['blur'],5)

    def test_theme_empty_override_and_clamping(self):
        theme=f'<a:theme {HEADER}><a:themeElements><a:fmtScheme><a:effectStyleLst><a:effectStyle>{SOFT}</a:effectStyle></a:effectStyleLst></a:fmtScheme></a:themeElements></a:theme>'
        extra={'ppt/theme/theme1.xml':theme,'ppt/_rels/presentation.xml.rels':relations([('s0','slide','slides/slide1.xml',''),('t','theme','theme/theme1.xml','')])}
        def themed(effect):return rectangle(effect).replace('</p:sp>','<p:style><a:effectRef idx="1"/></p:style></p:sp>')
        self.assertEqual(convert(themed(''),extra)['items'][0]['softEdge'],5)
        self.assertEqual(convert(themed('<a:effectLst/>'),extra)['items'][0]['softEdge'],0)
        result=convert(rectangle(SOFT.replace('63500','2540000')))
        self.assertEqual(result['items'][0]['softEdge'],100)
        self.assertTrue(any('clamped' in w for w in result['warnings']))

    def test_text_run_and_shape_effects_survive(self):
        tx=f'<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200">{SOFT}</a:rPr><a:t>Label</a:t></a:r></a:p></p:txBody>'
        block=convert(rectangle('').replace('</p:sp>',tx+'</p:sp>'))['items'][-1]
        self.assertEqual(block['paragraphs'][0]['runs'][0]['softEdge'],5)
        items=convert(rectangle(SOFT).replace('</p:sp>',tx+'</p:sp>'))['items']
        self.assertTrue(all(i['softEdge']==5 for i in items))

    def test_group_soft_edges_apply_once_to_composited_children(self):
        xf='<a:xfrm><a:off x="0" y="0"/><a:ext cx="3810000" cy="3810000"/><a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="1905000"/></a:xfrm>'
        group=f'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="Group"/></p:nvGrpSpPr><p:grpSpPr>{xf}{SOFT}</p:grpSpPr>{rectangle(SOFT)}</p:grpSp>'
        item=convert(group)['items'][0]
        self.assertEqual(item['type'],'shadowGroup')
        self.assertEqual(item['softEdge'],5)
        self.assertEqual(item['items'][0]['softEdge'],10)
        self.assertNotIn('shadow',item)

if __name__=='__main__':unittest.main()
