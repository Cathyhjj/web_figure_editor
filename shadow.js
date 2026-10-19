/** Picture shadows use PowerPoint-style points; item geometry uses 96 CSS px/in. */
import { imageCrop } from './crop.js';

export const DEFAULT_SHADOW = Object.freeze({ enabled: false, color: '#000000', transparency: 60, size: 100, blur: 5, angle: 0, distance: 0 });
export const SHADOW_PRESETS = Object.freeze([
  { id: 'none', label: 'No shadow', values: { ...DEFAULT_SHADOW } },
  { id: 'soft', label: 'Soft centered', values: { ...DEFAULT_SHADOW, enabled: true } },
  { id: 'bottom-right', label: 'Offset bottom right', values: { ...DEFAULT_SHADOW, enabled: true, angle: 45, distance: 5 } },
  { id: 'bottom', label: 'Offset below', values: { ...DEFAULT_SHADOW, enabled: true, angle: 90, distance: 6, blur: 8 } },
  { id: 'hard', label: 'Hard bottom right', values: { ...DEFAULT_SHADOW, enabled: true, transparency: 45, blur: 0, angle: 45, distance: 4 } },
].map(preset => Object.freeze({ ...preset, values: Object.freeze(preset.values) })));

/** Keep old projects unchanged: callers only validate when shadow is present. */
export function validateShadow(value) {
  const fail = message => { throw new Error(`Invalid figure project: image.shadow ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object.');
  const result = {};
  const enabled = value.enabled === undefined ? DEFAULT_SHADOW.enabled : value.enabled;
  if (typeof enabled !== 'boolean') fail('enabled must be true or false.');
  result.enabled = enabled;
  const color = value.color === undefined ? DEFAULT_SHADOW.color : value.color;
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) fail('color must be a six-digit hex color.');
  result.color = color;
  for (const [key, maximum] of [['transparency', 100], ['size', 200], ['blur', 100], ['angle', 360], ['distance', 200]]) {
    const number = value[key] === undefined ? DEFAULT_SHADOW[key] : value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > maximum) fail(`${key} must be a finite number between 0 and ${maximum}.`);
    result[key] = number;
  }
  return result;
}

const n = value => Number(value.toFixed(6)).toString();
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function shadowGeometry(item) {
  if (item.type !== 'image' || item.shadow === undefined) return null;
  const shadow = validateShadow(item.shadow);
  if (!shadow.enabled || shadow.transparency === 100 || shadow.size === 0) return null;
  const width = item.width * shadow.size / 100, height = item.height * shadow.size / 100;
  const angle = shadow.angle * Math.PI / 180, distance = shadow.distance * 96 / 72;
  const x = (item.width - width) / 2 + Math.cos(angle) * distance;
  const y = (item.height - height) / 2 + Math.sin(angle) * distance;
  const sigma = shadow.blur * 96 / 72 / 2;
  // Four standard deviations retain the visible blur; one CSS pixel covers antialiasing.
  const pad = sigma > 0 ? sigma * 4 + 1 : 1;
  return { shadow, x, y, width, height, sigma, bounds: { x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 } };
}

/** Local union of the picture frame and shadow, before the item's rotation. */
export function shadowBounds(item) {
  const geometry = shadowGeometry(item);
  if (!geometry) return { x: 0, y: 0, width: item.width, height: item.height };
  const box = geometry.bounds, x = Math.min(0, box.x), y = Math.min(0, box.y);
  return { x, y, width: Math.max(item.width, box.x + box.width) - x, height: Math.max(item.height, box.y + box.height) - y };
}

/** Shadow-only SVG in item-local coordinates; place before the ordinary picture. */
export function imageShadowSVG(item, asset, filterId) {
  const geometry = shadowGeometry(item);
  if (!geometry) return '';
  if (typeof filterId !== 'string' || !/^[A-Za-z][A-Za-z\d_-]*$/.test(filterId)) throw new Error('Image shadow filter ID contains unsupported characters.');
  const { shadow, x, y, width, height, sigma, bounds } = geometry;
  const crop = imageCrop(item);
  const picture = item.crop
    ? `<svg x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}" preserveAspectRatio="none" overflow="hidden"><image width="1" height="1" preserveAspectRatio="none" href="${xml(asset.dataUrl)}"/></svg>`
    : `<image x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="none" href="${xml(asset.dataUrl)}"/>`;
  return `<defs><filter id="${filterId}" filterUnits="userSpaceOnUse" x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${n(sigma)}" result="shadow-blur"/><feFlood flood-color="${shadow.color}" flood-opacity="${n(1 - shadow.transparency / 100)}"/><feComposite in2="shadow-blur" operator="in"/></filter></defs><g filter="url(#${filterId})" pointer-events="none">${picture}</g>`;
}
