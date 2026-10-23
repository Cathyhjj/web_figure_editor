import { createDeck, addSlide } from '../deck.js';

const results = document.querySelector('#results');
const run = document.querySelector('#run');
function check(name, pass) {
  window.pptxChecks.checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}
function entries(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map();
  const decoder = new TextDecoder();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), n = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true);
    if (view.getUint16(at + 8, true) !== 0) throw new Error('Expected stored PPTX ZIP entries.');
    const start = at + 30 + n + extra;
    files.set(decoder.decode(bytes.slice(at + 30, at + 30 + n)), bytes.slice(start, start + size));
    at = start + size;
  }
  return files;
}
async function imageAsset(mime, id) {
  const canvas = document.createElement('canvas');
  canvas.width = 240; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8e8ef'; ctx.fillRect(0, 0, 240, 160);
  ctx.strokeStyle = '#9d347d'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(20, 135);
  for (let x = 20; x < 225; x++) ctx.lineTo(x, 130 - 95 * Math.exp(-(((x - 120) / 42) ** 2)));
  ctx.stroke(); ctx.fillStyle = '#242031'; ctx.font = '16px Arial'; ctx.fillText('Synthetic spectrum', 38, 25);
  const dataUrl = canvas.toDataURL(mime);
  if (!dataUrl.startsWith(`data:${mime};`)) throw new Error(`This browser cannot generate ${mime}.`);
  return { id, name: `${id}.${mime.split('/')[1]}`, mime, width: 240, height: 160, dataUrl, size: 0, lastModified: 0, sourceKind: 'copy' };
}
async function fixture() {
  const deck = createDeck(); deck.name = 'PPT export check';
  deck.assets = await Promise.all(['image/png', 'image/jpeg', 'image/webp'].map((mime, i) => imageAsset(mime, `asset-${i}`)));
  const first = deck.slides[0]; first.name = 'Editable objects';
  first.items = [
    { id: 'title', type: 'text', x: 48, y: 32, width: 850, height: 60, text: 'Editable figure — α & β', fontSize: 32, fontWeight: 'bold', color: '#241c2c' },
    ...deck.assets.map((asset, i) => ({ id: `image-${i}`, name: asset.name, type: 'image', assetId: asset.id, x: 48 + i * 300, y: 140, width: 260, height: 180, opacity: i === 2 ? 0.65 : 1, rotation: i === 1 ? 8 : 0 })),
    { id: 'rect', name: 'Editable rectangle', type: 'rect', x: 48, y: 400, width: 250, height: 130, fill: '#9d347d80', stroke: '#663354', strokeWidth: 3, rotation: -8 },
    { id: 'line', name: 'Editable line', type: 'line', x: 370, y: 450, width: 160, height: 55, stroke: '#327caa', strokeWidth: 5 },
    { id: 'multiline', type: 'text', x: 600, y: 390, width: 300, height: 130, text: 'Independent text\nSecond line\nThird line', fontSize: 24, fontStyle: 'italic', align: 'center', color: '#327caa' },
    { id: 'hidden', type: 'text', x: 20, y: 20, width: 400, height: 40, text: 'HIDDEN TEXT', hidden: true },
  ];
  const second = addSlide(deck); second.name = 'Different canvas'; second.canvas = { width: 480, height: 480, background: '#e8edf5' };
  second.items = [
    { id: 'second-text', type: 'text', x: 30, y: 35, width: 420, height: 60, text: 'Centered square slide', fontSize: 24, color: '#241c2c' },
    { id: 'second-image', type: 'image', assetId: deck.assets[0].id, x: 50, y: 130, width: 380, height: 250 },
    { id: 'second-edge', name: 'Shape crossing source canvas edges', type: 'rect', x: -60, y: 420, width: 600, height: 20, fill: '#9d347d', stroke: 'none', strokeWidth: 0 },
  ];
  return deck;
}

