import { createDeck, validateDeck, currentSlide, slideProject } from '../deck.js';
import { createSelection, decodeSelection, decodeSlide, decodeSlides, encodeSlides } from '../clipboard.js';

const MIME = 'application/x-figure-editor-selection';
const checks = [];
const results = document.querySelector('#results');
const runButton = document.querySelector('#run');
// Explicit manual check: unlike the synthetic suite, this changes the system
// clipboard. execCommand asks the browser to dispatch its native copy event.
document.querySelector('#copy-system').onclick = () => {
  const iframe = document.querySelector('#editor-host iframe');
  if (!iframe) return;
  iframe.contentWindow.focus();
  iframe.contentDocument.getElementById('workspace').focus();
  iframe.contentDocument.execCommand('copy');
};

function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}

async function loadEditor() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under Clipboard integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?clipboard-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(iframe);
  await loaded;
  // Wait for app.js's top-level draft restoration before opening our fixture.
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow;
    const script = iframe.contentDocument.createElement('script');
    const appURL = [...iframe.contentDocument.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) throw new Error('The editor app module was not found.');
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('clipboard-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('clipboard-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => {
      clearTimeout(timeout);
      win.removeEventListener('clipboard-editor-ready', ready);
      win.removeEventListener('clipboard-editor-failed', failed);
      script.remove();
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('clipboard-editor-ready', ready, { once: true });
    win.addEventListener('clipboard-editor-failed', failed, { once: true });
    iframe.contentDocument.body.append(script);
  });
  return iframe;
}

async function makePNG(color, width = 24, height = 18) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(2, 3, 4, 5);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not generate PNG fixture.')), 'image/png'));
  return { blob, dataUrl: canvas.toDataURL('image/png'), width, height };
}

function makeFixture(png) {
  const deck = createDeck();
  deck.name = 'Clipboard integration fixture';
  deck.assets = [{ id: 'clipboard-asset', name: 'source.png', mime: 'image/png', width: png.width, height: png.height, dataUrl: png.dataUrl, size: png.blob.size, lastModified: 123, sourceKind: 'copy' }];
  deck.slides[0].items = [
    { id: 'clipboard-image', name: 'Original image', type: 'image', assetId: 'clipboard-asset', x: 45, y: 80, width: 144, height: 108, rotation: 12, opacity: 0.65 },
    { id: 'clipboard-text', name: 'Styled label', type: 'text', x: 225, y: 35, width: 320, height: 78, text: 'Figure α\nSecond line', fontFamily: 'Georgia', fontSize: 28, fontWeight: '700', fontStyle: 'italic', align: 'center', color: '#9d347d', rotation: -4, opacity: 0.8 },
    { id: 'clipboard-rect', name: 'Styled rectangle', type: 'rect', x: 205, y: 150, width: 180, height: 105, fill: '#abdcf0', stroke: '#173e80', strokeWidth: 4, rotation: 7 },
    { id: 'clipboard-line', name: 'Styled line', type: 'line', x: 80, y: 300, width: 240, height: 35, stroke: '#307a49', strokeWidth: 5, opacity: 0.7 },
  ];
  return validateDeck(deck);
}

function sameContent(originals, copies) {
  if (originals.length !== copies.length || !copies.length) return false;
  const dx = copies[0].x - originals[0].x, dy = copies[0].y - originals[0].y;
  return originals.every((item, index) => {
    const copy = copies[index];
    return Object.entries(item).every(([key, value]) => ['id', 'assetId', 'name'].includes(key) || (key === 'x' ? copy.x === value + dx : key === 'y' ? copy.y === value + dy : copy[key] === value));
  });
}

function sameSlideContent(original, copy) {
  const content = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'assetId'].includes(key)));
  return copy.name === original.name && JSON.stringify(copy.canvas) === JSON.stringify(original.canvas)
    && JSON.stringify(copy.items.map(content)) === JSON.stringify(original.items.map(content));
}

async function until(predicate, label) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function readPNG(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let maxAlpha = 0, transparent = 0, whiteCount = 0, whiteX = 0, whiteY = 0;
  for (let index = 0; index < data.length; index += 4) {
    maxAlpha = Math.max(maxAlpha, data[index + 3]);
    if (data[index + 3] === 0) transparent++;
    if (data[index + 3] > 32 && data[index] > 245 && data[index + 1] > 245 && data[index + 2] > 245) {
      const pixel = index / 4;
      whiteCount++;
      whiteX += pixel % canvas.width;
      whiteY += Math.floor(pixel / canvas.width);
    }
  }
  return {
    width: canvas.width, height: canvas.height, maxAlpha,
    transparentFraction: transparent / (canvas.width * canvas.height),
    whiteCenter: whiteCount ? [whiteX / whiteCount / canvas.width, whiteY / whiteCount / canvas.height] : null,
    alphaAt: (x, y) => data[(y * canvas.width + x) * 4 + 3],
    hasColor: (red, green, blue, alpha) => {
      for (let index = 0; index < data.length; index += 4) {
        if ([red, green, blue, alpha].every((value, channel) => Math.abs(data[index + channel] - value) <= 4)) return true;
      }
      return false;
    },
  };
}

async function checkImageOutput(fixture, png) {
  const { selectionToPNG } = await import('../clipboard-image.js');
  const single = createSelection(slideProject(fixture), new Set(['clipboard-image']));
  Object.assign(single.items[0], { x: 405, y: 300, width: 96, height: 72, rotation: 0, opacity: 1 });
  const singleBefore = JSON.stringify(single);
  const source = await selectionToPNG(single), sourcePixels = await readPNG(source);
  const sourceBytes = new Uint8Array(await source.arrayBuffer()), expectedBytes = new Uint8Array(await png.blob.arrayBuffer());
  check('A single unchanged PNG copies at its source resolution with identical original bytes', source.type === 'image/png' && sourcePixels.width === png.width && sourcePixels.height === png.height && sourceBytes.length === expectedBytes.length && sourceBytes.every((value, index) => value === expectedBytes[index]));

  const quarterTurn = structuredClone(single);
  Object.assign(quarterTurn.items[0], { rotation: 90, opacity: 0.5 });
  const rotated = await readPNG(await selectionToPNG(quarterTurn));
  check('Image output applies rotation and opacity and crops away the surrounding slide', Math.abs(rotated.width / rotated.height - 72 / 96) < 0.03 && rotated.maxAlpha >= 127 && rotated.maxAlpha <= 129 && rotated.whiteCenter?.[0] > 0.55 && rotated.whiteCenter?.[1] < 0.3);

  const diagonal = structuredClone(single);
  diagonal.items[0].rotation = 30;
  const angled = await readPNG(await selectionToPNG(diagonal));
  const expectedRatio = (96 * Math.cos(Math.PI / 6) + 72 * 0.5) / (96 * 0.5 + 72 * Math.cos(Math.PI / 6));
  check('Rotated image bounds retain transparent corners without clipping or a slide background', Math.abs(angled.width / angled.height - expectedRatio) < 0.03 && angled.maxAlpha === 255 && angled.alphaAt(0, 0) === 0 && angled.alphaAt(angled.width - 1, 0) === 0 && angled.alphaAt(0, angled.height - 1) === 0 && angled.alphaAt(angled.width - 1, angled.height - 1) === 0);

  const mixed = createSelection(slideProject(fixture), new Set(fixture.slides[0].items.map(item => item.id)));
  const mixedBefore = JSON.stringify(mixed);
  const composed = await readPNG(await selectionToPNG(mixed));
  check('Mixed selection PNG includes image, text and styled shapes on transparency without mutating editable content', composed.transparentFraction > 0.15 && composed.hasColor(157, 52, 125, 166) && composed.hasColor(157, 52, 125, 204) && composed.hasColor(171, 220, 240, 255) && composed.hasColor(48, 122, 73, 179) && JSON.stringify(single) === singleBefore && JSON.stringify(mixed) === mixedBefore);
}

