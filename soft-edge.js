/** Soft edges fade the object's alpha inward; source colors stay sharp. Units: pt. */
export const SOFT_EDGE_PRESETS = Object.freeze([0, 1, 2.5, 5, 10, 25, 50]);
export const MAX_SOFT_EDGE = 100;
const n = value => Number(value.toFixed(6)).toString();

export function softEdgeSVG(item, content, id, bounds) {
  if (!(item.softEdge > 0)) return content;
  if (!/^[A-Za-z][A-Za-z\d_-]*$/.test(id)) throw new Error('Soft edge filter ID contains unsupported characters.');
  const radius = item.softEdge * 96 / 72;
  const box = bounds || { x: 0, y: 0, width: item.width, height: item.height };
  // Build a silhouette before blurring so partially transparent interiors retain
  // their original opacity. Remap the blurred silhouette to an inward fade, then
  // mask the original pixels: neither RGB detail nor the outside area is blurred.
  return `<defs><filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${n(box.x - 1)}" y="${n(box.y - 1)}" width="${n(box.width + 2)}" height="${n(box.height + 2)}" color-interpolation-filters="sRGB"><feComponentTransfer in="SourceAlpha"><feFuncA type="linear" slope="10000"/></feComponentTransfer><feGaussianBlur stdDeviation="${n(radius / 3)}"/><feComponentTransfer result="soft-edge-mask"><feFuncA type="linear" slope="2" intercept="-1"/></feComponentTransfer><feComposite in="SourceGraphic" in2="soft-edge-mask" operator="in"/></filter></defs><g filter="url(#${id})">${content}</g>`;
}
