"""Build the offline insertion gallery from the pinned DrawingML definitions.

Run: python3 scripts/build_shape_catalog.py [--check]
See resources/NOTICE-preset-shapes.txt for upstream provenance and license.
"""
import copy
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pptx_geometry import NS, _presets, geometry_paths


GROUPS = [
    ('Lines', [
        ('line', 'Line'), ('arrow', 'Arrow'), ('doubleArrow', 'Double arrow'),
        ('bentConnector3', 'Elbow connector'), ('elbowArrow', 'Elbow arrow connector'),
        ('elbowDoubleArrow', 'Elbow double-arrow connector'),
        ('curvedConnector3', 'Curved connector'), ('curvedArrow', 'Curved arrow connector'),
        ('curvedDoubleArrow', 'Curved double-arrow connector'),
        ('curve', 'Curve'), ('freeform', 'Freeform'), ('scribble', 'Scribble'),
    ]),
    ('Rectangles', [
        ('rect', 'Rectangle'), ('roundRect', 'Rounded rectangle'),
        ('snip1Rect', 'Single corner snipped rectangle'),
        ('snip2SameRect', 'Same side corners snipped rectangle'),
        ('snip2DiagRect', 'Diagonal corners snipped rectangle'),
        ('snipRoundRect', 'Snipped and rounded rectangle'),
        ('round1Rect', 'Single corner rounded rectangle'),
        ('round2SameRect', 'Same side corners rounded rectangle'),
        ('round2DiagRect', 'Diagonal corners rounded rectangle'),
    ]),
    ('Basic Shapes', [
        ('textBox', 'Text box'), ('circle', 'Circle'), ('ellipse', 'Ellipse'),
        ('triangle', 'Triangle'), ('rtTriangle', 'Right triangle'),
        ('parallelogram', 'Parallelogram'), ('trapezoid', 'Trapezoid'),
        ('diamond', 'Diamond'), ('pentagon', 'Pentagon'), ('hexagon', 'Hexagon'),
        ('heptagon', 'Heptagon'), ('octagon', 'Octagon'), ('decagon', 'Decagon'),
        ('dodecagon', 'Dodecagon'), ('pie', 'Pie'), ('chord', 'Chord'),
        ('teardrop', 'Teardrop'), ('frame', 'Frame'), ('halfFrame', 'Half frame'),
        ('corner', 'L shape'), ('diagStripe', 'Diagonal stripe'), ('plus', 'Cross'),
        ('plaque', 'Plaque'), ('can', 'Cylinder'), ('cube', 'Cube'),
        ('bevel', 'Bevel'), ('donut', 'Donut'), ('noSmoking', 'No symbol'),
        ('blockArc', 'Block arc'), ('foldedCorner', 'Folded corner'),
        ('smileyFace', 'Smiley face'), ('heart', 'Heart'),
        ('lightningBolt', 'Lightning bolt'), ('sun', 'Sun'), ('moon', 'Moon'),
        ('cloud', 'Cloud'), ('arc', 'Arc'), ('bracketPair', 'Double bracket'),
        ('bracePair', 'Double brace'), ('leftBracket', 'Left bracket'),
        ('rightBracket', 'Right bracket'), ('leftBrace', 'Left brace'),
        ('rightBrace', 'Right brace'), ('star5', 'Five-point star'),
    ]),
    ('Block Arrows', [
        ('rightArrow', 'Right arrow'), ('leftArrow', 'Left arrow'),
        ('upArrow', 'Up arrow'), ('downArrow', 'Down arrow'),
        ('leftRightArrow', 'Left-right arrow'), ('upDownArrow', 'Up-down arrow'),
        ('quadArrow', 'Quad arrow'), ('leftRightUpArrow', 'Left-right-up arrow'),
        ('bentArrow', 'Bent arrow'), ('uturnArrow', 'U-turn arrow'),
        ('leftUpArrow', 'Left-up arrow'), ('bentUpArrow', 'Bent-up arrow'),
        ('curvedRightArrow', 'Curved right arrow'), ('curvedLeftArrow', 'Curved left arrow'),
        ('curvedUpArrow', 'Curved up arrow'), ('curvedDownArrow', 'Curved down arrow'),
        ('stripedRightArrow', 'Striped right arrow'), ('notchedRightArrow', 'Notched right arrow'),
        ('homePlate', 'Pentagon arrow'), ('chevron', 'Chevron'),
        ('rightArrowCallout', 'Right arrow callout'), ('leftArrowCallout', 'Left arrow callout'),
        ('upArrowCallout', 'Up arrow callout'), ('downArrowCallout', 'Down arrow callout'),
        ('leftRightArrowCallout', 'Left-right arrow callout'),
        ('upDownArrowCallout', 'Up-down arrow callout'), ('quadArrowCallout', 'Quad arrow callout'),
        ('circularArrow', 'Circular arrow'), ('leftCircularArrow', 'Left circular arrow'),
        ('leftRightCircularArrow', 'Left-right circular arrow'), ('swooshArrow', 'Swoosh arrow'),
    ]),
]
SPECIAL = {'line', 'arrow', 'doubleArrow', 'rect', 'roundRect', 'circle', 'ellipse',
           'textBox', 'curve', 'freeform', 'scribble', 'elbowArrow', 'elbowDoubleArrow',
           'curvedArrow', 'curvedDoubleArrow'}
