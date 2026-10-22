"""Editable fill gradients imported from synthetic native DrawingML."""
import unittest

from pptx_import import import_pptx
from test_pptx_import import HEADER, fixture, relations, slide, text_shape, xfrm
from test_gradient_stroke import shape as stroked_shape


STOPS = ('<a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000">'
         '<a:alpha val="50000"/></a:srgbClr></a:gs>'
         '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst>')


def gradient(direction='<a:lin ang="1800000" scaled="1"/>', attrs='', stops=STOPS):
    return f'<a:gradFill {attrs}>{stops}{direction}</a:gradFill>'


def radial(center=(.5,.5), attrs='', stops=STOPS):
    x,y = center
    rect = f'<a:fillToRect l="{round(x*100000)}" t="{round(y*100000)}" r="{round((1-x)*100000)}" b="{round((1-y)*100000)}"/>'
    return gradient(f'<a:path path="circle">{rect}</a:path><a:tileRect/>',attrs,stops)


def shape(paint, attrs='', style=''):
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Gradient shape"/></p:nvSpPr>'
            f'<p:spPr>{xfrm(40,50,200,100,attrs)}<a:prstGeom prst="rect"/>'
            f'{paint}<a:ln><a:noFill/></a:ln></p:spPr>{style}</p:sp>')


def converted(content, extra=None):
    return import_pptx({**fixture([slide(content)],extra),'slide':1})


class GradientFillTests(unittest.TestCase):
    def test_legacy_linear_fill_keeps_its_existing_schema_and_alpha(self):
        result = converted(shape(gradient()))
        self.assertEqual(result['items'][0]['fillGradient'],{
            'angle':30,'stops':[{'offset':0,'color':'#ff000080'},{'offset':1,'color':'#0000ff'}]})
        self.assertFalse(any('gradient' in warning.lower() for warning in result['warnings']))

    def test_radial_fill_stays_an_editable_vector_with_its_focus_and_alpha(self):
        for center in ((.5,.5),(0,0),(1,1),(.25,.8)):
            with self.subTest(center=center):
                result = converted(shape(radial(center)))
                item = result['items'][0]
                self.assertEqual(item['type'],'shape')
                self.assertTrue(item['paths'])
                self.assertEqual(item['fillGradient']['type'],'radial')
                self.assertAlmostEqual(item['fillGradient']['center']['x'],center[0])
                self.assertAlmostEqual(item['fillGradient']['center']['y'],center[1])
                self.assertEqual(item['fillGradient']['stops'][0]['color'],'#ff000080')
                self.assertEqual(result['media'],[])
                self.assertFalse(any('gradient' in warning.lower() for warning in result['warnings']))

    def test_fixed_orientation_and_shape_flips_survive_import(self):
        radial_result = converted(shape(radial((.25,.8),'rotWithShape="0"'),'rot="2400000" flipH="1" flipV="1"'))
        item = radial_result['items'][0]
        self.assertEqual(item['rotation'],40)
        self.assertFalse(item['fillGradient']['rotateWithShape'])
        self.assertAlmostEqual(item['fillGradient']['center']['x'],.75)
        self.assertAlmostEqual(item['fillGradient']['center']['y'],.2)
        self.assertFalse(any('gradient' in warning.lower() for warning in radial_result['warnings']))
        linear_result = converted(shape(gradient(attrs='rotWithShape="false"'),'flipH="1"'))
        self.assertFalse(linear_result['items'][0]['fillGradient']['rotateWithShape'])
        self.assertEqual(linear_result['items'][0]['fillGradient']['angle'],150)

    def test_standard_brightness_transforms_remain_editable_without_double_application(self):
        cases = [('<a:lumMod val="64000"/><a:lumOff val="36000"/>',36),
                 ('<a:lumMod val="25000"/>',-75),
                 ('<a:lumMod val="0"/><a:lumOff val="100000"/>',100),
                 ('<a:lumMod val="0"/>',-100)]
        for transforms,brightness in cases:
            with self.subTest(brightness=brightness):
                stops = STOPS.replace('<a:alpha val="50000"/>',transforms+'<a:alpha val="50000"/>')
                stop = converted(shape(radial(stops=stops)))['items'][0]['fillGradient']['stops'][0]
                self.assertEqual(stop,{'offset':0,'color':'#ff000080','brightness':brightness})

    def test_non_brightness_color_transforms_are_baked_once(self):
        # A non-complementary lumMod/lumOff pair cannot be represented by the
        # single brightness control and must retain its resolved appearance.
        stops = STOPS.replace('<a:alpha val="50000"/>','<a:lumMod val="50000"/><a:lumOff val="20000"/><a:alpha val="50000"/>')
        stop = converted(shape(radial(stops=stops)))['items'][0]['fillGradient']['stops'][0]
        self.assertEqual(stop,{'offset':0,'color':'#b2333380'})

    def test_theme_radial_fill_inherits_and_explicit_no_fill_overrides(self):
        theme = f'<a:theme {HEADER}><a:themeElements><a:fmtScheme><a:fillStyleLst>{radial((1,0))}</a:fillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
        extra = {'ppt/theme/theme1.xml':theme,'ppt/_rels/presentation.xml.rels':relations([('s0','slide','slides/slide1.xml',''),('t','theme','theme/theme1.xml','')])}
        style = '<p:style><a:fillRef idx="1"><a:srgbClr val="123456"/></a:fillRef></p:style>'
        item = converted(shape('',style=style),extra)['items'][0]
        self.assertEqual(item['fillGradient']['center'],{'x':1,'y':0})
        self.assertEqual(converted(shape('<a:noFill/>',style=style),extra)['items'],[])

    def test_radial_focus_region_and_out_of_bounds_center_report_approximations(self):
        region = gradient('<a:path path="circle"><a:fillToRect l="10000" t="20000" r="30000" b="40000"/></a:path>')
        result = converted(shape(region))
        self.assertAlmostEqual(result['items'][0]['fillGradient']['center']['x'],.4)
        self.assertAlmostEqual(result['items'][0]['fillGradient']['center']['y'],.4)
        self.assertTrue(any('focus rectangle is approximated' in warning for warning in result['warnings']))
        outside = converted(shape(radial((1.2,-.4))))
        self.assertEqual(outside['items'][0]['fillGradient']['center'],{'x':1,'y':0})
        self.assertTrue(any('center is clamped' in warning for warning in outside['warnings']))

    def test_other_path_types_and_unscaled_linear_fill_keep_visible_approximation_warnings(self):
        for direction,warning in [('<a:path path="rect"/>','Nonlinear gradient'),
                                  ('<a:path path="shape"/>','Nonlinear gradient'),
                                  ('<a:lin ang="1800000" scaled="0"/>','Unscaled fill gradient')]:
            with self.subTest(direction=direction):
                result = converted(shape(gradient(direction)))
                self.assertIn('fillGradient',result['items'][0])
                self.assertTrue(any(warning in message for message in result['warnings']))

    def test_invalid_gradient_stop_count_preserves_editable_text(self):
        stops = '<a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst>'
        content = text_shape(geometry=xfrm()+'<a:prstGeom prst="rect"/>'+radial(stops=stops))
        result = converted(content)
        self.assertEqual([item['type'] for item in result['items']],['textBlock'])
        self.assertTrue(any('gradient was omitted' in warning for warning in result['warnings']))


