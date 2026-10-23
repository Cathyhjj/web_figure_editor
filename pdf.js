import { posterProject } from './video.js';
/** Single-page vector PDF. Geometry is CSS px (96/in), PDF pages use points (72/in). */
import { validateProject, withRasterCanvas } from './core.js';
import { imageCrop } from './crop.js';
import { shadowBounds } from './shadow.js';
import { shadeColor, shapeBounds as vectorShapeBounds } from './shape.js';
import { isLineShape, shapePath, arrowHeads, shapeBounds, strokeDashArray } from './shapes.js';

const encoder = new TextEncoder();
const ascii = value => encoder.encode(value);
const n = value => Number(value.toFixed(6)).toString();
const MAX_BYTES = 240 * 1024 * 1024;
const launchHint = 'Vector PDF text needs the local macOS Figure Editor server. Start or restart with start.command (or npm start), then reload this page.';
function fail(message) { throw new Error(`PDF export: ${message}`); }
function checkPixels(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > 100000000) {
    fail('an image or shadow exceeds 100 megapixels or 32767 pixels per side. Reduce its size or shadow DPI.');
  }
}

function writer() {
  const objects = [null, null, null, null];
  const resources = { XObject: [], ExtGState: [] };
  let size = 0;
  const add = (parts, at = objects.length + 1) => {
    size += parts.reduce((sum, part) => sum + part.length, 0);
    if (size > MAX_BYTES) fail('this figure exceeds the 240 MB export limit. Use smaller images or fewer text characters.');
    objects[at - 1] = parts; return at;
  };
  const stream = (content, dictionary = '') => {
    const bytes = typeof content === 'string' ? ascii(content) : content;
    return [ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, ascii('\nendstream')];
  };
  const resource = (type, id) => {
    const name = `${type === 'XObject' ? 'X' : 'G'}${id}`;
    resources[type].push(`/${name} ${id} 0 R`); return name;
  };
  const resourceDictionary = () => `<< /XObject << ${resources.XObject.join(' ')} >> /ExtGState << ${resources.ExtGState.join(' ')} >> >>`;
  const alphas = new Map();
  const alpha = (fill, stroke = fill) => {
    const key = `${n(fill)} ${n(stroke)}`;
    if (!alphas.has(key)) alphas.set(key, resource('ExtGState', add([ascii(`<< /Type /ExtGState /ca ${n(fill)} /CA ${n(stroke)} >>`)])));
    return `/${alphas.get(key)} gs`;
  };
  const finish = (width, height, content) => {
    add([ascii('<< /Type /Catalog /Pages 2 0 R >>')], 1);
    add([ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')], 2);
    add([ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(width * .75)} ${n(height * .75)}] /Resources ${resourceDictionary()} /Contents 4 0 R >>`)], 3);
    add(stream(content), 4);
    const parts = [ascii('%PDF-1.4\n%'), new Uint8Array([226, 227, 207, 211, 10])];
    let length = parts.reduce((sum, part) => sum + part.length, 0);
    const offsets = [0];
    for (const [index, body] of objects.entries()) {
      offsets.push(length);
      for (const part of [ascii(`${index + 1} 0 obj\n`), ...body, ascii('\nendobj\n')]) { parts.push(part); length += part.length; }
    }
    parts.push(ascii(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    return new Blob(parts, { type: 'application/pdf' });
  };
  return { add, stream, resource, resourceDictionary, alpha, finish };
}

function color(value) {
  const named = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', gray: '808080', grey: '808080' };
  const lower = value.toLowerCase();
  if (lower === 'none' || lower === 'transparent') return { rgb: '0 0 0', alpha: 0 };
  let hex = named[lower] || lower.slice(1);
  if (hex.length <= 4) hex = Array.from(hex, digit => digit + digit).join('');
  return { rgb: [0, 2, 4].map(at => n(parseInt(hex.slice(at, at + 2), 16) / 255)).join(' '), alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
}

/** Accept only glyph path operators from the native helper, never arbitrary PDF syntax. */
function pathBounds(path) {
  if (typeof path !== 'string' || path.length > 32 * 1024 * 1024) fail('invalid text outline data.');
  const tokens = path.trim() ? path.trim().split(/\s+/) : [];
  const values = [];
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const token of tokens) {
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > 100000000) fail('text outline coordinates exceed the export limit.');
      values.push(value);
    } else {
      const count = { m: 2, l: 2, c: 6, h: 0 }[token];
      if (count === undefined || values.length !== count) fail('invalid text outline path.');
      for (let at = 0; at < count; at += 2) {
        left = Math.min(left, values[at]); right = Math.max(right, values[at]);
        bottom = Math.min(bottom, values[at + 1]); top = Math.max(top, values[at + 1]);
      }
      values.length = 0;
    }
  }
  if (values.length) fail('incomplete text outline path.');
  return left === Infinity ? null : [left, bottom, right, top];
}

async function textOutlines(items) {
  if (!items.length) return new Map();
  if (globalThis.location?.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname)) fail(launchHint);
  let local;
  try {
    const response = await fetch('/api/local', { cache: 'no-store', mode: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    local = await response.json();
  } catch { fail(launchHint); }
  if (local?.app !== 'figure-editor-local' || local.version !== 1 || local.pdfTextOutlines !== true || typeof local.token !== 'string' || !local.token) fail(launchHint);
  let response, result;
  try {
    response = await fetch('/api/pdf-text', {
      method: 'POST', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token },
      body: JSON.stringify({ items: items.map(({ id, text, fontFamily, fontSize, fontWeight, fontStyle }) => ({ id, text, fontFamily, fontSize, fontWeight, fontStyle })) }),
      signal: AbortSignal.timeout(120000),
    });
    result = await response.json();
  } catch { fail('could not outline the fonts. Check the local Figure Editor server and try again.'); }
  if (!response.ok) fail(result?.error || 'the local font helper could not create text outlines.');
  if (result?.substitutions?.length) fail(`font “${result.substitutions[0].requested}” is unavailable to the local font helper. Choose an installed font before exporting.`);
  if (!Array.isArray(result?.outlines) || result.outlines.length !== items.length) fail('incomplete font outline response.');
  const outlines = new Map();
  for (const [index, outline] of result.outlines.entries()) {
    const item = items[index];
    if (outline.id !== item.id || !Array.isArray(outline.lines) || outline.lines.length !== item.text.split('\n').length) fail('mismatched text outlines.');
    outline.lines.forEach(line => {
      if (!Number.isFinite(line.width) || line.width < 0 || line.width > 100000000) fail('invalid text outline width.');
      line.bounds = pathBounds(line.path);
    });
    outlines.set(item.id, outline.lines);
  }
  return outlines;
}

async function compressedStream(pdf, bytes, dictionary) {
  let filter = '';
  if (typeof CompressionStream !== 'undefined') {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    filter = ' /Filter /FlateDecode';
  }
  return pdf.add(pdf.stream(bytes, dictionary + filter));
}

async function embedPixels(pdf, data, width, height) {
  checkPixels(width, height);
  const pixels = width * height, rgb = new Uint8Array(pixels * 3);
  let alpha;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const src = pixel * 4, dst = pixel * 3;
    rgb[dst] = data[src]; rgb[dst + 1] = data[src + 1]; rgb[dst + 2] = data[src + 2];
    if (data[src + 3] !== 255 && !alpha) { alpha = new Uint8Array(pixels); alpha.fill(255); }
    if (alpha) alpha[pixel] = data[src + 3];
  }
  const dictionary = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8`;
  const mask = alpha ? await compressedStream(pdf, alpha, `${dictionary} /ColorSpace /DeviceGray`) : null;
  const id = await compressedStream(pdf, rgb, `${dictionary} /ColorSpace /DeviceRGB${mask ? ` /SMask ${mask} 0 R` : ''}`);
  return pdf.resource('XObject', id);
}

async function embedAsset(pdf, asset) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') fail('embedding images requires a browser.');
  checkPixels(asset.width, asset.height);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`PDF export: could not decode image “${asset.name}”. Reimport the image and try again.`));
    img.src = asset.dataUrl;
  });
  checkPixels(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) fail('could not allocate an image canvas. Use a smaller image.');
    context.drawImage(image, 0, 0);
    return await embedPixels(pdf, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  } finally { canvas.width = 0; canvas.height = 0; }
}

