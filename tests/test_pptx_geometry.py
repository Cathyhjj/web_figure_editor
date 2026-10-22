"""Geometry tests use synthetic OOXML; no private presentation is embedded."""
import hashlib
import math
from pathlib import Path
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import pptx_geometry as geometry
from pptx_geometry import geometry_paths


NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def preset(name, adjustments=''):
    return ET.fromstring(f'<a:prstGeom xmlns:a="{NAMESPACE}" prst="{name}"><a:avLst>{adjustments}</a:avLst></a:prstGeom>')


def custom(commands, guides='', adjustments='', dimensions='', path_style=''):
    return ET.fromstring(
        f'<a:custGeom xmlns:a="{NAMESPACE}"><a:avLst>{adjustments}</a:avLst>'
        f'<a:gdLst>{guides}</a:gdLst><a:pathLst><a:path {dimensions} {path_style}>'
        f'{commands}</a:path></a:pathLst></a:custGeom>')


def move(x, y):
    return f'<a:moveTo><a:pt x="{x}" y="{y}"/></a:moveTo>'


def line(x, y):
    return f'<a:lnTo><a:pt x="{x}" y="{y}"/></a:lnTo>'


def cubic_value(command, start, t):
    return tuple((1-t)**3 * start[axis] + 3*(1-t)**2*t*command[1+axis]
                 + 3*(1-t)*t*t*command[3+axis] + t**3*command[5+axis]
                 for axis in (0, 1))


class PresetGeometryTests(unittest.TestCase):
    def test_pinned_resource_checksum(self):
        resource = Path(geometry.__file__).with_name('resources') / 'presetShapeDefinitions.xml'
        self.assertEqual(hashlib.sha256(resource.read_bytes()).hexdigest(),
                         '4a762444d8d85876881c02a5b1dedf6f73006fcd8acb7b4e393435615b37c780')

    def test_down_arrow_dimensions_and_adjustments(self):
        paths = geometry_paths(preset('downArrow'), 80, 120)
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0]['fillMode'], 'norm')
        self.assertTrue(paths[0]['stroke'])
        self.assertEqual(paths[0]['commands'], [
            ['M', 0, 2/3], ['L', .25, 2/3], ['L', .25, 0], ['L', .75, 0],
            ['L', .75, 2/3], ['L', 1, 2/3], ['L', .5, 1], ['Z'],
        ])
        adjusted = geometry_paths(preset('downArrow',
            '<a:gd name="adj1" fmla="val 20000"/><a:gd name="adj2" fmla="val 25000"/>'), 80, 120)[0]
        self.assertEqual(adjusted['commands'][1], ['L', .4, 5/6])
        self.assertEqual(adjusted['commands'][3], ['L', .6, 0])

    def test_curved_down_arrow_has_three_faithful_layers(self):
        # Same non-square extents as the captured Mac PowerPoint arrows.
        width, height = 872540, 533481
        paths = geometry_paths(preset('curvedDownArrow'), width, height)
        self.assertEqual([(path['fillMode'], path['stroke']) for path in paths],
                         [('norm', False), ('darkenLess', False), ('none', True)])
        for path in paths:
            self.assertTrue(any(command[0] == 'C' for command in path['commands']))
            for command in path['commands']:
                self.assertTrue(all(math.isfinite(value) for value in command[1:]))
        # The tip is w - (min(w,h) / 2) / 2, at the lower edge.
        self.assertEqual(paths[0]['commands'][0], ['M', 1 - height / (4 * width), 1])
        # The back fold touches the left/lower corner, not a generic U-arrow.
        self.assertIn(['L', 0, 1], paths[1]['commands'])
        self.assertEqual(paths[0]['commands'][-1], ['Z'])
        self.assertEqual(paths[1]['commands'][-1], ['Z'])
        self.assertNotEqual(paths[0]['commands'], paths[1]['commands'])

    def test_default_preset_coverage_for_multiple_aspect_ratios(self):
        rejected = {'circularArrow', 'leftCircularArrow', 'leftRightCircularArrow'}
        self.assertEqual(len(geometry._presets()), 187)
        for dimensions in ((100, 100), (872540, 533481), (300, 50), (50, 300)):
            for name in geometry._presets():
                with self.subTest(name=name, dimensions=dimensions):
                    if name in rejected:
                        with self.assertRaisesRegex(ValueError, 'formula'):
                            geometry_paths(preset(name), *dimensions)
                    else:
                        result = geometry_paths(preset(name), *dimensions)
                        self.assertTrue(result)
                        self.assertLess(sum(len(path['commands']) for path in result), 500)

    def test_results_and_adjustments_are_independent(self):
        first = geometry_paths(preset('downArrow'), 100, 100)
        first[0]['commands'][0][1] = 1000
        second = geometry_paths(preset('downArrow'), 100, 100)
        self.assertEqual(second[0]['commands'][0], ['M', 0, .5])
        geometry_paths(preset('downArrow', '<a:gd name="adj1" fmla="val 0"/>'), 100, 100)
        self.assertEqual(geometry_paths(preset('downArrow'), 100, 100), second)
        self.assertEqual(geometry_paths(preset('rect'), .00001, .00002)[0]['commands'][2], ['L', 1, 1])


