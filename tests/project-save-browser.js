import { createDeck, serializeDeck } from '../deck.js';

const checks = [], results = document.querySelector('#results'), run = document.querySelector('#run');
function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const item = document.createElement('li');
  item.dataset.pass = String(!!pass); item.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`; results.append(item);
}
async function until(predicate, label) {
  const deadline = performance.now() + 10000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function loadEditor() {
  const iframe = document.createElement('iframe'); iframe.title = 'Editor under Save integration test';
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor load timed out.')), 15000);
    iframe.onload = () => { clearTimeout(timer); resolve(); };
    iframe.onerror = () => { clearTimeout(timer); reject(new Error('Editor failed to load.')); };
  });
  iframe.src = `../index.html?save-checks=${Date.now()}`; document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) return reject(new Error('Editor app module was not found.'));
    const script = doc.createElement('script'); script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(() => window.dispatchEvent(new Event('save-editor-ready')), error => window.dispatchEvent(new CustomEvent('save-editor-failed', {detail:error.message})));`;
    const cleanup = () => { clearTimeout(timer); win.removeEventListener('save-editor-ready', ready); win.removeEventListener('save-editor-failed', failed); script.remove(); };
    const ready = () => { cleanup(); resolve(); }, failed = event => { cleanup(); reject(new Error(event.detail)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Draft restoration timed out.')); }, 15000);
    win.addEventListener('save-editor-ready', ready, { once: true }); win.addEventListener('save-editor-failed', failed, { once: true }); doc.body.append(script);
  });
  return iframe;
}
function fixture(name) { const deck = createDeck(); deck.name = name; return deck; }
async function readDraft() {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('figure-editor-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    const tx = db.transaction('drafts'), store = tx.objectStore('drafts');
    const read = key => new Promise((resolve, reject) => { const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return await Promise.all([read('current'), read('current-file')]);
  } finally { db.close(); }
}

run.onclick = async () => {
  checks.length = 0; results.replaceChildren(); run.disabled = true;
  window.projectSaveChecks = { finished: false, checks }; document.title = 'RUNNING — Figure Editor Save checks';
  let restore = () => {}, privateRoot, privateFileName;
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use a separate localhost server on port 18766 to protect the normal editor draft.');
    let iframe = await loadEditor(), win = iframe.contentWindow, doc = iframe.contentDocument;
    const get = id => doc.getElementById(id);
    const oldOpen = win.showOpenFilePicker, oldSave = win.showSaveFilePicker, oldConfirm = win.confirm;
    const openQueue = [], saveQueue = [], pickerCalls = [], writes = [];
    const dequeue = queue => { const value = queue.shift(); if (value instanceof Error || value instanceof win.Error || value instanceof win.DOMException) throw value; if (!value) throw new Error('Unexpected file picker call.'); return value; };
    win.confirm = () => true;
    win.showOpenFilePicker = async options => { pickerCalls.push({ type: 'open', options }); return [dequeue(openQueue)]; };
    win.showSaveFilePicker = async options => { pickerCalls.push({ type: 'save', options }); return dequeue(saveQueue); };
    const mockWin = win;
    restore = () => { mockWin.showOpenFilePicker = oldOpen; mockWin.showSaveFilePicker = oldSave; mockWin.confirm = oldConfirm; };
    function handle(name, project = fixture(name)) {
      const state = { name, project, failWrite: false, failClose: false, closeGate: null, started: 0, closed: 0, aborted: 0 };
      state.handle = {
        kind: 'file', name,
        async getFile() { return new win.File([serializeDeck(state.project)], name, { type: 'application/json' }); },
        async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
        async createWritable() {
          state.started++;
          let payload;
          return {
            async write(blob) { if (state.failWrite) throw new Error('Synthetic write failure'); payload = JSON.parse(await blob.text()); },
            async close() { if (state.closeGate) await state.closeGate; if (state.failClose) throw new Error('Synthetic close failure'); state.project = payload; state.closed++; writes.push({ name, project: payload }); },
            async abort() { state.aborted++; },
          };
        },
      };
      return state;
    }
    const edit = name => { get('project-name').value = name; get('project-name').oninput({ target: get('project-name') }); };
    const dirty = () => { const event = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
    const key = (key, options = {}) => { const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, metaKey: true, ...options }); get('project-name').dispatchEvent(event); return event; };
    const save = () => get('save-project').onclick();
    const saveAs = () => get('save-project-as').onclick();
    const open = async state => { openQueue.push(state.handle); await get('open-project').onclick(); };

    check('Separate Save and Save As controls are available', get('save-project').textContent.trim() === 'Save' && !!get('save-project-as'));
    get('new-project').click(); edit('New project first save');
    const first = handle('first.figure.json'); saveQueue.push(first.handle); await save();
    check('A new project chooses its location on the first Save', pickerCalls.filter(call => call.type === 'save').length === 1 && first.closed === 1 && first.project.name === 'New project first save');
    check('Successful Save identifies its file and clears the unload warning', get('save-project').title.includes(first.name) && !dirty());
    edit('Same file update'); await save();
    check('Later Save updates the chosen file without another picker', first.closed === 2 && first.project.name === 'Same file update' && pickerCalls.filter(call => call.type === 'save').length === 1);

    const original = handle('opened.figure.json', fixture('Opened project')); await open(original); edit('Opened project edited');
    const pickerCount = pickerCalls.length; await save();
    check('Open retains the original file as the Save destination', original.closed === 1 && original.project.name === 'Opened project edited' && pickerCalls.length === pickerCount);
    edit('Saved using Cmd S'); const shortcut = key('s'); await until(() => !get('save-project').disabled && original.closed === 2, 'Cmd+S');
    check('Cmd+S saves to the original file while editing a text field', shortcut.defaultPrevented && original.project.name === 'Saved using Cmd S' && pickerCalls.length === pickerCount && !dirty());
    edit('Saved using Ctrl S'); key('s', { metaKey: false, ctrlKey: true }); await until(() => !get('save-project').disabled && original.closed === 3, 'Ctrl+S');
    check('Ctrl+S uses the same Save logic', original.project.name === 'Saved using Ctrl S');

    edit('Canceled save as edit'); saveQueue.push(new win.DOMException('Canceled', 'AbortError')); await saveAs();
    check('Canceled Save As preserves dirty state and the original destination', dirty() && get('save-project').title.includes(original.name) && !get('status').classList.contains('error'));
    await save(); check('Save after canceled Save As still updates the original file', original.project.name === 'Canceled save as edit');
    const copy = handle('copy.figure.json'); saveQueue.push(copy.handle); await saveAs(); edit('Copy only'); await save();
    check('Successful Save As selects a new file for later Save', copy.closed === 2 && copy.project.name === 'Copy only' && original.project.name === 'Canceled save as edit' && get('save-project').title.includes(copy.name));

    edit('Write must fail'); copy.failWrite = true; await save();
    check('A write failure preserves dirty state, original bytes, and destination', dirty() && copy.project.name === 'Copy only' && copy.aborted === 1 && get('status').textContent.includes('Could not save project') && get('save-project').title.includes(copy.name));
    copy.failWrite = false; copy.failClose = true; await save();
    check('A close failure is not reported as a completed Save', dirty() && copy.project.name === 'Copy only' && copy.aborted === 2 && get('status').classList.contains('error'));
    copy.failClose = false; await save();
    check('Save succeeds after a write failure is corrected', copy.project.name === 'Write must fail' && !dirty());
    edit('Failed save as edit'); const failedCopy = handle('failed-copy.figure.json'); failedCopy.failClose = true; saveQueue.push(failedCopy.handle); await saveAs();
    check('Failed Save As keeps the previous destination and unsaved changes', dirty() && get('save-project').title.includes(copy.name) && failedCopy.closed === 0);
    await save(); check('Save after failed Save As still writes the previous destination', copy.project.name === 'Failed save as edit' && !dirty());

    edit('Captured save snapshot'); let release; copy.closeGate = new Promise(resolve => { release = resolve; });
    const started = copy.started, pending = save(); await until(() => copy.started > started, 'delayed write');
    check('A pending save disables conflicting file actions', ['save-project', 'save-project-as', 'open-project', 'new-project', 'demo-project'].every(id => get(id).disabled));
    edit('Edit while saving'); await save(); key('s');
    release(); await pending; copy.closeGate = null;
    check('Edits made while writing remain dirty after the older snapshot finishes', copy.project.name === 'Captured save snapshot' && dirty() && get('project-name').value === 'Edit while saving' && copy.started === started + 1);
    await save(); check('The following Save includes edits made during the prior write', copy.project.name === 'Edit while saving' && !dirty());
    const shortcutCopy = handle('shortcut-copy.figure.json'); saveQueue.push(shortcutCopy.handle); const asShortcut = key('s', { shiftKey: true });
    await until(() => !get('save-project').disabled && shortcutCopy.closed === 1, 'Cmd+Shift+S');
    check('Cmd+Shift+S uses Save As and selects its new file', asShortcut.defaultPrevented && get('save-project').title.includes(shortcutCopy.name));

    get('new-project').click(); edit('Another new project'); const newest = handle('newest.figure.json'); saveQueue.push(newest.handle); await save();
    check('New project resets the previous file destination', newest.project.name === 'Another new project' && copy.project.name === 'Edit while saving');

    get('new-project').click(); edit('Download fallback fixture');
    const originalURL = win.URL.createObjectURL, originalClick = win.HTMLAnchorElement.prototype.click, savePicker = win.showSaveFilePicker;
    const urls = new Map(), downloads = [];
    win.showSaveFilePicker = undefined;
    win.URL.createObjectURL = blob => { const url = originalURL.call(win.URL, blob); urls.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: urls.get(this.href) }); else originalClick.call(this); };
    try {
      await save();
      check('Browsers without native Save download a project copy with clear feedback', downloads.length === 1 && JSON.parse(await downloads[0].blob.text()).name === 'Download fallback fixture' && get('status').textContent.includes('cannot save back to the original file'));
      check('Starting a fallback download does not claim verified file persistence', dirty());
    } finally {
      win.URL.createObjectURL = originalURL; win.HTMLAnchorElement.prototype.click = originalClick; win.showSaveFilePicker = savePicker;
      for (const url of urls.keys()) win.URL.revokeObjectURL(url);
    }

    // A real browser handle exercises structured cloning and restoration. It
    // lives only in this isolated origin's private file system, not user files.
    // Acquire in the harness realm so these handles survive replacing the editor iframe.
    privateRoot = await navigator.storage.getDirectory(); privateFileName = `save-check-${Date.now()}.figure.json`;
    const privateHandle = await privateRoot.getFileHandle(privateFileName, { create: true });
    const writer = await privateHandle.createWritable(); await writer.write(serializeDeck(fixture('Persistent handle fixture'))); await writer.close();
    await open({ handle: privateHandle }); edit('Persistent handle saved'); await save();
    await until(async () => { const [draft, file] = await readDraft(); return draft?.name === 'Persistent handle saved' && file?.name === privateFileName && file?.dirty === false && file?.handle; }, 'persistent file draft');
    restore(); iframe = await loadEditor(); win = iframe.contentWindow; doc = iframe.contentDocument;
    let unexpectedPicker = 0; win.showSaveFilePicker = async () => { unexpectedPicker++; throw new Error('Restored Save should not show a picker.'); };
    check('Reload restores the saved file destination and clean state', get('project-name').value === 'Persistent handle saved' && get('save-project').title.includes(privateFileName) && !dirty());
    edit('Persistent handle after reload'); await save();
    check('Save after reload writes the restored file without choosing again', unexpectedPicker === 0 && JSON.parse(await (await privateHandle.getFile()).text()).name === 'Persistent handle after reload' && !dirty());
    get('new-project').click(); await until(async () => { const [, file] = await readDraft(); return !file?.handle; }, 'cleared file binding');
  } catch (error) { check(error.stack || error.message, false); }
  finally {
    restore();
    if (privateRoot && privateFileName) await privateRoot.removeEntry(privateFileName).catch(() => {});
    run.disabled = false; const passed = checks.length > 0 && checks.every(item => item.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor Save checks`; window.projectSaveChecks = { finished: true, passed, checks: [...checks] };
  }
};
