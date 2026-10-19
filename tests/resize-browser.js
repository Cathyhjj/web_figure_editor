import { createDeck, validateDeck, slideProject } from '../deck.js';
import { exportPNG, projectToSVG } from '../core.js';

const checks = [], results = document.querySelector('#results');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const geometry = item => ['x', 'y', 'width', 'height'].map(key => item[key]);
const sameGeometry = (a, b) => geometry(a).every((value, j) => near(value, geometry(b)[j]));
function check(name, pass, details) {
  checks.push({ name, pass: !!pass, ...(details ? { details } : {}) });
  const el = document.createElement('li'); el.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`; el.dataset.pass = String(!!pass);
  if (!pass && details) { const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = JSON.stringify(details, null, 2); el.append(pre); }
  results.append(el);
}
async function until(fn) { for (let j = 0; j < 100; j++) { if (fn()) return; await pause(50); } throw new Error('Timed out waiting for editor.'); }
function fixture() {
  const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 120;
  const ctx = canvas.getContext('2d');
  for (const [color, x, y] of [['red', 0, 0], ['#00ff00', 100, 0], ['blue', 0, 60], ['yellow', 100, 60]]) { ctx.fillStyle = color; ctx.fillRect(x, y, 100, 60); }
  const deck = createDeck();
  deck.assets = [{ id: 'source', name: 'quadrants.png', mime: 'image/png', dataUrl: canvas.toDataURL(), width: 200, height: 120, sourceKind: 'copy' }];
  deck.slides[0].items = [
    { id: 'picture', type: 'image', name: 'Quadrants', assetId: 'source', x: 100, y: 80, width: 400, height: 240, rotation: 0, opacity: 1, crop: { x: .5, y: 0, width: .5, height: .5 } },
    { id: 'shape', type: 'rect', name: 'Reference shape', x: 780, y: 500, width: 100, height: 80, rotation: 0, opacity: 1, fill: '#000000', stroke: 'none', strokeWidth: 0 },
  ];
  return validateDeck(deck);
}
async function raster(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, pixel: (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data] };
  } finally { URL.revokeObjectURL(url); }
}
const green = p => p[0] < 10 && p[1] > 245 && p[2] < 10 && p[3] > 245;
const white = p => p.every(v => v > 245);

document.querySelector('#run').onclick = async () => {
  const button = document.querySelector('#run'); button.disabled = true; results.replaceChildren(); checks.length = 0;
  try {
    if (location.origin !== 'http://127.0.0.1:18767') throw new Error('Use dedicated test origin http://127.0.0.1:18767; refusing to replace another origin’s draft.');
    // Close any previous test editor before installing a fresh fixture.
    document.querySelector('#editor-host').replaceChildren(); await pause(50);
    const original = fixture();
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('figure-editor-drafts', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(original, 'current'); tx.objectStore('drafts').delete('project-file'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    const frame = document.createElement('iframe'); frame.title = 'Stretch test editor';
    const loaded = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Editor frame did not load.')), 15000); frame.onload = () => { clearTimeout(timer); resolve(); }; frame.onerror = () => { clearTimeout(timer); reject(new Error('Editor frame failed to load.')); }; });
    frame.src = '../index.html?resize-test=' + Date.now(); document.querySelector('#editor-host').append(frame); await loaded;
    const win = frame.contentWindow, doc = frame.contentDocument, $ = id => doc.getElementById(id);
    await until(() => $('status').textContent.includes('draft restored'));
    Object.defineProperty(win, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(win, 'showOpenFilePicker', { configurable: true, value: undefined }); win.confirm = () => true;
    const downloads = [], create = win.URL.createObjectURL.bind(win.URL);
    win.URL.createObjectURL = blob => { downloads.push(blob); return create(blob); }; win.HTMLAnchorElement.prototype.click = function () {};
    async function saved() { const n = downloads.length; $('save-project').click(); await until(() => downloads.length > n); await pause(30); return JSON.parse(await downloads.at(-1).text()); }
    const picture = deck => deck.slides[0].items.find(item => item.id === 'picture');
    const handles = () => [...doc.querySelectorAll('#stage [data-resize]')].map(el => el.dataset.resizeHandle).sort().join(',');
    function select(name = 'Quadrants', shiftKey = false) { [...doc.querySelectorAll('#layer-list .layer-row')].find(el => el.textContent.includes(name)).dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey })); }
    function drag(handle, dx, dy, shiftKey = false) {
      const stage = $('stage'), el = stage.querySelector(`[data-resize="picture"][data-resize-handle="${handle}"]`);
      if (!el) throw new Error(`Missing ${handle} image handle`);
      const box = el.getBoundingClientRect(), matrix = stage.getScreenCTM();
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const to = { x: from.x + matrix.a * dx + matrix.c * dy, y: from.y + matrix.b * dx + matrix.d * dy };
      const capture = stage.setPointerCapture, release = stage.releasePointerCapture; stage.setPointerCapture = () => {}; stage.releasePointerCapture = () => {};
      const event = (type, point) => new win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 2, clientX: point.x, clientY: point.y, shiftKey });
      const startEvent = event('pointerdown', from), moveEvent = event('pointermove', to), endEvent = event('pointerup', to);
      const diagnostics = { requestedDelta: [dx, dy], from, to, eventDelta: [moveEvent.clientX - startEvent.clientX, moveEvent.clientY - startEvent.clientY], matrix: [matrix.a, matrix.b, matrix.c, matrix.d], cssSize: [stage.style.width, stage.style.height], renderedSize: [stage.getBoundingClientRect().width, stage.getBoundingClientRect().height], viewBox: stage.getAttribute('viewBox') };
      try { el.dispatchEvent(startEvent); stage.dispatchEvent(moveEvent); stage.dispatchEvent(endEvent); }
      finally { stage.setPointerCapture = capture; stage.releasePointerCapture = release; }
      return diagnostics;
    }
    select(); check('Selected image exposes four edge handles and its scaling corner', handles() === 'e,n,s,se,w');
    let previous = picture(original);
    for (const [handle, dx, dy, expected] of [
      ['e', 60, 25, [100, 80, 460, 240]], ['w', -40, 15, [60, 80, 500, 240]],
      ['s', 25, 30, [60, 80, 500, 270]], ['n', 20, -20, [60, 60, 500, 290]],
    ]) {
      const pointer = drag(handle, dx, dy); const current = picture(await saved());
      check(`${handle.toUpperCase()} edge stretches only its own axis and fixes the opposite edge`, geometry(current).every((value, j) => near(value, expected[j])), { actual: geometry(current), expected, difference: geometry(current).map((value, j) => value - expected[j]), pointer }); previous = current;
    }
    drag('se', 50, 10); const scaled = picture(await saved());
    check('Corner drag preserves the current aspect ratio and top-left position', near(scaled.width / scaled.height, previous.width / previous.height) && scaled.width > previous.width && near(scaled.x, previous.x) && near(scaled.y, previous.y));
    const pointer = drag('se', 30, 10, true); const stretchedDeck = await saved(), stretched = picture(stretchedDeck);
    check('Shift-corner resizes both dimensions independently', near(stretched.width, scaled.width + 30) && near(stretched.height, scaled.height + 10) && near(stretched.x, scaled.x) && near(stretched.y, scaled.y), { actual: geometry(stretched), expected: [scaled.x, scaled.y, scaled.width + 30, scaled.height + 10], pointer });
    check('Stretch preserves crop coordinates and original image bytes', JSON.stringify(stretched.crop) === JSON.stringify(picture(original).crop) && stretchedDeck.assets[0].dataUrl === original.assets[0].dataUrl);
    $('undo').click(); check('A completed drag is one undo step', sameGeometry(picture(await saved()), scaled));
    $('redo').click(); check('Redo restores the stretched geometry', sameGeometry(picture(await saved()), stretched));
    const transfer = new win.DataTransfer(); transfer.items.add(new win.File([JSON.stringify(stretchedDeck)], 'stretch.figure.json', { type: 'application/json' }));
    $('project-input').files = transfer.files; $('project-input').dispatchEvent(new win.Event('change', { bubbles: true })); await until(() => $('status').textContent.includes('opened'));
    check('Saved and reopened images retain stretched dimensions and crop', sameGeometry(picture(await saved()), stretched) && JSON.stringify(picture(await saved()).crop) === JSON.stringify(stretched.crop));
    select(); $('object-locked').click(); check('Locked images expose no resize handles', handles() === ''); $('object-locked').click();
    select('Reference shape', true); check('Multiple selection exposes no resize handles', handles() === '');
    select('Reference shape'); check('Other objects retain only the original corner handle', handles() === 'se');
    const project = slideProject(stretchedDeck), exported = projectToSVG(project);
    const svgDocument = new DOMParser().parseFromString(exported, 'image/svg+xml'), imageBox = svgDocument.querySelector('g[id="picture"] > svg');
    check('SVG uses stretched viewport dimensions with the original crop', near(Number(imageBox.getAttribute('width')), stretched.width) && near(Number(imageBox.getAttribute('height')), stretched.height) && imageBox.getAttribute('preserveAspectRatio') === 'none');
    for (const [label, blob] of [['PNG', await exportPNG(project, 96)], ['SVG', new Blob([exported], { type: 'image/svg+xml' })]]) {
      const output = await raster(blob), x = stretched.x, y = stretched.y, w = stretched.width, h = stretched.height;
      const points = { topLeft: [x + 3, y + 3], bottomRight: [x + w - 3, y + h - 3], outsideLeft: [x - 3, y + h / 2], outsideRight: [x + w + 3, y + h / 2], outsideTop: [x + w / 2, y - 3], outsideBottom: [x + w / 2, y + h + 3], center: [x + w / 2, y + h / 2], insetTopLeft: [x + 12, y + 12], insetBottomRight: [x + w - 12, y + h - 12] };
      const pixels = Object.fromEntries(Object.entries(points).map(([name, point]) => [name, { point, rgba: output.pixel(...point) }]));
      // Sample the source color beyond the image interpolation footprint; the
      // four outside probes still verify the stretched viewport's exact bounds.
      check(`${label} visibly fills the stretched bounds without exposing cropped pixels`, output.width === project.canvas.width && output.height === project.canvas.height && green(pixels.insetTopLeft.rgba) && green(pixels.insetBottomRight.rgba) && ['outsideLeft', 'outsideRight', 'outsideTop', 'outsideBottom'].every(name => white(pixels[name].rgba)), { outputSize: [output.width, output.height], expectedSize: [project.canvas.width, project.canvas.height], item: geometry(stretched), crop: stretched.crop, pixels });
    }
    select();
  } catch (error) { check(error.message, false); console.error(error); }
  window.__resizeChecks = checks; button.disabled = false;
};
