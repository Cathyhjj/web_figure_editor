import { cloneDeck, validateDeck, slideProject } from './deck.js';
import { uid, exportPNG, projectToSVG } from './core.js';
import { exportPDF } from './pdf.js';
import { exportPPTX } from './pptx.js';
import { generateHTMLReport } from './report.js';
import { isMediaItem } from './video.js';
import { resizeMediaDimension } from './resize.js';

// Small, explicit editing vocabulary. Neither document replacement nor arbitrary
// JavaScript/asset writes are accepted through the live control interface.
const geometry = ['x', 'y', 'width', 'height', 'rotation', 'opacity'];
const textFields = ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'align'];
const fields = ['name', ...geometry, ...textFields];
const fail = message => { throw new Error(message); };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unsupported ${label} field: ${key}.`);
}
function properties(item, patch) {
  keys(patch, fields, 'properties');
  if (!Object.keys(patch).length) fail('Supply at least one property.');
  for (const [key, value] of Object.entries(patch)) {
    if (textFields.includes(key) && item.type !== 'text') fail(`${key} is only supported on text objects.`);
    if ([...geometry, 'fontSize'].includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${key} must be a finite number.`);
      if (['width', 'height', 'fontSize'].includes(key) && value <= 0) fail(`${key} must be positive.`);
    } else if (key === 'fontWeight') {
      if (![400, 700, '400', '700'].includes(value)) fail('fontWeight must be 400 or 700.');
    } else if (typeof value !== 'string') fail(`${key} must be a string.`);
  }
  // Match the inspector: a single media dimension preserves its aspect ratio.
  if (isMediaItem(item) && (('width' in patch) !== ('height' in patch))) {
    const dimension = 'width' in patch ? 'width' : 'height';
    Object.assign(item, resizeMediaDimension(item, dimension, patch[dimension]));
  }
  Object.assign(item, patch);
}
function targets(slide, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || new Set(ids).size !== ids.length) fail('itemIds must contain unique object IDs.');
  return ids.map(id => {
    const item = slide.items.find(item => item.id === id);
    if (!item) fail(`Object ${id} does not exist on slide ${slide.id}.`);
    if (item.locked) fail(`Object ${id} is locked. Unlock it in the editor first.`);
    return item;
  });
}