run.onclick = async () => {
  run.disabled = true; results.replaceChildren();
  window.pptxChecks = { finished: false, checks: [] };
  document.title = 'RUNNING — Figure Editor PPT checks';
  let restore = () => {};
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use test port 18766 to protect the normal editor draft.');
    const iframe = document.createElement('iframe'); iframe.title = 'PPT export test editor';
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Editor load timed out.')), 15000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
    });
    iframe.src = '../index.html'; document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
    const win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    // iframe load can precede the app's awaited draft/recent-file restoration.
    const readyDeadline = performance.now() + 15000;
    while (get('open-project').disabled) {
      if (performance.now() > readyDeadline) throw new Error('Editor initialization timed out.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const urls = new Map(), downloads = [];
    const originalURL = win.URL.createObjectURL, originalClick = win.HTMLAnchorElement.prototype.click, originalConfirm = win.confirm, originalSavePicker = win.showSaveFilePicker;
    win.confirm = () => true;
    win.showSaveFilePicker = undefined;
    win.URL.createObjectURL = blob => { const url = originalURL.call(win.URL, blob); urls.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: urls.get(this.href) }); else originalClick.call(this); };
    restore = () => { win.URL.createObjectURL = originalURL; win.HTMLAnchorElement.prototype.click = originalClick; win.confirm = originalConfirm; win.showSaveFilePicker = originalSavePicker; for (const url of urls.keys()) win.URL.revokeObjectURL(url); };
    const open = async deck => {
      const files = new win.DataTransfer(); files.items.add(new win.File([JSON.stringify(deck)], 'test.figure.json', { type: 'application/json' }));
      get('project-input').files = files.files; await get('project-input').onchange({ target: get('project-input') });
    };
    const choose = format => { get('export-format').value = format; get('export-format').onchange(); };
    const deck = await fixture(); await open(deck);
    check('Synthetic two-slide project opens in the editor', doc.querySelectorAll('.slide-card').length === 2);
    get('export-open').click(); choose('pptx');
    check('PPT export shows all slides, editable content, and mixed-size fitting', get('export-title').textContent === 'Export as PPT' && get('export-slide-name').textContent.includes('All 2 slides') && get('export-info').textContent.includes('centered') && get('export-info').textContent.includes('editable text'));
    check('PNG resolution is disabled for PPT', get('export-dpi').disabled && !get('export-submit').disabled);
    get('export-cancel').click();
    check('Cancel leaves the project intact and produces no download', !get('export-dialog').open && downloads.length === 0 && doc.querySelectorAll('.slide-card').length === 2);
    get('export-open').click(); const exporting = get('export-submit').onclick();
    check('Export progress disables repeated submission and format changes', get('export-submit').disabled && get('export-format').disabled && get('export-cancel').disabled && get('export-submit').textContent === 'Exporting…');
    await get('export-submit').onclick(); await exporting;
    const output = downloads.at(-1);
    if (!output?.blob) throw new Error(`PPT download missing: ${get('status').textContent}`);
    check('PPT download uses .pptx and the Office MIME type', output.name === 'PPT export check.pptx' && output.blob.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    check('Successful export closes the dialog and restores the button', !get('export-dialog').open && !get('export-submit').disabled && get('status').textContent.includes('all 2 slides'));
    const files = entries(await output.blob.arrayBuffer());
    const decoder = new TextDecoder(), xml = name => decoder.decode(files.get(name));
    check('Export contains both slides in deck order even when slide 2 is active', xml('ppt/slides/slide1.xml').includes('Editable figure') && xml('ppt/slides/slide2.xml').includes('Centered square slide'));
    check('Native editable text, picture and shape records are present; hidden text is omitted', /txBox="1"/.test(xml('ppt/slides/slide1.xml')) && xml('ppt/slides/slide1.xml').includes('<p:pic>') && xml('ppt/slides/slide1.xml').includes('prst="rect"') && !xml('ppt/slides/slide1.xml').includes('HIDDEN TEXT'));
    const media = [...files].filter(([path]) => path.startsWith('ppt/media/'));
    check('Shared image is embedded once; WebP becomes PNG', media.length === 3 && !media.some(([path]) => path.endsWith('.webp')) && media.filter(([path]) => path.endsWith('.png')).length === 2);
    const bitmaps = await Promise.all(media.map(async ([path, bytes]) => createImageBitmap(new Blob([bytes], { type: path.endsWith('.png') ? 'image/png' : 'image/jpeg' }))));
    check('Every exported image decodes at its source dimensions', bitmaps.every(bitmap => bitmap.width === 240 && bitmap.height === 160)); bitmaps.forEach(bitmap => bitmap.close());
    check('All XML parts are well formed', [...files].filter(([path]) => /\.xml$|\.rels$/.test(path)).every(([, bytes]) => !new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml').querySelector('parsererror')));
    window.pptxChecks.sample = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(output.blob); });
    window.pptxChecks.project = deck;
    await get('save-project').onclick();
    check('PPT export does not change the editable project or active slide', JSON.stringify(JSON.parse(await downloads.at(-1).blob.text())) === JSON.stringify((await import('../deck.js')).validateDeck(deck)));
    get('export-open').click(); choose('png');
    check('Switching back to PNG restores resolution and current-slide scope', !get('export-dpi').disabled && get('export-title').textContent === 'Export current slide' && get('export-slide-name').textContent.includes('Slide 2'));
    choose('html'); await get('export-submit').onclick();
    check('HTML report still exports all slides', downloads.at(-1).name.endsWith('-report.html') && (await downloads.at(-1).blob.text()).includes('Editable figure'));
    const extreme = createDeck(); extreme.slides[0].canvas = { width: 16000, height: 1, background: '#ffffff' };
    await open(extreme); get('export-open').click(); choose('pptx');
    check('Unsupported extreme aspect ratio gives a visible error and disables export', get('export-submit').disabled && !!get('export-info').textContent);
    choose('svg'); check('Other formats remain available after a PPT size error', !get('export-submit').disabled); get('export-cancel').click();
    const broken = structuredClone(deck); broken.assets[2].dataUrl = 'data:image/webp;base64,UklGRgAAAABXRUJQ'; await open(broken);
    get('export-open').click(); choose('pptx'); const beforeFailure = downloads.length; await get('export-submit').onclick();
    check('Image decode failure gives feedback, keeps dialog open, and restores the export button', downloads.length === beforeFailure && get('status').textContent.startsWith('Export failed:') && get('export-info').textContent.startsWith('Export failed:') && get('export-dialog').open && !get('export-submit').disabled);
    get('export-cancel').click(); await open(deck);
    get('export-open').click(); choose('pptx'); await get('export-submit').onclick();
    check('Export succeeds again after correcting the project', downloads.length === beforeFailure + 1 && !get('export-dialog').open);
  } catch (error) { check(error.stack || error.message, false); }
  finally {
    restore(); run.disabled = false; window.pptxChecks.finished = true;
    document.title = `${window.pptxChecks.checks.every(result => result.pass) ? 'PASS' : 'FAIL'} — Figure Editor PPT checks`;
  }
};
