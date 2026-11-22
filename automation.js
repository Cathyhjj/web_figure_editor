import { cloneDeck, createAssetItem, deckAssetUsage, validateDeck, slideProject } from './deck.js';
import { uid, exportPNG, projectToSVG } from './core.js';
import { exportPDF } from './pdf.js';
import { exportPPTX } from './pptx.js';
import { generateHTMLReport } from './report.js';
import { isMediaItem } from './video.js';
import { cropImage } from './crop.js';
import { applyLayout } from './layout.js';
import { inspectSVGAsset, patchSVGAsset } from './svg-edit.js';
import { SHAPE_TYPES, SHAPE_NAMES, isShapeItem, isLineShape } from './shapes.js';
import { checkLinkedAssetSource, isProjectRelativePath, MAX_IMPORT_BYTES } from './assets.js?v=locate-1';
import { SAC_TEXT_STYLE, sacShapeStyle } from './sac-theme.js';

// Small, explicit editing vocabulary. Neither document replacement nor arbitrary
// JavaScript/asset writes are accepted through the live control interface.
const geometry = ['x', 'y', 'width', 'height', 'rotation', 'opacity'];
const textFields = ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'align'];
const fillFields = ['fill', 'fillOpacity'];
const strokeFields = ['stroke', 'strokeWidth', 'strokeOpacity', 'strokeDash'];
const shapeFields = [...fillFields, ...strokeFields, 'cornerRadius'];
const fields = ['name', ...geometry, ...textFields, ...shapeFields, 'softEdge', 'softEdgeMode', 'softEdgeAngle', 'softEdgeRadius', 'softEdgeStrength'];
const fail = message => { throw new Error(message); };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unsupported ${label} field: ${key}.`);
}
function properties(item, values, { allowEmpty = false } = {}) {
  keys(values, [...fields, 'crop', 'imageFit'], 'properties');
  if (!allowEmpty && !Object.keys(values).length) fail('Supply at least one property.');
  const { crop, imageFit, ...patch } = values;
  if (('crop' in values || 'imageFit' in values) && item.type !== 'image') fail('crop and imageFit require an image object.');
  // The fit mode determines how the native Crop dialog sizes the frame. Any explicit
  // geometry below then describes the final, visible frame, irrespective of key order.
  if ('imageFit' in values) {
    if (imageFit === 'stretch') delete item.imageFit;
    else if (imageFit === 'contain') item.imageFit = imageFit;
    else fail('imageFit must be contain or stretch.');
  }
  if ('crop' in values) {
    if (crop !== null) keys(crop, ['x', 'y', 'width', 'height'], 'crop');
    const cropped = cropImage(item, crop ?? undefined);
    delete item.crop;
    Object.assign(item, cropped);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (textFields.includes(key) && item.type !== 'text') fail(`${key} is only supported on text objects.`);
    const shape = isShapeItem(item) || item.type === 'shape';
    if (fillFields.includes(key) && (!shape || isLineShape(item))) fail(`${key} requires a filled shape.`);
    if (strokeFields.includes(key) && !shape && item.type !== 'image') fail(`${key} requires a shape or image.`);
    if (key === 'cornerRadius' && item.type !== 'roundRect') fail('cornerRadius requires a rounded rectangle.');
    if (['softEdgeMode', 'softEdgeAngle', 'softEdgeRadius', 'softEdgeStrength'].includes(key) && item.type !== 'image') fail(`${key} requires an image object.`);
    if ([...geometry, 'fontSize', 'fillOpacity', 'strokeWidth', 'strokeOpacity', 'cornerRadius', 'softEdge', 'softEdgeAngle', 'softEdgeRadius', 'softEdgeStrength'].includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${key} must be a finite number.`);
      if (['width', 'height', 'fontSize'].includes(key) && value <= 0 && !(isLineShape(item) && key !== 'fontSize' && value === 0)) fail(`${key} must be positive (line dimensions may be zero).`);
    } else if (key === 'fontWeight') {
      if (![400, 700, '400', '700'].includes(value)) fail('fontWeight must be 400 or 700.');
    } else if (typeof value !== 'string') fail(`${key} must be a string.`);
  }
  // A solid paint change must be visible even on an existing gradient object.
  if ('fill' in patch) delete item.fillGradient;
  if ('stroke' in patch) delete item.strokeGradient;
  // Keep the requested size exact. Deck validation rejects an out-of-range proportional dimension.
  if (isMediaItem(item) && (('width' in patch) !== ('height' in patch))) {
    if ('width' in patch) item.height = patch.width * (item.height / item.width);
    else item.width = patch.height * (item.width / item.height);
  }
  Object.assign(item, patch);
}

