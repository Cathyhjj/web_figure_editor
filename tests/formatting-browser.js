import { createDeck, validateDeck } from '../deck.js';

const checks = [], results = document.querySelector('#results'), run = document.querySelector('#run');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, pass) {
  checks.push({ name, pass: Boolean(pass) });
  const row = document.createElement('li');
  row.dataset.pass = String(Boolean(pass));
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}
async function until(predicate, label) {
  const end = performance.now() + 8000;
  while (!await predicate()) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${label}.`);
    await pause(30);
  }
}
async function settle(win) {
  await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
  await pause(40);
}
async function loadEditor(width = 1400) {
  const frame = document.createElement('iframe');
  frame.title = 'Editor under formatting integration test';
  frame.style.width = `${width}px`;
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Editor frame did not load.')), 15000);
    frame.onload = () => { clearTimeout(timeout); resolve(); };
    frame.onerror = () => { clearTimeout(timeout); reject(new Error('Editor frame failed to load.')); };
  });
  frame.src = `../index.html?formatting-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(frame);
  await loaded;
  const win = frame.contentWindow, doc = frame.contentDocument;
  // Reuse the exact module URL; awaiting it also awaits saved-draft restoration.
  await new Promise((resolve, reject) => {
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) { reject(new Error('Editor module was not found.')); return; }
    const script = doc.createElement('script');
    const cleanup = () => {
      clearTimeout(timeout); script.remove();
      win.removeEventListener('formatting-editor-ready', ready);
      win.removeEventListener('formatting-editor-failed', failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Editor draft restoration timed out.')); }, 15000);
    win.addEventListener('formatting-editor-ready', ready, { once: true });
    win.addEventListener('formatting-editor-failed', failed, { once: true });
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(() => window.dispatchEvent(new Event('formatting-editor-ready')), error => window.dispatchEvent(new CustomEvent('formatting-editor-failed', {detail: error.message})));`;
    doc.body.append(script);
  });
  win.confirm = () => true;
  await settle(win);
  return frame;
}
function fixture() {
  const canvas = document.createElement('canvas');
  canvas.width = 80; canvas.height = 60;
  const context = canvas.getContext('2d');
  context.fillStyle = '#2878d0'; context.fillRect(0, 0, 40, 60);
  context.fillStyle = '#ffc44d'; context.fillRect(40, 0, 40, 60);
  const originalSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><rect width="40" height="60" fill="#2878d0"/><rect x="40" width="40" height="60" fill="#ffc44d"/></svg>';
  const deck = createDeck(); deck.name = 'Formatting integration fixture';
  deck.assets = [{ id: 'format-png', name: 'synthetic-picture.png', mime: 'image/png', dataUrl: canvas.toDataURL('image/png'), width: 80, height: 60, sourceKind: 'copy', originalMime: 'image/svg+xml', originalDataUrl: `data:image/svg+xml;base64,${btoa(originalSVG)}` }];
  deck.slides[0].canvas = { width: 800, height: 500, background: '#ffffff' };
  deck.slides[0].items = [
    { id: 'format-rect', name: 'Rectangle', type: 'rect', x: 40, y: 40, width: 180, height: 110, fill: '#ee7755', stroke: '#252735', strokeWidth: 2 },
    { id: 'format-picture', name: 'Synthetic picture', type: 'image', assetId: 'format-png', x: 280, y: 40, width: 160, height: 120 },
    { id: 'format-vector', name: 'Imported gradient', type: 'shape', x: 40, y: 240, width: 180, height: 120, fill: '#4472c4', stroke: '#224466', strokeWidth: 2,
      paths: [{ fillMode: 'norm', stroke: true, commands: [['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['L', 0, 1], ['Z']] }],
      fillGradient: { angle: 90, stops: [{ offset: 0, color: '#4472c4' }, { offset: 1, color: '#ffffff' }] } },
  ];
  return validateDeck(deck);
}
async function readDraft(win) {
  const db = await new Promise((resolve, reject) => {
    const request = win.indexedDB.open('figure-editor-drafts', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts', 'readonly').objectStore('drafts').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

run.onclick = async () => {
  run.disabled = true; results.replaceChildren(); checks.length = 0;
  document.querySelector('#summary').textContent = 'Running…';
  try {
    let frame = await loadEditor(), win = frame.contentWindow, doc = frame.contentDocument;
    const get = id => doc.getElementById(id);
    const find = selector => {
      const node = doc.querySelector(selector);
      if (!node) throw new Error(`Missing control: ${selector}`);
      return node;
    };
    const shown = node => Boolean(node && !node.hidden && node.getClientRects().length && win.getComputedStyle(node).visibility !== 'hidden');
    const item = id => find(`#stage [data-item="${id}"]`);
    const selected = () => doc.querySelector('#stage .figure-item.selected');
    const menu = () => doc.querySelector('.object-context-menu[role="menu"]');
    const action = name => find(`.object-context-menu [data-context-action="${name}"]`);
    const panel = () => find('[data-window="objects"]');
    const formatOpen = () => find('.editor-layout').classList.contains('format-panel-open');
    const select = id => find(`#layer-list [data-layer="${id}"] .layer-select`).click();
    const tab = name => find(`[role="tab"][data-format-tab="${name}"]`).click();
    const set = (selector, value) => {
      const input = find(selector); input.value = value;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    const key = (target, key, options = {}) => {
      target.focus({ preventScroll: true });
      const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event); return event;
    };
    const rightClick = (id, position) => {
      const target = item(id).querySelector('.item-hit'), bounds = target.getBoundingClientRect();
      const event = new win.MouseEvent('contextmenu', { button: 2, buttons: 2, bubbles: true, cancelable: true,
        clientX: position?.x ?? bounds.x + bounds.width / 2, clientY: position?.y ?? bounds.y + bounds.height / 2 });
      target.dispatchEvent(event); return event;
    };
    const openFormat = async id => { rightClick(id); action('format').click(); await settle(win); };

    get('reset-layout').click();
    const original = fixture(), transfer = new win.DataTransfer();
    transfer.items.add(new win.File([JSON.stringify(original)], 'formatting-checks.figure.json', { type: 'application/json' }));
    get('project-input').files = transfer.files;
    await get('project-input').onchange({ target: get('project-input') });

    const right = rightClick('format-rect');
    check('Right-click suppresses the browser menu, selects the clicked shape, and offers Format Shape', right.defaultPrevented && selected()?.dataset.item === 'format-rect' && shown(menu()) && /Format Shape/.test(action('format').textContent));
    get('assets-panel').dispatchEvent(new win.Event('scroll'));
    check('Revealing a selected image in Assets does not dismiss its object menu', shown(menu()));
    get('workspace').dispatchEvent(new win.Event('scroll'));
    check('Scrolling the canvas dismisses its object menu', !shown(menu()));
    rightClick('format-rect');
    const transform = item('format-rect').getAttribute('transform');
    key(action('format'), 'ArrowDown'); key(doc.activeElement, 'ArrowUp'); key(doc.activeElement, 'Delete');
    check('Keyboard menu navigation does not move or delete the selected shape', item('format-rect').getAttribute('transform') === transform && get('stage').querySelectorAll('[data-item]').length === 3);
    key(doc.activeElement, 'Escape');
    check('Escape dismisses only the context menu and preserves object selection', !shown(menu()) && selected()?.dataset.item === 'format-rect');
    const keyboardMenu = key(get('workspace'), 'F10', { shiftKey: true });
    check('Shift+F10 opens object actions for the keyboard selection without changing geometry', keyboardMenu.defaultPrevented && shown(menu()) && /Format Shape/.test(action('format').textContent) && item('format-rect').getAttribute('transform') === transform);
    key(action('format'), 'Escape');
    rightClick('format-rect', { x: win.innerWidth - 2, y: win.innerHeight - 2 });
    await settle(win);
    const menuBounds = menu().getBoundingClientRect();
    check('Context menu remains inside the viewport at its bottom-right edge', menuBounds.left >= 0 && menuBounds.top >= 0 && menuBounds.right <= win.innerWidth + 1 && menuBounds.bottom <= win.innerHeight + 1);
    get('project-name').dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    check('Pointer interaction outside the context menu dismisses it', !shown(menu()));
    const blank = new win.MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
    get('stage').dispatchEvent(blank);
    check('Blank canvas retains its normal browser context menu', !blank.defaultPrevented && !shown(menu()));

    await openFormat('format-rect');
    check('Format Shape opens the docked formatting panel with a selected Fill and Line tab', formatOpen() && shown(panel()) && panel().dataset.windowState === 'docked' && /Format Shape/.test(panel().textContent) && find('[data-format-tab="paint"]').getAttribute('aria-selected') === 'true');
    key(find('[data-format-tab="paint"]'), 'ArrowRight');
    const sizeByKeyboard = find('[data-format-tab="size"]').getAttribute('aria-selected') === 'true';
    key(doc.activeElement, 'ArrowLeft');
    check('Arrow keys navigate formatting tabs without nudging the selected object', sizeByKeyboard && find('[data-format-tab="paint"]').getAttribute('aria-selected') === 'true' && item('format-rect').getAttribute('transform') === transform);
    const saveShortcuts = [];
    const interceptSave = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        saveShortcuts.push({ target: event.target, prevented: event.defaultPrevented });
        // Observe propagation before document's real Save handler without opening a picker.
        event.stopPropagation();
      }
    };
    const shortcutInspector = get('inspector');
    shortcutInspector.addEventListener('keydown', interceptSave);
    try {
      const paintTab = find('[data-format-tab="paint"]');
      const summary = find('#format-page-paint .format-section > summary');
      for (const target of [paintTab, summary]) {
        key(target, 's', { ctrlKey: true });
        key(target, 's', { metaKey: true });
      }
      check('Formatting tabs and section summaries let Cmd/Ctrl+S reach the app shortcut boundary', saveShortcuts.length === 4 && saveShortcuts.every(event => !event.prevented));
    } finally { shortcutInspector.removeEventListener('keydown', interceptSave); }
    set('[data-shape-color="fill"]', '#1268cc');
    check('Shape fill changes the actual vector on the slide', Boolean(item('format-rect').querySelector('rect[fill="#1268cc"]')));
    set('[data-transparency="fillOpacity"][type="number"]', '45');
    check('Shape transparency synchronizes slider and rendered fill while the border stays opaque', find('[data-transparency="fillOpacity"][type="range"]').value === '45' && Boolean(item('format-rect').querySelector('rect[fill-opacity="0.55"][stroke-opacity="1"]')));
    get('undo').click(); select('format-rect');
    const undoPass = Boolean(item('format-rect').querySelector('rect[fill-opacity="1"]'));
    get('redo').click(); select('format-rect');
    check('Formatting uses existing Undo and Redo without losing shape color', undoPass && Boolean(item('format-rect').querySelector('rect[fill="#1268cc"][fill-opacity="0.55"]')));
    tab('size'); set('[data-property="width"]', '210');
    check('Size tab changes editable geometry', Boolean(item('format-rect').querySelector('rect[width="210"][fill="#1268cc"]')));
    get('object-locked').click();
    rightClick('format-rect');
    check('Locked object formatting and destructive context actions are disabled', [...get('inspector').querySelectorAll('[data-property],[data-transparency],[data-shape-color],[data-shape-paint]')].every(node => node.disabled) && action('delete').disabled && action('duplicate').disabled);
    key(action('format'), 'Escape'); get('object-locked').click();

    await openFormat('format-vector'); tab('paint');
    check('Imported PowerPoint vector opens Format Shape and retains editable gradient stops', find('[data-shape="mode"]').value === 'gradient' && doc.querySelectorAll('[data-shape="stopColor"]').length === 2 && /Format Shape/.test(panel().textContent));
    set('[data-shape="stopColor"][data-stop="0"]', '#00aa66');
    check('Editing an imported gradient updates its SVG stop without flattening its path', Boolean(item('format-vector').querySelector('linearGradient stop[stop-color^="#00aa66"]')) && Boolean(item('format-vector').querySelector('path')) && !item('format-vector').querySelector('image'));

    rightClick('format-picture');
    check('Picture context menu selects the picture and offers Format Picture and Crop', selected()?.dataset.item === 'format-picture' && /Format Picture/.test(action('format').textContent) && !action('crop').disabled);
    action('format').click(); await settle(win); tab('picture');
    check('Format Picture provides picture controls and no shape paint controls', formatOpen() && /Format Picture/.test(panel().textContent) && shown(get('crop-image')) && !doc.querySelector('[data-shape-color]'));
    const restoreSVG = get('edit-svg'), pictureBeforeSVG = item('format-picture').innerHTML;
    const svgEntryShown = shown(restoreSVG) && restoreSVG.textContent === 'Restore editable SVG' && !restoreSVG.disabled;
    restoreSVG?.click();
    const svgEditorOpened = get('svg-editor')?.open && get('svg-elements')?.options.length > 1;
    get('svg-cancel')?.click();
    check('Format Picture retains Restore editable SVG and opens the original SVG editor without applying edits', svgEntryShown && svgEditorOpened && !get('svg-editor') && item('format-picture').innerHTML === pictureBeforeSVG);
    tab('effects'); get('shadow-enabled').click(); set('[data-shadow-property="color"]', '#0066aa');
    check('Picture Effects edits the live SVG shadow', Boolean(item('format-picture').querySelector('filter')) && Boolean(item('format-picture').querySelector('feFlood[flood-color="#0066aa"]')));
    set('[data-shadow-property="transparency"][type="number"]', '35');
    check('Shadow transparency keeps its paired slider synchronized', find('[data-shadow-property="transparency"][type="range"]').value === '35');
    tab('picture'); set('[data-transparency="opacity"][type="number"]', '20');
    check('Picture transparency changes the selected object opacity', item('format-picture').getAttribute('opacity') === '0.8');
    rightClick('format-picture'); action('crop').click();
    const imageBeforeCrop = item('format-picture').innerHTML;
    check('Picture context Crop opens the original image with editable handles', get('crop-dialog').open && get('crop-preview').querySelectorAll('.crop-handle').length === 8 && get('crop-preview').querySelector('image').getAttribute('href') === original.assets[0].dataUrl);
    get('crop-cancel').click(); await settle(win);
    check('Cancelling Crop retains existing picture formatting and image geometry', !get('crop-dialog').open && item('format-picture').innerHTML === imageBeforeCrop);
    get('crop-image').click(); key(find('#crop-preview [data-crop-handle="w"]'), 'ArrowRight', { shiftKey: true }); get('crop-apply').click();
    await settle(win);
    check('Crop from formatting remains editable and preserves the original embedded image', Boolean(item('format-picture').querySelector('svg[overflow="hidden"]')) && item('format-picture').querySelector('svg[overflow="hidden"] image').getAttribute('href') === original.assets[0].dataUrl && item('format-picture').getAttribute('opacity') === '0.8');
    tab('size'); get('object-locked').click(); tab('picture');
    check('Locked picture disables Crop, SVG restoration, and transparency', get('crop-image').disabled && get('edit-svg').disabled && find('[data-transparency="opacity"][type="number"]').disabled);
    tab('size'); get('object-locked').click();

    get('reset-layout').click(); await settle(win);
    check('Reset layout exits formatting mode and restores Layers and Canvas settings', !formatOpen() && shown(get('layers-panel')) && shown(find('[data-window="canvas"]')) && shown(panel()));
    await openFormat('format-picture'); get('show-all-panels').click(); await settle(win);
    check('Show all panels exits formatting mode and reveals Layers and Canvas settings', !formatOpen() && shown(get('layers-panel')) && shown(find('[data-window="canvas"]')) && [...doc.querySelectorAll('[data-panel]')].every(option => option.checked));
    for (const name of ['layers', 'canvas']) {
      await openFormat('format-picture');
      const viewOption = find(`[data-panel="${name}"]`);
      if (viewOption.checked) viewOption.click();
      const activeBeforeEnabling = formatOpen();
      viewOption.click(); await settle(win);
      check(`Explicitly showing ${name === 'layers' ? 'Layers' : 'Canvas settings'} through View exits formatting mode`, activeBeforeEnabling && viewOption.checked && !formatOpen() && shown(find(`[data-window="${name}"]`)));
    }
    await openFormat('format-picture');
    get('close-format-panel').click(); await settle(win);
    check('Close leaves the formatting panel mode', !formatOpen());
    get('add-text').click(); await settle(win);
    const addedTextId = selected()?.dataset.item, addedTextEditor = get('text-content');
    check('Add text after closing Format reveals and focuses the text editor', Boolean(addedTextId) && shown(panel()) && shown(addedTextEditor) && doc.activeElement === addedTextEditor && addedTextEditor.selectionStart === 0 && addedTextEditor.selectionEnd === addedTextEditor.value.length);
    await openFormat('format-picture'); get('close-format-panel').click(); await settle(win);
    item(addedTextId).querySelector('.item-hit').dispatchEvent(new win.MouseEvent('dblclick', { button: 0, bubbles: true, cancelable: true }));
    await settle(win);
    const reopenedTextEditor = get('text-content');
    check('Double-clicking text after closing Format reveals and focuses its editor', selected()?.dataset.item === addedTextId && shown(panel()) && shown(reopenedTextEditor) && doc.activeElement === reopenedTextEditor && reopenedTextEditor.selectionStart === 0 && reopenedTextEditor.selectionEnd === reopenedTextEditor.value.length);
    await openFormat('format-picture'); get('close-format-panel').click(); await settle(win);
    const visibility = find('[data-panel="objects"]');
    visibility.checked = false; visibility.dispatchEvent(new win.Event('change', { bubbles: true }));
    await openFormat('format-rect');
    check('Format reopens a hidden Objects panel and synchronizes its View toggle', shown(panel()) && find('[data-panel="objects"]').checked && formatOpen());
    get('close-format-panel').click();
    const visibilityAgain = find('[data-panel="objects"]');
    if (!visibilityAgain.checked) { visibilityAgain.checked = true; visibilityAgain.dispatchEvent(new win.Event('change', { bubbles: true })); }
    panel().querySelector('.window-toggle').click();
    const wasFloating = panel().dataset.windowState === 'floating';
    await openFormat('format-picture');
    check('Format recovers a floating properties panel into the full-height dock', wasFloating && panel().dataset.windowState === 'docked' && shown(panel()) && formatOpen());
    frame.style.width = '900px'; await settle(win); await openFormat('format-picture');
    const narrowBounds = panel().getBoundingClientRect();
    check('At 900 px the formatting drawer and Close control remain reachable', win.innerWidth === 900 && shown(get('close-format-panel')) && narrowBounds.left >= 0 && narrowBounds.right <= win.innerWidth + 1 && narrowBounds.top >= 0 && narrowBounds.bottom <= win.innerHeight + 1);

    await until(async () => {
      const saved = await readDraft(win), items = saved?.slides[0]?.items;
      return items?.find(entry => entry.id === 'format-picture')?.crop && items.find(entry => entry.id === 'format-vector')?.fillGradient?.stops[0]?.color?.startsWith('#00aa66');
    }, 'formatted project to be persisted');
    const persisted = await readDraft(win), savedItems = persisted.slides[0].items;
    check('Saved draft contains shape paint, vector gradient, picture effects, and crop', savedItems.find(entry => entry.id === 'format-rect').fill === '#1268cc' && savedItems.find(entry => entry.id === 'format-rect').fillOpacity === .55 && savedItems.find(entry => entry.id === 'format-picture').shadow.color === '#0066aa' && savedItems.find(entry => entry.id === 'format-picture').opacity === .8);
    frame = await loadEditor(1400); win = frame.contentWindow; doc = frame.contentDocument;
    await openFormat('format-picture'); tab('effects');
    check('Reload restores real formatted vectors and editable picture effects/crop', Boolean(item('format-rect').querySelector('rect[fill="#1268cc"][fill-opacity="0.55"]')) && Boolean(item('format-vector').querySelector('stop[stop-color^="#00aa66"]')) && Boolean(item('format-picture').querySelector('svg[overflow="hidden"]')) && find('[data-shadow-property="color"]').value === '#0066aa' && get('shadow-enabled').checked);
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    window.__formattingChecks = checks;
    document.querySelector('#summary').textContent = `${checks.filter(entry => entry.pass).length}/${checks.length} passed`;
    run.disabled = false;
  }
};
