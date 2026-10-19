import { createDeck, validateDeck } from '../deck.js';

const checks = [], results = document.getElementById('results'), runButton = document.getElementById('run');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// SVGPoint/DOMMatrix coordinate conversion uses browser floating-point
// precision; synthetic screen coordinates can differ by a few 1e-5 slide px.
const near = (left, right) => Math.abs(left - right) < 1e-4;
function check(name, pass, details) {
  checks.push({ name, pass: !!pass, ...(details ? { details } : {}) });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass); row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  if (!pass && details) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(details, null, 2); row.append(pre); }
  results.append(row);
}

async function loadEditor() {
  const iframe = document.createElement('iframe'); iframe.title = 'Editor under marquee integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?marquee-checks=${Date.now()}`;
  document.getElementById('editor-host').replaceChildren(iframe); await loaded;
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) throw new Error('The editor app module was not found.');
    const script = doc.createElement('script'); script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('marquee-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('marquee-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => { clearTimeout(timeout); win.removeEventListener('marquee-editor-ready', ready); win.removeEventListener('marquee-editor-failed', failed); script.remove(); };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('marquee-editor-ready', ready, { once: true }); win.addEventListener('marquee-editor-failed', failed, { once: true });
    doc.body.append(script);
  });
  return iframe;
}

function fixtureDeck() {
  const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
  const context = canvas.getContext('2d'); context.fillStyle = '#9655a4'; context.fillRect(0, 0, 120, 80);
  context.fillStyle = '#ffffff'; context.fillRect(10, 10, 35, 30);
  const deck = createDeck(); deck.name = 'Marquee integration fixture';
  deck.assets = [{ id: 'marquee-source', name: 'generated.png', mime: 'image/png', width: 120, height: 80, dataUrl: canvas.toDataURL('image/png'), sourceKind: 'copy' }];
  const rect = (id, x, y, width, height, extra = {}) => ({ id, type: 'rect', name: id, x, y, width, height, rotation: 0, opacity: 1, fill: '#c0a4cd', stroke: 'none', strokeWidth: 0, ...extra });
  deck.slides[0].canvas = { width: 1000, height: 700, background: '#ffffff' };
  deck.slides[0].items = [
    { id: 'picture', type: 'image', name: 'Generated image', assetId: 'marquee-source', x: 100, y: 100, width: 120, height: 80, rotation: 0, opacity: 1 },
    rect('shape', 280, 120, 100, 100),
    rect('partial', 390, 110, 120, 90),
    rect('locked', 200, 240, 70, 50, { locked: true }),
    rect('hidden', 100, 240, 70, 50, { hidden: true }),
    rect('rotated', 480, 240, 160, 80, { rotation: 45 }),
    rect('remote', 750, 530, 100, 80),
  ];
  return validateDeck(deck);
}