function configureSlide(slide, op) {
  if (op.name !== undefined) {
    if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 300) fail('Slide name must contain 1–300 characters.');
    slide.name = op.name;
  }
  if (op.canvas !== undefined) {
    keys(op.canvas, ['width', 'height', 'background'], 'canvas');
    if (!Object.keys(op.canvas).length) fail('Supply at least one canvas property.');
    // Match the frontend canvas controls so agent-created pages remain adjustable there.
    for (const key of ['width', 'height']) if (key in op.canvas) {
      const value = op.canvas[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 64 || value > 8000) fail(`Canvas ${key} must be between 64 and 8000 px.`);
    }
    Object.assign(slide.canvas, op.canvas);
  }
}
function targets(slide, ids, { allowLocked = false } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || new Set(ids).size !== ids.length) fail('itemIds must contain unique object IDs.');
  return ids.map(id => {
    const item = slide.items.find(item => item.id === id);
    if (!item) fail(`Object ${id} does not exist on slide ${slide.id}.`);
    if (item.locked && !allowLocked) fail(`Object ${id} is locked. Use set_locked or unlock it in the editor first.`);
    return item;
  });
}

/** Prepare the entire batch without changing the live document. */
export function prepareBatch(project, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 200) fail('Supply 1–200 operations.');
  const next = cloneDeck(project), changed = new Set(), created = [], deleted = [], duplicatedItems = [];
  const createdAssetIds = [], assetReplacements = [], warnings = [];
  const createdSlideIds = [], changedSlideIds = new Set();
  for (const op of operations) {
    object(op, 'operation');
    const allowed = {
      set: ['op', 'slideId', 'itemIds', 'properties'],
      align: ['op', 'slideId', 'itemIds', 'alignment'],
      distribute: ['op', 'slideId', 'itemIds', 'axis', 'gap'],
      add_text: ['op', 'slideId', 'properties'],
      add_shape: ['op', 'slideId', 'shapeType', 'properties'],
      add_slide: ['op', 'slideId', 'name', 'canvas'],
      set_slide: ['op', 'slideId', 'name', 'canvas'],
      place_asset: ['op', 'slideId', 'assetId', 'properties'],
      swap_asset: ['op', 'slideId', 'itemId', 'assetId'],
      duplicate: ['op', 'slideId', 'itemIds', 'offsetX', 'offsetY'],
      delete: ['op', 'slideId', 'itemIds'],
      reorder: ['op', 'slideId', 'itemIds', 'direction'],
      set_hidden: ['op', 'slideId', 'itemIds', 'hidden'],
      set_locked: ['op', 'slideId', 'itemIds', 'locked'],
      replace_asset: ['op', 'slideId', 'itemIds', 'assetId'],
      edit_svg: ['op', 'slideId', 'itemId', 'assetId', 'patches'],
    }[op.op];
    if (!Array.isArray(allowed)) fail('Supported operations: set, align, distribute, add_text, add_shape, add_slide, set_slide, place_asset, swap_asset, duplicate, delete, reorder, set_hidden, set_locked, replace_asset, edit_svg.');
    keys(op, allowed, op.op);
    if (op.op === 'add_slide') {
      if (typeof op.slideId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(op.slideId)) fail('New slideId must be a safe ID of 1–100 characters.');
      if (next.slides.some(slide => slide.id === op.slideId)) fail(`Slide ${op.slideId} already exists. Choose a new slideId.`);
      const activeIndex = next.slides.findIndex(slide => slide.id === next.activeSlideId);
      const slide = { id: op.slideId, name: `Slide ${next.slides.length + 1}`, canvas: { ...next.slides[activeIndex].canvas }, items: [] };
      configureSlide(slide, op);
      next.slides.splice(activeIndex + 1, 0, slide);
      next.activeSlideId = slide.id;
      createdSlideIds.push(slide.id); changedSlideIds.add(slide.id);
      continue;
    }
    const slide = next.slides.find(slide => slide.id === op.slideId);
    if (!slide) fail(`Unknown slide: ${op.slideId}.`);
    changedSlideIds.add(slide.id);
    if (op.op === 'set_slide') {
      if (op.name === undefined && op.canvas === undefined) fail('Supply a slide name or canvas properties.');
      configureSlide(slide, op);
      continue;
    }
    if (op.op === 'edit_svg') {
      const [item] = targets(slide, [op.itemId]);
      if (item.type !== 'image' || item.assetId !== op.assetId) fail('SVG object or asset changed. Inspect the SVG again.');
      const source = next.assets.find(asset => asset.id === item.assetId);
      const edited = patchSVGAsset(source, op.patches, uid());
      next.assets.push(edited); createdAssetIds.push(edited.id);
      item.assetId = edited.id; changed.add(item.id);
      assetReplacements.push({ slideId: slide.id, itemId: item.id, sourceAssetId: source.id, assetId: edited.id });
      continue;
    }
    if (op.op === 'replace_asset') {
      const items = targets(slide, op.itemIds);
      const asset = next.assets.find(asset => asset.id === op.assetId);
      if (!asset) fail(`Unknown asset: ${op.assetId}. Use an assetId from get_state.assets.`);
      if (!asset.mime.startsWith('image/') || items.some(item => item.type !== 'image')) fail('replace_asset requires image objects and an SVG or raster image asset.');
      for (const item of items) {
        if (item.assetId === asset.id) fail(`Object ${item.id} already uses the requested asset.`);
        const source = next.assets.find(asset => asset.id === item.assetId);
        assetReplacements.push({ slideId: slide.id, itemId: item.id, sourceAssetId: source.id, assetId: asset.id,
          sourceSize: { width: source.width, height: source.height }, replacementSize: { width: asset.width, height: asset.height } });
        if (Math.abs(source.width / source.height - asset.width / asset.height) > 1e-8)
          warnings.push({ code: 'source_aspect_changed', slideId: slide.id, itemId: item.id,
            message: 'Source aspect ratio changed. The frame, imageFit and normalized crop are preserved; preview the visible region and proportions.' });
        // Preserve crop, imageFit, geometry, effects and layer order exactly.
        item.assetId = asset.id; changed.add(item.id);
      }
      continue;
    }
    if (['duplicate', 'delete', 'reorder', 'set_hidden', 'set_locked'].includes(op.op)) {
      const items = targets(slide, op.itemIds, { allowLocked: op.op === 'set_locked' });
      const ids = new Set(op.itemIds);
      if (op.op === 'duplicate') {
        const dx = op.offsetX ?? 20, dy = op.offsetY ?? 20;
        if (![dx, dy].every(value => typeof value === 'number' && Number.isFinite(value))) fail('Duplicate offsets must be finite numbers.');
        // Preserve stacking order regardless of the order of the supplied IDs.
        for (const item of slide.items.filter(item => ids.has(item.id))) {
          const copy = { ...structuredClone(item), id: uid(), name: (item.name + ' copy').slice(0, 1000), x: item.x + dx, y: item.y + dy };
          slide.items.push(copy); created.push(copy.id); changed.add(copy.id);
          duplicatedItems.push({ slideId: slide.id, sourceItemId: item.id, itemId: copy.id });
        }
      } else if (op.op === 'delete') {
        slide.items = slide.items.filter(item => !ids.has(item.id));
        deleted.push(...op.itemIds);
      } else if (op.op === 'reorder') {
        if (!['front', 'back', 'forward', 'backward'].includes(op.direction)) fail('Unsupported layer direction.');
        if (op.direction === 'front' || op.direction === 'back') {
          const moving = slide.items.filter(item => ids.has(item.id)), rest = slide.items.filter(item => !ids.has(item.id));
          slide.items = op.direction === 'front' ? [...rest, ...moving] : [...moving, ...rest];
        } else {
          const forward = op.direction === 'forward', step = forward ? -1 : 1;
          for (let index = forward ? slide.items.length - 2 : 1; index >= 0 && index < slide.items.length; index += step) {
            const neighbor = index - step;
            if (ids.has(slide.items[index].id) && !ids.has(slide.items[neighbor].id))
              [slide.items[index], slide.items[neighbor]] = [slide.items[neighbor], slide.items[index]];
          }
        }
      } else {
        const field = op.op === 'set_hidden' ? 'hidden' : 'locked';
        if (typeof op[field] !== 'boolean') fail(`${field} must be boolean.`);
        for (const item of items) item[field] = op[field];
      }
      if (op.op !== 'duplicate') for (const item of items) changed.add(item.id);
      continue;
    }
    if (op.op === 'swap_asset') {
      const [item] = targets(slide, [op.itemId]);
      const asset = next.assets.find(candidate => candidate.id === op.assetId);
      if (!asset) fail(`Unknown asset: ${op.assetId}. Use an assetId from get_state.assets.`);
      if (item.type !== 'image' || !asset.mime.startsWith('image/')) fail('swap_asset requires an image object and an SVG or raster image asset.');
      if (item.assetId === asset.id) fail('This object already uses the requested asset.');
      item.assetId = asset.id;
      item.imageFit = 'contain';
      delete item.crop;
      changed.add(item.id);
      continue;
    }
    if (['place_asset', 'add_text', 'add_shape'].includes(op.op)) {
      let item;
      if (op.op === 'add_shape') {
        if (!SHAPE_TYPES.includes(op.shapeType)) fail(`shapeType must be one of: ${SHAPE_TYPES.join(', ')}.`);
        item = { id: uid(), type: op.shapeType, name: SHAPE_NAMES[op.shapeType], x: 80, y: 80,
          width: 160, height: ['line', 'arrow', 'doubleArrow'].includes(op.shapeType) ? 0 : 100,
          rotation: 0, opacity: 1, locked: false, hidden: false,
          ...sacShapeStyle({line:['line', 'arrow', 'doubleArrow'].includes(op.shapeType)}) };
        if (op.properties !== undefined) properties(item, op.properties, { allowEmpty: true });
      } else if (op.op === 'place_asset') {
        const asset = next.assets.find(asset => asset.id === op.assetId);
        if (!asset) fail(`Unknown asset: ${op.assetId}. Use an assetId from get_state.assets.`);
        item = createAssetItem(slide, asset);
        if (op.properties !== undefined) properties(item, op.properties, { allowEmpty: true });
      } else {
        item = { id: uid(), type: 'text', name: 'Text', x: 80, y: 80, width: 160, height: 40,
          rotation: 0, opacity: 1, locked: false, hidden: false, text: '', fontSize: 24,
          ...SAC_TEXT_STYLE };
        properties(item, op.properties);
      }
      slide.items.push(item); created.push(item.id); changed.add(item.id);
      continue;
    }
    const items = targets(slide, op.itemIds);
    if (op.op === 'set') for (const item of items) properties(item, op.properties);
    else {
      // Keep the live-control contract stable; the toolbar additionally supports
      // arranging rotated frames through the shared layout implementation.
      if (items.some(item => item.rotation % 360 !== 0)) fail('Align/distribute requires unrotated objects. Use set for rotated objects.');
      applyLayout(slide, op.itemIds, op);
    }
    for (const item of items) changed.add(item.id);
  }
  return { project: validateDeck(next), changedItemIds: [...changed], createdItemIds: created, deletedItemIds: deleted,
    duplicatedItems, createdAssetIds, createdSlideIds, changedSlideIds: [...changedSlideIds], assetReplacements, warnings };
}

