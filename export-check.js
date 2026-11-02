import { imageContentRect, imageCrop } from './crop.js';
import { pptxLayoutForDeck } from './pptx.js';
import { objectBounds, shadowBounds } from './shadow.js';
import { isLineShape, shapeColor } from './shapes.js';
import { fromPixels } from './units.js';
import { isMediaItem } from './video.js';

const formats = ['png', 'svg', 'pdf', 'pptx', 'html'];

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(label + ' must be a finite positive number.');
  return value;
}

function painted(color, gradient) {
  return gradient ? gradient.stops.some(stop => shapeColor(stop.color).alpha > 0) : shapeColor(color || 'none').alpha > 0;
}

function hasBorder(item) {
  return item.strokeWidth > 0 && item.strokeOpacity !== 0 && painted(item.stroke, item.strokeGradient);
}

function visible(item) {
  if (item.hidden || item.opacity === 0) return false;
  if (isMediaItem(item)) return true;
  if (item.type === 'text') return !!item.text.trim() && painted(item.color);
  return hasBorder(item) || (!isLineShape(item) && item.fillOpacity !== 0 && painted(item.fill, item.fillGradient));
}

function orientedBounds(item, asset) {
  // Transparent letterboxing without a visible border does not paint the outer frame.
  const local = item.type === 'image' && !hasBorder(item) ? imageContentRect(item, asset) : objectBounds(item);
  const box = shadowBounds(item, local);
  const angle = (item.rotation || 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = box.x + box.width / 2 - item.width / 2, dy = box.y + box.height / 2 - item.height / 2;
  const cx = item.x + item.width / 2 + dx * cos - dy * sin;
  const cy = item.y + item.height / 2 + dx * sin + dy * cos;
  const width = box.width * Math.abs(cos) + box.height * Math.abs(sin);
  const height = box.height * Math.abs(cos) + box.width * Math.abs(sin);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

function vectorOutput(format, item, asset) {
  const svg = asset?.mime === 'image/svg+xml';
  if (format === 'png') return 'rasterized';
  if (format === 'pdf' && (svg || item.fillGradient || item.strokeGradient || item.shadow?.enabled || item.softEdge > 0)) return 'rasterized';
  if (format === 'pptx' && svg) return 'vector_with_png_fallback';
  return 'vector';
}

function measureRaster(item, asset, pxPerInch) {
  const isPoster = item.type === 'html' || item.type === 'video';
  const crop = imageCrop(item), rect = imageContentRect(item, asset);
  const sourceWidthPx = (isPoster ? asset.posterWidth : asset.width) * crop.width;
  const sourceHeightPx = (isPoster ? asset.posterHeight : asset.height) * crop.height;
  const dpiX = positive(sourceWidthPx / rect.width * pxPerInch, 'Horizontal effective DPI');
  const dpiY = positive(sourceHeightPx / rect.height * pxPerInch, 'Vertical effective DPI');
  const sourceType = item.type === 'html' ? 'html_snapshot' : item.type === 'video' ? 'video_poster'
    : asset.originalMime === 'image/svg+xml' || asset.rasterized ? 'flattened_svg' : 'raster_image';
  return { assetId: asset.id, sourceType, sourceKind: asset.sourceKind, sourceWidthPx, sourceHeightPx,
    placedWidthMm: positive(rect.width / pxPerInch * 25.4, 'Placed width'),
    placedHeightMm: positive(rect.height / pxPerInch * 25.4, 'Placed height'),
    dpiX, dpiY, effectiveDpi: Math.min(dpiX, dpiY) };
}

/** Inspect the live deck without decoding assets, changing the project or writing a file. */
export function checkExport(project, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Supply export check options.');
  for (const key of Object.keys(params)) {
    if (!['format', 'slideId', 'finalWidthMm', 'minRasterDpi'].includes(key)) throw new Error('Unsupported export check option: ' + key);
  }
  const { format, slideId, finalWidthMm, minRasterDpi = 300 } = params;
  if (!formats.includes(format)) throw new Error('Unsupported export format.');
  positive(minRasterDpi, 'minRasterDpi');
  if (finalWidthMm !== undefined) positive(finalWidthMm, 'finalWidthMm');
  const checkAll = slideId === undefined && (format === 'pptx' || format === 'html');
  const target = slideId === undefined ? project.activeSlideId : slideId;
  const included = checkAll ? project.slides : project.slides.filter(slide => slide.id === target);
  if (!included.length) throw new Error('Unknown slide: ' + target);
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const pptx = format === 'pptx' ? pptxLayoutForDeck(project) : null;
  const findings = [], slides = [];
  for (const slide of included) {
    const page = { slideId: slide.id, slideName: slide.name };
    const outputPage = pptx || slide.canvas;
    const fit = pptx?.slides.find(fitted => fitted.id === slide.id);
    const widthMm = finalWidthMm ?? fromPixels(outputPage.width, 'mm');
    const pagePxPerInch = finalWidthMm === undefined ? 96 : positive(outputPage.width / widthMm * 25.4, 'Print scale');
    const pxPerInch = positive(pagePxPerInch / (fit?.scale ?? 1), 'Slide print scale');
    const finalHeightMm = positive(outputPage.height / outputPage.width * widthMm, 'Print height');
    const summary = { ...page, finalWidthMm: widthMm, finalHeightMm, rasters: [], vectors: [] };
    if (fit) summary.pptxCanvasMm = {
      x: fit.x / pagePxPerInch * 25.4, y: fit.y / pagePxPerInch * 25.4,
      width: fit.width / pagePxPerInch * 25.4, height: fit.height / pagePxPerInch * 25.4,
    };
    slides.push(summary);
    for (const item of slide.items.filter(visible)) {
      const identity = { itemId: item.id, itemName: item.name };
      const asset = isMediaItem(item) ? assets.get(item.assetId) : undefined;
      if (isMediaItem(item) && !asset) throw new Error('Missing asset for object ' + item.id);
      const bounds = orientedBounds(item, asset), sides = [];
      const epsilon = 1e-7; // Exactly touching a canvas edge after rotation is not clipping.
      if (bounds.x < -epsilon) sides.push('left');
      if (bounds.y < -epsilon) sides.push('top');
      if (bounds.x + bounds.width > slide.canvas.width + epsilon) sides.push('right');
      if (bounds.y + bounds.height > slide.canvas.height + epsilon) sides.push('bottom');
      if (sides.length) findings.push({ code: 'outside_canvas', ...page, ...identity, bounds, sides });
      if (item.type === 'html' && !asset.hasSnapshot) {
        findings.push({ code: 'missing_html_snapshot', ...page, ...identity, assetId: asset.id });
      } else if (asset && asset.mime !== 'image/svg+xml') {
        const raster = { ...identity, ...measureRaster(item, asset, pxPerInch) };
        summary.rasters.push(raster);
        if (raster.effectiveDpi < minRasterDpi) findings.push({ code: 'low_raster_dpi', ...page, ...raster, minRasterDpi });
      } else {
        summary.vectors.push({ ...identity, ...(asset ? { assetId: asset.id } : {}), output: vectorOutput(format, item, asset) });
      }
    }
  }
  return { format, minRasterDpi, slides, findings, notes: [
    'Print width is the width of the entire output page. PPTX centers each source canvas on the common PowerPoint page. Other formats use each slide’s canvas. Without an override, 96 output CSS px equal one inch. HTML viewer or printer scaling can change the final size.',
    'Raster DPI uses the visible source pixels on each local axis and the fitted picture dimensions. The lower axis is compared before rounding. HTML snapshots and video posters use their own pixel dimensions.',
    'Vector entries have no source DPI. PNG rasterizes the page. PDF rasterizes SVG pictures and effect or gradient patches at the selected export DPI. PPTX embeds SVG with a PNG fallback.',
    'Bounds use original slide CSS px, including painted borders and shadows. PowerPoint covers the margins around the fitted canvas. Rotated bounds are conservative. Text bounds depend on available fonts, and image bounds include transparent pixels within the source.',
  ] };
}
