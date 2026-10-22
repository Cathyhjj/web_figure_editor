import { parseSVG, svgDataURL } from './svg-vector.js';
import { isMP4, readVideoMetadata } from './video.js';
import { HTML_MIME, looksLikeHTML, readHTMLMetadata } from './html-chart.js';
/** Local image IO. The editable project embeds copies; filesystem handles never leave IndexedDB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_SIDE = 16_384;
const DB_NAME = 'figure-editor-local-assets-v1';
const STORE_NAME = 'handles';
const memoryHandles = new Map();
const sessionHandles = new WeakSet();
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
  // Legacy dropped entries can be read again, but cannot be serialized to IndexedDB.
  if (sessionHandles.has(handle)) return false;
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
    lastModified: Number(file.lastModified) || 0, sourceKind: 'copy', sourceOrigin: 'file',
  };
  if (relativePath) asset.relativePath = relativePath;
  const digest = await fingerprint(buffer);
  if (digest) asset.fingerprint = digest;
  if (mime === HTML_MIME) {
    Object.assign(asset, await readHTMLMetadata(bytes, asset.name));
  } else if (mime === 'video/mp4') {
    Object.assign(asset, await readVideoMetadata(bytes));
  } else if (mime === 'image/svg+xml') {
    const svg = parseSVG(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    asset.svgDocument = svg.document;
    asset.dataUrl = svgDataURL(svg.document);
    asset.originalDataUrl = originalDataUrl;
    asset.originalMime = mime;
    asset.width = svg.width;
    asset.height = svg.height;
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
      const handle = { kind: 'file', name: entry.name,
        getFile: () => new Promise((resolve, reject) => entry.file(resolve, reject)) };
      sessionHandles.add(handle);
      yield { file: await handle.getFile(), handle, relativePath, filter };
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
    const permission = sessionHandles.has(handle) ? 'granted'
      : typeof handle.queryPermission === 'function' ? await handle.queryPermission({ mode: 'read' }) : 'prompt';
    const scope = asset?.linkPersistence === 'session' ? 'this session only' : 'this browser';
    return permission === 'granted' ? `Local file linked (${scope})` : `File handle saved; permission required to refresh (${scope})`;
  } catch { return 'Link unavailable. Relink the file; the embedded copy is preserved.'; }
}
