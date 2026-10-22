"""Bounded DrawingML preset/custom geometry, returned as editable vector paths.

Coordinates are normalized to the source shape's width/height. Only numeric
M/L/C/Z commands leave this module; no supplied XML or expression is executable.
Preset data comes from Apache POI; see resources/NOTICE-preset-shapes.txt.
"""

from functools import lru_cache
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET


NS = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
MAX_GUIDES = 1024
MAX_PATHS = 32
MAX_COMMANDS = 2048
MAX_ELEMENTS = 16000
MAX_COORDINATE = 100
MAX_NUMBER = 1e24
FILL_MODES = frozenset(('norm', 'none', 'darken', 'darkenLess', 'lighten', 'lightenLess'))
_NUMBER = re.compile(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)\Z')
_NAME = re.compile(r'[A-Za-z0-9_]{1,64}\Z')
_RESOURCE = Path(__file__).with_name('resources') / 'presetShapeDefinitions.xml'


def _tag(element):
    if not isinstance(element.tag, str) or not element.tag.startswith(NS):
        raise ValueError('Invalid DrawingML geometry namespace.')
    return element.tag[len(NS):]


def _finite(value):
    if not math.isfinite(value) or abs(value) > MAX_NUMBER:
        raise ValueError('DrawingML geometry exceeds the numeric limit.')
    return value


def _divide(numerator, denominator):
    if denominator == 0:
        raise ValueError('DrawingML geometry divides by zero.')
    return _finite(numerator / denominator)


def _sqrt(value):
    if value < 0:
        raise ValueError('DrawingML geometry has a negative square root.')
    return math.sqrt(value)


def _children(parent, name):
    if parent is None:
        return []
    if any(_tag(child) != name for child in parent):
        raise ValueError('Invalid DrawingML geometry list.')
    return list(parent)


@lru_cache(maxsize=1)
def _presets():
    # This is a fixed, versioned application resource, never an uploaded file.
    try:
        data = _RESOURCE.read_bytes()
        if len(data) > 1024 * 1024 or b'<!DOCTYPE' in data or b'<!ENTITY' in data:
            raise ValueError('Invalid preset geometry resource.')
        root = ET.fromstring(data)
    except (OSError, ET.ParseError) as error:
        raise ValueError('Preset geometry resource is unavailable.') from error
    return {element.tag: element for element in root}


def _builtins(width, height):
    values = {'w': width, 'h': height, 'l': 0, 't': 0, 'r': width, 'b': height,
              'hc': width / 2, 'vc': height / 2, 'ss': min(width, height),
              'ls': max(width, height), 'cd': 21600000}
    for denominator in (2, 3, 4, 5, 6, 8, 10, 12, 16, 32):
        for name, base in (('wd', width), ('hd', height), ('ssd', min(width, height))):
            values[name + str(denominator)] = base / denominator
    for numerator, denominator in ((1, 2), (1, 4), (1, 8), (3, 4), (3, 8), (5, 8), (7, 8)):
        values[('' if numerator == 1 else str(numerator)) + 'cd' + str(denominator)] = 21600000 * numerator / denominator
    return values


class _Guides:
    def __init__(self, width, height):
        self.values = _builtins(width, height)
        self.count = 0

    def value(self, token):
        if not isinstance(token, str) or len(token) > 64:
            raise ValueError('Invalid DrawingML geometry value.')
        if _NUMBER.fullmatch(token):
            return _finite(float(token))
        if token not in self.values:
            raise ValueError('Unknown DrawingML geometry guide: ' + token)
        return self.values[token]

    def formula(self, formula):
        if not isinstance(formula, str) or len(formula) > 256:
            raise ValueError('Invalid DrawingML geometry formula.')
        parts = formula.split()
        if not parts:
            raise ValueError('Empty DrawingML geometry formula.')
        operator = parts[0]
        arity = {'val': 1, 'abs': 1, 'sqrt': 1, 'at2': 2, 'cos': 2, 'sin': 2, 'tan': 2,
                 'max': 2, 'min': 2, '*/': 3, '+-': 3, '+/': 3, '?:': 3, 'cat2': 3,
                 'sat2': 3, 'mod': 3, 'pin': 3}
        if operator not in arity or len(parts) != arity[operator] + 1:
            raise ValueError('Unsupported DrawingML geometry formula.')
        args = [self.value(part) for part in parts[1:]]
        x = args[0]
        y = args[1] if len(args) > 1 else 0
        z = args[2] if len(args) > 2 else 0
        radians = math.pi / 10800000
        if operator == 'val': result = x
        elif operator == 'abs': result = abs(x)
        elif operator == 'sqrt': result = _sqrt(x)
        elif operator == 'at2': result = math.atan2(y, x) / radians
        elif operator == 'cos': result = x * math.cos(y * radians)
        elif operator == 'sin': result = x * math.sin(y * radians)
        elif operator == 'tan': result = x * math.tan(y * radians)
        elif operator == 'max': result = max(x, y)
        elif operator == 'min': result = min(x, y)
        elif operator == '*/': result = _divide(x * y, z)
        elif operator == '+-': result = x + y - z
        elif operator == '+/': result = _divide(x + y, z)
        elif operator == '?:': result = y if x > 0 else z
        elif operator == 'cat2': result = x * math.cos(math.atan2(z, y))
        elif operator == 'sat2': result = x * math.sin(math.atan2(z, y))
        elif operator == 'mod': result = math.hypot(x, y, z)
        elif operator == 'pin': result = min(max(y, x), z)
        return _finite(result)

    def add(self, guide):
        self.count += 1
        if self.count > MAX_GUIDES:
            raise ValueError('DrawingML geometry has too many guides.')
        if _tag(guide) != 'gd' or len(guide):
            raise ValueError('Invalid DrawingML geometry guide.')
        name = guide.get('name', '')
        if not _NAME.fullmatch(name) or _NUMBER.fullmatch(name):
            raise ValueError('Invalid DrawingML geometry guide name.')
        # Sequential overwrites are intentional in several standard presets.
        self.values[name] = self.formula(guide.get('fmla'))


