import { isMediaItem } from './video.js';
/** Render only copied objects as a transparent image for other applications. */
import { exportPNG, validateProject } from './core.js';
import { shadowBounds } from './shadow.js';
import { isCropped } from './crop.js';
import { shapeBounds as vectorShapeBounds } from './shape.js';
import { isShapeItem, shapeBounds as presetShapeBounds } from './shapes.js';

const MAX_SIDE = 16000;
const MAX_PIXELS = 32_000_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

function localBounds(item, measured) {
  if (item.shadow) return shadowBounds(item, measured?.get(item.id));
  if (measured?.has(item.id)) return measured.get(item.id);
  if (isMediaItem(item)) return shadowBounds(item);
  if (item.type === 'shape') return vectorShapeBounds(item);
  if (isShapeItem(item)) return presetShapeBounds(item);
  return { x: 0, y: 0, width: item.width, height: item.height };
}

function boundsOf(items, measured) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of items) {
    const box = localBounds(item, measured), angle = item.rotation * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle), cx = item.width / 2, cy = item.height / 2;
    for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
      const px = item.x + cx + (x - cx) * cos - (y - cy) * sin;
      const py = item.y + cy + (x - cx) * sin + (y - cy) * cos;
      left = Math.min(left, px); right = Math.max(right, px);
      top = Math.min(top, py); bottom = Math.max(bottom, py);
    }
  }
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function imageProject(selection, measured) {
  const source = validateProject(selection);
  const items = source.items.filter(item => !item.hidden);
  if (!items.length) throw new Error('Select at least one visible object to copy as an image.');
  const bounds = boundsOf(items, measured);
  if (bounds.width > MAX_SIDE + 1e-7 || bounds.height > MAX_SIDE + 1e-7) {
    throw new Error('The selected objects span more than 16,000 canvas pixels. Move them closer together or copy fewer objects.');
  }
  const assetIds = new Set(items.filter(item => isMediaItem(item)).map(item => item.assetId));
  return validateProject({
    ...source,
    canvas: { width: Math.min(MAX_SIDE, bounds.width), height: Math.min(MAX_SIDE, bounds.height), background: 'transparent' },
    assets: source.assets.filter(asset => assetIds.has(asset.id)),
    items: items.map(item => ({ ...item, x: item.x - bounds.left, y: item.y - bounds.top })),
  });
}

/** Pure cropped view; image bytes, item sizes, rotation, opacity and input are unchanged. */
export function selectionImageProject(selection) { return imageProject(selection); }

function textBounds(selection) {
  const measured = new Map(), texts = selection.items.filter(item => item.type === 'text' && !item.hidden);
  if (!texts.length) return measured;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '1'); svg.setAttribute('height', '1');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:fixed;left:-100000px;top:-100000px;overflow:visible;pointer-events:none;';
  document.body.append(svg);
  try {
    for (const item of texts) {
      const text = document.createElementNS(SVG_NS, 'text');
      const x = item.align === 'center' ? item.width / 2 : item.align === 'right' ? item.width : 0;
      const attrs = { 'font-family': item.fontFamily + ', Arial, sans-serif', 'font-size': item.fontSize,
        'font-weight': item.fontWeight, 'font-style': item.fontStyle,
        'text-anchor': item.align === 'center' ? 'middle' : item.align === 'right' ? 'end' : 'start' };
      for (const [key, value] of Object.entries(attrs)) text.setAttribute(key, value);
      text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      item.text.split('\n').forEach((line, index) => {
        const span = document.createElementNS(SVG_NS, 'tspan');
        span.setAttribute('x', x); span.setAttribute('y', item.fontSize * (1 + index * 1.2));
        span.textContent = line; text.append(span);
      });
      svg.append(text);
      const box = text.getBBox();
      const left = Math.min(0, box.x), top = Math.min(0, box.y);
      measured.set(item.id, { x: left, y: top, width: Math.max(item.width, box.x + box.width) - left,
        height: Math.max(item.height, box.y + box.height) - top });
      text.remove();
    }
  } finally { svg.remove(); }
  return measured;
}

function originalPNG(selection) {
  const items = selection.items.filter(item => !item.hidden);
  if (items.length !== 1 || items[0].type !== 'image') return null;
  const item = items[0], asset = selection.assets.find(value => value.id === item.assetId);
  if (asset.mime !== 'image/png' || item.rotation % 360 !== 0 || item.opacity !== 1 || isCropped(item) || item.softEdge > 0 || item.shadow?.enabled || item.strokeWidth > 0) return null;
  if (Math.abs(item.width / item.height / (asset.width / asset.height) - 1) > 1e-9) return null;
  if (asset.width > MAX_SIDE || asset.height > MAX_SIDE || asset.width * asset.height > MAX_PIXELS) return null;
  const binary = atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1));
  return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: 'image/png' });
}

/**
 * Native PNG bytes are retained for a single untransformed image. Otherwise use
 * the highest source-image density, with at least 300 DPI for text and shapes.
 * Image-only compositions are not deliberately upscaled beyond source density.
 * Raster output is capped at 32 MP and 16,000 pixels per side; core's separate
 * 100 MP export guard remains in force. Mixed-resolution images share one scale.
 */
export async function selectionToPNG(selection) {
  const source = validateProject(selection);
  const original = originalPNG(source);
  if (original) return original;
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('Copying this selection as an image requires a browser.');
  if (document.fonts?.ready) await document.fonts.ready;
  const project = imageProject(source, textBounds(source));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  let scale = 1 / 96;
  for (const item of project.items) {
    if (!isMediaItem(item)) { scale = Math.max(scale, 300 / 96); continue; }
    const asset = assets.get(item.assetId);
    scale = Math.max(scale, (asset.posterWidth ?? asset.width) * (item.crop?.width ?? 1) / item.width, (asset.posterHeight ?? asset.height) * (item.crop?.height ?? 1) / item.height);
  }
  const { width, height } = project.canvas;
  scale = Math.min(scale, 25, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  // Floor within the caps, allowing only floating-point noise near an exact pixel.
  const pixelWidth = Math.max(1, Math.floor(width * scale + 1e-7)), pixelHeight = Math.max(1, Math.floor(height * scale + 1e-7));
  const dpi = Math.max(1, Math.min(pixelWidth / width, pixelHeight / height) * 96);
  return exportPNG(project, dpi);
}