function transform(item) {
  const radians = item.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const x = item.width / 2, y = item.height / 2;
  return `${[cos, sin, -sin, cos, item.x + x - cos * x + sin * y, item.y + y - sin * x - cos * y].map(n).join(' ')} cm`;
}

function shape(pdf, item) {
  if (item.type === 'shape') {
    const stroke = color(item.stroke), commands = [];
    stroke.alpha *= item.strokeOpacity ?? 1;
    const dash = `[${strokeDashArray(item).map(n).join(' ')}] 0 d`;
    for (const path of item.paths) {
      const fill = color(path.fillMode === 'none' ? 'none' : shadeColor(item.fill, path.fillMode));
      fill.alpha *= item.fillOpacity ?? 1;
      const filled = fill.alpha > 0, stroked = path.stroke && stroke.alpha > 0 && item.strokeWidth > 0;
      if (!filled && !stroked) continue;
      const geometry = path.commands.map(([op, ...values]) => {
        if (op === 'Z') return 'h';
        return `${values.map((value, index) => n(value * (index % 2 ? item.height : item.width))).join(' ')} ${{ M: 'm', L: 'l', C: 'c' }[op]}`;
      }).join('\n');
      commands.push(`q ${pdf.alpha(fill.alpha, stroke.alpha)}\n${fill.rgb} rg\n${stroke.rgb} RG\n${n(item.strokeWidth)} w\n0 J 0 j 4 M\n${dash}\n${geometry}\n${filled ? (stroked ? 'B' : 'f') : 'S'} Q`);
    }
    if (!commands.length) return null;
    const bounds = vectorShapeBounds(item);
    return { bounds: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height], content: commands.join('\n') + '\n' };
  }
  const fill = color(isLineShape(item) ? 'none' : item.fill), stroke = color(item.stroke);
  fill.alpha *= item.fillOpacity ?? 1;
  stroke.alpha *= item.strokeOpacity ?? 1;
  const filled = fill.alpha > 0, stroked = stroke.alpha > 0 && item.strokeWidth > 0;
  if (!filled && !stroked) return null;
  const box = shapeBounds(item), bounds = [box.x, box.y, box.x + box.width, box.y + box.height];
  const path = commands => commands.map(([op, ...values]) => [...values.map(n), { M: 'm', L: 'l', C: 'c', Z: 'h' }[op]].join(' ')).join('\n');
  const geometry = item.type === 'rect' ? `0 0 ${n(item.width)} ${n(item.height)} re` : path(shapePath(item));
  const heads = stroked ? arrowHeads(item) : [];
  const dash = `[${strokeDashArray(item).map(n).join(' ')}] 0 d`;
  let content = `${pdf.alpha(fill.alpha, heads.length ? 1 : stroke.alpha)}\n${fill.rgb} rg\n${stroke.rgb} RG\n${n(item.strokeWidth)} w\n0 J ${isLineShape(item) ? 1 : 0} j 4 M\n${dash}\n${geometry}\n${filled ? (stroked ? 'B' : 'f') : 'S'}\n`;
  if (heads.length) {
    content += `[] 0 d\n${heads.map(points => path(points.map(([x, y], i) => [i ? 'L' : 'M', x, y]))).join('\n')}\nS\n`;
    // Composite opaque shaft and heads first, so intersections do not darken.
    const form = pdf.add(pdf.stream(content, `/Type /XObject /Subtype /Form /BBox [${bounds.map(n).join(' ')}] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources ${pdf.resourceDictionary()}`));
    const name = pdf.resource('XObject', form);
    content = `${pdf.alpha(stroke.alpha)} /${name} Do\n`;
  }
  return { bounds, content };
}

