"""Synthetic native DrawingML gradients; no private presentation data."""
import unittest

from pptx_import import EMU, import_pptx
from test_pptx_import import HEADER, fixture, relations, slide, xfrm


def gradient(angle=0):
    return ('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000">'
            '<a:alpha val="50000"/></a:srgbClr></a:gs>'
            '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst>'
            f'<a:lin ang="{angle*60000}" scaled="1"/></a:gradFill>')


def shape(preset='line', width=200, height=0, attrs='', angle=0, ends='', style='', paint=None):
    paint = gradient(angle) if paint is None else paint
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Gradient {preset}"/></p:nvSpPr>'
            f'<p:spPr>{xfrm(40,50,width,height,attrs)}<a:prstGeom prst="{preset}"/>'
            f'<a:noFill/><a:ln w="{6*EMU}">{paint}<a:prstDash val="dash"/>{ends}</a:ln>'
            f'</p:spPr>{style}</p:sp>')


def converted(content, extra=None):
    return import_pptx({**fixture([slide(content)], extra), 'slide':1})


class GradientStrokeTests(unittest.TestCase):
    def test_zero_area_lines_and_gradient_only_outlines_remain_native(self):
        for preset, width, height, angle in [('line',200,0,0),('line',0,200,90),('rect',200,100,30),('triangle',200,100,30)]:
            with self.subTest(preset=preset,width=width):
                result=converted(shape(preset,width,height,angle=angle))
                self.assertEqual(len(result['items']),1)
                item=result['items'][0]
                self.assertEqual(item['fill'],'none')
                self.assertEqual(item['strokeWidth'],6)
                self.assertEqual(item['strokeDash'],'dash')
                self.assertEqual(item['strokeGradient']['stops'],[{'offset':0,'color':'#ff000080'},{'offset':1,'color':'#0000ff'}])
                self.assertAlmostEqual(item['strokeGradient']['angle'],0 if preset=='line' else angle)
                self.assertEqual(result['media'],[])

    def test_flipped_lines_and_head_only_arrows_do_not_double_reverse_paint(self):
        for attrs,ends,rotation,angle in [
            ('flipH="1"','',180,0),
            ('','<a:headEnd type="arrow"/>',180,180),
            ('flipH="1"','<a:headEnd type="arrow"/>',360,180),
        ]:
            item=converted(shape(attrs=attrs,ends=ends))['items'][0]
            self.assertEqual(item['rotation'],rotation)
            self.assertEqual(item['strokeGradient']['angle'],angle)

    def test_local_width_inherits_theme_gradient_and_explicit_no_fill_overrides(self):
        theme=f'<a:theme {HEADER}><a:themeElements><a:fmtScheme><a:lnStyleLst><a:ln w="12700">{gradient(45)}</a:ln></a:lnStyleLst></a:fmtScheme></a:themeElements></a:theme>'
        extra={'ppt/theme/theme1.xml':theme,'ppt/_rels/presentation.xml.rels':relations([('s0','slide','slides/slide1.xml',''),('t','theme','theme/theme1.xml','')])}
        style='<p:style><a:lnRef idx="1"><a:srgbClr val="123456"/></a:lnRef></p:style>'
        item=converted(shape('rect',200,100,style=style,paint=''),extra)['items'][0]
        self.assertEqual(item['strokeGradient']['angle'],45)
        self.assertEqual(item['strokeWidth'],6)
        self.assertEqual(converted(shape('rect',200,100,style=style,paint='<a:noFill/>'),extra)['items'],[])

    def test_nonlinear_gradient_reports_approximation_without_dropping_border(self):
        result=converted(shape(paint=gradient().replace('<a:lin ang="0" scaled="1"/>','<a:path path="circle"/>')))
        self.assertIn('strokeGradient',result['items'][0])
        self.assertTrue(any('Nonlinear border gradient' in warning for warning in result['warnings']))

    def test_unrepresented_gradient_coordinates_have_an_explicit_warning(self):
        for paint in [gradient().replace('<a:gradFill>','<a:gradFill rotWithShape="0">'),gradient().replace('scaled="1"','scaled="0"')]:
            result=converted(shape('rect',200,100,paint=paint))
            self.assertIn('strokeGradient',result['items'][0])
            self.assertTrue(any('direction is approximated' in warning for warning in result['warnings']))


if __name__=='__main__':
    unittest.main()
