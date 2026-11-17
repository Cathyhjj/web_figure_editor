/** Full HTML figures pair a browser capture with their editable native document. */
import { uid } from './core.js';
import { validateDeck } from './deck.js';
import { importFiles } from './assets.js';

export function sourceDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected HTML or ZIP file.'));
    reader.readAsDataURL(file);
  });
}

export async function prepareHTMLFigure(rendered, source, signal) {
  signal?.throwIfAborted();
  if (typeof rendered.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(rendered.dataUrl)) throw new Error('The renderer returned an invalid PNG capture.');
  const name = `${rendered.title} · ${rendered.label}`.slice(0, 280);
  const response = await fetch(rendered.dataUrl);
  const result = await importFiles([new File([await response.blob()], name + '.png', { type: 'image/png' })]);
  if (result.errors.length || !result.assets.length) throw new Error(result.errors[0]?.message || 'Could not read the rendered figure.');
  signal?.throwIfAborted();
  const asset = { ...result.assets[0], sourceKind: 'copy', sourceOrigin: 'file',
    originalMime: source.mime, originalDataUrl: `data:${source.mime};base64,${source.data}`, originalName: source.name,
    ...(rendered.htmlFigure ? { htmlFigure: rendered.htmlFigure } : {}),
    rasterized: true, rasterizationScale: rendered.effectiveDpi / 96,
    relativePath: `${source.name} / ${rendered.target.page} / ${rendered.label}`.slice(0, 2000) };
  const slide = { id: uid(), name, canvas: { width: Math.max(64, rendered.width), height: Math.max(64, rendered.height), background: '#ffffff' },
    items: [{ id: uid(), type: 'image', name, assetId: asset.id, x: 0, y: 0, width: rendered.width, height: rendered.height, rotation: 0, opacity: 1, locked: false, hidden: false }] };
  return validateDeck({ format: 'figure-editor', version: 2, id: uid(), name: source.name, assets: [asset], slides: [slide], activeSlideId: slide.id });
}