/** Prepare the entire batch without changing the live document. */
export function prepareBatch(project, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 200) fail('Supply 1–200 operations.');
  const next = cloneDeck(project), changed = new Set(), created = [];
  for (const op of operations) {
    keys(op, ['op', 'slideId', 'itemIds', 'properties', 'alignment', 'axis', 'gap'], 'operation');
    const allowed = {
      set: ['op', 'slideId', 'itemIds', 'properties'],
      align: ['op', 'slideId', 'itemIds', 'alignment'],
      distribute: ['op', 'slideId', 'itemIds', 'axis', 'gap'],
      add_text: ['op', 'slideId', 'properties'],
    }[op.op];
    if (!allowed) fail('Supported operations: set, align, distribute, add_text.');
    keys(op, allowed, op.op);
    const slide = next.slides.find(slide => slide.id === op.slideId);
    if (!slide) fail(`Unknown slide: ${op.slideId}.`);
    if (op.op === 'add_text') {
      const item = { id: uid(), type: 'text', name: 'Text', x: 80, y: 80, width: 160, height: 40,
        rotation: 0, opacity: 1, locked: false, hidden: false, text: '', fontSize: 24,
        fontFamily: 'Arial', fontWeight: 400, fontStyle: 'normal', color: '#222222', align: 'left' };
      properties(item, op.properties);
      slide.items.push(item); created.push(item.id); changed.add(item.id);
      continue;
    }
    const items = targets(slide, op.itemIds);
    if (op.op === 'set') for (const item of items) properties(item, op.properties);
    else {
      // Bounds of rotated shapes are visually ambiguous; exact placement remains
      // possible with set. Alignment uses unrotated boxes, just like the toolbar.
      if (items.some(item => item.rotation % 360 !== 0)) fail('Align/distribute requires unrotated objects. Use set for rotated objects.');
      if (op.op === 'align') {
        if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(op.alignment)) fail('Invalid alignment.');
        const horizontal = ['left', 'center', 'right'].includes(op.alignment);
        const axis = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
        const start = items.length === 1 ? 0 : Math.min(...items.map(item => item[axis]));
        const end = items.length === 1 ? slide.canvas[size] : Math.max(...items.map(item => item[axis] + item[size]));
        for (const item of items) item[axis] = ['left', 'top'].includes(op.alignment) ? start
          : ['right', 'bottom'].includes(op.alignment) ? end - item[size] : (start + end - item[size]) / 2;
      } else {
        if (!['x', 'y'].includes(op.axis)) fail('axis must be x or y.');
        if (items.length < 2 || (op.gap === undefined && items.length < 3)) fail('Distribute needs 3 objects, or 2 with an explicit gap.');
        if (op.gap !== undefined && (typeof op.gap !== 'number' || !Number.isFinite(op.gap) || op.gap < 0 || op.gap > 100000)) fail('gap must be between 0 and 100000 px.');
        const size = op.axis === 'x' ? 'width' : 'height';
        items.sort((a, b) => a[op.axis] - b[op.axis]);
        const start = items[0][op.axis], end = items.at(-1)[op.axis] + items.at(-1)[size];
        const gap = op.gap ?? (end - start - items.reduce((sum, item) => sum + item[size], 0)) / (items.length - 1);
        let position = start;
        for (const item of items) { item[op.axis] = position; position += item[size] + gap; }
      }
    }
    for (const item of items) changed.add(item.id);
  }
  return { project: validateDeck(next), changedItemIds: [...changed], createdItemIds: created };
}

/** State is intentionally free of embedded images, HTML scripts and file handles. */
export function describeProject(project, slideId = project.activeSlideId) {
  const slide = project.slides.find(slide => slide.id === slideId);
  if (!slide) fail(`Unknown slide: ${slideId}.`);
  const visibleFields = ['id', 'type', ...fields, 'locked', 'hidden', 'assetId'];
  return {
    project: { id: project.id, name: project.name }, activeSlideId: project.activeSlideId,
    slides: project.slides.map(page => ({ id: page.id, name: page.name, canvas: { ...page.canvas }, itemCount: page.items.length })),
    slide: { id: slide.id, name: slide.name, canvas: { ...slide.canvas }, items: slide.items.map(item => Object.fromEntries(visibleFields.filter(key => key in item).map(key => [key, item[key]]))) },
    assets: project.assets.map(asset => ({ id: asset.id, name: asset.name, mime: asset.mime, width: asset.width, height: asset.height })),
  };
}

export async function renderAutomation(project, params, preview = false) {
  keys(params, preview ? ['slideId', 'maxSize'] : ['slideId', 'format', 'dpi'], 'render');
  const format = preview ? 'png' : params.format;
  if (!['png', 'svg', 'pdf', 'pptx', 'html'].includes(format)) fail('Unsupported export format.');
  if (['pptx', 'html'].includes(format) && params.slideId !== undefined) fail('PPTX and HTML export all slides; omit slideId.');
  let blob, width, height, dpi = params.dpi ?? 300;
  if (!preview && ![150, 300, 600].includes(dpi)) fail('dpi must be 150, 300 or 600.');
  if (format === 'pptx') blob = await exportPPTX(project);
  else if (format === 'html') blob = new Blob([generateHTMLReport(project)], { type: 'text/html' });
  else {
    const page = slideProject(project, params.slideId ?? project.activeSlideId);
    const used = new Set(page.items.filter(isMediaItem).map(item => item.assetId));
    page.assets = page.assets.filter(asset => used.has(asset.id));
    if (preview) {
      const maxSize = params.maxSize ?? 1200;
      if (!Number.isInteger(maxSize) || maxSize < 256 || maxSize > 1600) fail('maxSize must be 256–1600 px.');
      dpi = Math.min(96, maxSize * 96 / Math.max(page.canvas.width, page.canvas.height));
    }
    width = Math.max(1, Math.round(page.canvas.width * dpi / 96));
    height = Math.max(1, Math.round(page.canvas.height * dpi / 96));
    blob = format === 'png' ? await exportPNG(page, dpi) : format === 'pdf' ? await exportPDF(page, dpi)
      : new Blob([projectToSVG(page)], { type: 'image/svg+xml' });
  }
  if (blob.size > 24 * 1024 * 1024) fail('Export exceeds the 24 MiB AI bridge limit. Use the editor Export dialog for larger files.');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { data, mimeType: blob.type, bytes: blob.size, format,
    ...(format === 'png' ? { width, height, dpi } : {}),
    slideIds: ['pptx', 'html'].includes(format) ? project.slides.map(page => page.id) : [params.slideId ?? project.activeSlideId] };
}

