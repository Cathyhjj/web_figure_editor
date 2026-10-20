import { isMP4, readVideoMetadata } from './video.js';
import { HTML_MIME, looksLikeHTML, readHTMLMetadata } from './html-chart.js';
/** Local image IO. The editable project embeds copies; filesystem handles never leave IndexedDB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_SIDE = 16_384;
const SVG_MAX_PIXELS = 24_000_000;
const SVG_MAX_SIDE = 8_192;
const DB_NAME = 'figure-editor-local-assets-v1';
const STORE_NAME = 'handles';
const memoryHandles = new Map();
let databasePromise;

const pickerOptions = {
  multiple: true,
  excludeAcceptAllOption: true,
  types: [{ description: 'Images, MP4 videos and HTML charts', accept: {
    'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'], 'image/svg+xml': ['.svg'], 'video/mp4': ['.mp4'], 'text/html': ['.html', '.htm'],
  } }],
};

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readableError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'File read permission was not granted. Relink the file and allow read access.';
  }
  if (error?.name === 'NotFoundError') return 'The original file was moved or deleted. Relink the file.';
  return error?.message || 'Unable to read the image.';
}

function getDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!databasePromise) {
    databasePromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return databasePromise;
}

async function getHandle(id) {
  if (memoryHandles.has(id)) return memoryHandles.get(id);
  const db = await getDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        if (request.result) memoryHandles.set(id, request.result);
        resolve(request.result || null);
      };
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function handleKey(asset) {
  // Old projects did not contain a token and used the asset id directly.
  return asset.linkToken ? `${asset.id}:${asset.linkToken}` : asset.id;
}

function getAssetHandle(asset) {
  if (asset?.sourceKind !== 'linked') return Promise.resolve(null);
  const key = handleKey(asset);
  // A failed IDB write can leave an older handle under the same id. Never resurrect it.
  if (asset.linkPersistence === 'session' && !memoryHandles.has(key)) return Promise.resolve(null);
  return getHandle(key);
}

async function setHandle(key, handle) {
  memoryHandles.set(key, handle);
  const db = await getDatabase();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(handle, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

function bytesToDataUrl(bytes, mime) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return `data:${mime};base64,${btoa(chunks.join(''))}`;
}

async function fingerprint(buffer) {
  try {
    if (!globalThis.crypto?.subtle) return undefined;
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch { return undefined; }
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('The image is damaged, or this browser cannot decode its format.')); };
    const timer = setTimeout(() => {
      image.src = '';
      reject(new Error('Image decoding timed out. Try a smaller image.'));
    }, 20_000);
    image.src = url;
  });
}

function checkDimensions(width, height) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new Error('The image has no valid width or height.');
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('Image dimensions are too large. Resize to at most 16,384 px per side and 40 million pixels total.');
  }
}

function detectMime(bytes) {
  if (isMP4(bytes)) return 'video/mp4';
  if (bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (looksLikeHTML(bytes)) return HTML_MIME;
  const start = new TextDecoder().decode(bytes.subarray(0, 8192));
  if (/<(?:[A-Za-z_][\w.-]*:)?svg(?:\s|>)/i.test(start)) return 'image/svg+xml';
  throw new Error('Only PNG, JPEG, WebP, SVG images, MP4 videos and HTML charts are supported. Formats are identified by actual file contents.');
}

// Read available raster dimensions before asking the browser to decode compressed pixels.
function checkRasterHeader(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24) {
    checkDimensions(view.getUint32(16), view.getUint32(20));
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        checkDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        return;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8X') {
      checkDimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
    } else if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      checkDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      checkDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
  }
}

const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'title', 'desc', 'style', 'image', 'switch',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'filter',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG',
  'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';

function checkCss(css) {
  const value = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // No CSS escapes, imports, font downloads, or dynamic image functions.
  if (/[\\@]/.test(value) || /(?:expression|image-set|cross-fade|paint|image|src)\s*\(/i.test(value)) {
    throw new Error('The SVG contains unsupported dynamic styles or external resources. Export it as a self-contained static image.');
  }
  const withoutLocalUrls = value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, '');
  if (/url\s*\(/i.test(withoutLocalUrls)) throw new Error('The SVG references external resources. Embed its images and fonts, or export a PNG.');
}

function svgLength(value) {
  const match = String(value || '').trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(px|pt|pc|in|cm|mm|q)?$/i);
  if (!match) return null;
  const factor = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  return Number(match[1]) * (factor[(match[2] || 'px').toLowerCase()]);
}

/** Validate before anything is assigned to an image URL. Never inject source SVG into the document. */
function safeSvg(source) {
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[|<\?xml-stylesheet\b/i.test(source)) {
    throw new Error('The SVG contains entities, external stylesheets, or complex document declarations and cannot be imported safely.');
  }
  // Common plotting applications emit an SVG 1.1 public doctype; it is not needed for rendering.
  const xml = source.replace(/<!DOCTYPE[^>]*>/gi, '');
  const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The SVG contains invalid XML.');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NS)) throw new Error('The file is not a valid SVG.');
  // Authoring metadata does not affect rendering and may use unrelated XML namespaces.
  for (const element of [...doc.getElementsByTagName('*')]) {
    if (element.localName === 'metadata' || (element.namespaceURI && element.namespaceURI !== SVG_NS)) {
      element.remove();
    }
  }
  let count = 0;
  for (const element of [...doc.getElementsByTagName('*')]) {
    if (++count > 100_000) throw new Error('The SVG contains too many elements. Simplify it or export a PNG.');
    if (!SVG_TAGS.has(element.localName)) throw new Error(`The SVG contains an unsupported ${element.localName} element. Only static images are supported.`);
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (/^on/i.test(name) || name === 'src' || (attribute.prefix === 'xml' && name === 'base')) {
        throw new Error('The SVG contains event scripts or external resource settings and cannot be imported.');
      }
      if (name === 'href') {
        const localReference = /^#[\w:.-]+$/.test(value);
        const embeddedImage = ['image', 'feImage'].includes(element.localName)
          && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
        if (!localReference && !embeddedImage) throw new Error('The SVG contains external links. Embed external images in the SVG first.');
      }
      // Presentation attributes are CSS too. Checking all values prevents escaped url() bypasses.
      checkCss(value);
    }
    if (element.localName === 'style') checkCss(element.textContent || '');
  }
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const validViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  let width = svgLength(root.getAttribute('width'));
  let height = svgLength(root.getAttribute('height'));
  if (validViewBox) {
    if (!width && !height) [width, height] = viewBox.slice(2);
    else if (!width) width = height * viewBox[2] / viewBox[3];
    else if (!height) height = width * viewBox[3] / viewBox[2];
  }
  width ||= 300;
  height ||= 150;
  if (!(Number.isFinite(width + height) && width > 0 && height > 0)) throw new Error('The SVG has no valid dimensions.');
  const scale = Math.min(3, SVG_MAX_SIDE / width, SVG_MAX_SIDE / height, Math.sqrt(SVG_MAX_PIXELS / width / height));
  const rasterWidth = Math.max(1, Math.round(width * scale));
  const rasterHeight = Math.max(1, Math.round(height * scale));
  // Preserve physical coordinate system when replacing CSS/print units with raster dimensions.
  if (!validViewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('xmlns', SVG_NS);
  root.setAttribute('width', String(rasterWidth));
  root.setAttribute('height', String(rasterHeight));
  return { xml: new XMLSerializer().serializeToString(root), width: rasterWidth, height: rasterHeight, scale };
}