export function inspectSVG(project, { slideId, itemId, offset, limit }) {
  const slide = project.slides.find(slide => slide.id === slideId);
  if (!slide) fail(`Unknown slide: ${slideId}.`);
  const [item] = targets(slide, [itemId], { allowLocked: true });
  if (item.type !== 'image') fail('SVG inspection requires an image object.');
  return { slideId, itemId, ...inspectSVGAsset(project.assets.find(asset => asset.id === item.assetId), { offset, limit }) };
}

function sourceMetadata(asset) {
  return {
    ...(isProjectRelativePath(asset.relativePath) ? { relativePath: asset.relativePath } : {}),
    ...(/^(?:sha256:)?[a-f0-9]{64}$/i.test(asset.fingerprint ?? '') ? { fingerprint: asset.fingerprint } : {}),
  };
}

/** Capture placements before asynchronous file reads so every row describes the same project revision. */
export async function checkSources(project, assetIds, ensureActive) {
  if (assetIds !== undefined && (!Array.isArray(assetIds) || !assetIds.length || new Set(assetIds).size !== assetIds.length))
    fail('assetIds must contain unique asset IDs.');
  const byId = new Map(project.assets.map(asset => [asset.id, asset]));
  const assets = assetIds === undefined ? project.assets : assetIds.map(id => {
    if (!byId.has(id)) fail(`Unknown asset: ${id}.`);
    return byId.get(id);
  });
  const usage = deckAssetUsage(project);
  const checks = assets.map(asset => ({
    // Only the handle identity and recorded fingerprint are needed to verify a linked file.
    link: { id: asset.id, sourceKind: asset.sourceKind, linkToken: asset.linkToken,
      linkPersistence: asset.linkPersistence, fingerprint: asset.fingerprint },
    rootId: asset.mcpRootId,
    row: { assetId: asset.id, name: asset.name, ...sourceMetadata(asset), usedBy: usage.get(asset.id) },
  }));
  const budget = { remainingBytes: MAX_IMPORT_BYTES };
  const sources = [];
  for (const { link, rootId, row } of checks) {
    ensureActive();
    const result = rootId ? { status: 'check_root', mcpRootId: rootId } : await checkLinkedAssetSource(link, budget);
    sources.push({ ...row, ...result });
  }
  ensureActive();
  return sources;
}

