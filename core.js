/** Portable project model and exports. Geometry is measured in CSS pixels (96/in). */
const LIMITS = Object.freeze({ assets: 500, items: 2000, assetBytes: 40 * 1024 * 1024, totalBytes: 160 * 1024 * 1024 });
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createProject() {
  return { format: 'figure-editor', version: 1, id: uid(), name: 'Untitled figure', canvas: { width: 960, height: 640, background: '#ffffff' }, assets: [], items: [] };
}

function fail(message) { throw new Error(`Invalid figure project: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}
function string(value, label, max = 1000, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be text of at most ${max} characters.`);
  return value;
}
function number(value, label, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
}
function boolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}
function id(value, label, max = 100) {
  const result = string(value, label, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) fail(`${label} contains unsupported characters.`);
  return result;
}
function choice(value, label, options, fallback) {
  const result = value ?? fallback;
  if (!options.includes(result)) fail(`${label} is unsupported.`);
  return result;
}
function color(value, label, fallback) {
  const result = string(value, label, 40, fallback);
  if (!/^(?:#[a-fA-F0-9]{3,4}|#[a-fA-F0-9]{6}|#[a-fA-F0-9]{8}|none|transparent|black|white|red|green|blue|gray|grey)$/i.test(result)) fail(`${label} must be a hex color or a supported plain color.`);
  return result;
}

function dataURL(value, mime, label, inertOriginal = false) {
  if ((!inertOriginal && !RASTER_MIMES.has(mime)) || (inertOriginal && mime !== 'image/svg+xml')) fail(`${label} has an unsupported MIME type.`);
  const result = string(value, label, Math.ceil(LIMITS.assetBytes / 3) * 4 + 64);
  const prefix = `data:${mime};base64,`;
  if (!result.startsWith(prefix)) fail(`${label} must be an embedded base64 ${mime} image, not a file path or external URL.`);
  const payload = result.slice(prefix.length);
  if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) fail(`${label} contains invalid base64 data.`);
  const byteLength = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (byteLength > LIMITS.assetBytes) fail(`${label} exceeds the 40 MB asset limit.`);
  // A MIME label alone must not turn an embedded script or SVG into a raster asset.
  if (!inertOriginal) {
    const header = atob(payload.slice(0, 32));
    const valid = mime === 'image/png' ? PNG_SIGNATURE.every((v, i) => header.charCodeAt(i) === v)
      : mime === 'image/jpeg' ? header.charCodeAt(0) === 255 && header.charCodeAt(1) === 216 && header.charCodeAt(2) === 255
        : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
    if (!valid) fail(`${label} bytes do not match its MIME type.`);
  }
  return { value: result, byteLength };
}

/** Validate untrusted parsed JSON, discard unknown fields, and return a fresh model. */
export function validateProject(input) {
  return validateProjectInternal(input);
}

/** Validate related v1 views; an identical shared assets array is checked once per call. */
export function validateProjectBatch(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 100) fail('a validation batch must contain at most 100 projects.');
  const assetCache = new Map();
  return inputs.map(input => validateProjectInternal(input, assetCache));
}