function textShape(pdf, item, lines) {
  const fill = color(item.color);
  if (!fill.alpha) return null;
  const commands = [`${pdf.alpha(fill.alpha)}\n${fill.rgb} rg`], bounds = [Infinity, Infinity, -Infinity, -Infinity];
  lines.forEach((line, index) => {
    if (!line.bounds) return;
    const x = item.align === 'center' ? (item.width - line.width) / 2 : item.align === 'right' ? item.width - line.width : 0;
    const baseline = item.fontSize * (1 + index * 1.2);
    commands.push(`q 1 0 0 -1 ${n(x)} ${n(baseline)} cm\n${line.path}\nf Q`);
    bounds[0] = Math.min(bounds[0], x + line.bounds[0]); bounds[1] = Math.min(bounds[1], baseline - line.bounds[3]);
    bounds[2] = Math.max(bounds[2], x + line.bounds[2]); bounds[3] = Math.max(bounds[3], baseline - line.bounds[1]);
  });
  return commands.length > 1 ? { bounds, content: commands.join('\n') + '\n' } : null;
}

/** Vectors stay vectors; image shadows and gradient shapes use individual raster patches. */
export async function exportPDF(input, dpi = 300) {
  const project = posterProject(validateProject(input));
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi < 1 || dpi > 2400) fail('export DPI must be a finite number between 1 and 2400.');
  const visible = project.items.filter(item => !item.hidden && item.opacity > 0);
  const outlines = await textOutlines(visible.filter(item => item.type === 'text' && item.text.trim() && color(item.color).alpha > 0));
  const pdf = writer(), assets = new Map(project.assets.map(asset => [asset.id, asset])), images = new Map();
  const { width, height, background } = project.canvas;
  const commands = [`q .75 0 0 -.75 0 ${n(height * .75)} cm\n0 0 ${n(width)} ${n(height)} re W n`];
  const backdrop = shape(pdf, { type: 'rect', width, height, fill: background, stroke: 'none', strokeWidth: 0 });
  if (backdrop) commands.push(`q\n${backdrop.content}Q`);
  for (const item of visible) {
    // Raster patches use unrotated local axes; preserve fixed world shadow direction.
    const localShadow = item.shadow?.rotateWithShape === false ? {shadow:{...item.shadow,angle:((item.shadow.angle-item.rotation)%360+360)%360,rotateWithShape:true}} : {};
    let drawing;
    if (item.type !== 'image' && (item.softEdge > 0 || item.shadow?.enabled || item.strokeGradient || item.fillGradient)) {
      const bounds = shadowBounds(item);
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      // The raster canvas requires at least 1 CSS px; keep thin strokes centered.
      if (bounds.width < 1) { bounds.x -= (1-bounds.width)/2; bounds.width = 1; }
      if (bounds.height < 1) { bounds.y -= (1-bounds.height)/2; bounds.height = 1; }
      checkPixels(Math.max(1, Math.round(bounds.width * dpi / 96)), Math.max(1, Math.round(bounds.height * dpi / 96)));
      const local = { ...project, canvas: { width: bounds.width, height: bounds.height, background: 'transparent' }, assets: [], items: [{ ...item, ...localShadow, x: -bounds.x, y: -bounds.y, rotation: 0, opacity: 1 }] };
      const name = await withRasterCanvas(local, dpi, async (canvas, context) => embedPixels(pdf, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height), 'PDF gradient shape', {gradientRotation:item.rotation});
      drawing = { bounds: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height], content: `q ${n(bounds.width)} 0 0 ${n(-bounds.height)} ${n(bounds.x)} ${n(bounds.y + bounds.height)} cm /${name} Do Q\n` };
    }
    else if (item.type === 'text') drawing = outlines.has(item.id) ? textShape(pdf, item, outlines.get(item.id)) : null;
    else if (item.type !== 'image') drawing = shape(pdf, item);
    else {
      const asset = assets.get(item.assetId), shadow = item.shadow;
      if (asset.mime === 'image/svg+xml' || item.softEdge > 0 || item.strokeWidth > 0 || (shadow?.enabled && shadow.transparency < 100 && shadow.size > 0)) {
        const bounds = shadowBounds(item);
        checkPixels(Math.max(1, Math.round(bounds.width * dpi / 96)), Math.max(1, Math.round(bounds.height * dpi / 96)));
        const local = { ...project, canvas: { width: bounds.width, height: bounds.height, background: 'transparent' }, assets: [asset], items: [{ ...item, ...localShadow, x: -bounds.x, y: -bounds.y, rotation: 0, opacity: 1 }] };
        const name = await withRasterCanvas(local, dpi, async (canvas, context) => embedPixels(pdf, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height), 'PDF shadow', {gradientRotation:item.rotation});
        drawing = { bounds: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height], content: `q ${n(bounds.width)} 0 0 ${n(-bounds.height)} ${n(bounds.x)} ${n(bounds.y + bounds.height)} cm /${name} Do Q\n` };
      } else {
        if (!images.has(asset.id)) images.set(asset.id, await embedAsset(pdf, asset));
        const crop = imageCrop(item), w = item.width / crop.width, h = item.height / crop.height;
        drawing = { bounds: [0, 0, item.width, item.height], content: `q 0 0 ${n(item.width)} ${n(item.height)} re W n\n${n(w)} 0 0 ${n(-h)} ${n(-crop.x * w)} ${n((1 - crop.y) * h)} cm /${images.get(asset.id)} Do Q\n` };
      }
    }
    if (!drawing) continue;
    commands.push(`q\n${transform(item)}`);
    if (item.opacity < 1) {
      // Apply object opacity once after fill/stroke/shadow composition, matching SVG group opacity.
      const form = pdf.add(pdf.stream(drawing.content, `/Type /XObject /Subtype /Form /BBox [${drawing.bounds.map(n).join(' ')}] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources ${pdf.resourceDictionary()}`));
      const name = pdf.resource('XObject', form);
      commands.push(`${pdf.alpha(item.opacity)} /${name} Do`);
    } else commands.push(drawing.content);
    commands.push('Q');
  }
  commands.push('Q');
  return pdf.finish(width, height, commands.join('\n'));
}
