"""Native DrawingML shadows stay editable and group alpha is composited once."""
import unittest
from pptx_import import import_pptx
from test_pptx_import import HEADER, fixture, slide, xfrm, relations, picture
from test_gradient_stroke import gradient

SHADOW = '<a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="2700000" sx="102000" sy="102000" algn="ctr" rotWithShape="0"><a:srgbClr val="123456"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>'
def rectangle(effects=SHADOW):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shadow rectangle"/></p:nvSpPr><p:spPr>{xfrm(10,20,100,80)}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill>{effects}</p:spPr></p:sp>'
def convert(content,extra=None):
    return import_pptx({**fixture([slide(content)],extra),'slide':1})

class NativeShadowTests(unittest.TestCase):
    def test_picture_gradient_border_and_shadow_remain_on_editable_picture(self):
        border='<a:ln w="38100">'+gradient(45)+'</a:ln>'
        item=convert(picture().replace('</p:spPr>',border+SHADOW+'</p:spPr>'))['items'][0]
        self.assertEqual(item['type'],'image')
        self.assertEqual(item['strokeWidth'],4)
        self.assertEqual(item['strokeGradient']['angle'],45)
        self.assertEqual(item['shadow']['blur'],5)

    def test_native_shape_exact_opacity_points_and_orientation(self):
        result=convert(rectangle());item=result['items'][0]
        self.assertEqual(item['type'],'rect')
        self.assertEqual(item['shadow'],{'enabled':True,'color':'#123456','transparency':60,'size':102,'blur':5,'angle':45,'distance':3,'alignment':'ctr','rotateWithShape':False})
        self.assertFalse(any('not retained' in w for w in result['warnings']))

    def test_explicit_empty_list_clears_inherited_theme_effect(self):
        theme=f'<a:theme {HEADER}><a:themeElements><a:fmtScheme><a:effectStyleLst><a:effectStyle>{SHADOW}</a:effectStyle></a:effectStyleLst></a:fmtScheme></a:themeElements></a:theme>'
        extra={'ppt/theme/theme1.xml':theme,'ppt/_rels/presentation.xml.rels':relations([('s0','slide','slides/slide1.xml',''),('t','theme','theme/theme1.xml','')])}
        def themed(effect):return rectangle(effect).replace('</p:sp>','<p:style><a:effectRef idx="1"><a:srgbClr val="FFFFFF"/></a:effectRef></p:style></p:sp>')
        self.assertIn('shadow',convert(themed(''),extra)['items'][0])
        self.assertNotIn('shadow',convert(themed('<a:effectLst/>'),extra)['items'][0])

    def test_hidden_old_shadow_does_not_apply(self):
        item=convert(rectangle('<a:extLst><a:ext><a:hiddenEffects>'+SHADOW+'</a:hiddenEffects></a:ext></a:extLst>'))['items'][0]
        self.assertNotIn('shadow',item)

    def test_group_keeps_child_and_group_effects_separate(self):
        xf='<a:xfrm rot="1800000"><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1905000"/><a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="1905000"/></a:xfrm>'
        group=f'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="Group"/></p:nvGrpSpPr><p:grpSpPr>{xf}{SHADOW}</p:grpSpPr>{rectangle()}</p:grpSp>'
        item=convert(group)['items'][0]
        self.assertEqual(item['type'],'shadowGroup');self.assertAlmostEqual(item['rotation'],30)
        self.assertEqual(len(item['items']),1)
        self.assertAlmostEqual(item['items'][0]['shadow']['angle'],15)
        self.assertEqual(item['shadow']['angle'],45)

    def test_visible_text_run_keeps_shadow(self):
        tx=f'<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200">{SHADOW}</a:rPr><a:t>Label</a:t></a:r></a:p></p:txBody>'
        item=convert(rectangle('').replace('</p:sp>',tx+'</p:sp>'))['items'][-1]
        self.assertEqual(item['type'],'textBlock')
        self.assertEqual(item['paragraphs'][0]['runs'][0]['shadow']['blur'],5)

if __name__=='__main__':unittest.main()