function validateProjectInternal(input, assetCache) {
  const p = object(input, 'project');
  if (p.format !== 'figure-editor' || p.version !== 1) fail('only figure-editor version 1 projects are supported.');
  const c = object(p.canvas, 'canvas');
  if (!Array.isArray(p.assets) || p.assets.length > LIMITS.assets) fail('assets must be an array with at most 500 entries.');
  if (!Array.isArray(p.items) || p.items.length > LIMITS.items) fail('items must be an array with at most 2000 entries.');
  const project = {
    format: 'figure-editor', version: 1, id: id(p.id, 'project.id'), name: string(p.name, 'project.name', 300, 'Untitled figure'),
    canvas: { width: number(c.width, 'canvas.width', 1, 16000), height: number(c.height, 'canvas.height', 1, 16000), background: color(c.background, 'canvas.background', '#ffffff') }, assets: [], items: [],
  };
  const assetIDs = new Set();
  let totalBytes = 0;
  const cachedAssets = assetCache?.get(p.assets);
  if (cachedAssets) {
    project.assets = cachedAssets.map(asset => ({ ...asset }));
    for (const asset of project.assets) assetIDs.add(asset.id);
  } else for (const raw of p.assets) {
    const a = object(raw, 'asset');
    const assetID = id(a.id, 'asset.id');
    if (assetIDs.has(assetID)) fail(`duplicate asset ID ${assetID}.`);
    assetIDs.add(assetID);
    const mime = string(a.mime, 'asset.mime', 100);
    const embedded = dataURL(a.dataUrl, mime, 'asset.dataUrl');
    totalBytes += embedded.byteLength;
    const asset = {
      id: assetID, name: string(a.name, 'asset.name', 1000, 'Image'), mime, dataUrl: embedded.value,
      width: number(a.width, 'asset.width', 1, 100000), height: number(a.height, 'asset.height', 1, 100000),
      size: number(a.size, 'asset.size', 0, Number.MAX_SAFE_INTEGER, embedded.byteLength),
      lastModified: number(a.lastModified, 'asset.lastModified', 0, Number.MAX_SAFE_INTEGER, 0),
      sourceKind: choice(a.sourceKind, 'asset.sourceKind', ['copy', 'linked'], 'copy'),
    };
    for (const key of ['relativePath', 'fingerprint']) if (a[key] !== undefined) asset[key] = string(a[key], `asset.${key}`, 2000);
    if (a.linkToken !== undefined) asset.linkToken = id(a.linkToken, 'asset.linkToken', 200);
    if (a.linkPersistence !== undefined) asset.linkPersistence = choice(a.linkPersistence, 'asset.linkPersistence', ['browser', 'session']);
    if (a.rasterized !== undefined) asset.rasterized = boolean(a.rasterized, 'asset.rasterized');
    if (a.rasterizationScale !== undefined) asset.rasterizationScale = number(a.rasterizationScale, 'asset.rasterizationScale', Number.MIN_VALUE, 16);
    if (a.originalDataUrl !== undefined || a.originalMime !== undefined) {
      const originalMime = string(a.originalMime, 'asset.originalMime', 100);
      const original = dataURL(a.originalDataUrl, originalMime, 'asset.originalDataUrl', true);
      asset.originalDataUrl = original.value;
      asset.originalMime = originalMime;
      totalBytes += original.byteLength;
    }
    if (totalBytes > LIMITS.totalBytes) fail('embedded assets exceed the 160 MB project limit.');
    project.assets.push(asset);
  }
  if (assetCache && !cachedAssets) assetCache.set(p.assets, project.assets);
  const itemIDs = new Set();
  for (const raw of p.items) {
    const item = object(raw, 'item');
    const itemID = id(item.id, 'item.id');
    if (itemIDs.has(itemID)) fail(`duplicate item ID ${itemID}.`);
    itemIDs.add(itemID);
    const type = choice(item.type, 'item.type', ['image', 'text', 'rect', 'line']);
    const canonical = {
      id: itemID, type, name: string(item.name, 'item.name', 1000, type === 'text' ? 'Text' : type === 'image' ? 'Image' : 'Shape'),
      x: number(item.x, 'item.x', -100000, 100000), y: number(item.y, 'item.y', -100000, 100000),
      width: number(item.width, 'item.width', type === 'line' ? 0 : 0.01, 100000), height: number(item.height, 'item.height', type === 'line' ? 0 : 0.01, 100000),
      rotation: number(item.rotation, 'item.rotation', -36000, 36000, 0), opacity: number(item.opacity, 'item.opacity', 0, 1, 1),
      locked: boolean(item.locked, 'item.locked'), hidden: boolean(item.hidden, 'item.hidden'),
    };
    if (type === 'image') {
      canonical.assetId = id(item.assetId, 'item.assetId');
      if (!assetIDs.has(canonical.assetId)) fail(`image ${itemID} refers to a missing asset.`);
    } else if (type === 'text') {
      canonical.text = string(item.text, 'item.text', 100000, '').replace(/\r\n?/g, '\n');
      canonical.fontFamily = string(item.fontFamily, 'item.fontFamily', 200, 'Arial');
      canonical.fontSize = number(item.fontSize, 'item.fontSize', 1, 2000, 24);
      canonical.fontWeight = choice(item.fontWeight, 'item.fontWeight', ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900', 100, 200, 300, 400, 500, 600, 700, 800, 900], 'normal');
      canonical.fontStyle = choice(item.fontStyle, 'item.fontStyle', ['normal', 'italic', 'oblique'], 'normal');
      canonical.color = color(item.color, 'item.color', '#111827');
      canonical.align = choice(item.align, 'item.align', ['left', 'center', 'right'], 'left');
    } else {
      canonical.fill = color(item.fill, 'item.fill', type === 'line' ? 'none' : '#ffffff');
      canonical.stroke = color(item.stroke, 'item.stroke', '#111827');
      canonical.strokeWidth = number(item.strokeWidth, 'item.strokeWidth', 0, 1000, 2);
    }
    project.items.push(canonical);
  }
  return project;
}

export function serializeProject(project) { return JSON.stringify(validateProject(project), null, 2); }

function xml(value) {
  // XML 1.0 forbids these controls even when they came from legal JSON strings.
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function n(value) { return Number(value.toFixed(6)).toString(); }

function manifest(project) {
  return {
    format: 'figure-editor-source-manifest', version: 1,
    project: { id: project.id, name: project.name },
    canvas: { ...project.canvas, unit: 'CSS px', pixelsPerInch: 96, widthMM: project.canvas.width / 96 * 25.4, heightMM: project.canvas.height / 96 * 25.4 },
    exportNotes: {
      svg: 'Text and editor shapes are vector. Imported PNG, JPEG, WebP, and flattened SVG images are embedded rasters. Fonts are referenced by family and are not embedded.',
      png: 'All content is rasterized. DPI changes export pixel dimensions and the PNG resolution metadata, not the resolution of the original images.',
      localSources: 'Portable projects embed material copies. Local file handles are browser-local permissions, are not serialized, and may require permission or relinking after reopening.',
    },
    sources: project.assets.map(a => ({
      id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height, size: a.size, lastModified: a.lastModified,
      sourceKind: a.sourceKind, embeddedCopy: true, ...(a.relativePath !== undefined ? { relativePath: a.relativePath } : {}),
      ...(a.fingerprint !== undefined ? { fingerprint: a.fingerprint } : {}),
      ...(a.linkToken !== undefined ? { linkToken: a.linkToken, linkTokenScope: 'Browser-local reference; file handle is not embedded.' } : {}),
      ...(a.linkPersistence !== undefined ? { linkPersistence: a.linkPersistence } : {}),
      ...(a.rasterized !== undefined ? { rasterized: a.rasterized } : {}),
      ...(a.rasterizationScale !== undefined ? { rasterizationScale: a.rasterizationScale } : {}),
      ...(a.originalMime ? { originalMime: a.originalMime, originalEmbedded: true, renderedAs: 'raster' } : {}),
      usedBy: project.items.filter(i => i.type === 'image' && i.assetId === a.id).map(i => i.id),
    })),
  };
}

export function sourceManifest(project) { return manifest(validateProject(project)); }

function svgFromCanonical(project) {
  const { width, height, background } = project.canvas;
  const assets = new Map(project.assets.map(a => [a.id, a]));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width / 96 * 25.4)}mm" height="${n(height / 96 * 25.4)}mm" viewBox="0 0 ${n(width)} ${n(height)}">`,
    `<title>${xml(project.name)}</title>`,
    '<desc>Figure Editor export. Text and shapes are vector; imported images remain raster. Fonts are not embedded.</desc>',
    `<metadata>${xml(JSON.stringify(manifest(project)))}</metadata>`,
    `<rect width="${n(width)}" height="${n(height)}" fill="${xml(background)}"/>`,
  ];
  for (const item of project.items) {
    if (item.hidden) continue;
    const { width: w, height: h } = item;
    lines.push(`<g id="${xml(item.id)}" transform="translate(${n(item.x)} ${n(item.y)}) rotate(${n(item.rotation)} ${n(w / 2)} ${n(h / 2)})" opacity="${n(item.opacity)}">`);
    if (item.type === 'image') {
      lines.push(`<image x="0" y="0" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none" href="${xml(assets.get(item.assetId).dataUrl)}"/>`);
    } else if (item.type === 'text') {
      const textX = item.align === 'center' ? w / 2 : item.align === 'right' ? w : 0;
      const anchor = item.align === 'center' ? 'middle' : item.align === 'right' ? 'end' : 'start';
      lines.push(`<text xml:space="preserve" font-family="${xml(item.fontFamily + ', Arial, sans-serif')}" font-size="${n(item.fontSize)}" font-weight="${xml(item.fontWeight)}" font-style="${xml(item.fontStyle)}" fill="${xml(item.color)}" text-anchor="${anchor}">`);
      item.text.split('\n').forEach((line, index) => lines.push(`<tspan x="${n(textX)}" y="${n(item.fontSize * (1 + index * 1.2))}">${xml(line)}</tspan>`));
      lines.push('</text>');
    } else if (item.type === 'rect') {
      lines.push(`<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${xml(item.fill)}" stroke="${xml(item.stroke)}" stroke-width="${n(item.strokeWidth)}"/>`);
    } else {
      lines.push(`<line x1="0" y1="0" x2="${n(w)}" y2="${n(h)}" stroke="${xml(item.stroke)}" stroke-width="${n(item.strokeWidth)}"/>`);
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

export function projectToSVG(project) { return svgFromCanonical(validateProject(project)); }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function withPNGResolution(blob, dpi) {
  const data = new Uint8Array(await blob.arrayBuffer());
  if (!PNG_SIGNATURE.every((v, i) => data[i] === v)) throw new Error('The browser returned an invalid PNG.');
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const parts = [data.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= data.length) {
    const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
    const end = offset + length + 12;
    if (end > data.length) throw new Error('The browser returned a truncated PNG.');
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (type !== 'pHYs') parts.push(data.subarray(offset, end));
    if (type === 'IHDR') { parts.push(chunk); inserted = true; }
    offset = end;
    if (type === 'IEND') break;
  }
  if (!inserted) throw new Error('The browser returned a PNG without dimensions.');
  return new Blob(parts, { type: 'image/png' });
}

/** Rasterize at the requested physical DPI and write a matching PNG pHYs chunk. */
export async function exportPNG(input, dpi = 300) {
  const project = validateProject(input);
  number(dpi, 'export DPI', 1, 2400);
  const width = Math.max(1, Math.round(project.canvas.width * dpi / 96));
  const height = Math.max(1, Math.round(project.canvas.height * dpi / 96));
  if (width > 32767 || height > 32767 || width * height > 100000000) throw new Error('PNG export exceeds 100 megapixels or 32767 pixels per side. Reduce canvas size or DPI.');
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('PNG export requires a browser.');
  if (document.fonts?.ready) await document.fonts.ready;
  const svgBlob = new Blob([svgFromCanonical(project)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The browser could not render the figure. Check the imported images and fonts.'));
      img.src = url;
    });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not allocate a drawing canvas. Reduce export size.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The browser could not encode this PNG. Reduce export size.')), 'image/png'));
    return await withPNGResolution(blob, dpi);
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Defer cleanup so browsers can finish beginning the download.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