export function initHTMLImport({ captureTarget, targetIsCurrent, insert }) {
  const button = document.getElementById('import-html-figures');
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.html,.htm,.zip'; input.id = 'html-figure-input'; input.hidden = true;
  const dialog = document.createElement('dialog'); dialog.id = 'html-import-dialog'; dialog.setAttribute('aria-labelledby', 'html-import-title');
  dialog.innerHTML = `<div class="dialog-header"><span class="eyebrow">HTML FIGURE IMPORT</span><h2 id="html-import-title">Import HTML figures</h2><p id="html-import-file"></p></div>
    <div class="dialog-body"><div class="field-row"><label class="field"><span>Import region</span><select id="html-import-mode"><option value="figures">Individual Figures</option><option value="pages">Full pages</option></select></label><label class="field"><span>Page width (px)</span><input id="html-import-width" type="number" min="320" max="2400" step="1" value="1440"></label><label class="field"><span>Capture resolution</span><select id="html-import-dpi"><option value="150">150 DPI</option><option value="300" selected>300 DPI</option><option value="600">600 DPI</option></select></label></div>
    <p class="hint">Each selection becomes a new slide. Double-click a supported Figure to edit its HTML text, colors and positions. A matching image preserves its appearance in exports. The original HTML or ZIP is saved with the project.</p>
    <p id="html-import-status" role="status" aria-live="polite"></p><div class="html-import-selection"><button id="html-import-select-all" class="text-button">Select all</button><button id="html-import-select-none" class="text-button">Clear selection</button></div><div id="html-import-candidates"></div>
    <details id="html-import-notes" hidden><summary>Import notes</summary><ul></ul></details></div>
    <div class="dialog-actions"><button id="html-import-cancel" class="button">Cancel</button><button id="html-import-submit" class="button primary" disabled>Insert selected Figures</button></div>`;
  document.body.append(input, dialog);
  const get = key => dialog.querySelector('#html-import-' + key), info = get('status'), submit = get('submit');
  let generation = 0, controller, fileData, target, token, candidates = [], selected = new Set(), busy = false, sourceHash;
  const key = item => JSON.stringify([item.page, item.figure]);
  const visible = () => candidates.filter(item => (item.figure === -1) === (get('mode').value === 'pages'));
  function controls() {
    for (const name of ['mode', 'width', 'dpi', 'select-all', 'select-none']) get(name).disabled = busy;
    submit.disabled = busy || !visible().some(item => selected.has(key(item)));
    submit.textContent = `Insert ${visible().filter(item => selected.has(key(item))).length || 'selected'} as new slides`;
    dialog.setAttribute('aria-busy', String(busy));
  }
  function showNotes(notes) {
    get('notes').hidden = !notes.length;
    get('notes').querySelector('ul').replaceChildren(...notes.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  }
  function renderList() {
    get('candidates').replaceChildren(...visible().map(item => {
      const label = document.createElement('label'); label.className = 'html-import-card';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(key(item)); checkbox.disabled = busy;
      checkbox.onchange = () => { checkbox.checked ? selected.add(key(item)) : selected.delete(key(item)); controls(); };
      const img = document.createElement('img'); img.src = item.preview; img.alt = `${item.title}, ${item.label}`;
      const text = document.createElement('span'); text.textContent = `${item.title} · ${item.label}`;
      const size = document.createElement('small'); size.textContent = `${item.width} × ${item.height} px${item.heading ? ' · ' + item.heading : ''}`;
      label.append(checkbox, img, text, size); return label;
    })); controls();
  }
  async function request(extra = {}, run = { controller, fileData, token, width: Number(get('width').value), sourceHash }) {
    const response = await fetch('/api/html-import', { method: 'POST', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Figure-Token': run.token }, signal: run.controller.signal,
      body: JSON.stringify({ ...run.fileData, width: run.width, ...extra }) });
    let result; try { result = await response.json(); } catch { throw new Error('HTML import needs the updated local server. Restart the editor and try again.'); }
    if (!response.ok) throw new Error(result.error || 'Could not render this HTML.');
    if (run.sourceHash && run.sourceHash !== result.source.sha256) throw new Error('The source changed. Cancel and import again.');
    return result;
  }
  async function inspect() {
    const current = generation;
    busy = true; candidates = []; selected.clear(); renderList(); showNotes([]); info.textContent = 'Rendering pages and finding Figures…';
    try {
      const result = await request(); if (current !== generation) return;
      sourceHash = result.source.sha256; candidates = result.candidates;
      if (!candidates.length) throw new Error('No renderable pages or Figures were found.');
      get('mode').value = candidates.some(item => item.figure !== -1) ? 'figures' : 'pages';
      selected = new Set(visible().map(key)); showNotes(result.warnings);
      info.textContent = `Found ${candidates.filter(item => item.figure !== -1).length} Figures in ${candidates.filter(item => item.figure === -1).length} pages. Choose what to import.`;
    } catch (error) { if (current === generation && error.name !== 'AbortError') info.textContent = error.message; }
    finally { if (current === generation) { busy = false; renderList(); } }
  }
  async function open(file) {
    if (!file || dialog.open) return;
    generation++; const current = generation; controller = new AbortController(); fileData = null; sourceHash = null; candidates = []; selected.clear(); target = captureTarget();
    button.disabled = true; busy = true; renderList(); showNotes([]); get('file').textContent = file.name; info.textContent = 'Reading file…'; dialog.showModal();
    try {
      if (!/\.(html?|zip)$/i.test(file.name) || !file.size || file.size > 25 * 1024 * 1024) throw new Error('Choose an HTML or ZIP file of at most 25 MB.');
      const source = await sourceDataURL(file);
      if (current !== generation) return;
      const response = await fetch('/api/local', { signal: controller.signal, mode: 'same-origin', cache: 'no-store', redirect: 'error' });
      const local = await response.json();
      if (local.app !== 'figure-editor-local' || !local.htmlFigureImport || typeof local.token !== 'string') throw new Error('HTML import needs the updated local server, Node.js and Chrome or Edge. Restart the editor after installing them.');
      if (current !== generation) return;
      token = local.token; fileData = { name: file.name, data: source.slice(source.indexOf(',') + 1) }; await inspect();
    } catch (error) { if (current === generation && error.name !== 'AbortError') { info.textContent = error.message; busy = false; controls(); } }
  }
  submit.onclick = async () => {
    if (busy) return;
    const chosen = visible().filter(item => selected.has(key(item))); if (!chosen.length) return;
    const current = generation; busy = true; renderList();
    const run = { controller, fileData, token, width: Number(get('width').value), sourceHash, target, dpi: Number(get('dpi').value) };
    try {
      let deck; const notes = new Set();
      for (const [index, candidate] of chosen.entries()) {
        if (current !== generation) return;
        if (!targetIsCurrent(run.target)) throw new Error('The destination changed. Cancel and import again.');
        info.textContent = `Rendering ${index + 1} of ${chosen.length}: ${candidate.label}…`;
        const result = await request({ target: { page: candidate.page, figure: candidate.figure }, dpi: run.dpi }, run);
        if (current !== generation) return;
        run.controller.signal.throwIfAborted();
        const prepared = await prepareHTMLFigure(result, { ...run.fileData, mime: result.source.mime }, run.controller.signal);
        if (current !== generation) return;
        if (!deck) deck = prepared; else { deck.assets.push(...prepared.assets); deck.slides.push(...prepared.slides); }
        validateDeck(deck); result.warnings.forEach(note => notes.add(note));
      }
      if (current !== generation) return;
      if (!targetIsCurrent(run.target)) throw new Error('The destination changed. Cancel and import again.');
      if (insert(validateDeck(deck), [...notes]) !== false) dialog.close();
    } catch (error) { if (current === generation && error.name !== 'AbortError') info.textContent = error.message; }
    finally { if (current === generation) { busy = false; renderList(); } }
  };
  get('mode').onchange = () => { selected = new Set(visible().map(key)); renderList(); };
  get('width').onchange = () => { if (fileData && !busy && get('width').checkValidity()) void inspect(); };
  get('select-all').onclick = () => { selected = new Set(visible().map(key)); renderList(); };
  get('select-none').onclick = () => { selected.clear(); renderList(); };
  get('cancel').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; controller?.abort(); fileData = null; candidates = []; selected.clear(); get('candidates').replaceChildren(); button.disabled = false; });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  for (const type of ['copy', 'cut', 'paste']) dialog.addEventListener(type, event => event.stopPropagation());
  button.onclick = () => input.click();
  input.onchange = () => { const file = input.files[0]; input.value = ''; void open(file); };
  return { open };
}