def _arc_segments(current, radius_x, radius_y, start_angle, sweep_angle):
    if radius_x == 0 and radius_y == 0:
        # Standard rounded rectangles use a zero-sized arc for a square corner.
        return []
    if radius_x <= 0 or radius_y <= 0:
        raise ValueError('DrawingML arc radii must be positive.')
    if abs(sweep_angle) > 21600000 + 1e-6:
        raise ValueError('DrawingML arc exceeds one revolution.')
    if abs(sweep_angle) < 1e-10:
        return []
    factor = math.pi / 10800000
    theta = start_angle * factor
    end_theta = (start_angle + sweep_angle) * factor
    # OOXML angles specify rays from an ellipse's center, not the ellipse's
    # parametric angles. Using the latter directly distorts noncircular arcs.
    start = math.atan2(radius_x * math.sin(theta), radius_y * math.cos(theta))
    end = math.atan2(radius_x * math.sin(end_theta), radius_y * math.cos(end_theta))
    if sweep_angle > 0:
        sweep = (end - start) % math.tau
    else:
        sweep = -((start - end) % math.tau)
    if abs(abs(sweep_angle) - 21600000) < 1e-6:
        sweep = math.copysign(math.tau, sweep_angle)
    center = (current[0] - radius_x * math.cos(start), current[1] - radius_y * math.sin(start))
    count = max(1, math.ceil(abs(sweep) / (math.pi / 2)))
    step = sweep / count
    result = []
    for index in range(count):
        first, last = start + index * step, start + (index + 1) * step
        kappa = 4 / 3 * math.tan(step / 4)
        x0, y0 = center[0] + radius_x * math.cos(first), center[1] + radius_y * math.sin(first)
        x1, y1 = center[0] + radius_x * math.cos(last), center[1] + radius_y * math.sin(last)
        result.append((x0 - kappa * radius_x * math.sin(first), y0 + kappa * radius_y * math.cos(first),
                       x1 + kappa * radius_x * math.sin(last), y1 - kappa * radius_y * math.cos(last), x1, y1))
    return result