async function buildAsset(file, id = newId(), relativePath = file?.webkitRelativePath) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Unable to read the file. Select a local image again.');
  if (file.size === 0) throw new Error('The file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Each image or video must be 25 MB or smaller.');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Each image or video must be 25 MB or smaller.');
  const mime = detectMime(bytes);
  if (mime !== 'image/svg+xml') checkRasterHeader(bytes, mime);
  const originalDataUrl = bytesToDataUrl(bytes, mime);
  const asset = {
    id, name: file.name || 'image', mime, dataUrl: originalDataUrl,
    width: 0, height: 0, size: bytes.length,
    lastModified: Number(file.lastModified) || 0, sourceKind: 'copy',
  };
  if (relativePath) asset.relativePath = relativePath;
  const digest = await fingerprint(buffer);
  if (digest) asset.fingerprint = digest;
  if (mime === HTML_MIME) {
    Object.assign(asset, await readHTMLMetadata(bytes, asset.name));
  } else if (mime === 'video/mp4') {
    Object.assign(asset, await readVideoMetadata(bytes));
  } else if (mime === 'image/svg+xml') {
    const svg = safeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const safeDataUrl = bytesToDataUrl(new TextEncoder().encode(svg.xml), 'image/svg+xml');
    const image = await imageFromUrl(safeDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = svg.width;
    canvas.height = svg.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create an image canvas.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    asset.dataUrl = canvas.toDataURL('image/png');
    if (!asset.dataUrl.startsWith('data:image/png;')) throw new Error('SVG conversion failed. Try a smaller image.');
    if (asset.dataUrl.length > 40 * 1024 * 1024 * 4 / 3 + 64) throw new Error('The rasterized SVG exceeds 40 MB as a PNG. Resize or simplify the original image.');
    asset.mime = 'image/png';
    asset.originalDataUrl = originalDataUrl;
    asset.originalMime = mime;
    asset.rasterized = true;
    asset.rasterizationScale = svg.scale;
    asset.width = svg.width;
    asset.height = svg.height;
    canvas.width = canvas.height = 0;
  } else {
    const image = await imageFromUrl(originalDataUrl);
    checkDimensions(image.naturalWidth, image.naturalHeight);
    asset.width = image.naturalWidth;
    asset.height = image.naturalHeight;
  }
  return asset;
}

