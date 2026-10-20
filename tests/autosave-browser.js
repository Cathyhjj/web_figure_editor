import { createDeck, serializeDeck } from '../deck.js';

const checks = [], results = document.querySelector('#results'), run = document.querySelector('#run');
const preferenceKey = 'figure-editor-autosave';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass); row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`; results.append(row);
  document.querySelector('#summary').textContent = `${checks.filter(item => item.pass).length}/${checks.length} passed`;
}
async function until(predicate, label) {
  const deadline = performance.now() + 12000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await pause(25);
  }
}
async function draftDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('figure-editor-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function clearDraft() {
  const db = await draftDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').clear();
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function readDraft() {
  const db = await draftDB();
  try {
    const store = db.transaction('drafts').objectStore('drafts');
    const read = key => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return await Promise.all([read('current'), read('current-file')]);
  } finally { db.close(); }
}
async function loadEditor() {
  const iframe = document.createElement('iframe'); iframe.title = 'Editor under autosave integration test';
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor load timed out.')), 15000);
    iframe.onload = () => { clearTimeout(timer); resolve(); };
    iframe.onerror = () => { clearTimeout(timer); reject(new Error('Editor failed to load.')); };
  });
  iframe.src = `../index.html?autosave-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) return reject(new Error('Editor app module was not found.'));
    const script = doc.createElement('script'); script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(() => window.dispatchEvent(new Event('autosave-editor-ready')), error => window.dispatchEvent(new CustomEvent('autosave-editor-failed', {detail:error.message})));`;
    const cleanup = () => { clearTimeout(timer); win.removeEventListener('autosave-editor-ready', ready); win.removeEventListener('autosave-editor-failed', failed); script.remove(); };
    const ready = () => { cleanup(); resolve(); }, failed = event => { cleanup(); reject(new Error(event.detail)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Draft restoration timed out.')); }, 15000);
    win.addEventListener('autosave-editor-ready', ready, { once: true }); win.addEventListener('autosave-editor-failed', failed, { once: true }); doc.body.append(script);
  });
  return iframe;
}
function fixture(name) { const deck = createDeck(); deck.name = name; return deck; }

run.onclick = async () => {
  checks.length = 0; results.replaceChildren(); run.disabled = true;
  window.autosaveChecks = { finished: false, checks }; document.title = 'RUNNING — Figure Editor autosave checks';
  let iframe, win, doc, restore = () => {}, releaseWrite, privateRoot, privateFileName, originalPreference, mayCleanUp = false;
  const get = id => doc.getElementById(id);
  const pickerCalls = [], downloads = [], openQueue = [], saveQueue = [];
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use isolated localhost port 18766 to protect the normal editor draft.');
    originalPreference = localStorage.getItem(preferenceKey); mayCleanUp = true;
    localStorage.removeItem(preferenceKey); await clearDraft();
    async function reload() {
      restore(); iframe = await loadEditor(); win = iframe.contentWindow; doc = iframe.contentDocument;
      const realm = win;
      const old = { open: win.showOpenFilePicker, save: win.showSaveFilePicker, confirm: win.confirm, click: win.HTMLAnchorElement.prototype.click };
      const dequeue = queue => { const result = queue.shift(); if (!result) throw new Error('Unexpected picker call.'); return result; };
      win.confirm = () => true;
      win.showOpenFilePicker = async () => { pickerCalls.push('open'); return [dequeue(openQueue)]; };
      win.showSaveFilePicker = async () => { pickerCalls.push('save'); return dequeue(saveQueue); };
      win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else old.click.call(this); };
      restore = () => {
        realm.showOpenFilePicker = old.open; realm.showSaveFilePicker = old.save; realm.confirm = old.confirm;
        realm.HTMLAnchorElement.prototype.click = old.click;
      };
    }
    await reload();
    function destination(name, permission = 'granted') {
      const state = { name, project: fixture(name), permission, grant: 'granted', queries: 0, requests: 0, started: 0, closed: 0, aborted: 0, failWrite: false, closeGate: null };
      state.handle = {
        kind: 'file', name,
        async getFile() { return new Blob([serializeDeck(state.project)], { type: 'application/json' }); },
        async queryPermission(options) { if (options.mode !== 'readwrite') throw new Error('Expected readwrite permission query.'); state.queries++; return state.permission; },
        async requestPermission(options) { if (options.mode !== 'readwrite') throw new Error('Expected readwrite permission request.'); state.requests++; state.permission = state.grant; return state.permission; },
        async createWritable() {
          state.started++; let payload;
          return {
            async write(blob) { if (state.failWrite) throw new Error('Synthetic autosave write failure'); payload = JSON.parse(await blob.text()); },
            async close() { if (state.closeGate) await state.closeGate; state.project = payload; state.closed++; },
            async abort() { state.aborted++; },
          };
        },
      };
      return state;
    }
    const edit = name => { get('project-name').value = name; get('project-name').dispatchEvent(new win.Event('input', { bubbles: true })); };
    const dirty = () => { const event = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
    const state = () => get('autosave-status').dataset.state;
    const idle = () => !get('save-project').disabled;
    const save = () => get('save-project').onclick();
    const open = async target => { openQueue.push(target.handle); await get('open-project').onclick(); };
    const saved = (target, name) => until(() => target.project.name === name && !dirty() && idle(), `autosave of ${name}`);
    const drafted = name => until(async () => (await readDraft())[0]?.name === name, `local draft of ${name}`);
    const setEnabled = enabled => { if (get('autosave-toggle').checked !== enabled) get('autosave-toggle').click(); };

    check('Autosave starts enabled and exposes a persistent status', get('autosave-toggle').checked && !!get('autosave-status').textContent.trim());
    edit('Local draft without a file');
    await drafted('Local draft without a file'); await pause(1800);
    check('A new project saves a recoverable local draft without a picker or download', state() === 'local' && dirty() && pickerCalls.length === 0 && downloads.length === 0);
    await reload();
    check('Reload restores an unbound local draft and its unsaved-file warning', get('project-name').value === 'Local draft without a file' && dirty() && get('autosave-toggle').checked);

    const first = destination('automatic.figure.json'); await open(first);
    edit('Rapid edit one'); await pause(100); edit('Rapid edit two'); await pause(100); edit('Rapid edit final');
    await pause(500);
    check('Rapid edits wait for the autosave debounce', first.started === 0 && dirty() && state() === 'pending');
    await saved(first, 'Rapid edit final');
    check('Debounced autosave writes the latest complete project once without requesting permission', first.closed === 1 && first.requests === 0 && first.queries > 0 && state() === 'saved');
    const idleWrites = first.started; await pause(1800);
    check('An unchanged project does not repeatedly rewrite its file', first.started === idleWrites);
    edit('Same text edit after autosave'); await saved(first, 'Same text edit after autosave');
    get('project-name').dispatchEvent(new win.FocusEvent('blur'));
    get('undo').click(); await saved(first, 'automatic.figure.json');
    check('Autosave preserves a single undo step for one ongoing text edit', get('project-name').value === 'automatic.figure.json');
    get('redo').click(); await saved(first, 'Same text edit after autosave');
    check('Redo is also automatically saved', first.project.name === 'Same text edit after autosave');

    get('new-slide').click(); get('add-text').click();
    get('text-content').value = 'Automatically saved scientific caption';
    get('text-content').dispatchEvent(new win.Event('input', { bubbles: true }));
    get('slide-name').value = 'Automatic second slide';
    get('slide-name').dispatchEvent(new win.Event('input', { bubbles: true }));
    await saved(first, 'Same text edit after autosave');
    const secondSlide = first.project.slides[1], textItem = secondSlide.items[0];
    check('Autosave includes new slides, slide names, and editable text objects', first.project.slides.length === 2 && secondSlide.name === 'Automatic second slide' && textItem?.text === 'Automatically saved scientific caption' && first.project.activeSlideId === secondSlide.id);

    // Synthetic pointer events cannot acquire native pointer capture. All
    // movement and revision handling still run through the actual editor.
    const stage = get('stage'), capture = stage.setPointerCapture, release = stage.releasePointerCapture, hasCapture = stage.hasPointerCapture;
    stage.setPointerCapture = () => {}; stage.releasePointerCapture = () => {}; stage.hasPointerCapture = () => false;
    try {
      const screen = (x, y) => { const point = stage.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(stage.getScreenCTM()); };
      const pointer = (target, type, point) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 97, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: point.x, clientY: point.y }));
      const beforeDragWrites = first.started, start = screen(textItem.x + 5, textItem.y + 5), end = screen(textItem.x + 45, textItem.y + 30);
      edit('Save after the complete drag');
      pointer(doc.querySelector(`#stage [data-item="${textItem.id}"]`), 'pointerdown', start);
      pointer(stage, 'pointermove', end); await pause(1800);
      check('A pending autosave waits while a pointer drag is unfinished', first.started === beforeDragWrites && dirty() && state() === 'pending');
      pointer(stage, 'pointerup', end); await saved(first, 'Save after the complete drag');
      const moved = first.project.slides[1].items.find(item => item.id === textItem.id);
      check('Autosave after pointer release includes the final object position', Math.abs(moved.x - textItem.x - 40) < 0.001 && Math.abs(moved.y - textItem.y - 25) < 0.001);
    } finally {
      stage.setPointerCapture = capture; stage.releasePointerCapture = release; stage.hasPointerCapture = hasCapture;
    }

    const dragSnapshot = first.project.slides[1].items[0], oldDragX = dragSnapshot.x, oldDragY = dragSnapshot.y;
    const writesBeforeLateDrag = first.started, closesBeforeLateDrag = first.closed;
    first.closeGate = new Promise(resolve => { releaseWrite = resolve; });
    edit('Drag begun during an older write');
    get('project-name').dispatchEvent(new win.FocusEvent('blur'));
    await until(() => first.started > writesBeforeLateDrag, 'autosave before late drag');
    stage.setPointerCapture = () => {}; stage.releasePointerCapture = () => {}; stage.hasPointerCapture = () => false;
    try {
      const screen = (x, y) => { const point = stage.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(stage.getScreenCTM()); };
      const pointer = (target, type, point) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 98, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: point.x, clientY: point.y }));
      const start = screen(oldDragX + 5, oldDragY + 5), end = screen(oldDragX + 35, oldDragY + 25);
      pointer(doc.querySelector(`#stage [data-item="${dragSnapshot.id}"]`), 'pointerdown', start);
      pointer(stage, 'pointermove', end);
      releaseWrite(); releaseWrite = null; first.closeGate = null;
      await until(() => first.closed === closesBeforeLateDrag + 1 && idle(), 'older write completion during drag');
      const [, dragFile] = await readDraft();
      check('An older write completing during a new drag keeps both the editor and draft marked unsaved', dirty() && dragFile?.dirty === true && first.project.slides[1].items[0].x === oldDragX && state() === 'pending');
      pointer(stage, 'pointerup', end); await saved(first, 'Drag begun during an older write');
      const moved = first.project.slides[1].items.find(item => item.id === dragSnapshot.id);
      check('Finishing that drag automatically commits its geometry after the older write', Math.abs(moved.x - oldDragX - 30) < 0.001 && Math.abs(moved.y - oldDragY - 20) < 0.001 && first.closed === closesBeforeLateDrag + 2);
    } finally {
      stage.setPointerCapture = capture; stage.releasePointerCapture = release; stage.hasPointerCapture = hasCapture;
    }

    const permission = destination('needs-permission.figure.json', 'prompt'); await open(permission);
    const permissionsPickerCount = pickerCalls.length; edit('Waiting for write permission');
    await until(() => state() === 'permission', 'permission status'); await drafted('Waiting for write permission');
    check('Autosave with prompt permission keeps a local draft without opening a dialog', permission.queries > 0 && permission.requests === 0 && permission.started === 0 && dirty() && pickerCalls.length === permissionsPickerCount && downloads.length === 0);
    setEnabled(false); permission.permission = 'denied'; const deniedQueries = permission.queries; setEnabled(true);
    edit('Denied file remains local'); await drafted('Denied file remains local');
    await until(() => permission.queries > deniedQueries && state() === 'permission', 'denied permission');
    check('Denied permission never causes a request or file write', permission.requests === 0 && permission.started === 0 && dirty() && state() === 'permission');
    await save();
    check('Manual Save can request permission and commit the current changes', permission.requests === 1 && permission.project.name === 'Denied file remains local' && !dirty());
    edit('Autosave after manual grant'); await saved(permission, 'Autosave after manual grant');
    check('Automatic saving resumes after a successful manual permission grant', permission.requests === 1 && state() === 'saved');

    permission.failWrite = true; edit('Keep this edit after failure');
    await until(() => state() === 'error' && idle(), 'autosave error'); await drafted('Keep this edit after failure');
    check('An autosave write failure retains the last committed file and recoverable dirty draft', permission.project.name === 'Autosave after manual grant' && permission.aborted > 0 && dirty());
    permission.failWrite = false; await save();
    check('Manual Save recovers from an autosave write failure', permission.project.name === 'Keep this edit after failure' && !dirty());

    const concurrent = destination('concurrent.figure.json'); await open(concurrent);
    concurrent.closeGate = new Promise(resolve => { releaseWrite = resolve; });
    edit('First slow save snapshot'); await until(() => concurrent.started === 1, 'slow autosave start');
    check('A pending automatic write reports saving and disables conflicting file actions', state() === 'saving' && ['save-project', 'save-project-as', 'open-project', 'new-project'].every(id => get(id).disabled));
    edit('New edit during slow save'); await pause(1800);
    check('Edits during an in-flight autosave do not start a concurrent writer', concurrent.started === 1 && dirty());
    releaseWrite(); releaseWrite = null; concurrent.closeGate = null;
    await saved(concurrent, 'New edit during slow save');
    check('The latest edit is automatically written after the older save completes', concurrent.closed === 2 && state() === 'saved');

    setEnabled(false); const pausedWrites = concurrent.started; edit('Local recovery while autosave is off');
    await drafted('Local recovery while autosave is off'); await pause(1800);
    check('Turning autosave off stops file writes while retaining local recovery', concurrent.started === pausedWrites && dirty() && state() === 'off');
    setEnabled(true); await saved(concurrent, 'Local recovery while autosave is off');
    check('Turning autosave on saves pending changes to the existing destination', concurrent.started === pausedWrites + 1);
    setEnabled(false); await reload();
    check('Autosave off persists after reload', !get('autosave-toggle').checked && state() === 'off');
    setEnabled(true); await reload();
    check('Autosave on also persists after reload', get('autosave-toggle').checked);

    const previous = destination('previous-project.figure.json'); await open(previous);
    edit('Must not reach the previous file'); get('new-project').click(); await pause(1800);
    check('New project cancels the old pending file autosave and clears its destination', previous.started === 0 && !get('save-project').title.includes(previous.name) && !dirty());

    const source = destination('source.figure.json'), copy = destination('copy.figure.json'); await open(source);
    edit('Save As copy snapshot'); saveQueue.push(copy.handle); await get('save-project-as').onclick();
    edit('Automatic change in the copy'); await saved(copy, 'Automatic change in the copy');
    check('Save As moves automatic writes to the new destination without changing the original', source.started === 0 && source.project.name === source.name && copy.closed === 2 && get('save-project').title.includes(copy.name));

    // A genuine handle exercises IndexedDB structured cloning and file persistence.
    // It belongs to the harness realm and only accesses this isolated origin's OPFS.
    privateRoot = await navigator.storage.getDirectory(); privateFileName = `autosave-check-${Date.now()}.figure.json`;
    const privateHandle = await privateRoot.getFileHandle(privateFileName, { create: true });
    const writer = await privateHandle.createWritable(); await writer.write(serializeDeck(fixture('Private handle fixture'))); await writer.close();
    await open({ handle: privateHandle }); edit('Real handle automatically saved');
    const privateName = async () => JSON.parse(await (await privateHandle.getFile()).text()).name;
    await until(async () => await privateName() === 'Real handle automatically saved' && !dirty() && idle(), 'real private file autosave');
    await until(async () => { const [, file] = await readDraft(); return file?.handle && file.name === privateFileName && file.dirty === false; }, 'persistent handle draft');
    check('Automatic saving commits an actual browser file and persists its handle', await privateName() === 'Real handle automatically saved');
    await reload();
    check('Reload restores the real file destination and clean saved state', get('project-name').value === 'Real handle automatically saved' && get('save-project').title.includes(privateFileName) && !dirty());
    const reloadPickerCount = pickerCalls.length; edit('Real handle auto after reload');
    await until(async () => await privateName() === 'Real handle auto after reload' && !dirty() && idle(), 'real private autosave after reload');
    check('Editing after reload automatically updates the restored file without a picker', pickerCalls.length === reloadPickerCount && state() === 'saved');
    check('The complete autosave workflow never starts a download', downloads.length === 0);
    get('new-project').click();
    await until(async () => !(await readDraft())[1]?.handle, 'cleared test file binding');
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    releaseWrite?.();
    // Removing the iframe stops any pending timers before deleting test storage.
    iframe?.remove(); restore();
    if (privateRoot && privateFileName) await privateRoot.removeEntry(privateFileName).catch(() => {});
    if (mayCleanUp) {
      await clearDraft().catch(() => {});
      if (originalPreference === null) localStorage.removeItem(preferenceKey);
      else localStorage.setItem(preferenceKey, originalPreference);
    }
    run.disabled = false; const passed = checks.length > 0 && checks.every(item => item.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor autosave checks`;
    window.autosaveChecks = { finished: true, passed, checks: [...checks] };
  }
};
