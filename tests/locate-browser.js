const checks = [];
const results = document.querySelector('#results');
const runButton = document.querySelector('#run');

function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const item = document.createElement('li');
  item.dataset.pass = String(!!pass);
  item.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(item);
}

async function loadEditor() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under Locate integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?locate-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(iframe);
  await loaded;
  // iframe.onload can precede app.js's top-level await loadDraft(). Wait for
  // that same module to settle before replacing the test-origin project.
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow;
    const script = iframe.contentDocument.createElement('script');
    script.type = 'module';
    const appURL = iframe.contentDocument.querySelector('script[type="module"][src]').src;
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('locate-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('locate-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => {
      clearTimeout(timeout);
      win.removeEventListener('locate-editor-ready', ready);
      win.removeEventListener('locate-editor-failed', failed);
      script.remove();
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('locate-editor-ready', ready, { once: true });
    win.addEventListener('locate-editor-failed', failed, { once: true });
    iframe.contentDocument.body.append(script);
  });
  return iframe;
}

async function makePNG(color = '#9d347d', width = 4, height = 3) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not generate PNG fixture.')), 'image/png'));
}

runButton.onclick = async () => {
  results.replaceChildren();
  checks.length = 0;
  runButton.disabled = true;
  document.title = 'RUNNING — Figure Editor Locate checks';
  window.locateChecks = { finished: false, checks };
  let restore = () => {};
  try {
    if (!['18766','18768','18770'].includes(location.port) || !['127.0.0.1', 'localhost'].includes(location.hostname)) {
      throw new Error('Use a separate localhost server on port 18766, 18768, or 18770 to protect the normal editor draft.');
    }
    const iframe = await loadEditor();
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    const get = id => doc.getElementById(id);
    const cards = () => [...doc.querySelectorAll('.asset-card')];
    const locateButtons = () => [...doc.querySelectorAll('[data-action="locate"]')];
    const selection = () => JSON.stringify([...doc.querySelectorAll('#stage [data-item].selected')].map(node => node.dataset.item));
    const oldFetch = win.fetch;
    const oldConfirm = win.confirm;
    const oldSavePicker = win.showSaveFilePicker;
    const oldCreateURL = win.URL.createObjectURL;
    const oldClick = win.HTMLAnchorElement.prototype.click;
    const createdURLs = new Map();
    const downloads = [];
    const calls = [];
    const capability = { app: 'figure-editor-local', version: 1, token: 'browser-test-token', locate: true };
    const json = (value, status = 200) => new win.Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    let reply = async () => json({ status: 'revealed' });
    win.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/local') return json(capability);
      if (url === '/api/locate') return reply();
      throw new Error(`Unexpected fetch during Locate checks: ${url}`);
    };
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
      win.fetch = oldFetch;
      win.confirm = oldConfirm;
      win.showSaveFilePicker = oldSavePicker;
      win.URL.createObjectURL = oldCreateURL;
      win.HTMLAnchorElement.prototype.click = oldClick;
      for (const url of createdURLs.keys()) win.URL.revokeObjectURL(url);
    };
    const save = async () => {
      const count = downloads.length;
      await get('save-project').onclick();
      if (!downloads[count]) throw new Error('Could not capture the project snapshot.');
      return downloads[count].text();
    };
    await get('new-project').onclick();
    const png = await makePNG();
    const transfer = new win.DataTransfer();
    for (const name of ['selected.png', 'unselected.png']) {
      const file = new win.File([png], name, { type: 'image/png', lastModified: 123 });
      Object.defineProperty(file, 'webkitRelativePath', { value: `Locate fixture/${name}` });
      transfer.items.add(file);
    }
    const input = get('folder-input');
    input.files = transfer.files;
    await input.onchange({ target: input });
    await cards()[0].onclick({ target: cards()[0].querySelector('[data-action="place"]') });
    const snapshot = await save();
    const selected = selection();
    check('Every asset offers a short Locate button with a Finder description', locateButtons().length === 2 && locateButtons().every(button => button.textContent === 'Locate' && button.title.includes('Finder')));
    const targetCard = cards()[1];
    const targetButton = targetCard.querySelector('[data-action="locate"]');
    if (!targetButton) throw new Error('Locate button is missing.');
    const clickLocate = () => targetCard.onclick({ target: targetButton });
    check('Fixture has one selected canvas object and a separate unselected source', doc.querySelectorAll('#stage [data-item]').length === 1 && !targetCard.classList.contains('selected') && selected !== '[]');

    let finishRequest;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    reply = () => { markStarted(); return new Promise(resolve => { finishRequest = resolve; }); };
    const pending = clickLocate();
    await started;
    check('Pending Locate disables every Locate button and reports progress', locateButtons().every(button => button.disabled) && get('status').textContent.startsWith('Locating '));
    targetButton.click();
    await clickLocate();
    check('Repeated clicks cannot start a second Finder request while pending', calls.filter(call => call.url === '/api/locate').length === 1);
    finishRequest(json({ status: 'revealed' }));
    await pending;
    check('Successful Locate restores buttons and reports the Finder request', locateButtons().every(button => !button.disabled) && get('status').textContent.includes('Asked Finder to show unselected.png') && !get('status').classList.contains('error'));
    check('Locate leaves the selected object, canvas items, and all source material unchanged', selection() === selected && await save() === snapshot && !targetCard.classList.contains('selected'));
    const sent = JSON.parse(calls.find(call => call.url === '/api/locate').options.body);
    check('Finder requests contain source metadata without image contents', sent.asset.name === 'unselected.png' && sent.asset.relativePath === 'Locate fixture/unselected.png' && !('dataUrl' in sent.asset) && Object.keys(sent.asset).every(key => ['id', 'name', 'relativePath', 'fingerprint', 'linkToken'].includes(key)));

    reply = async () => json({ status: 'cancelled' });
    await clickLocate();
    check('Cancelling restores Locate and shows a non-error cancellation notice', !targetButton.disabled && get('status').textContent === 'Locate cancelled.' && !get('status').classList.contains('error'));
    reply = async () => json({ error: 'The selected source does not match.' }, 400);
    await clickLocate();
    check('Source mismatch restores Locate and displays the backend error', !targetButton.disabled && get('status').textContent.includes('selected source does not match') && get('status').classList.contains('error'));
    reply = async () => { throw new TypeError('Local launcher unavailable'); };
    await clickLocate();
    check('A failed local connection restores Locate and explains the failure', !targetButton.disabled && get('status').textContent.includes('Could not reach Finder') && get('status').classList.contains('error'));
    check('Cancellation and failures preserve selection, objects, and embedded image bytes', selection() === selected && await save() === snapshot);

    reply = async () => json({ status: 'revealed' });
    const library = doc.querySelector('.library-panel');
    const drop = dataTransfer => library.ondrop({ dataTransfer, preventDefault() {}, stopPropagation() {} });
    const cardNamed = name => cards().find(card => card.querySelector('.asset-name')?.textContent === name);
    const clickAction = async (name, action) => {
      const card = cardNamed(name);
      const button = card?.querySelector(`[data-action="${action}"]`);
      if (!button) throw new Error(`${name} has no ${action} action.`);
      await card.onclick({ target: button });
    };

    const looseName = 'dropped-original.png';
    const plainDrop = new win.DataTransfer();
    plainDrop.items.add(new win.File([png], looseName, { type: 'image/png', lastModified: 456 }));
    // Supply a genuine FileList without handle/entry APIs to exercise that fallback.
    const looseStart = calls.length;
    await drop({ files: plainDrop.files });
    const looseBefore = await save();
    const looseAsset = JSON.parse(looseBefore).assets.find(asset => asset.name === looseName);
    check('A plain single-file drop keeps file provenance without inventing a source path',
      looseAsset?.sourceOrigin === 'file' && looseAsset.sourceKind === 'copy' && !looseAsset.relativePath);
    await clickAction(looseName, 'locate');
    const looseCalls = calls.slice(looseStart);
    check('Locate on a plain drop requests its original directly and never saves a clipboard copy',
      JSON.stringify(looseCalls.map(call => call.url)) === JSON.stringify(['/api/local', '/api/locate'])
      && JSON.parse(looseCalls[1].options.body).asset.id === looseAsset.id
      && !looseCalls.some(call => call.url === '/api/clipboard-image')
      && !get('status').classList.contains('error'));
    check('Locating a plain drop preserves its embedded image and existing layout', await save() === looseBefore);

    const sessionName = 'session-original.png';
    let currentFile = new win.File([png], sessionName, { type: 'image/png', lastModified: 789 });
    let entryReads = 0;
    const entry = { name: sessionName, isFile: true, isDirectory: false,
      file(resolve) { entryReads++; resolve(currentFile); } };
    await drop({ files: [currentFile], items: [{ kind: 'file', getAsFile: () => currentFile, webkitGetAsEntry: () => entry }] });
    const sessionCard = cardNamed(sessionName);
    check('A legacy file-entry drop exposes a session link and Refresh action',
      sessionCard?.querySelector('.asset-meta')?.textContent.includes('Session link + copy')
      && !!sessionCard?.querySelector('[data-action="refresh"]'));
    await clickAction(sessionName, 'place');
    const sessionBefore = JSON.parse(await save());
    const sourceBefore = sessionBefore.assets.find(asset => asset.name === sessionName);
    const layoutBefore = JSON.stringify(sessionBefore.slides);
    check('The session-linked source is saved with its token and a placed canvas object',
      sourceBefore?.sourceKind === 'linked' && sourceBefore.linkPersistence === 'session'
      && typeof sourceBefore.linkToken === 'string' && !!sourceBefore.linkToken
      && sessionBefore.slides.some(slide => slide.items.some(item => item.assetId === sourceBefore.id)));

    const updatedPNG = await makePNG('#168f7b', 8, 5);
    currentFile = new win.File([updatedPNG], sessionName, { type: 'image/png', lastModified: 790 });
    await clickAction(sessionName, 'refresh');
    const sessionAfter = JSON.parse(await save());
    const sourceAfter = sessionAfter.assets.find(asset => asset.id === sourceBefore.id);
    check('Refresh re-reads the retained entry and updates saved image bytes and dimensions',
      entryReads === 2 && sourceAfter.dataUrl !== sourceBefore.dataUrl
      && sourceAfter.fingerprint !== sourceBefore.fingerprint && sourceAfter.width === 8 && sourceAfter.height === 5
      && cardNamed(sessionName).querySelector('.asset-thumb').getAttribute('src') === sourceAfter.dataUrl
      && !get('status').classList.contains('error'));
    check('Refresh preserves the session link token and all placed object geometry',
      sourceAfter.linkToken === sourceBefore.linkToken && sourceAfter.linkPersistence === 'session'
      && JSON.stringify(sessionAfter.slides) === layoutBefore);

    const sessionStart = calls.length;
    await clickAction(sessionName, 'locate');
    const sessionCalls = calls.slice(sessionStart);
    const sessionLocate = sessionCalls.find(call => call.url === '/api/locate');
    const sessionSent = sessionLocate && JSON.parse(sessionLocate.options.body).asset;
    check('Locate after Refresh sends the same source token with the updated fingerprint',
      sessionSent?.linkToken === sourceBefore.linkToken && sessionSent?.fingerprint === sourceAfter.fingerprint
      && JSON.stringify(sessionCalls.map(call => call.url)) === JSON.stringify(['/api/local', '/api/locate']));
    const originalProject = JSON.parse(snapshot);
    check('Drop and Refresh regressions leave the original fixture assets and objects unchanged',
      originalProject.assets.every(asset => JSON.stringify(sessionAfter.assets.find(current => current.id === asset.id)) === JSON.stringify(asset))
      && originalProject.slides.every(slide => slide.items.every(item =>
        JSON.stringify(sessionAfter.slides.find(current => current.id === slide.id)?.items.find(current => current.id === item.id)) === JSON.stringify(item))));
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    restore();
    runButton.disabled = false;
    const passed = checks.length > 0 && checks.every(result => result.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor Locate checks`;
    window.locateChecks = { finished: true, passed, checks: [...checks] };
  }
};