async function associateHandle(asset, handle, linkToken = newId()) {
  if (!handle || handle.kind !== 'file' || typeof handle.getFile !== 'function') return asset;
  // Associations are immutable: undo can restore an older token and its corresponding file.
  const linked = { ...asset, sourceKind: 'linked', linkToken };
  const persisted = await setHandle(handleKey(linked), handle);
  return { ...linked, linkPersistence: persisted ? 'browser' : 'session' };
}

function isImageCandidate(file) {
  return /\.(?:png|jpe?g|webp|svg|mp4|html?)$/i.test(file?.name || '')
    || /^(?:image\/(?:png|jpeg|webp|svg\+xml)|video\/mp4|text\/html)$/i.test(file?.type || '');
}

// Records keep paths separate from File objects, whose webkitRelativePath is read-only.
async function importRecords(records) {
  const assets = [];
  const errors = [];
  let skipped = 0;
  let total = 0;
  let totalPixels = 0;
  let embeddedBytes = 0;
  for await (const record of records) {
    if (record.error) {
      errors.push({ name: record.relativePath || 'Unknown file', message: readableError(record.error) });
      continue;
    }
    const { file, handle, relativePath = file?.webkitRelativePath } = record;
    if (record.filter && !isImageCandidate(file)) { skipped++; continue; }
    try {
      if (total + Number(file.size || 0) > MAX_IMPORT_BYTES) throw new Error('Each import is limited to 100 MB of media. Import smaller batches.');
      const asset = await buildAsset(file, undefined, relativePath);
      const sizeOfCopy = asset.dataUrl.length + (asset.originalDataUrl?.length || 0) + (asset.posterDataUrl?.length || 0);
      if (embeddedBytes + sizeOfCopy > MAX_IMPORT_BYTES * 4 / 3 || totalPixels + asset.width * asset.height > 64_000_000) {
        throw new Error('The decoded batch exceeds 64 million pixels or 100 MB of assets. Resize the images or import smaller batches.');
      }
      total += asset.size;
      totalPixels += asset.width * asset.height;
      embeddedBytes += sizeOfCopy;
      assets.push(await associateHandle(asset, handle));
    } catch (error) {
      errors.push({ name: relativePath || file?.name || 'Unknown file', message: readableError(error) });
    }
  }
  return { assets, errors, skipped };
}

