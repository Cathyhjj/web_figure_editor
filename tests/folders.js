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
  iframe.title = 'Editor under folder integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?folder-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(iframe);
  await loaded;
  return iframe;
}

async function makePNG() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 3;
  const context = canvas.getContext('2d');
  context.fillStyle = '#9d347d';
  context.fillRect(0, 0, 2, 3);
  context.fillStyle = '#327caa';
  context.fillRect(2, 0, 2, 3);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not generate PNG fixture.')), 'image/png'));
}

function directory(name, children) {
  return { kind: 'directory', name, async *values() { yield* children; } };
}

function fileHandle(file) {
  return { kind: 'file', name: file.name, async getFile() { return file; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } };
}

runButton.onclick = async () => {
  results.replaceChildren();
  checks.length = 0;
  runButton.disabled = true;
  document.title = 'RUNNING — Figure Editor folder checks';
  window.folderChecks = { finished: false, checks };
  let restore = () => {};
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) {
      throw new Error('Use a separate localhost server on port 18766 to protect the normal editor draft.');
    }
    const iframe = await loadEditor();
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    const get = id => doc.getElementById(id);
    const cards = () => [...doc.querySelectorAll('.asset-card')];
    const items = () => doc.querySelectorAll('#stage [data-item]').length;
    const folder = path => [...doc.querySelectorAll('.asset-folder[data-path]')].find(node => node.dataset.path === path);
    const oldConfirm = win.confirm;
    const oldPicker = win.showDirectoryPicker;
    const oldCreateURL = win.URL.createObjectURL;
    const oldClick = win.HTMLAnchorElement.prototype.click;
    const createdURLs = new Map();
    const downloads = [];
    win.confirm = () => true;
    win.URL.createObjectURL = blob => {
      const url = oldCreateURL.call(win.URL, blob);
      createdURLs.set(url, blob);
      return url;
    };
    win.HTMLAnchorElement.prototype.click = function () {
      if (this.download) downloads.push({ name: this.download, blob: createdURLs.get(this.href) });
      else oldClick.call(this);
    };
    restore = () => {
      win.confirm = oldConfirm;
      win.showDirectoryPicker = oldPicker;
      win.URL.createObjectURL = oldCreateURL;
      win.HTMLAnchorElement.prototype.click = oldClick;
      for (const url of createdURLs.keys()) win.URL.revokeObjectURL(url);
    };
    const capture = async id => {
      const start = downloads.length;
      await get(id).onclick();
      const output = downloads[start];
      if (!output?.blob) throw new Error(`${id} did not produce a captured download.`);
      return { ...output, value: JSON.parse(await output.blob.text()) };
    };
    const setFiles = (input, files) => {
      const transfer = new win.DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
    };
    const chooseFiles = async (id, files) => {
      const input = get(id);
      setFiles(input, files);
      await input.onchange({ target: input });
    };
    const png = await makePNG();
    const imageFile = (name, relativePath) => {
      const file = new win.File([png], name, { type: 'image/png', lastModified: 123 });
      if (relativePath) Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
      return file;
    };
    const textFile = path => {
      const file = new win.File(['Not an image.'], path.split('/').at(-1), { type: 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    };

    await get('new-project').onclick();
    check('Folder button and directory input are available', !!get('add-folders') && !!get('folder-input')?.hasAttribute('webkitdirectory'));
    const input = get('folder-input');
    if (!input || !get('add-folders')) throw new Error('Folder controls are missing.');

    let fallbackCalls = 0;
    const oldInputClick = input.click;
    input.click = () => { fallbackCalls++; };
    try {
      win.showDirectoryPicker = undefined;
      await get('add-folders').onclick();
      check('Unsupported native picker opens the directory input fallback', fallbackCalls === 1);
      await chooseFiles('folder-input', []);
      check('Empty directory-input selection leaves the editor unchanged', cards().length === 0 && items() === 0);
      win.showDirectoryPicker = async () => { throw new win.DOMException('Cancelled by test.', 'AbortError'); };
      await get('add-folders').onclick();
      check('Native picker cancellation adds nothing and does not open fallback', cards().length === 0 && fallbackCalls === 1);
    } finally { input.click = oldInputClick; }

    const root = 'Study & review';
    const expectedPaths = [`${root}/overview.png`, `${root}/A/shared.png`, `${root}/B/shared.png`, `${root}/B/deep/detail.png`];
    await chooseFiles('folder-input', [...expectedPaths.map(path => imageFile(path.split('/').at(-1), path)), textFile(`${root}/notes.txt`)]);
    check('Directory input imports all four nested images and skips a text file', cards().length === 4);
    check('Folder imports populate the library without placing images on the slide', items() === 0);
    check('Root, sibling folders, and deep subfolder retain directory hierarchy', !!folder(root) && folder(`${root}/A`)?.parentElement.closest('.asset-folder') === folder(root) && folder(`${root}/B`)?.parentElement.closest('.asset-folder') === folder(root) && folder(`${root}/B/deep`)?.parentElement.closest('.asset-folder') === folder(`${root}/B`));
    check('Duplicate image basenames stay in their respective sibling folders', [...folder(`${root}/A`).querySelectorAll('.asset-name')].some(node => node.textContent === 'shared.png') && [...folder(`${root}/B`).querySelectorAll('.asset-name')].some(node => node.textContent === 'shared.png'));
    const previews = [...doc.querySelectorAll('.asset-card img')];
    await Promise.all(previews.map(image => image.decode()));
    check('Every imported preview decodes as the original 4 × 3 PNG', previews.length === 4 && previews.every(image => image.naturalWidth === 4 && image.naturalHeight === 3));
    await get('undo').onclick();
    check('Undo removes the complete folder import in one step', cards().length === 0 && items() === 0 && !folder(root));
    await get('redo').onclick();
    check('Redo reconstructs folder previews and all nested directories', cards().length === 4 && items() === 0 && !!folder(`${root}/B/deep`));

    folder(`${root}/B`).open = false;
    folder(`${root}/B`).dispatchEvent(new win.Event('toggle'));
    await folder(`${root}/A`).querySelector('.asset-card').onclick({ target: folder(`${root}/A`).querySelector('[data-action="place"]') });
    check('Place adds one selected library asset to the canvas', items() === 1);
    check('Collapsed subfolders stay collapsed after the editor rerenders', folder(`${root}/B`).open === false);
    await get('undo').onclick();
    check('Undo removes placement while retaining folder library assets', items() === 0 && cards().length === 4);
    await get('redo').onclick();
    check('Redo restores placement and retains folder grouping', items() === 1 && cards().length === 4 && !!folder(`${root}/B/deep`));

    const nativeRoot = 'Native';
    win.showDirectoryPicker = async () => directory(nativeRoot, [
      fileHandle(imageFile('native.png')),
      directory('Sub', [fileHandle(imageFile('native.png')), fileHandle(textFile('notes.txt'))]),
    ]);
    await get('add-folders').onclick();
    expectedPaths.push(`${nativeRoot}/native.png`, `${nativeRoot}/Sub/native.png`);
    check('Native folder picker recursively adds a second root and its previews', cards().length === 6 && !!folder('Native') && !!folder('Native/Sub'));
    check('Native folder import preserves the existing canvas placement', items() === 1);
    const nativeCard = folder('Native/Sub').querySelector('.asset-card');
    const refresh = nativeCard.querySelector('[data-action="refresh"]');
    check('Native folder images retain a refreshable local source link', !!refresh);
    if (refresh) await nativeCard.onclick({ target: refresh });
    check('Refreshing a native folder image preserves its parent directory', folder('Native/Sub')?.querySelectorAll('.asset-card').length === 1);

    const dropped = directory('Dropped', [directory('Sub', [fileHandle(imageFile('dropped.png'))])]);
    let prevented = false;
    await doc.querySelector('.library-panel').ondrop({
      preventDefault() { prevented = true; }, stopPropagation() {},
      dataTransfer: { files: [], items: [{ kind: 'file', getAsFile() { return null; }, async getAsFileSystemHandle() { return dropped; } }] },
    });
    expectedPaths.push('Dropped/Sub/dropped.png');
    check('Dropping a folder in Assets recursively imports previews without changing the canvas', prevented && cards().length === 7 && items() === 1 && !!folder('Dropped/Sub'));

    const saved = await capture('save-project');
    const actualPaths = saved.value.assets.map(asset => asset.relativePath).sort();
    check('Save project preserves every root and nested asset path', JSON.stringify(actualPaths) === JSON.stringify([...expectedPaths].sort()));
    check('Portable project stores embedded copies without filesystem handles', saved.value.assets.every(asset => asset.dataUrl.startsWith('data:image/png;base64,') && !('fileHandle' in asset) && !('handle' in asset)));
    const manifest = (await capture('source-manifest')).value;
    check('Source list includes all directory paths and the placed image usage', JSON.stringify(manifest.sources.map(source => source.relativePath).sort()) === JSON.stringify([...expectedPaths].sort()) && manifest.sources.reduce((sum, source) => sum + source.usedBy.length, 0) === 1);
    await get('new-project').onclick();
    check('New project clears imported folders and canvas content', cards().length === 0 && items() === 0);
    await chooseFiles('project-input', [new win.File([saved.blob], 'folder-checks.figure.json', { type: 'application/json' })]);
    check('Open project reconstructs folder previews and prior placement', cards().length === 7 && items() === 1 && !!folder(`${root}/B/deep`) && !!folder('Native/Sub') && !!folder('Dropped/Sub'));
    const reopened = (await capture('save-project')).value;
    check('Save/Open roundtrip retains asset paths exactly', JSON.stringify(reopened.assets.map(asset => asset.relativePath).sort()) === JSON.stringify(actualPaths));

    const pendingPickers = [];
    win.showDirectoryPicker = () => new Promise((resolve, reject) => pendingPickers.push({ resolve, reject }));
    const firstImport = get('add-folders').onclick();
    const secondImport = get('add-folders').onclick();
    pendingPickers[0].resolve(directory('Empty', []));
    await firstImport;
    check('A pending overlapping folder import keeps the library busy after the first finishes', get('assets-panel').getAttribute('aria-busy') === 'true' && get('asset-import-status').textContent.startsWith('Reading'));
    pendingPickers[1].reject(new win.DOMException('Cancelled overlapping picker.', 'AbortError'));
    await secondImport;
    check('Cancelling the last pending import restores the completed notice and clears busy state', get('assets-panel').getAttribute('aria-busy') === 'false' && get('asset-import-status').textContent.startsWith('No supported images found.') && !get('asset-import-status').textContent.includes('Reading'));
    check('Empty and cancelled overlapping imports retain existing assets and canvas content', cards().length === 7 && items() === 1);

    let completeStalePicker;
    win.showDirectoryPicker = () => new Promise(resolve => { completeStalePicker = resolve; });
    const staleImport = get('add-folders').onclick();
    await get('new-project').onclick();
    completeStalePicker(directory('Stale import', [fileHandle(imageFile('stale.png'))]));
    await staleImport;
    check('An import that completes after switching projects cannot add stale assets', cards().length === 0 && items() === 0 && !folder('Stale import') && get('status').textContent.includes('Import cancelled because the target project or slide changed'));
    check('Discarding a stale import leaves no active progress notice', get('assets-panel').getAttribute('aria-busy') === 'false' && !get('asset-import-status').textContent.includes('Reading'));
    await chooseFiles('project-input', [new win.File([saved.blob], 'folder-checks.figure.json', { type: 'application/json' })]);
    await capture('save-project');
  } catch (error) {
    check(error.stack || error.message, false);
  } finally {
    restore();
    runButton.disabled = false;
    const passed = checks.length > 0 && checks.every(result => result.pass);
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor folder checks`;
    window.folderChecks = { finished: true, passed, checks: [...checks] };
  }
};
