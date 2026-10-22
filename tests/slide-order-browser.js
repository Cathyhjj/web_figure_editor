import { createDeck, validateDeck } from '../deck.js';

const checks = [], results = document.getElementById('results'), runButton = document.getElementById('run');
function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}

async function loadEditor() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under Slide order integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?slide-order-checks=${Date.now()}`;
  document.getElementById('editor-host').replaceChildren(iframe);
  await loaded;
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) throw new Error('The editor app module was not found.');
    const script = doc.createElement('script');
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('slide-order-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('slide-order-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => { clearTimeout(timeout); win.removeEventListener('slide-order-editor-ready', ready); win.removeEventListener('slide-order-editor-failed', failed); script.remove(); };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('slide-order-editor-ready', ready, { once: true });
    win.addEventListener('slide-order-editor-failed', failed, { once: true });
    doc.body.append(script);
  });
  return iframe;
}

function fixtureDeck(count = 6) {
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 16;
  const context = canvas.getContext('2d');
  context.fillStyle = '#9456aa'; context.fillRect(0, 0, 32, 16);
  context.fillStyle = '#ffffff'; context.fillRect(2, 2, 5, 5);
  const deck = createDeck();
  deck.name = 'Slide order integration fixture';
  deck.assets = [{ id: 'order-image', name: 'original.png', mime: 'image/png', width: 32, height: 16, dataUrl: canvas.toDataURL('image/png'), sourceKind: 'copy' }];
  deck.slides = Array.from({ length: count }, (_, index) => ({
    id: `order-slide-${index}`, name: `Slide ${String.fromCharCode(65 + index)}`,
    canvas: { width: 400 + index * 2, height: 210 + index, background: index % 2 ? '#f3eaf9' : '#f5f7ee' },
    items: [
      { id: `order-text-${index}`, name: `Label ${index}`, type: 'text', text: `Slide ${String.fromCharCode(65 + index)} α`, x: 15 + index, y: 20, width: 200, height: 45, fontFamily: 'Georgia', fontSize: 25, fontWeight: '700', fontStyle: 'italic', align: 'left', color: '#452f65', rotation: index * 2, opacity: 0.8, hidden: index === 3, locked: index === 2 },
      ...(index % 2 === 0 ? [{ id: `order-image-item-${index}`, name: 'Shared source', type: 'image', assetId: 'order-image', x: 35, y: 90 + index, width: 128, height: 64, rotation: index, opacity: 0.75, locked: index === 0 }] : []),
    ],
  }));
  deck.activeSlideId = deck.slides[Math.min(2, count - 1)].id;
  return validateDeck(deck);
}

async function until(predicate, label) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

runButton.onclick = async () => {
  results.replaceChildren(); checks.length = 0; runButton.disabled = true;
  document.title = 'RUNNING — Figure Editor Slide order checks';
  window.slideOrderChecks = { finished: false, checks };
  let restore = () => {};
  try {
    if (!['18766', '18768'].includes(location.port) || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use a separate localhost server on port 18766 or 18768 to protect the normal editor draft.');
    const iframe = await loadEditor(), win = iframe.contentWindow, doc = iframe.contentDocument;
    const get = id => doc.getElementById(id), list = get('slide-list');
    const oldCreateURL = win.URL.createObjectURL, oldClick = win.HTMLAnchorElement.prototype.click, oldConfirm = win.confirm;
    const pickerDescriptor = Object.getOwnPropertyDescriptor(win, 'showSaveFilePicker');
    const createdURLs = new Map(), downloads = [];
    Object.defineProperty(win, 'showSaveFilePicker', { configurable: true, value: undefined });
    win.confirm = () => true;
    win.URL.createObjectURL = blob => { const url = oldCreateURL.call(win.URL, blob); createdURLs.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(createdURLs.get(this.href)); else oldClick.call(this); };
    restore = () => {
      if (pickerDescriptor) Object.defineProperty(win, 'showSaveFilePicker', pickerDescriptor); else delete win.showSaveFilePicker;
      win.confirm = oldConfirm; win.URL.createObjectURL = oldCreateURL; win.HTMLAnchorElement.prototype.click = oldClick;
      for (const url of createdURLs.keys()) win.URL.revokeObjectURL(url);
    };
    const frame = () => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    const save = async () => {
      const index = downloads.length;
      await get('save-project').onclick();
      if (!downloads[index]) throw new Error('Could not capture the project snapshot.');
      return JSON.parse(await downloads[index].text());
    };
    const open = async deck => {
      const transfer = new win.DataTransfer();
      transfer.items.add(new win.File([JSON.stringify(deck)], 'slide-order.figure.json', { type: 'application/json' }));
      get('project-input').files = transfer.files;
      await get('project-input').onchange({ target: get('project-input') });
      list.scrollTop = 0; list.scrollLeft = 0; await frame();
    };
    const cards = () => [...list.querySelectorAll('.slide-card')];
    const cardFor = id => cards().find(card => card.dataset.slide === id);
    const selected = () => cards().filter(card => card.getAttribute('aria-pressed') === 'true').map(card => card.dataset.slide);
    const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const onlyOrderChanged = (before, after, order) => equal(after, { ...before, slides: order.map(id => before.slides.find(page => page.id === id)) });
    // Fixture selection uses the real card handler without leaving an unrelated
    // pointer-generated click for the drag controller to suppress.
    const select = (id, options = {}) => cardFor(id).onclick(new win.MouseEvent('click', options));
    let pointerId = 60;
    const pointer = (target, type, point, id, options = {}) => {
      const event = new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: point.x, clientY: point.y, ...options });
      target.dispatchEvent(event); return event;
    };
    const center = element => { const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }; };
    const targetPoint = (id, side) => {
      const card = cardFor(id); card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const bounds = card.getBoundingClientRect(), horizontal = win.getComputedStyle(list).flexDirection.startsWith('row');
      return horizontal ? { x: side === 'before' ? bounds.left + 3 : bounds.right - 3, y: bounds.top + bounds.height / 2 } : { x: bounds.left + bounds.width / 2, y: side === 'before' ? bounds.top + 3 : bounds.bottom - 3 };
    };
    const begin = async (sourceId, targetId, side = 'before') => {
      const source = cardFor(sourceId); source.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const start = center(source), id = ++pointerId;
      pointer(source, 'pointerdown', start, id);
      const point = targetPoint(targetId, side);
      pointer(doc, 'pointermove', point, id); await frame();
      return { source, point, id };
    };
    const finish = async (drag, point = drag.point) => {
      pointer(doc, 'pointerup', point, drag.id);
      // Synthetic PointerEvents do not produce the browser's trailing click.
      // Exercise click suppression on the original card while it remains in
      // this list. Once a project replacement detaches that card, the native
      // pointer-capture target is the connected list, never the stale card.
      const clickTarget = drag.source.isConnected && list.contains(drag.source) ? drag.source : list;
      clickTarget.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: point.x, clientY: point.y }));
      await frame();
    };
    const dragTo = async (sourceId, targetId, side = 'before') => { const drag = await begin(sourceId, targetId, side); await finish(drag); };
    const marker = () => doc.querySelector('.slide-drop-marker'), preview = () => doc.querySelector('.slide-drag-preview');
    const indicatorsGone = () => !marker() && !preview();
    const outsidePoint = () => center(get('workspace'));
    const fixture = fixtureDeck(), ids = fixture.slides.map(page => page.id);

    await open(fixture);
    check('Slide thumbnails disable HTML drag-and-drop while retaining keyboard button semantics', cards().every(card => card.tagName === 'BUTTON' && card.draggable === false));
    const firstDrag = await begin(ids[2], ids[0]);
    check('Moving beyond the threshold displays a drop marker and one-slide drag preview', !!marker() && !marker().hidden && !!preview() && /1\s+slide/i.test(preview().textContent));
    await finish(firstDrag);
    const beforeFirst = await save();
    check('Dragging a slide before the first thumbnail changes only slide order and preserves the active slide', onlyOrderChanged(fixture, beforeFirst, [ids[2], ids[0], ids[1], ids[3], ids[4], ids[5]]) && equal(selected(), [ids[2]]) && indicatorsGone());
    get('undo').click();
    check('One Undo restores slide order and focuses the original active thumbnail', equal(await save(), fixture) && equal(selected(), [ids[2]]) && doc.activeElement?.dataset.slide === ids[2]);
    get('redo').click();
    check('One Redo restores the move, selection and thumbnail keyboard focus', equal(await save(), beforeFirst) && equal(selected(), [ids[2]]) && doc.activeElement?.dataset.slide === ids[2]);
    await open(beforeFirst);
    check('Save/Open retains reordered slides with unchanged objects, assets and active identity', equal(await save(), beforeFirst) && equal(cards().map(card => card.dataset.slide), beforeFirst.slides.map(page => page.id)));

    await open(fixture); select(ids[0]);
    const beforeEnd = await save();
    await dragTo(ids[0], ids[5], 'after');
    const atEnd = await save();
    check('Dragging to the bottom half of the final thumbnail appends the slide after every remaining slide', onlyOrderChanged(beforeEnd, atEnd, [ids[1], ids[2], ids[3], ids[4], ids[5], ids[0]]) && equal(selected(), [ids[0]]));

    await open(fixture); select(ids[4]); select(ids[2], { metaKey: true }); select(ids[0], { ctrlKey: true });
    const groupBefore = await save(), groupIDs = [ids[0], ids[2], ids[4]];
    const groupDrag = await begin(ids[2], ids[5]);
    check('Dragging an already selected thumbnail retains the non-adjacent group and reports its size', equal(selected(), groupIDs) && /3\s+slides/i.test(preview()?.textContent || ''));
    await finish(groupDrag);
    const groupMoved = await save();
    check('A selected group moves as one block in original slide order despite reverse selection order', onlyOrderChanged(groupBefore, groupMoved, [ids[1], ids[3], ids[0], ids[2], ids[4], ids[5]]) && equal(selected(), groupIDs) && groupMoved.activeSlideId === ids[0]);
    check('The pointer-generated click after a group drag cannot collapse selection or change the active slide', selected().length === 3 && doc.activeElement?.dataset.slide === ids[0]);
    get('undo').click();
    check('Undo of a group move restores the complete previous order and multi-selection in one step', equal(await save(), groupBefore) && equal(selected(), groupIDs) && doc.activeElement?.dataset.slide === ids[0] && get('undo').disabled);
    get('redo').click();
    check('Redo of a group move restores all selected slides together without changing their content', equal(await save(), groupMoved) && equal(selected(), groupIDs) && doc.activeElement?.dataset.slide === ids[0]);

    await open(fixture); select(ids[4]); select(ids[2], { metaKey: true }); select(ids[0], { ctrlKey: true });
    const unselectedDrag = await begin(ids[1], ids[5]);
    check('Starting a drag from an unselected thumbnail selects only that slide once dragging activates', equal(selected(), [ids[1]]) && /1\s+slide/i.test(preview()?.textContent || ''));
    await finish(unselectedDrag);
    const formerlyUnselectedMoved = await save();
    check('Dragging an unselected thumbnail moves that slide alone and leaves the prior group in place', onlyOrderChanged({ ...fixture, activeSlideId: ids[1] }, formerlyUnselectedMoved, [ids[0], ids[2], ids[3], ids[4], ids[1], ids[5]]) && equal(selected(), [ids[1]]));

    await open(fixture); select(ids[1]); select(ids[2], { metaKey: true });
    const noOpBefore = await save();
    await dragTo(ids[1], ids[3]);
    check('Dropping a contiguous group at its existing boundary is a no-op with no Undo entry', equal(await save(), noOpBefore) && equal(selected(), [ids[1], ids[2]]) && get('undo').disabled && indicatorsGone());

    await open(fixture);
    const tinySource = cardFor(ids[0]), tinyStart = center(tinySource), tinyID = ++pointerId;
    pointer(tinySource, 'pointerdown', tinyStart, tinyID);
    pointer(doc, 'pointermove', { x: tinyStart.x + 2, y: tinyStart.y + 2 }, tinyID);
    pointer(doc, 'pointerup', { x: tinyStart.x + 2, y: tinyStart.y + 2 }, tinyID);
    tinySource.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    check('Movement below the drag threshold remains an ordinary single-slide click without reordering', onlyOrderChanged({ ...fixture, activeSlideId: ids[0] }, await save(), ids) && equal(selected(), [ids[0]]) && get('undo').disabled && indicatorsGone());

    await open(fixture);
    const outsideDrag = await begin(ids[2], ids[0]), outside = outsidePoint();
    pointer(doc, 'pointermove', outside, outsideDrag.id); await frame();
    check('Moving outside the slide list hides the insertion marker', !!marker() && marker().hidden);
    await finish(outsideDrag, outside);
    check('Dropping outside the slide list cancels the move and removes every drag indicator', equal(await save(), fixture) && get('undo').disabled && indicatorsGone());

    await open(fixture);
    const escaped = await begin(ids[2], ids[0]);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await finish(escaped);
    check('Escape cancels an active drag without moving slides or creating history', equal(await save(), fixture) && get('undo').disabled && indicatorsGone());

    await open(fixture);
    const cancelled = await begin(ids[2], ids[0]);
    pointer(doc, 'pointercancel', cancelled.point, cancelled.id);
    await finish(cancelled);
    check('Pointer cancellation clears the drag without committing a slide move', equal(await save(), fixture) && get('undo').disabled && indicatorsGone());

    await open(fixture);
    const foreignSource = cardFor(ids[2]), foreignStart = center(foreignSource), foreignID = ++pointerId, foreignTarget = targetPoint(ids[0], 'before');
    pointer(foreignSource, 'pointerdown', foreignStart, foreignID);
    pointer(doc, 'pointermove', foreignTarget, foreignID + 1);
    pointer(doc, 'pointerup', foreignTarget, foreignID + 1);
    check('A different pointer cannot activate or finish another pointer’s drag candidate', indicatorsGone() && equal(await save(), fixture));
    pointer(doc, 'pointercancel', foreignStart, foreignID);

    await open(fixture);
    const staleRevision = await begin(ids[2], ids[0]);
    get('canvas-width').value = '640'; get('canvas-height').value = '360';
    get('apply-canvas').click();
    const editedDuringDrag = await save();
    await finish(staleRevision);
    check('Editing the project during a drag invalidates the stale move while preserving the newer edit', equal(await save(), editedDuringDrag) && indicatorsGone());
    get('undo').click();
    check('A cancelled stale drag adds no extra history after the intervening edit', equal(await save(), fixture) && get('undo').disabled);

    await open(fixture);
    const staleProject = await begin(ids[2], ids[0]);
    get('new-project').click();
    const replacement = await save();
    await finish(staleProject, center(list));
    check('Replacing the project during a drag prevents old slide identities from changing the new project', equal(await save(), replacement) && replacement.slides.length === 1 && get('undo').disabled && indicatorsGone());

    const longFixture = fixtureDeck(20); longFixture.activeSlideId = longFixture.slides[0].id;
    await open(longFixture);
    const scrollSource = cardFor(longFixture.activeSlideId), scrollStart = center(scrollSource), scrollID = ++pointerId;
    pointer(scrollSource, 'pointerdown', scrollStart, scrollID);
    const viewport = list.getBoundingClientRect(), scrollsHorizontally = win.getComputedStyle(list).flexDirection.startsWith('row');
    const edge = scrollsHorizontally ? { x: viewport.right - 6, y: viewport.top + viewport.height / 2 } : { x: viewport.left + viewport.width / 2, y: viewport.bottom - 6 };
    pointer(doc, 'pointermove', edge, scrollID);
    const scrollOffset = () => scrollsHorizontally ? list.scrollLeft : list.scrollTop;
    await until(() => scrollOffset() > 10, 'drag auto-scroll at the list edge');
    check('Holding a dragged slide near the list edge scrolls the rail while retaining the drag preview', scrollOffset() > 10 && !!preview() && !!marker());
    const scrollDrag = { source: scrollSource, point: edge, id: scrollID };
    pointer(doc, 'pointermove', outsidePoint(), scrollID);
    await finish(scrollDrag, outsidePoint());
    check('Cancelling after auto-scroll retains every slide and its original position', equal(await save(), longFixture) && get('undo').disabled && indicatorsGone());

    // Leave five distinct slides and a non-adjacent group ready for a separate
    // real-pointer drag and visual inspection after the synthetic suite.
    const visualFixture = fixtureDeck(5);
    await open(visualFixture);
    select(visualFixture.slides[4].id); select(visualFixture.slides[2].id, { metaKey: true }); select(visualFixture.slides[0].id, { ctrlKey: true });
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    restore(); runButton.disabled = false;
    const passed = checks.length > 0 && checks.every(result => result.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor Slide order checks`;
    window.slideOrderChecks = { finished: true, passed, checks: [...checks] };
  }
};