class CustomGeometryTests(unittest.TestCase):
    def test_path_dimensions_guides_and_quadratic_to_cubic(self):
        element = custom(move('x', 0) + '<a:quadBezTo><a:pt x="50" y="100"/><a:pt x="100" y="0"/></a:quadBezTo>'
                         + '<a:cubicBezTo><a:pt x="90" y="20"/><a:pt x="20" y="90"/><a:pt x="0" y="100"/></a:cubicBezTo><a:close/>',
                         guides='<a:gd name="x" fmla="*/ w 0 1"/>', dimensions='w="100" h="100"',
                         path_style='fill="lightenLess" stroke="0"')
        path = geometry_paths(element, 500, 800)[0]
        self.assertEqual(path['commands'][0], ['M', 0, 0])
        quadratic = path['commands'][1]
        self.assertEqual(quadratic[0], 'C')
        self.assertAlmostEqual(quadratic[1], 1/3)
        self.assertAlmostEqual(quadratic[2], 2/3)
        self.assertAlmostEqual(quadratic[3], 2/3)
        self.assertAlmostEqual(quadratic[4], 2/3)
        self.assertEqual(quadratic[5:], [1, 0])
        self.assertEqual(path['commands'][2], ['C', .9, .2, .2, .9, 0, 1])
        self.assertEqual(path['commands'][-1], ['Z'])
        self.assertEqual((path['fillMode'], path['stroke']), ('lightenLess', False))

    def test_non_circular_arc_uses_polar_angles(self):
        # Polar 45deg on a 2:1 ellipse meets the ellipse at equal x,y.
        coordinate = math.sqrt(8000)
        element = custom(move(coordinate, coordinate)
                         + '<a:arcTo wR="200" hR="100" stAng="2700000" swAng="5400000"/>',
                         dimensions='w="400" h="200"')
        path = geometry_paths(element, 400, 200)[0]['commands']
        end = path[-1][-2:]
        self.assertAlmostEqual(end[0], -coordinate / 400)
        self.assertAlmostEqual(end[1], coordinate / 200)
        # Every sampled cubic lies near x²/200² + y²/100² = 1.
        start = path[0][1:]
        for command in path[1:]:
            for t in (.25, .5, .75):
                x, y = cubic_value(command, start, t)
                self.assertAlmostEqual((x * 2)**2 + (y * 2)**2, 1, delta=.001)
            start = command[-2:]

    def test_full_circle_and_negative_arc(self):
        for sweep, expected_y in ((21600000, 0), (-10800000, 0)):
            with self.subTest(sweep=sweep):
                element = custom(move(200, 0) + f'<a:arcTo wR="200" hR="100" stAng="0" swAng="{sweep}"/>',
                                 dimensions='w="200" h="100"')
                commands = geometry_paths(element, 200, 100)[0]['commands']
                self.assertEqual(len(commands), 5 if sweep > 0 else 3)
                self.assertAlmostEqual(commands[-1][-2], 1 if sweep > 0 else -1)
                self.assertAlmostEqual(commands[-1][-1], expected_y)
                if sweep < 0:
                    self.assertLess(commands[1][2], 0)

    def test_all_supported_guide_operators(self):
        formula_expected = {
            'val 5': 5, 'abs -5': 5, 'sqrt 81': 9, 'at2 0 1': 5400000,
            'cos 2 10800000': -2, 'sin 2 5400000': 2, 'tan 2 2700000': 2,
            'max 3 4': 4, 'min 3 4': 3, '*/ 4 6 2': 12, '+- 4 6 2': 8,
            '+/ 4 6 2': 5, '?: -1 8 9': 9, '?: 1 8 9': 8,
            'cat2 5 3 4': 3, 'sat2 5 3 4': 4, 'mod 3 4 12': 13,
            'pin 1 9 5': 5, 'pin 1 -9 5': 1,
        }
        for formula, expected in formula_expected.items():
            with self.subTest(formula=formula):
                element = custom(move(0, 0) + line('value', 1),
                    guides=f'<a:gd name="value" fmla="{formula}"/>', dimensions='w="10000000" h="1"')
                actual = geometry_paths(element, 100, 100)[0]['commands'][-1][1] * 10000000
                self.assertAlmostEqual(actual, expected)