/** File failures are independent: valid images still import, with a per-file error list. */
export async function importFiles(files, handleMap = new Map()) {
  const records = Array.from(files || [], (file) => ({ file, handle: handleMap?.get?.(file) }));
  const { assets, errors } = await importRecords(records);
  return { assets, errors };
}

/** Directory-input fallback: preserve the selected root and all nested directory names. */
export function importFolderFiles(files) {
  return importRecords(Array.from(files || [], (file) => ({ file, filter: true })));
}

function childPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

async function* walkHandle(handle, relativePath, filter = true, depth = 0) {
  try {
    if (depth > 64) throw new Error('The folder is nested too deeply. Select a folder closer to these images.');
    if (handle.kind === 'file') {
      yield { file: await handle.getFile(), handle, relativePath, filter };
    } else if (handle.kind === 'directory') {
      for await (const child of handle.values()) {
        yield* walkHandle(child, childPath(relativePath, child.name), true, depth + 1);
      }
    }
  } catch (error) { yield { relativePath: relativePath || handle.name, error }; }
}

async function* walkEntry(entry, relativePath, filter = true, depth = 0) {
  try {
    if (depth > 64) throw new Error('The folder is nested too deeply. Select a folder closer to these images.');
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      yield { file, relativePath, filter };
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // Chromium returns directory entries in batches, so one readEntries call is insufficient.
      while (true) {
        const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) yield* walkEntry(child, childPath(relativePath, child.name), true, depth + 1);
      }
    }
  } catch (error) { yield { relativePath: relativePath || entry.name, error }; }
}

/** Call directly in the click handler to retain the user gesture. Access is read-only. */
export async function pickFolder() {
  if (typeof globalThis.showDirectoryPicker !== 'function') return null;
  try {
    const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
    return await importRecords(walkHandle(handle, handle.name));
  } catch (error) {
    if (error?.name === 'AbortError') return { assets: [], errors: [] };
    if (error?.name === 'SecurityError') return null;
    return { assets: [], errors: [{ name: 'Select folder', message: readableError(error) }] };
  }
}

/** Snapshot every drop source before the first await: browsers protect DataTransfer afterwards. */
export function importDroppedFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  const sources = [];
  let fileIndex = 0;
  for (const item of Array.from(dataTransfer?.items || [])) {
    if (item.kind !== 'file') continue;
    const source = { file: files[fileIndex++] };
    try { source.file = item.getAsFile?.() || source.file; } catch (error) { source.error = error; }
    try { source.entry = item.webkitGetAsEntry?.(); } catch (error) { source.error = error; }
    try {
      // Start and settle handle promises now, even if earlier files take time to decode.
      if (item.getAsFileSystemHandle) source.handleResult = Promise.resolve(item.getAsFileSystemHandle())
        .then((handle) => ({ handle }), (error) => ({ error }));
    } catch (error) { source.error = error; }
    sources.push(source);
  }
  async function* droppedRecords() {
    if (!sources.length) {
      for (const file of files) yield { file };
      return;
    }
    for (const source of sources) {
      const result = source.handleResult ? await source.handleResult : null;
      if (result?.handle) {
        const handle = result.handle;
        yield* walkHandle(handle, handle.kind === 'directory' ? handle.name : undefined, false);
      } else if (source.entry) {
        yield* walkEntry(source.entry, source.entry.isDirectory ? source.entry.name : undefined, false);
      } else if (source.file) {
        yield { file: source.file };
      } else {
        yield { relativePath: 'Dropped item', error: result?.error || source.error || new Error('Unable to read the dropped item. Select the folder or images again.') };
      }
    }
  }
  return importRecords(droppedRecords());
}

