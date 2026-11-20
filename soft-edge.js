/** Linear and contour widths use points. Radial size is a percentage of the visible image's shorter side. */
export const SOFT_EDGE_PRESETS = Object.freeze([0, 1, 2.5, 5, 10, 25, 50]);
export const MAX_SOFT_EDGE = 100;
export const MAX_SOFT_EDGE_STRENGTH = 300;
export const DEFAULT_RADIAL_RADIUS = 50;
export const MAX_RADIAL_RADIUS = 200;
const n = value => Number(value.toFixed(6)).toString();

export function isGradientFeather(item) {
  return item.type === 'image' && (item.softEdgeMode === 'single' || item.softEdgeMode === 'radial');
}

export function hasSoftEdge(item) {
  if (!isGradientFeather(item)) return item.softEdge > 0;
  const size = item.softEdgeMode === 'radial' ? item.softEdgeRadius ?? DEFAULT_RADIAL_RADIUS : item.softEdge;
  return size > 0 && item.softEdgeStrength !== 0;
}

function featherStops(strength) {
  if (strength <= 100) {
    return `<stop stop-color="white" stop-opacity="${n(1 - strength / 100)}"/><stop offset="1" stop-color="white"/>`;
  }
  // Sample the opacity curve t^(strength/100). Across the supported range,
  // 24 intervals keep interpolation error below one 8-bit alpha step.
  const exponent = strength / 100;
  const intervals = 24;
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const t = index / intervals;
    return `<stop offset="${n(t)}" stop-color="white" stop-opacity="${n(t ** exponent)}"/>`;
  }).join('');
}

function featherGradient(item, id, visible) {
  const angle = (item.softEdgeAngle ?? 0) * Math.PI / 180;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const stops = featherStops(item.softEdgeStrength ?? 100);
  if (item.softEdgeMode === 'radial') {
    // Map the angle around the image perimeter before scaling to its aspect ratio.
    // This keeps the four diagonal directions on the four corners of any image.
    const normal = Math.max(Math.abs(dx), Math.abs(dy));
    const cx = visible.x + visible.width * (1 - dx / normal) / 2;
    const cy = visible.y + visible.height * (1 - dy / normal) / 2;
    const radius = Math.min(visible.width, visible.height) * (item.softEdgeRadius ?? DEFAULT_RADIAL_RADIUS) / 100;
    return `<radialGradient id="${id}-fade" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}">${stops}</radialGradient>`;
  }
  const radius = item.softEdge * 96 / 72;
  const length = Math.min(radius, Math.abs(dx) * visible.width + Math.abs(dy) * visible.height);
  const x = dx < 0 ? visible.x + visible.width : visible.x;
  const y = dy < 0 ? visible.y + visible.height : visible.y;
  return `<linearGradient id="${id}-fade" gradientUnits="userSpaceOnUse" x1="${n(x)}" y1="${n(y)}" x2="${n(x + dx * length)}" y2="${n(y + dy * length)}">${stops}</linearGradient>`;
}

export function softEdgeSVG(item, content, id, bounds) {
  if (!hasSoftEdge(item)) return content;
  if (!/^[A-Za-z][A-Za-z\d_-]*$/.test(id)) throw new Error('Soft edge filter ID contains unsupported characters.');
  const box = bounds || { x: 0, y: 0, width: item.width, height: item.height };
  if (isGradientFeather(item)) {
    const gradient = featherGradient(item, id, box.content ?? box);
    return `<defs>${gradient}<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="url(#${id}-fade)"/></mask></defs><g mask="url(#${id})">${content}</g>`;
  }
  const radius = item.softEdge * 96 / 72;
  // Build a silhouette before blurring so partially transparent interiors retain
  // their original opacity. Remap the blurred silhouette to an inward fade, then
  // mask the original pixels: neither RGB detail nor the outside area is blurred.
  return `<defs><filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${n(box.x - 1)}" y="${n(box.y - 1)}" width="${n(box.width + 2)}" height="${n(box.height + 2)}" color-interpolation-filters="sRGB"><feComponentTransfer in="SourceAlpha"><feFuncA type="linear" slope="10000"/></feComponentTransfer><feGaussianBlur stdDeviation="${n(radius / 3)}"/><feComponentTransfer result="soft-edge-mask"><feFuncA type="linear" slope="2" intercept="-1"/></feComponentTransfer><feComposite in="SourceGraphic" in2="soft-edge-mask" operator="in"/></filter></defs><g filter="url(#${id})">${content}</g>`;
}