class InvalidGeometryTests(unittest.TestCase):
    def test_invalid_dimensions_and_presets(self):
        for dimensions in ((0, 100), (100, -1), (math.inf, 100), (math.nan, 100), (True, 100), ('100', 100), (10**400, 100)):
            with self.subTest(dimensions=dimensions), self.assertRaises(ValueError):
                geometry_paths(preset('rect'), *dimensions)
        for element in (preset('notARealShape'), ET.fromstring('<prstGeom prst="rect"/>'), None):
            with self.subTest(element=element), self.assertRaises(ValueError):
                geometry_paths(element, 100, 100)

    def test_invalid_guides_and_adjustments(self):
        for formula in ('exec 1', 'val', '+- 1 2 3 0', '*/ 1 2 0', 'sqrt -1', 'val missing', 'val 1e100', 'val NaN'):
            with self.subTest(formula=formula), self.assertRaises(ValueError):
                geometry_paths(custom(move(0, 0) + line('q', 1),
                    guides=f'<a:gd name="q" fmla="{formula}"/>'), 100, 100)
        for adjustments in ('<a:gd name="unknown" fmla="val 1"/>',
            '<a:gd name="adj1" fmla="val 1"/><a:gd name="adj1" fmla="val 2"/>'):
            with self.subTest(adjustments=adjustments), self.assertRaises(ValueError):
                geometry_paths(preset('downArrow', adjustments), 100, 100)

    def test_invalid_paths_and_degenerate_geometry(self):
        fragments = (
            '', move(0, 0), move(0, 0) + line(0, 0), line(1, 1), move(0, 0) + '<a:unknown/>',
            move(0, 0) + '<a:lnTo><a:pt x="1" y="1"/><a:pt x="2" y="2"/></a:lnTo>',
            move(0, 0) + '<a:arcTo wR="0" hR="10" stAng="0" swAng="5400000"/>',
            move(0, 0) + '<a:arcTo wR="10" hR="10" stAng="0" swAng="21600001"/>',
            move(0, 0) + line(10000001, 1),
        )
        for commands in fragments:
            with self.subTest(commands=commands), self.assertRaises(ValueError):
                geometry_paths(custom(commands, dimensions='w="1" h="1"'), 100, 100)
        for style in ('stroke="maybe"', 'fill="url(evil)"'):
            with self.subTest(style=style), self.assertRaises(ValueError):
                geometry_paths(custom(move(0, 0) + line(1, 1), path_style=style), 100, 100)
        with self.assertRaises(ValueError):
            geometry_paths(custom(move(0, 0) + line(1, 1), dimensions='w="0"'), 100, 100)

    def test_budgets_are_applied_before_unbounded_output(self):
        ordinary = custom(move(0, 0) + line(1, 1) * 4)
        with patch.object(geometry, 'MAX_COMMANDS', 4), self.assertRaisesRegex(ValueError, 'commands'):
            geometry_paths(ordinary, 100, 100)
        guides = custom(move(0, 0) + line(1, 1),
                        guides=''.join(f'<a:gd name="q{i}" fmla="val 1"/>' for i in range(5)))
        with patch.object(geometry, 'MAX_GUIDES', 4), self.assertRaisesRegex(ValueError, 'guides'):
            geometry_paths(guides, 100, 100)
        with patch.object(geometry, 'MAX_ELEMENTS', 3), self.assertRaisesRegex(ValueError, 'XML elements'):
            geometry_paths(ordinary, 100, 100)
        with patch.object(geometry, 'MAX_PATHS', 2), self.assertRaisesRegex(ValueError, 'paths'):
            geometry_paths(preset('curvedDownArrow'), 100, 100)


if __name__ == '__main__':
    unittest.main()