/** Same-origin long polling keeps the active browser document authoritative. */
export function connectAutomation({ execute, summary, button, fetcher = fetch }) {
  let enabled = true, resumeEnabled = true, stopped = false, sessionId = null, token = null, controller = null;
  let delay = 500;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const show = (label, title) => { if (button) { button.textContent = label; button.title = title; button.setAttribute('aria-pressed', String(enabled)); } };
  async function request(action, body, signal) {
    const response = await fetcher(`/api/automation/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Figure-Token': token }, body: JSON.stringify(body), signal });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'AI bridge unavailable.'), { status: response.status });
    return data;
  }
  async function disconnect() {
    const old = sessionId; sessionId = null;
    if (old && token) { try { await request('disconnect', { sessionId: old }); } catch { /* Expiration also removes closed tabs. */ } }
  }
  if (button) button.onclick = () => {
    enabled = !enabled; controller?.abort();
    if (!enabled) { void disconnect(); show('AI paused', 'Click to reconnect this page to local AI tools.'); }
  };
  async function run() {
    while (!stopped) {
      if (!enabled) { await pause(500); continue; }
      try {
        if (!sessionId) {
          const info = await (await fetcher('/api/local')).json();
          if (!info.automation) { show('AI unavailable', 'Restart the local Figure Editor server to enable AI control.'); await pause(10000); continue; }
          token = info.token;
          sessionId = (await request('register', { summary: summary() })).sessionId;
          if (!enabled || stopped) { await disconnect(); continue; }
        }
        show('AI connected', `Local AI tools can control this page. Click to pause. Session: ${sessionId}`);
        const current = sessionId;
        controller = new AbortController();
        const { command } = await request('poll', { sessionId: current, summary: summary() }, controller.signal);
        delay = 500;
        if (!command || !enabled || current !== sessionId) continue;
        let result;
        try {
          if (Date.now() > command.expiresAt) throw new Error('Command expired before execution; read state before retrying.');
          result = { ok: true, value: await execute(command.method, command.params) };
        } catch (error) { result = { ok: false, error: error.message }; }
        // Retry delivery only, never execute a command again after a network error.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await request('result', { sessionId: current, commandId: command.id, result }); break; }
          catch (error) { if (error.status || attempt === 2) throw error; await pause(250); }
        }
      } catch (error) {
        if (enabled && !stopped) show('AI reconnecting', 'Reconnecting to the local server. Editing remains available.');
        await disconnect(); token = null;
        if (!stopped) await pause(delay);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }
  void run();
  const stop = () => { stopped = true; controller?.abort(); void disconnect(); };
  globalThis.addEventListener?.('pagehide', event => {
    if (event.persisted) { resumeEnabled = enabled; enabled = false; controller?.abort(); void disconnect(); }
    else stop();
  });
  globalThis.addEventListener?.('pageshow', event => { if (event.persisted && !stopped) enabled = resumeEnabled; });
  return { stop };
}