def _path(path, guides, width, height, budget):
    path_width = width if path.get('w') is None else guides.value(path.get('w'))
    path_height = height if path.get('h') is None else guides.value(path.get('h'))
    if path_width <= 0 or path_height <= 0:
        raise ValueError('DrawingML path dimensions must be positive.')
    fill_mode = path.get('fill', 'norm')
    stroke = path.get('stroke', 'true')
    if fill_mode not in FILL_MODES or stroke not in ('true', 'false', '1', '0'):
        raise ValueError('Invalid DrawingML path style.')
    commands = []
    current = start = None
    drawn = False

    def emit(operator, coordinates=()):
        budget[0] += 1
        if budget[0] > MAX_COMMANDS:
            raise ValueError('DrawingML geometry has too many path commands.')
        normalized = [_finite(coordinate / (path_width if index % 2 == 0 else path_height))
                      for index, coordinate in enumerate(coordinates)]
        if any(abs(coordinate) > MAX_COORDINATE for coordinate in normalized):
            raise ValueError('DrawingML path coordinates exceed the limit.')
        commands.append([operator, *normalized])

    def points(command, count):
        if len(command) != count or any(_tag(point) != 'pt' or len(point) for point in command):
            raise ValueError('Invalid DrawingML path points.')
        return [(guides.value(point.get('x')), guides.value(point.get('y'))) for point in command]

    for command in path:
        kind = _tag(command)
        if kind == 'moveTo':
            current = start = points(command, 1)[0]
            emit('M', current)
        elif current is None:
            raise ValueError('DrawingML path must begin with moveTo.')
        elif kind == 'lnTo':
            end = points(command, 1)[0]
            drawn = drawn or current != end
            current = end
            emit('L', current)
        elif kind == 'cubicBezTo':
            control1, control2, end = points(command, 3)
            emit('C', (*control1, *control2, *end))
            drawn = drawn or any(point != current for point in (control1, control2, end))
            current = end
        elif kind == 'quadBezTo':
            control, end = points(command, 2)
            first = tuple(current[axis] + (control[axis] - current[axis]) * 2 / 3 for axis in (0, 1))
            last = tuple(end[axis] + (control[axis] - end[axis]) * 2 / 3 for axis in (0, 1))
            emit('C', (*first, *last, *end))
            drawn = drawn or control != current or end != current
            current = end
        elif kind == 'arcTo':
            if len(command):
                raise ValueError('Invalid DrawingML arc.')
            args = [guides.value(command.get(key)) for key in ('wR', 'hR', 'stAng', 'swAng')]
            for segment in _arc_segments(current, *args):
                emit('C', segment)
                current = segment[-2:]
                drawn = True
        elif kind == 'close':
            if len(command):
                raise ValueError('Invalid DrawingML close command.')
            emit('Z')
            current = start
        else:
            raise ValueError('Unsupported DrawingML path command: ' + kind)
    if not drawn:
        raise ValueError('DrawingML path contains no drawable geometry.')
    return {'commands': commands, 'fillMode': fill_mode, 'stroke': stroke in ('true', '1')}


def geometry_paths(geom_element, width, height):
    """Convert an a:prstGeom or a:custGeom element to normalized M/L/C/Z paths.

    Input dimensions refer to the untransformed source shape. Callers retain
    grouping, flips, rotation, fill/stroke, and text separately. Unsupported or
    invalid geometry raises ValueError, allowing the caller to report omission.
    """
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        raise ValueError('DrawingML shape dimensions must be numbers.')
    try:
        width, height = _finite(float(width)), _finite(float(height))
    except OverflowError as error:
        raise ValueError('DrawingML shape dimensions exceed the numeric limit.') from error
    if min(width, height) <= 0 or max(width, height) > 1e12:
        raise ValueError('DrawingML shape dimensions are outside the supported range.')
    if not isinstance(geom_element, ET.Element):
        raise ValueError('DrawingML geometry element is required.')
    if sum(1 for _ in geom_element.iter()) > MAX_ELEMENTS:
        raise ValueError('DrawingML geometry has too many XML elements.')
    kind = _tag(geom_element)
    allowed = {'avLst'} if kind == 'prstGeom' else {'avLst', 'gdLst', 'ahLst', 'cxnLst', 'rect', 'pathLst'}
    if any(_tag(child) not in allowed for child in geom_element):
        raise ValueError('Unsupported DrawingML geometry element.')
    for name in ('avLst', 'gdLst', 'pathLst'):
        if len(geom_element.findall(NS + name)) > 1:
            raise ValueError('Repeated DrawingML geometry list.')
    if kind == 'prstGeom':
        geometry = _presets().get(geom_element.get('prst'))
        if geometry is None:
            raise ValueError('Unknown DrawingML preset geometry.')
        overrides = _children(geom_element.find(NS + 'avLst'), 'gd')
    elif kind == 'custGeom':
        geometry, overrides = geom_element, []
    else:
        raise ValueError('Expected DrawingML preset or custom geometry.')
    guides = _Guides(width, height)
    defaults = _children(geometry.find(NS + 'avLst'), 'gd')
    known = {guide.get('name') for guide in defaults}
    by_name = {}
    for guide in overrides:
        name = guide.get('name')
        if name not in known or name in by_name:
            raise ValueError('Unknown or repeated DrawingML preset adjustment.')
        by_name[name] = guide
    for guide in defaults:
        guides.add(by_name.get(guide.get('name'), guide))
    for guide in _children(geometry.find(NS + 'gdLst'), 'gd'):
        guides.add(guide)
    paths = _children(geometry.find(NS + 'pathLst'), 'path')
    if not paths or len(paths) > MAX_PATHS:
        raise ValueError('DrawingML geometry has no paths or too many paths.')
    budget = [0]
    return [_path(path, guides, width, height, budget) for path in paths]