runButton.onclick = async () => {
  results.replaceChildren(); checks.length = 0; runButton.disabled = true;
  document.title = 'RUNNING — Figure Editor marquee checks';
  window.marqueeChecks = { finished: false, checks }; window.__marqueeChecks = checks;
  let restore = () => {};
  try {
    if (location.origin !== 'http://127.0.0.1:18769') throw new Error('Use dedicated test origin http://127.0.0.1:18769 to protect the normal editor draft.');
    const iframe = await loadEditor(), win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    const stage = get('stage'), workspace = get('workspace');
    const oldCreateURL = win.URL.createObjectURL, oldClick = win.HTMLAnchorElement.prototype.click, oldConfirm = win.confirm;
    const pickerDescriptor = Object.getOwnPropertyDescriptor(win, 'showSaveFilePicker');
    const createdURLs = new Map(), downloads = [];
    Object.defineProperty(win, 'showSaveFilePicker', { configurable: true, value: undefined }); win.confirm = () => true;
    win.URL.createObjectURL = blob => { const url = oldCreateURL.call(win.URL, blob); createdURLs.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(createdURLs.get(this.href)); else oldClick.call(this); };
    // Synthetic pointer events have no browser-owned active pointer to capture.
    const captures = [stage, workspace].map(element => ({ element, capture: element.setPointerCapture, release: element.releasePointerCapture, has: element.hasPointerCapture }));
    for (const { element } of captures) { element.setPointerCapture = () => {}; element.releasePointerCapture = () => {}; element.hasPointerCapture = () => false; }
    restore = () => {
      if (pickerDescriptor) Object.defineProperty(win, 'showSaveFilePicker', pickerDescriptor); else delete win.showSaveFilePicker;
      win.confirm = oldConfirm; win.URL.createObjectURL = oldCreateURL; win.HTMLAnchorElement.prototype.click = oldClick;
      for (const url of createdURLs.keys()) win.URL.revokeObjectURL(url);
      for (const { element, capture, release, has } of captures) { element.setPointerCapture = capture; element.releasePointerCapture = release; element.hasPointerCapture = has; }
    };
    const frame = () => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    const save = async () => {
      const index = downloads.length; await get('save-project').onclick();
      if (!downloads[index]) throw new Error('Could not capture the project snapshot.');
      return JSON.parse(await downloads[index].text());
    };
    const open = async deck => {
      const transfer = new win.DataTransfer(); transfer.items.add(new win.File([JSON.stringify(deck)], 'marquee.figure.json', { type: 'application/json' }));
      get('project-input').files = transfer.files; await get('project-input').onchange({ target: get('project-input') });
      workspace.scrollTop = 0; workspace.scrollLeft = 0; await frame();
    };
    const selected = () => [...doc.querySelectorAll('#layer-list .layer-row.selected')].map(row => row.dataset.layer).sort();
    const selectionIs = (...ids) => equal(selected(), [...ids].sort());
    const select = (id, shiftKey = false) => doc.querySelector(`#layer-list [data-layer="${id}"]`).dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey }));
    const item = (deck, id) => deck.slides[0].items.find(object => object.id === id);
    const marker = () => doc.querySelector('.selection-marquee');
    const screen = ([x, y]) => { const point = stage.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(stage.getScreenCTM()); };
    let pointerId = 70;
    const pointer = (target, type, point, id, options = {}) => target.dispatchEvent(new win.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: point.x, clientY: point.y, ...options,
    }));
    const begin = async (from, to, options = {}) => {
      const { target = stage, ...modifiers } = options, id = ++pointerId;
      pointer(target, 'pointerdown', screen(from), id, modifiers);
      pointer(stage, 'pointermove', screen(to), id, modifiers); await frame();
      return { id, to, modifiers };
    };
    const finish = async drag => { pointer(stage, 'pointerup', screen(drag.to), drag.id, drag.modifiers); await frame(); };
    const marquee = async (from, to, options) => { const drag = await begin(from, to, options); await finish(drag); };
    const clickBlank = async shiftKey => { const id = ++pointerId, point = screen([900, 80]); pointer(stage, 'pointerdown', point, id, { shiftKey }); pointer(stage, 'pointerup', point, id, { shiftKey }); await frame(); };
    const original = fixtureDeck(), pair = ['picture', 'shape'];

    await open(original);
    const first = await begin([80, 80], [400, 310]);
    check('Dragging blank canvas displays a visible selection rectangle', !!marker() && Number(marker().getAttribute('width')) > 0 && Number(marker().getAttribute('height')) > 0);
    await finish(first);
    check('Marquee selects fully enclosed objects and excludes partial, hidden and locked objects', selectionIs(...pair) && !marker(), { selected: selected() });
    check('Selecting objects changes neither project content nor Undo history', equal(await save(), original) && get('undo').disabled);
    for (const [label, from, to] of [
      ['bottom right to top left', [400, 310], [80, 80]],
      ['top right to bottom left', [400, 80], [80, 310]],
      ['bottom left to top right', [80, 310], [400, 80]],
    ]) {
      await marquee(from, to); check(`Marquee works from ${label}`, selectionIs(...pair), { selected: selected() });
    }

    // Start on an already selected object; both selected objects must move by
    // the same slide-space delta, leaving source bytes and other objects intact.
    const move = await begin([140, 140], [177, 163], { target: stage.querySelector('[data-item="picture"] .item-hit') });
    await finish(move);
    const moved = await save();
    const unchanged = moved.slides[0].items.filter(object => !pair.includes(object.id)).every(object => equal(object, item(original, object.id)));
    const spacingPreserved = ['x', 'y'].every(axis => Math.abs((item(moved, 'shape')[axis] - item(moved, 'picture')[axis]) - (item(original, 'shape')[axis] - item(original, 'picture')[axis])) < 1e-6);
    check('Dragging a selected object moves the whole group by the same amount', pair.every(id => near(item(moved, id).x, item(original, id).x + 37) && near(item(moved, id).y, item(original, id).y + 23)) && spacingPreserved && selectionIs(...pair), { selected: selected(), spacingPreserved, items: moved.slides[0].items });
    check('Group movement preserves unselected objects and original asset data', unchanged && equal(moved.assets, original.assets));
    get('undo').click();
    check('One Undo reverts the entire move, with no extra selection history', equal(await save(), original) && get('undo').disabled);
    get('redo').click(); const redone = await save();
    check('One Redo restores the entire group move', equal(redone, moved));

    await open(original); select('remote');
    await marquee([80, 80], [400, 310], { shiftKey: true });
    check('Shift-marquee adds enclosed objects without losing the previous selection', selectionIs('remote', ...pair));
    await marquee([80, 80], [400, 310], { shiftKey: true });
    check('Shift-marquee retains objects already included in the selection', selectionIs('remote', ...pair));
    await clickBlank(true); check('Shift-clicking blank canvas preserves the selection', selectionIs('remote', ...pair) && !marker());
    await clickBlank(false); check('Clicking blank canvas clears the selection without a marquee or Undo entry', selectionIs() && !marker() && get('undo').disabled);
    select('remote'); await marquee([80, 80], [400, 310]);
    check('Marquee without Shift replaces the previous selection', selectionIs(...pair));

    await open(original);
    await marquee([475, 235], [645, 325]);
    check('A rectangle enclosing only an object’s unrotated bounds does not select its protruding rotated corners', selectionIs(), { selected: selected() });
    await marquee([460, 180], [660, 380]);
    check('Enclosing all rotated corners selects the rotated object', selectionIs('rotated'), { selected: selected() });

    await open(original);
    const outside = screen([-20, -20]), stageBounds = stage.getBoundingClientRect(), workspaceBounds = workspace.getBoundingClientRect();
    check('Outside-start fixture begins in the surrounding workspace', outside.x < stageBounds.left && outside.y < stageBounds.top && outside.x > workspaceBounds.left && outside.y > workspaceBounds.top, { outside: { x: outside.x, y: outside.y }, stage: { left: stageBounds.left, top: stageBounds.top }, workspace: { left: workspaceBounds.left, top: workspaceBounds.top } });
    await marquee([-20, -20], [400, 310], { target: workspace });
    check('A drag beginning outside the slide selects enclosed canvas objects', selectionIs(...pair) && !marker());

    for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'window blur']) {
      await open(original); select('remote');
      const drag = await begin([80, 80], [400, 310]);
      if (cancellation === 'Escape') doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else if (cancellation === 'window blur') win.dispatchEvent(new win.Event('blur'));
      else pointer(stage, cancellation, screen(drag.to), drag.id);
      await finish(drag);
      check(`${cancellation} restores the selection from before the drag and removes the rectangle`, selectionIs('remote') && !marker(), { selected: selected() });
      check(`${cancellation} leaves project content and Undo history unchanged`, equal(await save(), original) && get('undo').disabled);
    }

    await open(original); select('remote');
    const owned = await begin([80, 80], [400, 310]);
    const ownedBounds = ['x', 'y', 'width', 'height'].map(attribute => marker()?.getAttribute(attribute));
    pointer(stage, 'pointermove', screen([900, 650]), owned.id + 1);
    pointer(stage, 'pointerup', screen([900, 650]), owned.id + 1); await frame();
    check('Another pointer cannot change or finish the active selection rectangle', selectionIs(...pair) && !!marker() && equal(['x', 'y', 'width', 'height'].map(attribute => marker()?.getAttribute(attribute)), ownedBounds));
    pointer(stage, 'pointercancel', screen(owned.to), owned.id); await frame();
    check('The original pointer can still cancel after unrelated pointer events', selectionIs('remote') && !marker() && get('undo').disabled);

    await open(original); select('remote');
    const staleEdit = await begin([80, 80], [400, 310]);
    // A toolbar edit also models an asynchronous import/edit completing while
    // the pointer is down: the new edit owns the selection after its revision.
    get('add-rect').click(); await frame();
    const edited = await save(), added = edited.slides[0].items.find(object => !original.slides[0].items.some(previous => previous.id === object.id));
    check('A newer edit invalidates the marquee without restoring the old selection', !!added && selectionIs(added.id) && !marker(), { selected: selected(), added: added?.id });
    await finish(staleEdit);
    check('Releasing a stale pointer preserves the newer object, selection and project edit', !!added && selectionIs(added.id) && equal(await save(), edited) && !marker());
    get('undo').click();
    check('Cancelling a stale marquee adds no history beyond the newer edit', equal(await save(), original) && get('undo').disabled);

    const multiple = structuredClone(original);
    multiple.slides.push({ id: 'marquee-slide-two', name: 'Second slide', canvas: { ...multiple.slides[0].canvas }, items: [{ ...item(original, 'remote'), id: 'second-slide-object' }] });
    await open(validateDeck(multiple)); select('remote');
    const staleSlide = await begin([80, 80], [400, 310]);
    doc.querySelector('#slide-list [data-slide="marquee-slide-two"]').click(); await frame();
    await finish(staleSlide);
    const switched = await save();
    check('Switching slides cancels the rectangle without carrying stale object selection into the new slide', switched.activeSlideId === 'marquee-slide-two' && selectionIs() && !marker() && equal(switched.slides, multiple.slides) && get('undo').disabled);

    await open(original);
    for (let index = 0; index < 8; index++) get('zoom-in').click();
    workspace.scrollLeft = 140; workspace.scrollTop = 100; await frame();
    check('Zoom/scroll fixture has nonzero workspace scrolling', workspace.scrollLeft > 0 && workspace.scrollTop > 0, { scrollLeft: workspace.scrollLeft, scrollTop: workspace.scrollTop, zoom: get('zoom-value').textContent });
    await marquee([80, 80], [400, 310]);
    check('Marquee coordinates remain accurate after zooming and scrolling', selectionIs(...pair), { selected: selected(), zoom: get('zoom-value').textContent });

    await open(original);
    const objectClick = async (id, shiftKey = false) => {
      const object = item(original, id), point = screen([object.x + object.width / 2, object.y + object.height / 2]), pointer = ++pointerId;
      const target = stage.querySelector(`[data-item="${id}"] .item-hit`);
      target.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: pointer, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: point.x, clientY: point.y, shiftKey }));
      stage.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, pointerId: pointer, pointerType: 'mouse', isPrimary: true, button: 0, clientX: point.x, clientY: point.y, shiftKey })); await frame();
    };
    await objectClick('picture'); await objectClick('shape', true);
    check('Shift-click still adds individual objects without starting a marquee', selectionIs(...pair) && !marker());
    await objectClick('shape', true);
    check('Shift-click still removes individual objects from the selection', selectionIs('picture'));
    const handle = stage.querySelector('[data-resize="picture"][data-resize-handle="e"]');
    if (!handle) throw new Error('Selected image lost its east resize handle.');
    const bounds = handle.getBoundingClientRect(), from = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, matrix = stage.getScreenCTM();
    const to = { x: from.x + matrix.a * 40, y: from.y + matrix.b * 40 }, resizeID = ++pointerId;
    pointer(handle, 'pointerdown', from, resizeID); pointer(stage, 'pointermove', to, resizeID); pointer(stage, 'pointerup', to, resizeID); await frame();
    const resized = item(await save(), 'picture');
    check('Image edge resizing remains functional and does not start marquee selection', near(resized.width, 160) && near(resized.height, 80) && near(resized.x, 100) && near(resized.y, 100) && !marker());
    get('undo').click(); check('Undo still restores an ordinary resize in one step', equal(await save(), original) && get('undo').disabled);
  } catch (error) { check(error.message, false); console.error(error); }
  finally {
    restore(); runButton.disabled = false;
    window.marqueeChecks = { finished: true, checks }; window.__marqueeChecks = checks;
    document.title = `${checks.every(result => result.pass) ? 'PASS' : 'FAIL'} — Figure Editor marquee checks`;
  }
};