/** State is intentionally free of embedded images, HTML scripts and file handles. */
export function describeProject(project, slideId = project.activeSlideId) {
  const slide = project.slides.find(slide => slide.id === slideId);
  if (!slide) fail(`Unknown slide: ${slideId}.`);
  const visibleFields = ['id', 'type', ...fields, 'locked', 'hidden', 'assetId', 'crop', 'imageFit',
    'fillGradient', 'strokeGradient', 'connector', 'connectorFlipX', 'connectorFlipY'];
  const usage = deckAssetUsage(project);
  return {
    project: { id: project.id, name: project.name }, activeSlideId: project.activeSlideId,
    slides: project.slides.map(page => ({ id: page.id, name: page.name, canvas: { ...page.canvas }, itemCount: page.items.length })),
    slide: { id: slide.id, name: slide.name, canvas: { ...slide.canvas }, items: slide.items.map(item => Object.fromEntries(visibleFields.filter(key => key in item).map(key => [key, item[key]]))) },
    assets: project.assets.map(asset => ({
      id: asset.id, name: asset.name, mime: asset.mime, width: asset.width, height: asset.height,
      sourceKind: asset.sourceKind,
      ...(asset.sourceOrigin !== undefined ? { sourceOrigin: asset.sourceOrigin } : {}),
      ...sourceMetadata(asset),
      usedBy: usage.get(asset.id),
    })),
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
export function connectAutomation({ execute, summary, button, onSessionChange, fetcher = fetch }) {
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
    if (old) onSessionChange?.(null);
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
          onSessionChange?.(sessionId);
        }
        show('AI connected', `Local AI tools can control this page. Click to pause. Session: ${sessionId}`);
        const current = sessionId;
        controller = new AbortController();
        const { command } = await request('poll', { sessionId: current, summary: summary() }, controller.signal);
        delay = 500;
        if (!command || !enabled || current !== sessionId) continue;
        let result;
        try {
          const ensureActive = () => {
            if (!enabled || stopped || current !== sessionId || Date.now() >= command.expiresAt)
              throw new Error('Command expired or disconnected. Read state before retrying.');
          };
          ensureActive();
          result = { ok: true, value: await execute(command.method, command.params, ensureActive) };
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