runButton.onclick = async () => {
  results.replaceChildren();
  checks.length = 0;
  runButton.disabled = true;
  document.title = 'RUNNING — Figure Editor Clipboard checks';
  window.clipboardChecks = { finished: false, checks };
  let restore = () => {};
  try {
    if (!['18766', '18770'].includes(location.port) || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use a separate localhost server on port 18766 to protect the normal editor draft.');
    const iframe = await loadEditor();
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const get = id => doc.getElementById(id);
    const stageCount = () => get('stage').querySelectorAll('[data-item]').length;
    const oldCreateURL = win.URL.createObjectURL, oldClick = win.HTMLAnchorElement.prototype.click, oldConfirm = win.confirm, oldSavePicker = win.showSaveFilePicker;
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(win.navigator, 'clipboard');
    const savePickerDescriptor = Object.getOwnPropertyDescriptor(win, 'showSaveFilePicker');
    // Snapshot capture must not open a real native file picker as the editor's
    // Save implementation evolves; this suite deliberately uses its download fallback.
    Object.defineProperty(win, 'showSaveFilePicker', { configurable: true, value: undefined });
    const writes = [];
    let clipboardText = '';
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: {
      write: async items => {
        const record = {};
        writes.push(record);
        for (const item of items) for (const type of item.types) record[type] = await item.getType(type);
        if (record['text/plain']) clipboardText = await record['text/plain'].text();
      },
      writeText: async text => { clipboardText = text; writes.push({ 'text/plain': new win.Blob([text], { type: 'text/plain' }) }); },
      readText: async () => clipboardText,
      read: async () => [{ types: ['text/plain'], getType: async () => new win.Blob([clipboardText], { type: 'text/plain' }) }],
    } });
    const createdURLs = new Map(), downloads = [];
    win.confirm = () => true;
    win.showSaveFilePicker = undefined;
    win.URL.createObjectURL = blob => {
      const url = oldCreateURL.call(win.URL, blob);
      createdURLs.set(url, blob);
      return url;
    };
    win.HTMLAnchorElement.prototype.click = function () {
      if (this.download) downloads.push(createdURLs.get(this.href));
      else oldClick.call(this);
    };
    restore = () => {
      if (clipboardDescriptor) Object.defineProperty(win.navigator, 'clipboard', clipboardDescriptor);
      else delete win.navigator.clipboard;
      if (savePickerDescriptor) Object.defineProperty(win, 'showSaveFilePicker', savePickerDescriptor);
      else delete win.showSaveFilePicker;
      win.URL.createObjectURL = oldCreateURL;
      win.HTMLAnchorElement.prototype.click = oldClick;
      win.confirm = oldConfirm;
      win.showSaveFilePicker = oldSavePicker;
      for (const url of createdURLs.keys()) win.URL.revokeObjectURL(url);
    };
    const save = async () => {
      const count = downloads.length;
      await get('save-project').onclick();
      if (!downloads[count]) throw new Error('Could not capture the project snapshot.');
      return JSON.parse(await downloads[count].text());
    };
    const open = async deck => {
      const transfer = new win.DataTransfer();
      transfer.items.add(new win.File([JSON.stringify(deck)], 'clipboard.figure.json', { type: 'application/json' }));
      get('project-input').files = transfer.files;
      await get('project-input').onchange({ target: get('project-input') });
    };
    const key = (target, value, options = {}) => {
      const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, metaKey: true, ...options });
      target.dispatchEvent(event);
      return event;
    };
    const clipboard = (type, data, target = get('workspace')) => {
      const event = new win.ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const selectedIDs = () => [...get('stage').querySelectorAll('[data-item].selected')].map(node => node.dataset.item);
    const png = await makePNG('#9d347d');
    const fixture = makeFixture(png), originals = fixture.slides[0].items;
    await open(fixture);
    get('workspace').focus();
    key(get('workspace'), 'a');
    check('The fixture selects image, text, rectangle and line objects together', selectedIDs().length === originals.length);
    check('Cmd+C keydown remains available for the browser native copy event', !key(get('workspace'), 'c').defaultPrevented);
    const copyTransfer = new win.DataTransfer();
    const copyEvent = clipboard('copy', copyTransfer);
    check('Async image copy prevents native copy without a competing DataTransfer write', copyEvent.defaultPrevented && copyTransfer.types.length === 0);
    await until(() => writes[0]?.['text/plain'], 'system clipboard image formats');
    const plain = await writes[0]['text/plain'].text();
    check('Copy carries original embedded PNG bytes and leaves the project unchanged', plain.includes(png.dataUrl) && JSON.stringify(await save()) === JSON.stringify(fixture));
    check('System image copy offers PNG, image HTML and editable data together', writes[0]['image/png']?.type === 'image/png' && (await writes[0]['text/html'].text()).includes('<img src="data:image/png;base64,') && await writes[0]['text/plain'].text() === plain);

    const systemWrite = win.navigator.clipboard.write;
    try {
      win.navigator.clipboard.write = () => Promise.reject(new win.DOMException('Test clipboard denial', 'NotAllowedError'));
      const rejectedTransfer = new win.DataTransfer();
      clipboard('copy', rejectedTransfer);
      await until(() => get('status').textContent.startsWith('Copy failed.'), 'truthful clipboard rejection');
      check('Rejected async copy reports failure without claiming editable objects were copied', rejectedTransfer.types.length === 0 && !get('status').textContent.includes('Objects copied'));
      win.navigator.clipboard.write = undefined;
      const legacyTransfer = new win.DataTransfer();
      const legacyEvent = clipboard('copy', legacyTransfer);
      check('Browsers without async image writing retain the editable native copy fallback', legacyEvent.defaultPrevented && legacyTransfer.getData(MIME) === plain && legacyTransfer.getData('text/plain') === plain);
    } finally { win.navigator.clipboard.write = systemWrite; }

    // Native paste exposes the formats from the completed async write.
    const copied = new win.DataTransfer();
    copied.setData('text/plain', plain);

    const pasteEvent = clipboard('paste', copied);
    await until(() => stageCount() === originals.length * 2, 'same-slide paste');
    const sameSlide = await save(), duplicates = sameSlide.slides[0].items.slice(originals.length);
    check('Native paste inserts and selects every copied object on the current slide', pasteEvent.defaultPrevented && selectedIDs().length === originals.length && duplicates.every(item => selectedIDs().includes(item.id)));
    check('Paste preserves relative positions, dimensions, rotation, opacity, text and shape styling', sameContent(originals, duplicates));
    check('Same-slide copies have fresh IDs and reuse the original image asset without changing bytes', duplicates.every(item => !originals.some(original => original.id === item.id)) && sameSlide.assets.length === 1 && duplicates.find(item => item.type === 'image').assetId === fixture.assets[0].id && sameSlide.assets[0].dataUrl === png.dataUrl);
    get('undo').click();
    check('One Undo removes the complete pasted selection', JSON.stringify(await save()) === JSON.stringify(fixture));
    get('redo').click();
    check('One Redo restores the complete pasted selection and its identities', JSON.stringify(await save()) === JSON.stringify(sameSlide));

    get('new-slide').click();
    get('workspace').focus();
    clipboard('paste', copied);
    await until(() => stageCount() === originals.length, 'new-slide paste');
    const newSlide = await save(), newItems = currentSlide(newSlide).items;
    const allIDs = newSlide.slides.flatMap(slide => slide.items.map(item => item.id));
    check('Copied objects paste into a new slide with their original appearance', newSlide.slides.length === 2 && sameContent(originals, newItems));
    check('Cross-slide paste keeps all object IDs unique and shares the embedded asset', new Set(allIDs).size === allIDs.length && newSlide.assets.length === 1 && newItems.find(item => item.type === 'image').assetId === fixture.assets[0].id);
    get('undo').click();
    check('Undo of cross-slide paste retains the blank slide and original slide contents', currentSlide(await save()).items.length === 0 && (await save()).slides[0].items.length === originals.length * 2);
    get('redo').click();
    check('Redo of cross-slide paste restores the complete saved project', JSON.stringify(await save()) === JSON.stringify(newSlide));

    const textOnly = new win.DataTransfer();
    textOnly.setData('text/plain', plain);
    get('workspace').focus();
    clipboard('paste', textOnly);
    await until(() => stageCount() === originals.length * 2, 'plain-text selection fallback paste');
    const fallback = await save();
    check('The plain-text fallback preserves the selection when custom clipboard types are unavailable', sameContent(originals, currentSlide(fallback).items.slice(originals.length)) && fallback.assets.length === 1);

    const external = await makePNG('#2368ab', 40, 30);
    const files = new win.DataTransfer();
    files.items.add(new win.File([external.blob], 'pasted-external.png', { type: 'image/png', lastModified: 456 }));
    const externalEvent = clipboard('paste', files);
    await until(() => stageCount() === originals.length * 2 + 1, 'external PNG paste');
    const imported = await save(), externalItem = currentSlide(imported).items.at(-1), externalAsset = imported.assets.find(asset => asset.id === externalItem.assetId);
    check('An external PNG clipboard file imports asynchronously as a selected image', externalEvent.defaultPrevented && externalItem.type === 'image' && selectedIDs().includes(externalItem.id) && imported.assets.length === 2);
    check('External image paste preserves PNG bytes and intrinsic dimensions', externalAsset?.dataUrl === external.dataUrl && externalAsset?.width === external.width && externalAsset?.height === external.height);
    get('undo').click();
    check('One Undo removes both the external pasted image and its new asset', JSON.stringify(await save()) === JSON.stringify(fallback));
    get('redo').click();
    check('One Redo restores the external image and original embedded bytes', JSON.stringify(await save()) === JSON.stringify(imported));

    get('workspace').focus();
    const ordinary = new win.DataTransfer();
    ordinary.setData('text/plain', 'Ordinary text copied from another app.');
    const ordinaryEvent = clipboard('paste', ordinary);
    check('Ordinary text never pastes a stale selection or intercepts the native event', !ordinaryEvent.defaultPrevented && JSON.stringify(await save()) === JSON.stringify(imported));
    const broken = new win.DataTransfer();
    broken.setData(MIME, '{not valid json');
    clipboard('paste', broken);
    check('Malformed custom clipboard content cannot change the project', JSON.stringify(await save()) === JSON.stringify(imported));

    // Keep a real selection so copy guards cannot pass merely because Undo/Redo
    // cleared selection before these native-editing checks.
    key(get('workspace'), 'a');
    const editableHost = doc.createElement('div');
    editableHost.innerHTML = '<input aria-label="Clipboard test input" value="Editable input"><textarea aria-label="Clipboard test textarea">Editable text</textarea><div contenteditable="true" aria-label="Clipboard test editable"><span>Editable child</span></div>';
    doc.body.append(editableHost);
    try {
      for (const [label, target, focusTarget] of [
        ['INPUT', editableHost.querySelector('input')],
        ['TEXTAREA', editableHost.querySelector('textarea')],
        ['contenteditable descendants', editableHost.querySelector('span'), editableHost.querySelector('[contenteditable]')],
      ]) {
        (focusTarget || target).focus();
        const textCopy = new win.DataTransfer();
        const textCut = new win.DataTransfer();
        const copying = clipboard('copy', textCopy, target), cutting = clipboard('cut', textCut, target), pasting = clipboard('paste', copied, target);
        check(`${label} copy, cut and paste retain native editing behavior`, !copying.defaultPrevented && !cutting.defaultPrevented && !pasting.defaultPrevented && textCopy.types.length === 0 && textCut.types.length === 0 && JSON.stringify(await save()) === JSON.stringify(imported));
      }
    } finally { editableHost.remove(); }

    get('workspace').focus();
    get('export-open').click();
    const dialogCopy = new win.DataTransfer();
    const dialogCut = new win.DataTransfer();
    const copyingInDialog = clipboard('copy', dialogCopy, get('export-submit'));
    const cuttingInDialog = clipboard('cut', dialogCut, get('export-submit'));
    const pastingInDialog = clipboard('paste', copied, get('export-submit'));
    check('Export dialog copy, cut and paste do not alter the canvas or intercept native events', get('export-dialog').open && !copyingInDialog.defaultPrevented && !cuttingInDialog.defaultPrevented && !pastingInDialog.defaultPrevented && dialogCopy.types.length === 0 && dialogCut.types.length === 0 && JSON.stringify(await save()) === JSON.stringify(imported));
    get('export-cancel').click();

    // Synthetic pointer events have no hardware pointer to capture. Only this
    // focus regression check stubs capture; selection and focus use app handlers.
    const stage = get('stage'), originalCapture = stage.setPointerCapture;
    stage.setPointerCapture = () => {};
    try {
      get('project-name').focus();
      const target = stage.querySelector('[data-item] .item-hit');
      const bounds = target.getBoundingClientRect();
      target.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: bounds.left + 2, clientY: bounds.top + 2 }));
      stage.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      check('Clicking a canvas object after an input returns keyboard focus to the workspace', doc.activeElement === get('workspace'));
      const afterFocus = new win.DataTransfer();
      const writesBeforeFocus = writes.length;
      const focusedCopy = clipboard('copy', afterFocus, doc.activeElement);
      check('A canvas click after text editing enables object copy immediately', focusedCopy.defaultPrevented && afterFocus.types.length === 0 && writes.length === writesBeforeFocus + 1);
    } finally { stage.setPointerCapture = originalCapture; }
    // Cut uses the same native event and system image formats as Copy, but its
    // removal must be conditional on a successful write of the original content.
    const selectAll = () => { get('workspace').focus(); key(get('workspace'), 'a'); };
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const deferWrite = () => {
      const index = writes.length;
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      win.navigator.clipboard.write = async items => { await systemWrite(items); await ready; };
      return { index, release };
    };
    const pasteRecord = async index => {
      const data = new win.DataTransfer();
      data.setData('text/plain', await writes[index]['text/plain'].text());
      return clipboard('paste', data);
    };
    try {
      await open(fixture);
      selectAll();
      check('Cmd+X and Ctrl+X keydown leave native cut dispatch available', !key(get('workspace'), 'x').defaultPrevented && !key(get('workspace'), 'x', { metaKey: false, ctrlKey: true }).defaultPrevented);
      const heldCut = deferWrite(), cutTransfer = new win.DataTransfer();
      const cutting = clipboard('cut', cutTransfer);
      await until(() => writes[heldCut.index]?.['text/plain'], 'pending cut image formats');
      check('Cut waits for the clipboard write and avoids competing native DataTransfer data', cutting.defaultPrevented && cutTransfer.types.length === 0 && JSON.stringify(await save()) === JSON.stringify(fixture));
      check('Cut offers PNG, image HTML and all editable objects to native applications', writes[heldCut.index]['image/png']?.type === 'image/png' && (await writes[heldCut.index]['text/html'].text()).includes('<img src="data:image/png;base64,') && decodeSelection(await writes[heldCut.index]['text/plain'].text())?.items.length === originals.length);
      heldCut.release();
      await until(() => stageCount() === 0, 'completed cut removes originals');
      const cutState = await save();
      check('A completed cut removes selected objects and retains reusable source assets', cutState.assets.length === 1 && cutState.assets[0].dataUrl === png.dataUrl && selectedIDs().length === 0);
      get('undo').click();
      check('One Undo restores every cut object with its original identity and style', JSON.stringify(await save()) === JSON.stringify(fixture));
      get('redo').click();
      check('One Redo removes the complete cut selection again', JSON.stringify(await save()) === JSON.stringify(cutState));
      await pasteRecord(heldCut.index);
      const cutPasted = await save();
      check('Cut content pastes back onto the same slide as editable objects with fresh IDs', sameContent(originals, cutPasted.slides[0].items) && cutPasted.slides[0].items.every(item => !originals.some(original => original.id === item.id)) && cutPasted.assets.length === 1);

      win.navigator.clipboard.write = systemWrite;
      get('new-slide').click();
      await pasteRecord(heldCut.index);
      const cutCrossSlide = await save();
      check('Cut content pastes onto another slide without losing styles or source image bytes', sameContent(originals, currentSlide(cutCrossSlide).items) && cutCrossSlide.assets.length === 1 && cutCrossSlide.assets[0].dataUrl === png.dataUrl);

      const lockedFixture = structuredClone(fixture);
      lockedFixture.slides[0].items[0].locked = true;
      lockedFixture.slides[0].items[2].locked = true;
      await open(lockedFixture);
      selectAll();
      const lockedWrite = writes.length;
      clipboard('cut', new win.DataTransfer());
      await until(() => stageCount() === 2, 'cut excludes locked objects');
      const lockedAfter = await save(), unlocked = originals.filter((_, index) => index === 1 || index === 3);
      const unlockedPayload = decodeSelection(await writes[lockedWrite]['text/plain'].text());
      check('Cut leaves locked objects in place and puts only unlocked objects on the clipboard', lockedAfter.slides[0].items.every(item => item.locked) && JSON.stringify(lockedAfter.slides[0].items) === JSON.stringify(lockedFixture.slides[0].items.filter(item => item.locked)) && sameContent(unlocked, unlockedPayload.items));
      selectAll();
      const allLockedWrites = writes.length;
      clipboard('cut', new win.DataTransfer());
      check('An all-locked selection cannot be cut or overwrite the clipboard', writes.length === allLockedWrites && stageCount() === 2);
      get('undo').click();
      check('Undo restores unlocked cut objects without changing the retained locked objects', JSON.stringify(await save()) === JSON.stringify(lockedFixture));

      await open(fixture);
      selectAll();
      for (const [failure, write] of [
        ['rejected write', () => Promise.reject(new win.DOMException('Test clipboard denial', 'NotAllowedError'))],
        ['synchronous write exception', () => { throw new Error('Test clipboard write throw'); }],
      ]) {
        win.navigator.clipboard.write = write;
        const failedTransfer = new win.DataTransfer();
        clipboard('cut', failedTransfer);
        await until(() => get('status').classList.contains('error'), failure);
        const truthfulFailure = /cut failed|could not cut/i.test(get('status').textContent);
        check(`Cut ${failure} reports failure and preserves every original`, truthfulFailure && failedTransfer.types.length === 0 && JSON.stringify(await save()) === JSON.stringify(fixture) && selectedIDs().length === originals.length);
      }

      win.navigator.clipboard.write = undefined;
      const legacyCut = new win.DataTransfer();
      clipboard('cut', legacyCut);
      check('Legacy native clipboard cut stores editable content before removing originals', stageCount() === 0 && legacyCut.getData(MIME) === plain && legacyCut.getData('text/plain') === plain);
      get('undo').click();
      check('One Undo also restores objects after legacy native cut', JSON.stringify(await save()) === JSON.stringify(fixture));

      await open(fixture);
      selectAll();
      const changedCut = deferWrite();
      clipboard('cut', new win.DataTransfer());
      await until(() => writes[changedCut.index]?.['text/plain'], 'cut before editing');
      key(get('workspace'), 'ArrowRight', { metaKey: false });
      const editedWhilePending = await save();
      changedCut.release();
      await settle();
      check('Editing selected objects while cut is pending preserves the newer content', JSON.stringify(await save()) === JSON.stringify(editedWhilePending) && stageCount() === originals.length);

      await open(fixture);
      selectAll();
      const switchedCut = deferWrite();
      clipboard('cut', new win.DataTransfer());
      await until(() => writes[switchedCut.index]?.['text/plain'], 'cut before slide switching');
      get('new-slide').click();
      await pasteRecord(heldCut.index);
      const destinationBefore = await save(), destinationIDs = selectedIDs();
      switchedCut.release();
      await until(() => get('slide-list').firstElementChild.querySelectorAll('image, text, line').length === 0, 'pending cut source removal after slide switching');
      const destinationAfter = await save();
      check('Switching slides during cut removes only captured source objects and preserves current selection', destinationAfter.slides[0].items.length === 0 && JSON.stringify(currentSlide(destinationAfter)) === JSON.stringify(currentSlide(destinationBefore)) && JSON.stringify(selectedIDs()) === JSON.stringify(destinationIDs));

      await open(fixture);
      selectAll();
      const replacedCut = deferWrite();
      clipboard('cut', new win.DataTransfer());
      await until(() => writes[replacedCut.index]?.['text/plain'], 'cut before project replacement');
      await open(fixture);
      replacedCut.release();
      await settle();
      check('Opening a project while cut is pending cannot delete objects in the replacement project', JSON.stringify(await save()) === JSON.stringify(fixture));

      selectAll();
      const supersededCut = deferWrite();
      clipboard('cut', new win.DataTransfer());
      await until(() => writes[supersededCut.index]?.['text/plain'], 'cut before newer copy');
      win.navigator.clipboard.write = systemWrite;
      const newerCopyIndex = writes.length;
      clipboard('copy', new win.DataTransfer());
      await until(() => writes[newerCopyIndex]?.['text/plain'], 'newer copy');
      supersededCut.release();
      await settle();
      check('A newer Copy prevents an older pending Cut from deleting originals', JSON.stringify(await save()) === JSON.stringify(fixture));
    } finally { win.navigator.clipboard.write = systemWrite; }

    // Whole-slide clipboard operations have their own payload and focus scope.
    // Include hidden, locked and out-of-canvas objects so a visible selection or
    // an image preview cannot accidentally satisfy the complete-slide checks.
    const slideFixtureInput = structuredClone(fixture);
    slideFixtureInput.slides[0].name = 'Complete slide α';
    slideFixtureInput.slides[0].canvas = { width: 820, height: 465, background: '#f5ecd8' };
    slideFixtureInput.slides[0].items[0].locked = true;
    slideFixtureInput.slides[0].items[2].hidden = true;
    Object.assign(slideFixtureInput.slides[0].items[3], { x: -16, y: 470 });
    slideFixtureInput.slides.push({ id: 'clipboard-following-slide', name: 'Following slide', canvas: { width: 320, height: 240, background: '#ffffff' }, items: [] });
    const slideFixture = validateDeck(slideFixtureInput), sourceSlide = slideFixture.slides[0];
    const slideCount = () => get('slide-list').querySelectorAll('.slide-card').length;
    const textTransfer = text => { const transfer = new win.DataTransfer(); transfer.setData('text/plain', text); return transfer; };
    const systemWriteText = win.navigator.clipboard.writeText, systemReadText = win.navigator.clipboard.readText;
    await open(slideFixture);
    selectAll();
    const sourceCard = get('slide-list').firstElementChild;
    sourceCard.focus();
    check('Slide thumbnail focus keeps Cmd+C and Ctrl+C available for native copy dispatch', !key(sourceCard, 'c').defaultPrevented && !key(sourceCard, 'c', { metaKey: false, ctrlKey: true }).defaultPrevented);
    const nativeSlideData = new win.DataTransfer(), selectionBeforeSlideCopy = selectedIDs();
    const nativeSlideCopy = clipboard('copy', nativeSlideData, sourceCard);
    const nativeSlideText = nativeSlideData.getData('text/plain'), decodedSlide = decodeSlide(nativeSlideText);
    check('Focused slide copy uses a distinct complete-slide payload despite an existing object selection', nativeSlideCopy.defaultPrevented && selectionBeforeSlideCopy.length > 0 && nativeSlideText.startsWith('Figure Editor slide v1\n') && decodedSlide.items.length === originals.length && !decodeSelection(nativeSlideText));
    check('Whole-slide copy includes hidden and locked objects and leaves the source untouched', decodedSlide.items.some(item => item.hidden) && decodedSlide.items.some(item => item.locked) && JSON.stringify(selectedIDs()) === JSON.stringify(selectionBeforeSlideCopy) && JSON.stringify(await save()) === JSON.stringify(slideFixture));
    const bodySlideData = new win.DataTransfer();
    const bodySlideCopy = clipboard('copy', bodySlideData, doc.body);
    check('A native copy event dispatched at the document body respects the focused slide thumbnail', bodySlideCopy.defaultPrevented && bodySlideData.getData('text/plain') === nativeSlideText);

    get('workspace').focus();
    const nativeSlidePaste = clipboard('paste', textTransfer(nativeSlideText));
    await until(() => slideCount() === 3, 'native whole-slide paste');
    const wholeSlidePasted = await save(), pastedSlide = currentSlide(wholeSlidePasted);
    check('Native slide paste inserts after the active slide, activates it and retains the following slide', nativeSlidePaste.defaultPrevented && wholeSlidePasted.slides[0].id === sourceSlide.id && wholeSlidePasted.slides[1].id === pastedSlide.id && wholeSlidePasted.slides[2].id === slideFixture.slides[1].id && doc.activeElement?.dataset.slide === pastedSlide.id);
    check('Whole-slide paste preserves exact coordinates, canvas, name, styles, hidden and locked flags', sameSlideContent(sourceSlide, pastedSlide));
    const pastedObjectIDs = wholeSlidePasted.slides.flatMap(page => page.items.map(item => item.id));
    check('Whole-slide paste creates fresh identities and reuses original embedded image assets', pastedSlide.id !== sourceSlide.id && new Set(pastedObjectIDs).size === pastedObjectIDs.length && wholeSlidePasted.assets.length === 1 && pastedSlide.items[0].assetId === sourceSlide.items[0].assetId && wholeSlidePasted.assets[0].dataUrl === png.dataUrl);
    get('undo').click();
    check('One Undo removes the pasted slide and restores the previous active slide and order', JSON.stringify(await save()) === JSON.stringify(slideFixture));
    get('redo').click();
    check('One Redo restores the whole pasted slide with its exact identities and active state', JSON.stringify(await save()) === JSON.stringify(wholeSlidePasted));

    selectAll();
    const objectWriteIndex = writes.length;
    clipboard('copy', new win.DataTransfer());
    await until(() => writes[objectWriteIndex]?.['text/plain'], 'object copy after whole-slide paste');
    const objectText = await writes[objectWriteIndex]['text/plain'].text();
    check('Returning focus to the canvas keeps object copy separate from whole-slide copy', decodeSelection(objectText)?.items.length > 0 && !decodeSlide(objectText) && !!writes[objectWriteIndex]['image/png']);
    const slideWriteIndex = writes.length;
    await get('copy-slide').onclick();
    await until(() => writes[slideWriteIndex]?.['text/plain'], 'explicit slide copy');
    const buttonSlideText = await writes[slideWriteIndex]['text/plain'].text();
    check('Copy slide explicitly writes only editable slide text even while canvas objects are selected', Object.keys(writes[slideWriteIndex]).join() === 'text/plain' && sameSlideContent(sourceSlide, decodeSlide(buttonSlideText)));

    const destinationDeck = createDeck();
    destinationDeck.name = 'Different destination project';
    await open(destinationDeck);
    await get('paste-slide').onclick();
    const crossProjectSlide = await save();
    check('Paste slide imports into another project with the original canvas, objects and image bytes', crossProjectSlide.id === destinationDeck.id && crossProjectSlide.slides.length === 2 && crossProjectSlide.slides[0].id === destinationDeck.slides[0].id && sameSlideContent(sourceSlide, currentSlide(crossProjectSlide)) && crossProjectSlide.assets.length === 1 && crossProjectSlide.assets[0].dataUrl === png.dataUrl);
    get('undo').click();
    check('Undo of cross-project slide paste also removes its imported assets', JSON.stringify(await save()) === JSON.stringify(destinationDeck));
    get('redo').click();
    check('Redo of cross-project slide paste restores the imported assets and slide atomically', JSON.stringify(await save()) === JSON.stringify(crossProjectSlide));

    const blankDeck = createDeck();
    blankDeck.slides[0].name = 'Intentional blank';
    blankDeck.slides[0].canvas = { width: 410, height: 290, background: '#cceedd' };
    await open(blankDeck);
    await get('copy-slide').onclick();
    const blankSlideText = clipboardText;
    await open(slideFixture);
    await get('paste-slide').onclick();
    const blankSlidePasted = await save();
    check('A blank slide copies and pastes with its own canvas between existing slides', decodeSlide(blankSlideText)?.items.length === 0 && blankSlidePasted.slides.length === 3 && sameSlideContent(blankDeck.slides[0], currentSlide(blankSlidePasted)) && blankSlidePasted.slides[1].id === blankSlidePasted.activeSlideId && blankSlidePasted.assets.length === slideFixture.assets.length);

    const corruptSlideEvent = clipboard('paste', textTransfer('Figure Editor slide v1\n{invalid json'));
    check('Malformed whole-slide clipboard data fails without partial slides or asset changes', corruptSlideEvent.defaultPrevented && JSON.stringify(await save()) === JSON.stringify(blankSlidePasted));
    clipboardText = 'Ordinary clipboard text after copying a slide';
    await get('paste-slide').onclick();
    check('Paste slide does not reuse stale slide data when the system clipboard contains ordinary text', JSON.stringify(await save()) === JSON.stringify(blankSlidePasted));

    const slideEditableHost = doc.createElement('div');
    slideEditableHost.innerHTML = '<input aria-label="Slide clipboard input"><textarea aria-label="Slide clipboard textarea"></textarea><div contenteditable="true" aria-label="Slide clipboard editable"><span>Editable child</span></div>';
    doc.body.append(slideEditableHost);
    try {
      for (const [label, target, focusTarget] of [
        ['INPUT', slideEditableHost.querySelector('input')],
        ['TEXTAREA', slideEditableHost.querySelector('textarea')],
        ['contenteditable descendants', slideEditableHost.querySelector('span'), slideEditableHost.querySelector('[contenteditable]')],
      ]) {
        (focusTarget || target).focus();
        const editCopyData = new win.DataTransfer();
        const editCopy = clipboard('copy', editCopyData, target), editPaste = clipboard('paste', textTransfer(buttonSlideText), target);
        check(`${label} retains native copy and paste even with complete-slide clipboard data`, !editCopy.defaultPrevented && !editPaste.defaultPrevented && editCopyData.types.length === 0 && JSON.stringify(await save()) === JSON.stringify(blankSlidePasted));
      }
    } finally { slideEditableHost.remove(); }

    get('workspace').focus();
    try {
      win.navigator.clipboard.writeText = () => Promise.reject(new win.DOMException('Test slide copy denial', 'NotAllowedError'));
      await get('copy-slide').onclick();
      const failedCopyStatus = get('status').textContent, failedCopyVisible = get('status').classList.contains('error');
      check('Denied slide copy reports failure without claiming success or changing the project', failedCopyVisible && /copy.*failed|could not copy/i.test(failedCopyStatus) && JSON.stringify(await save()) === JSON.stringify(blankSlidePasted));
      win.navigator.clipboard.writeText = systemWriteText;
      win.navigator.clipboard.readText = () => Promise.reject(new win.DOMException('Test slide paste denial', 'NotAllowedError'));
      await get('paste-slide').onclick();
      const failedPasteStatus = get('status').textContent, failedPasteVisible = get('status').classList.contains('error');
      check('Denied slide paste reports failure and preserves the complete project', failedPasteVisible && /paste.*failed|could not paste|could not read/i.test(failedPasteStatus) && JSON.stringify(await save()) === JSON.stringify(blankSlidePasted));

      let finishSlideRead;
      win.navigator.clipboard.readText = () => new Promise(resolve => { finishSlideRead = resolve; });
      const pendingSlidePaste = get('paste-slide').onclick();
      await until(() => finishSlideRead, 'pending slide clipboard read');
      get('new-slide').click();
      const changedTarget = await save();
      finishSlideRead(buttonSlideText);
      await pendingSlidePaste;
      await settle();
      check('Switching the active slide during clipboard reading cancels paste without changing either slide', JSON.stringify(await save()) === JSON.stringify(changedTarget));

      finishSlideRead = null;
      const pendingProjectPaste = get('paste-slide').onclick();
      await until(() => finishSlideRead, 'pending clipboard read before project replacement');
      await open(slideFixture);
      finishSlideRead(buttonSlideText);
      await pendingProjectPaste;
      await settle();
      check('Opening another project during clipboard reading cancels the pending slide paste', JSON.stringify(await save()) === JSON.stringify(slideFixture));

      win.navigator.clipboard.writeText = undefined;
      win.navigator.clipboard.readText = undefined;
      const fallbackSlideWrite = writes.length;
      await get('copy-slide').onclick();
      await until(() => writes[fallbackSlideWrite]?.['text/plain'], 'slide clipboard write fallback');
      await get('paste-slide').onclick();
      const clipboardAPIFallback = await save();
      check('Browsers with ClipboardItem read/write but no text helpers can copy and paste whole slides', Object.keys(writes[fallbackSlideWrite]).join() === 'text/plain' && clipboardAPIFallback.slides.length === 3 && sameSlideContent(sourceSlide, currentSlide(clipboardAPIFallback)));
    } finally {
      win.navigator.clipboard.writeText = systemWriteText;
      win.navigator.clipboard.readText = systemReadText;
      win.navigator.clipboard.write = systemWrite;
    }

    await open(slideFixture);
    const objectPasteCard = get('slide-list').firstElementChild;
    objectPasteCard.focus();
    clipboard('paste', textTransfer(plain), objectPasteCard);
    const focusAfterObjectPaste = doc.activeElement;
    const bodyObjectWrite = writes.length;
    clipboard('copy', new win.DataTransfer(), doc.body);
    await until(() => writes[bodyObjectWrite]?.['text/plain'], 'body-dispatched object copy after thumbnail paste');
    const bodyObjectText = await writes[bodyObjectWrite]['text/plain'].text();
    check('Pasting objects from a focused thumbnail returns focus to the canvas so the next native Copy copies those objects', focusAfterObjectPaste === get('workspace') && slideCount() === 2 && decodeSelection(bodyObjectText)?.items.length === originals.length && !decodeSlide(bodyObjectText));
    get('slide-list').firstElementChild.focus();
    key(doc.activeElement, 'a');
    const focusAfterSelectAll = doc.activeElement;
    const selectAllFromRailData = new win.DataTransfer();
    clipboard('copy', selectAllFromRailData, doc.body);
    const selectAllFromRailText = selectAllFromRailData.getData('text/plain');
    check('Cmd+A in the slide rail selects every slide and native Copy carries the slide batch', !!focusAfterSelectAll?.closest('#slides-panel') && get('slide-list').querySelectorAll('[aria-pressed="true"]').length === slideCount() && decodeSlides(selectAllFromRailText)?.slides.length === 2 && !decodeSelection(selectAllFromRailText));

    // Batch selection remains a rail operation; copies follow deck order even
    // when the user chooses non-adjacent thumbnails in the opposite order.
    const batchInput = structuredClone(slideFixture);
    const batchPage = (id, name) => ({ ...structuredClone(sourceSlide), id, name, items: sourceSlide.items.map(item => ({ ...structuredClone(item), id: `${id}-${item.id}` })) });
    const blankPage = (id, name, background) => ({ id, name, canvas: { width: 450, height: 315, background }, items: [] });
    batchInput.slides = [
      batchPage('batch-first', 'First image slide'),
      blankPage('batch-second', 'Middle blank slide', '#ddeeff'),
      batchPage('batch-third', 'Second image slide'),
      blankPage('batch-fourth', 'Separator slide', '#ffffff'),
      blankPage('batch-fifth', 'Last blank slide', '#eeddcc'),
    ];
    batchInput.activeSlideId = batchInput.slides[0].id;
    const batchFixture = validateDeck(batchInput);
    const cards = () => [...get('slide-list').querySelectorAll('.slide-card')];
    const selectedSlides = () => cards().filter(card => card.getAttribute('aria-pressed') === 'true').map(card => card.dataset.slide);
    const selectPage = (index, options = {}) => {
      const card = cards()[index];
      card.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...options }));
      return card;
    };
    const selectedAre = ids => JSON.stringify(selectedSlides()) === JSON.stringify(ids);
    const batchSources = [batchFixture.slides[0], batchFixture.slides[2], batchFixture.slides[4]];
    await open(batchFixture);
    selectPage(4);
    selectPage(0, { metaKey: true });
    selectPage(2, { ctrlKey: true });
    const batchBefore = await save(), sourceBatchIDs = batchSources.map(page => page.id);
    check('Cmd/Ctrl-click selects non-adjacent slides in deck order and shows the selection count', selectedAre(sourceBatchIDs) && get('slide-selection-count').textContent.trim() === '3 selected' && cards().filter(card => card.getAttribute('aria-current') === 'true').length === 1 && batchBefore.activeSlideId === batchSources[1].id);
    const batchCopyData = new win.DataTransfer();
    const batchCopyEvent = clipboard('copy', batchCopyData, doc.body);
    const batchText = batchCopyData.getData('text/plain'), batchPayload = decodeSlides(batchText);
    check('Native batch Copy stores selected slides in deck order with shared image bytes stored once', batchCopyEvent.defaultPrevented && batchText.startsWith('Figure Editor slides v1\n') && JSON.stringify(batchPayload.slides.map(page => page.name)) === JSON.stringify(batchSources.map(page => page.name)) && batchPayload.assets.length === 1 && batchPayload.assets[0].dataUrl === png.dataUrl && batchPayload.slides.every((page, index) => sameSlideContent(batchSources[index], page)));
    const batchButtonWrite = writes.length;
    await get('copy-slide').onclick();
    check('The Copy button writes the whole selected batch as text without altering its source slides', Object.keys(writes[batchButtonWrite]).join() === 'text/plain' && decodeSlides(await writes[batchButtonWrite]['text/plain'].text()).slides.length === 3 && JSON.stringify(await save()) === JSON.stringify(batchBefore));
    const batchPasteEvent = clipboard('paste', textTransfer(batchText), doc.body);
    const firstBatchPaste = await save(), firstInserted = firstBatchPaste.slides.slice(3, 6), firstInsertedIDs = firstInserted.map(page => page.id);
    check('Pasting a batch inserts one ordered block after the active slide and activates its final slide', batchPasteEvent.defaultPrevented && firstBatchPaste.slides.length === 8 && firstInserted.every((page, index) => sameSlideContent(batchSources[index], page)) && firstBatchPaste.activeSlideId === firstInserted.at(-1).id && firstBatchPaste.slides[6].id === batchFixture.slides[3].id && firstBatchPaste.slides[7].id === batchFixture.slides[4].id);
    const batchObjectIDs = firstBatchPaste.slides.flatMap(page => page.items.map(item => item.id));
    check('Batch paste selects all inserted thumbnails with fresh slide/object identities and reused assets', selectedAre(firstInsertedIDs) && doc.activeElement?.dataset.slide === firstInserted.at(-1).id && firstInsertedIDs.every(id => !batchFixture.slides.some(page => page.id === id)) && new Set(batchObjectIDs).size === batchObjectIDs.length && firstBatchPaste.assets.length === 1);
    get('undo').click();
    check('One Undo removes the entire pasted batch and restores the original multi-selection', JSON.stringify(await save()) === JSON.stringify(batchBefore) && selectedAre(sourceBatchIDs));
    get('redo').click();
    check('One Redo restores the batch, its identities and all inserted thumbnail selections', JSON.stringify(await save()) === JSON.stringify(firstBatchPaste) && selectedAre(firstInsertedIDs));
    clipboard('paste', textTransfer(batchText), doc.body);
    const repeatedBatchPaste = await save(), repeatedInserted = repeatedBatchPaste.slides.slice(6, 9);
    check('Repeated batch paste appends another ordered block after the last pasted slide', repeatedBatchPaste.slides.length === 11 && repeatedInserted.every((page, index) => sameSlideContent(batchSources[index], page)) && repeatedBatchPaste.activeSlideId === repeatedInserted.at(-1).id && selectedAre(repeatedInserted.map(page => page.id)) && repeatedBatchPaste.slides[9].id === batchFixture.slides[3].id && repeatedBatchPaste.assets.length === 1);

    clipboardText = batchText;
    await open(destinationDeck);
    await get('paste-slide').onclick();
    const crossProjectBatch = await save(), crossBatchInserted = crossProjectBatch.slides.slice(1);
    check('Cross-project batch paste retains blank slides, individual canvases, hidden/locked objects and one shared image asset', crossProjectBatch.id === destinationDeck.id && crossBatchInserted.length === 3 && crossBatchInserted.every((page, index) => sameSlideContent(batchSources[index], page)) && crossProjectBatch.assets.length === 1 && crossProjectBatch.assets[0].dataUrl === png.dataUrl && selectedAre(crossBatchInserted.map(page => page.id)));
    get('undo').click();
    check('Cross-project batch Undo removes every inserted slide and its imported asset in one step', JSON.stringify(await save()) === JSON.stringify(destinationDeck));
    get('redo').click();
    check('Cross-project batch Redo restores the complete ordered block and its shared asset', JSON.stringify(await save()) === JSON.stringify(crossProjectBatch));

    await open(batchFixture);
    selectPage(1);
    selectPage(3, { shiftKey: true });
    check('Shift-click selects the contiguous range from the selection anchor', selectedAre(batchFixture.slides.slice(1, 4).map(page => page.id)) && (await save()).activeSlideId === batchFixture.slides[3].id);
    selectPage(4, { metaKey: true, shiftKey: true });
    check('Cmd+Shift-click adds the anchored range to the existing slide selection', selectedAre(batchFixture.slides.slice(1).map(page => page.id)));
    selectPage(2, { ctrlKey: true });
    check('Ctrl-click toggles an already selected slide out without clearing the others', selectedAre([batchFixture.slides[1].id, batchFixture.slides[3].id, batchFixture.slides[4].id]));
    selectPage(2);
    selectPage(2, { metaKey: true });
    check('Toggling the only selected slide retains one selected thumbnail', selectedAre([batchFixture.slides[2].id]));
    key(doc.activeElement, 'a', { metaKey: false, ctrlKey: true });
    const allSlidesBeforeDelete = await save();
    const deleteAllKey = key(doc.activeElement, 'Delete', { metaKey: false });
    check('Ctrl+A in the rail selects all slides and disables deleting the entire project', selectedSlides().length === 5 && get('delete-slide').disabled && deleteAllKey.defaultPrevented && JSON.stringify(await save()) === JSON.stringify(allSlidesBeforeDelete));
    selectPage(2);
    check('A plain click on an already active thumbnail collapses the batch selection', selectedAre([batchFixture.slides[2].id]) && get('slide-selection-count').textContent.trim() === '1 selected');
    const singleFromBatchData = new win.DataTransfer();
    clipboard('copy', singleFromBatchData, doc.body);
    check('A collapsed single-slide selection keeps the compatible single-slide clipboard format', singleFromBatchData.getData('text/plain').startsWith('Figure Editor slide v1\n') && !!decodeSlide(singleFromBatchData.getData('text/plain')));

    selectPage(0);
    selectPage(2, { metaKey: true });
    const beforeBatchDuplicate = await save();
    get('duplicate-slide').click();
    const duplicatedBatch = await save(), duplicatedPages = duplicatedBatch.slides.filter(page => !batchFixture.slides.some(original => original.id === page.id));
    check('Duplicate applies to the selected batch with independent identities and editable content', duplicatedBatch.slides.length === 7 && duplicatedPages.length === 2 && duplicatedPages.every((page, index) => sameSlideContent({ ...batchSources[index], name: page.name }, page) && page.name.endsWith(' copy')) && selectedAre(duplicatedPages.map(page => page.id)) && duplicatedBatch.assets.length === 1);
    get('undo').click();
    check('Undo of batch Duplicate restores the original slides and selected source thumbnails', JSON.stringify(await save()) === JSON.stringify(beforeBatchDuplicate) && selectedAre([batchFixture.slides[0].id, batchFixture.slides[2].id]));
    const duplicateKey = key(doc.activeElement, 'd');
    const keyboardDuplicated = await save();
    check('Cmd+D while the rail is focused duplicates the selected slides instead of canvas objects', duplicateKey.defaultPrevented && keyboardDuplicated.slides.length === 7 && selectedSlides().length === 2 && keyboardDuplicated.slides[0].items.length === batchFixture.slides[0].items.length);
    const deleteBatchKey = key(doc.activeElement, 'Delete', { metaKey: false });
    const keyboardDeleted = await save();
    check('Delete while the rail is focused removes the complete selected slide batch and retains shared sources', deleteBatchKey.defaultPrevented && keyboardDeleted.slides.length === 5 && JSON.stringify(keyboardDeleted.slides) === JSON.stringify(batchFixture.slides) && keyboardDeleted.assets.length === 1);
    const copyAfterBatchDelete = new win.DataTransfer();
    clipboard('copy', copyAfterBatchDelete, doc.body);
    check('Deleting a focused batch focuses a remaining thumbnail so the next Copy still copies a slide', doc.activeElement?.dataset.slide === keyboardDeleted.activeSlideId && decodeSlides(copyAfterBatchDelete.getData('text/plain'))?.slides.length === 1);
    get('undo').click();
    check('One Undo restores a keyboard-deleted batch and its multi-selection', JSON.stringify(await save()) === JSON.stringify(keyboardDuplicated) && selectedSlides().length === 2);
    const copyAfterBatchDeleteUndo = new win.DataTransfer();
    clipboard('copy', copyAfterBatchDeleteUndo, doc.body);
    check('Undo of a deleted batch restores rail focus and native Copy of both restored slides', doc.activeElement?.dataset.slide === keyboardDuplicated.activeSlideId && decodeSlides(copyAfterBatchDeleteUndo.getData('text/plain'))?.slides.length === 2);
    get('redo').click();
    const copyAfterBatchDeleteRedo = new win.DataTransfer();
    clipboard('copy', copyAfterBatchDeleteRedo, doc.body);
    check('Redo of a batch deletion keeps focus on a surviving slide and preserves native slide-copy routing', JSON.stringify(await save()) === JSON.stringify(keyboardDeleted) && doc.activeElement?.dataset.slide === keyboardDeleted.activeSlideId && decodeSlides(copyAfterBatchDeleteRedo.getData('text/plain'))?.slides.length === 1);

    await open(batchFixture);
    selectPage(1);
    selectPage(3, { metaKey: true });
    get('delete-slide').click();
    const buttonDeletedBatch = await save();
    check('Delete button removes non-adjacent selected slides while preserving all remaining slide order', JSON.stringify(buttonDeletedBatch.slides.map(page => page.id)) === JSON.stringify(sourceBatchIDs) && selectedSlides().length === 1 && buttonDeletedBatch.assets.length === 1);
    await open(batchFixture);
    check('Opening a project resets slide selection to its active slide', selectedAre([batchFixture.activeSlideId]));
    selectPage(2, { metaKey: true });
    get('new-slide').click();
    const newPageFromBatch = await save();
    check('Adding a new slide replaces the prior multi-selection with the new active slide', newPageFromBatch.slides.length === 6 && selectedAre([newPageFromBatch.activeSlideId]) && currentSlide(newPageFromBatch).items.length === 0);
    get('new-project').click();
    const newProjectFromBatch = await save();
    check('Creating a new project leaves exactly its single active slide selected', newProjectFromBatch.slides.length === 1 && selectedAre([newProjectFromBatch.activeSlideId]));

    await open(batchFixture);
    selectPage(0);
    selectPage(2, { metaKey: true });
    selectAll();
    const canvasBatchWrite = writes.length;
    clipboard('copy', new win.DataTransfer(), doc.body);
    await until(() => writes[canvasBatchWrite]?.['text/plain'], 'canvas copy with multiple slides selected');
    const canvasBatchText = await writes[canvasBatchWrite]['text/plain'].text();
    check('Canvas focus keeps object Copy separate even when several slide thumbnails remain selected', selectedSlides().length === 2 && decodeSelection(canvasBatchText)?.items.length === selectedIDs().length && !decodeSlides(canvasBatchText));

    const nearlyFullDeck = createDeck();
    nearlyFullDeck.slides = Array.from({ length: 99 }, (_, index) => blankPage(`limit-slide-${index}`, `Limit slide ${index + 1}`, '#ffffff'));
    nearlyFullDeck.activeSlideId = nearlyFullDeck.slides[48].id;
    await open(nearlyFullDeck);
    const twoSlidePayload = { ...batchPayload, slides: batchPayload.slides.slice(0, 2), activeSlideId: batchPayload.slides[1].id };
    const limitPasteEvent = clipboard('paste', textTransfer(encodeSlides(twoSlidePayload)));
    const limitFailureVisible = get('status').classList.contains('error');
    check('Pasting two slides into a 99-slide project fails atomically without imported assets or Undo history', limitPasteEvent.defaultPrevented && limitFailureVisible && JSON.stringify(await save()) === JSON.stringify(nearlyFullDeck) && get('undo').disabled && selectedAre([nearlyFullDeck.activeSlideId]));
    const corruptBatchPaste = clipboard('paste', textTransfer('Figure Editor slides v1\n{invalid json'));
    check('Malformed batch clipboard data cannot partially import slides or assets', corruptBatchPaste.defaultPrevented && JSON.stringify(await save()) === JSON.stringify(nearlyFullDeck) && get('undo').disabled);

    // Leave the visual fixture selected for the separate real-system copy check.
    await open(imported);
    selectAll();
    await checkImageOutput(fixture, png);
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    restore();
    runButton.disabled = false;
    const passed = checks.length > 0 && checks.every(result => result.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor Clipboard checks`;
    window.clipboardChecks = { finished: true, passed, checks: [...checks] };
  }
};
