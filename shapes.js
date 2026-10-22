import { gradientSVG } from './shape.js';
/** Shared vector geometry for the editor, thumbnails and exports. Units are CSS px. */
export const SHAPE_TYPES = Object.freeze(['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'doubleArrow']);
export const SHAPE_NAMES = Object.freeze({ rect: 'Rectangle', roundRect: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', doubleArrow: 'Double arrow' });
export const isShapeItem = item => SHAPE_TYPES.includes(item.type);
export const isLineShape = item => ['line', 'arrow', 'doubleArrow'].includes(item.type);
const n = value => Number(value.toFixed(6)).toString();

export function strokeDashArray(item) {
  const width = item.strokeWidth ?? 2;
  return item.strokeDash === 'dash' ? [4 * width, 3 * width] : item.strokeDash === 'dot' ? [width, 2 * width] : [];
}

/** Open arrowheads, with the tip at the endpoint and no marker-ID collisions. */
export function arrowHeads(item) {
  if (!['arrow', 'doubleArrow'].includes(item.type)) return [];
  const length = Math.hypot(item.width, item.height);
  if (!length || !item.strokeWidth) return [];
  const ux = item.connector && item.width ? 1 : item.width / length, uy = item.connector && item.width ? 0 : item.height / length;
  const size = Math.min(3 * item.strokeWidth, length / (item.type === 'doubleArrow' ? 3 : 2));
  const head = (x, y, direction) => [
    [x - direction * size * ux - size / 2 * uy, y - direction * size * uy + size / 2 * ux],
    [x, y],
    [x - direction * size * ux + size / 2 * uy, y - direction * size * uy - size / 2 * ux],
  ];
  return [...(item.type === 'doubleArrow' ? [head(0, 0, -1)] : []), head(item.width, item.height, 1)]
    .map(points => points.map(([x,y]) => [item.connectorFlipX ? item.width-x : x, item.connectorFlipY ? item.height-y : y]));
}

/** M/L/C/Z commands shared with PDF and native PowerPoint custom arrow paths. */
export function shapePath(item) {
  const w = item.width, h = item.height, k = 0.5522847498307936;
  if (isLineShape(item)) {
    const commands = item.connector === 'elbow' ? [['M',0,0],['L',w/2,0],['L',w/2,h],['L',w,h]]
      : item.connector === 'curved' ? [['M',0,0],['C',w/4,0,w/2,h/4,w/2,h/2],['C',w/2,3*h/4,3*w/4,h,w,h]] : [['M', 0, 0], ['L', w, h]];
    return commands.map(([op,...values]) => [op,...values.map((v,i) => i%2 ? (item.connectorFlipY ? h-v : v) : (item.connectorFlipX ? w-v : v))]);
  }
  if (item.type === 'ellipse') {
    const x = w / 2, y = h / 2;
    return [['M', w, y], ['C', w, y + k * y, x + k * x, h, x, h],
      ['C', x - k * x, h, 0, y + k * y, 0, y],
      ['C', 0, y - k * y, x - k * x, 0, x, 0],
      ['C', x + k * x, 0, w, y - k * y, w, y], ['Z']];
  }
  const r = item.type === 'roundRect' ? Math.min(w, h) * (item.cornerRadius ?? 1 / 6) : 0;
  if (!r) return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
  const c = r * (1 - k);
  return [['M', r, 0], ['L', w - r, 0], ['C', w - c, 0, w, c, w, r],
    ['L', w, h - r], ['C', w, h - c, w - c, h, w - r, h],
    ['L', r, h], ['C', c, h, 0, h - c, 0, h - r],
    ['L', 0, r], ['C', 0, c, c, 0, r, 0], ['Z']];
}

export const pathData = commands => commands.map(([op, ...values]) => [op, ...values.map(n)].join(' ')).join(' ');

/** Paints only; object opacity belongs to the enclosing group. */
export function shapeSVG(item, id = `preset-${item.id||'shape'}`) {
  id=String(id).replace(/[^a-zA-Z0-9_-]/g,'-');
  const gradient=item.strokeGradient,strokePaint=gradient?`url(#${id}-stroke-gradient)`:item.stroke;
  const defs=gradient?`<defs>${gradientSVG(item,gradient,`${id}-stroke-gradient`,'norm',true)}</defs>`:'';
  const dash = strokeDashArray(item);
  const stroke = `stroke="${strokePaint}" stroke-width="${n(item.strokeWidth)}" stroke-opacity="${n(item.strokeOpacity ?? 1)}" stroke-linejoin="${isLineShape(item) ? 'round' : 'miter'}"`;
  const fill = `fill="${isLineShape(item) ? 'none' : item.fill}" fill-opacity="${n(item.fillOpacity ?? 1)}"`;
  let geometry;
  if (item.type === 'rect' || item.type === 'roundRect') {
    const r = item.type === 'roundRect' ? Math.min(item.width, item.height) * (item.cornerRadius ?? 1 / 6) : 0;
    geometry = `<rect width="${n(item.width)}" height="${n(item.height)}"${r ? ` rx="${n(r)}"` : ''}`;
  } else if (item.type === 'ellipse') {
    geometry = `<ellipse cx="${n(item.width / 2)}" cy="${n(item.height / 2)}" rx="${n(item.width / 2)}" ry="${n(item.height / 2)}"`;
  } else if (item.connector) {
    geometry = `<path d="${pathData(shapePath(item))}"`;
  } else {
    geometry = `<line x1="0" y1="0" x2="${n(item.width)}" y2="${n(item.height)}"`;
  }
  // One group composites shaft/head overlaps before applying stroke alpha.
  const heads = arrowHeads(item);
  if (heads.length) {
    const body = `${geometry} fill="none" stroke-dasharray="${dash.length ? dash.map(n).join(' ') : 'none'}"/>`;
    const ends = heads.map(points => `<path d="${pathData(points.map(([x, y], i) => [i ? 'L' : 'M', x, y]))}" fill="none"/>`).join('');
    if (gradient) {
      // Merge opaque coverage before applying translucent gradient stops once.
      const bounds=shapeBounds({...item,strokeOpacity:1}),mask=`${id}-stroke-mask`;
      const box=`x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}"`;
      return `${defs}<defs><mask id="${mask}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${box}><g stroke="white" stroke-width="${n(item.strokeWidth)}" stroke-linejoin="round">${body}${ends}</g></mask></defs><rect ${box} fill="${strokePaint}" stroke="none" opacity="${n(item.strokeOpacity??1)}" mask="url(#${mask})"/>`;
    }
    const paint = shapeColor(item.stroke);
    return `${defs}<g stroke="${paint.hex}" stroke-width="${n(item.strokeWidth)}" stroke-linejoin="round" opacity="${n(paint.alpha * (item.strokeOpacity ?? 1))}">${body}${ends}</g>`;
  }
  return `${defs}${geometry} ${fill} ${stroke}${dash.length ? ` stroke-dasharray="${dash.map(n).join(' ')}"` : ''}/>`;
}

export function shapeBounds(item) {
  const pad = (item.strokeGradient || item.stroke !== 'none' && item.stroke !== 'transparent') && (item.strokeOpacity ?? 1) > 0 ? item.strokeWidth / 2 : 0;
  const points = [[0, 0], [item.width, item.height], ...arrowHeads(item).flat()];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/** Preserve legacy hex alpha when the color picker edits RGB separately. */
export function shapeColor(value = '#000000') {
  const named = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', gray: '808080', grey: '808080' };
  const input = value.toLowerCase();
  if (input === 'none' || input === 'transparent') return { hex: '#000000', alpha: 0 };
  let hex = named[input] ?? input.slice(1);
  if (hex.length <= 4) hex = [...hex].map(v => v + v).join('');
  return { hex: '#' + hex.slice(0, 6), alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
}