OUTLINES = {'arc', 'bracketPair', 'bracePair', 'leftBracket', 'rightBracket',
            'leftBrace', 'rightBrace', 'bentConnector3', 'curvedConnector3'}


def preset_paths(name, width, height):
    if name in {'circularArrow', 'leftCircularArrow', 'leftRightCircularArrow'}:
        # The pinned POI resource has eight surplus-operand formulas in these
        # three definitions. Correct only this exact known typo on a copy;
        # keep the resource checksum and uploaded-geometry parser unchanged.
        definition = copy.deepcopy(_presets()[name])
        definition.tag = NS + 'custGeom'
        for guide in definition.findall('.//' + NS + 'gd'):
            formula = guide.get('fmla', '')
            if formula in {'+- xH 0 dxB 0', '+- yH 0 dyB 0',
                           '+- xI 0 dxJ 0', '+- yI 0 dyJ 0'}:
                guide.set('fmla', formula[:-2])
        return geometry_paths(definition, width, height)
    element = ET.Element(NS + 'prstGeom', prst=name)
    ET.SubElement(element, NS + 'avLst')
    return geometry_paths(element, width, height)


def build():
    groups, geometry = [], {}
    for label, entries in GROUPS:
        shapes = []
        for key, name in entries:
            width, height = (160, 100) if label == 'Rectangles' else (140, 140)
            if label == 'Lines': width, height = 160, 100
            if key in {'rightArrow', 'leftArrow', 'leftRightArrow', 'homePlate', 'chevron',
                       'stripedRightArrow', 'notchedRightArrow', 'swooshArrow'}:
                width, height = 180, 100
            if key in {'upArrow', 'downArrow', 'upDownArrow'}: width, height = 100, 180
            if key in {'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace'}: width, height = 40, 140
            if key == 'ellipse': width, height = 160, 100
            shapes.append({'id': key, 'name': name, 'width': width, 'height': height,
                           **({'outline': True} if key in OUTLINES else {})})
            if key not in SPECIAL:
                paths = preset_paths(key, width, height)
                for path in paths:
                    path['commands'] = [[cmd[0], *[round(n, 9) or 0 for n in cmd[1:]]] for cmd in path['commands']]
                geometry[key] = paths
        groups.append({'name': label, 'shapes': shapes})
    compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return ('// Generated by scripts/build_shape_catalog.py; do not edit by hand.\n'
            '// Derived from Apache POI DrawingML definitions; see resources/NOTICE-preset-shapes.txt.\n'
            'export const SHAPE_CATEGORIES = ' + json.dumps(groups, indent=2) + ';\n'
            'export const PRESET_PATHS = {\n' + ',\n'.join(
                '  ' + compact(key) + ':' + compact(value) for key, value in geometry.items()) + '\n};\n')


if __name__ == '__main__':
    target = Path(__file__).resolve().parents[1] / 'shape-presets.js'
    content = build()
    if '--check' in sys.argv:
        if not target.exists() or target.read_text() != content:
            sys.exit('shape-presets.js is stale; run python3 scripts/build_shape_catalog.py')
        print('Shape catalog matches the pinned DrawingML source.')
    else:
        target.write_text(content)
        print(f'Wrote {target.name}')