/** Call directly in the click handler so showOpenFilePicker retains the user gesture. */
export async function pickImages() {
  if (typeof globalThis.showOpenFilePicker !== 'function') return null;
  try {
    const handles = await globalThis.showOpenFilePicker(pickerOptions);
    const files = [];
    const handleMap = new Map();
    const errors = [];
    for (const handle of handles) {
      try {
        const file = await handle.getFile();
        files.push(file);
        handleMap.set(file, handle);
      } catch (error) { errors.push({ name: handle.name || 'Unknown file', message: readableError(error) }); }
    }
    const result = await importFiles(files, handleMap);
    return { assets: result.assets, errors: [...errors, ...result.errors] };
  } catch (error) {
    if (error?.name === 'AbortError') return { assets: [], errors: [] };
    // Some otherwise supported environments prohibit the native picker (e.g. embedded browser).
    if (error?.name === 'SecurityError') return null;
    return { assets: [], errors: [{ name: 'Select images', message: readableError(error) }] };
  }
}

/** A replacement changes the portable copy and source record, retaining the asset id and layout. */
export async function replaceAsset(asset, file, handle) {
  if (!asset?.id) throw new Error('No asset is selected.');
  const replacement = await buildAsset(file, asset.id, replacementPath(asset, file));
  if ((replacement.mime === 'video/mp4') !== (asset.mime === 'video/mp4')) throw new Error('Replace a video with another MP4, or an image with another image.');
  if ((replacement.mime === HTML_MIME) !== (asset.mime === HTML_MIME)) throw new Error('Replace an HTML chart with another HTML chart.');
  if (handle) return associateHandle(replacement, handle);
  // Leave previous handles intact for undo. This new copy has no linkage fields.
  return replacement;
}

function replacementPath(asset, file) {
  if (file?.webkitRelativePath) return file.webkitRelativePath;
  if (!asset.relativePath) return undefined;
  const slash = asset.relativePath.lastIndexOf('/');
  return childPath(slash >= 0 ? asset.relativePath.slice(0, slash) : '', file?.name || asset.name);
}

/** Returns null for an input[type=file] fallback; cancellation throws AbortError. */
export async function linkAsset(asset) {
  if (typeof globalThis.showOpenFilePicker !== 'function') return null;
  let handles;
  try {
    handles = await globalThis.showOpenFilePicker({ ...pickerOptions, multiple: false });
  } catch (error) {
    if (error?.name === 'SecurityError') return null;
    throw error;
  }
  if (!handles[0]) throw new DOMException('No file was selected.', 'AbortError');
  const file = await handles[0].getFile();
  return replaceAsset(asset, file, handles[0]);
}

/** Must be called from a user action. Reading never asks for write permission. */
export async function refreshAsset(asset) {
  const handle = await getAssetHandle(asset);
  if (!handle) throw new Error('This browser has no file handle for this image. Click Relink to select the original.');
  try {
    if (typeof handle.queryPermission === 'function') {
      let permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted' && typeof handle.requestPermission === 'function') {
        permission = await handle.requestPermission({ mode: 'read' });
      }
      if (permission !== 'granted') throw new Error('Read permission for the original was not granted. The embedded copy is unchanged. Relink the file.');
    }
    const file = await handle.getFile();
    const refreshed = await buildAsset(file, asset.id, replacementPath(asset, file));
    if ((refreshed.mime === 'video/mp4') !== (asset.mime === 'video/mp4')) throw new Error('The original file changed media type. Relink a file of the same type.');
    if ((refreshed.mime === HTML_MIME) !== (asset.mime === HTML_MIME)) throw new Error('The original file changed media type. Relink another HTML chart.');
    return await associateHandle(refreshed, handle, asset.linkToken);
  } catch (error) { throw new Error(readableError(error)); }
}

/** Read-only status; checking status never triggers a permission prompt. */
export async function assetLinkStatus(asset) {
  const handle = await getAssetHandle(asset);
  if (!handle) return asset?.sourceKind === 'linked' ? 'Link unavailable. Relink the file; the embedded copy is preserved.' : 'Embedded project copy';
  try {
    const permission = typeof handle.queryPermission === 'function' ? await handle.queryPermission({ mode: 'read' }) : 'prompt';
    const scope = asset?.linkPersistence === 'session' ? 'this session only' : 'this browser';
    return permission === 'granted' ? `Local file linked (${scope})` : `File handle saved; permission required to refresh (${scope})`;
  } catch { return 'Link unavailable. Relink the file; the embedded copy is preserved.'; }
}