class GradientStrokeAdvancedTests(unittest.TestCase):
    def test_radial_border_retains_center_brightness_alpha_and_fixed_orientation(self):
        stops = STOPS.replace('<a:alpha val="50000"/>','<a:alpha val="50000"/><a:lumMod val="64000"/><a:lumOff val="36000"/>')
        result = converted(stroked_shape('rect',200,100,attrs='rot="2400000" flipH="1"',paint=radial((.25,.8),'rotWithShape="0"',stops)))
        paint = result['items'][0]['strokeGradient']
        self.assertEqual(paint['type'],'radial')
        self.assertEqual(paint['center'],{'x':.75,'y':.8})
        self.assertFalse(paint['rotateWithShape'])
        self.assertEqual(paint['stops'][0],{'offset':0,'color':'#ff000080','brightness':36})
        self.assertFalse(any('gradient' in warning.lower() for warning in result['warnings']))

    def test_linear_border_keeps_negative_brightness_and_fixed_slide_angle(self):
        stops = STOPS.replace('<a:alpha val="50000"/>','<a:lumMod val="25000"/><a:alpha val="50000"/>')
        result = converted(stroked_shape('line',200,0,attrs='rot="5400000"',paint=gradient(attrs='rotWithShape="0"',stops=stops)))
        paint = result['items'][0]['strokeGradient']
        self.assertEqual(paint['angle'],30)
        self.assertFalse(paint['rotateWithShape'])
        self.assertEqual(paint['stops'][0],{'offset':0,'color':'#ff000080','brightness':-75})

    def test_radial_line_focus_follows_normalized_vertical_flipped_and_head_only_geometry(self):
        for width,height,attrs,ends,center in [
            (0,200,'','',(.8,.75)),
            (200,0,'flipH="1"','',(.25,.2)),
            (200,0,'','<a:headEnd type="arrow"/>',(.75,.2)),
        ]:
            with self.subTest(width=width,attrs=attrs,ends=ends):
                result = converted(stroked_shape('line',width,height,attrs=attrs,ends=ends,paint=radial((.25,.8))))
                paint = result['items'][0]['strokeGradient']
                self.assertAlmostEqual(paint['center']['x'],center[0])
                self.assertAlmostEqual(paint['center']['y'],center[1])
                self.assertFalse(any('gradient' in warning.lower() for warning in result['warnings']))

    def test_unsupported_border_coordinates_keep_approximation_warnings(self):
        cases = [
            (stroked_shape('rect',200,100,paint=gradient('<a:path path="rect"/>')),'Nonlinear border gradient'),
            (stroked_shape('rect',200,100,paint=gradient('<a:lin ang="1800000" scaled="0"/>')),'Unscaled border gradient'),
            (stroked_shape('line',200,100,paint=radial()),'Diagonal line border gradient'),
            (stroked_shape('line',0,200,paint=gradient(attrs='rotWithShape="0"')),'Fixed-orientation border gradient coordinates'),
        ]
        for content,warning in cases:
            with self.subTest(warning=warning):
                result = converted(content)
                self.assertIn('strokeGradient',result['items'][0])
                self.assertTrue(any(warning in message for message in result['warnings']))

    def test_invalid_border_stops_use_visible_first_color(self):
        stops = '<a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst>'
        result = converted(stroked_shape('rect',200,100,paint=radial(stops=stops)))
        self.assertNotIn('strokeGradient',result['items'][0])
        self.assertEqual(result['items'][0]['stroke'],'#ff0000')
        self.assertTrue(any('Unsupported border gradient stops' in warning for warning in result['warnings']))


if __name__ == '__main__':
    unittest.main()
