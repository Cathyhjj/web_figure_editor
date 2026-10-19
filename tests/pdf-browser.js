import { createDeck, addSlide, slideProject, validateDeck } from '../deck.js';
import { exportPNG } from '../core.js';

const results = document.querySelector('#results');
const run = document.querySelector('#run');
function check(name, pass) {
  window.pdfChecks.checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}
function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function pdfDetails(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // PDF dictionaries are ASCII even though the image streams contain binary bytes.
  const text = new TextDecoder('latin1').decode(bytes);
  const mediaBox = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const images = [...text.matchAll(/<<[^<>]*\/Subtype\s*\/Image\b[^<>]*>>/g)].map(([dictionary]) => ({
    width: Number(dictionary.match(/\/Width\s+(\d+)/)?.[1]),
    height: Number(dictionary.match(/\/Height\s+(\d+)/)?.[1]),
    rgb: /\/ColorSpace\s*\/DeviceRGB\b/.test(dictionary),
  }));
  const vectorStreams = [];
  for (const match of text.matchAll(/(?:^|\n)\d+\s+0\s+obj\s*(<<(?:(?!\bendobj\b)[\s\S])*?>>)\s*stream\r?\n/g)) {
    const dictionary = match[1];
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const length = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1]);
    const start = match.index + match[0].length;
    let stream = bytes.slice(start, start + length);
    if (/\/Filter\s*\/FlateDecode\b/.test(dictionary)) stream = new Uint8Array(await new Response(new Blob([stream]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    vectorStreams.push(new TextDecoder().decode(stream));
  }
  return { text, mediaBox: mediaBox?.slice(1).map(Number), pages: [...text.matchAll(/\/Type\s*\/Page\b/g)].length, images, vectorContent: vectorStreams.join('\n') };
}
const pathOperator = (pdf, operator) => new RegExp(`(?:^|\\s)${operator}(?:\\s|$)`).test(pdf.vectorContent);
function fixture() {
  const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e6edf4'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#9d347d'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(12, 110);
  for (let x = 12; x < 180; x++) ctx.lineTo(x, 106 - 80 * Math.exp(-(((x - 96) / 34) ** 2)));
  ctx.stroke(); ctx.fillStyle = '#242031'; ctx.font = '12px Arial'; ctx.fillText('Synthetic spectrum', 30, 20);
  const deck = createDeck(); deck.name = 'PDF export check';
  deck.assets = [{ id: 'spectrum', name: 'spectrum.png', mime: 'image/png', width: 192, height: 128, dataUrl: canvas.toDataURL('image/png'), sourceKind: 'copy' }];
  deck.slides[0].name = 'First slide is not exported';
  deck.slides[0].items = [{ id: 'first-text', type: 'text', x: 48, y: 40, width: 800, height: 50, text: 'FIRST SLIDE ONLY', fontSize: 36 }];
  const second = addSlide(deck); second.name = 'PDF selected slide';
  second.canvas = { width: 384, height: 256, background: 'transparent' };
  second.items = [
    { id: 'title', type: 'text', x: 24, y: 18, width: 336, height: 32, text: 'PDF figure — α & β 中文', fontSize: 22, fontWeight: 'bold', color: '#241c2c' },
    { id: 'spectrum-image', type: 'image', assetId: 'spectrum', x: 28, y: 64, width: 192, height: 128, rotation: -4, crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, shadow: { enabled: true, color: '#000000', transparency: 60, size: 100, blur: 5, angle: 45, distance: 3 } },
    { id: 'transparent-shape', type: 'rect', x: 250, y: 84, width: 90, height: 80, fill: '#9d347d80', stroke: '#663354', strokeWidth: 2, rotation: 10 },
    { id: 'source-image', type: 'image', assetId: 'spectrum', x: 250, y: 175, width: 90, height: 40 },
    { id: 'line', type: 'line', x: 250, y: 232, width: 85, height: 0, stroke: '#327caa', strokeWidth: 4 },
    { id: 'caption', type: 'text', x: 24, y: 220, width: 220, height: 24, text: 'Current slide · transparent background', fontSize: 12, color: '#327caa' },
    { id: 'hidden', type: 'rect', x: 0, y: 0, width: 384, height: 256, fill: '#ff0000', hidden: true },
  ];
  return deck;
}

run.onclick = async () => {
  run.disabled = true; results.replaceChildren(); document.querySelector('#samples').replaceChildren();
  window.pdfChecks = { finished: false, checks: [] };
  document.title = 'RUNNING — Figure Editor PDF checks';
  let restore = () => {};
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use test port 18766 to protect the normal editor draft.');
    const iframe = document.createElement('iframe'); iframe.title = 'PDF export test editor';
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Editor load timed out.')), 15000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
    });
    iframe.src = '../index.html'; document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
    const win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    // The editor awaits its IndexedDB draft after the iframe load event. Opening
    // a fixture sooner would be ignored while the initial file operation runs.
    await new Promise((resolve, reject) => {
      const ready = () => get('save-project')?.getAttribute('aria-busy') === 'false' && typeof get('project-input')?.onchange === 'function';
      if (ready()) { resolve(); return; }
      const observer = new MutationObserver(() => { if (ready()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Editor initialization timed out.')); }, 15000);
      observer.observe(doc, { subtree: true, attributes: true, attributeFilter: ['aria-busy', 'disabled'] });
    });
    const urls = new Map(), downloads = [];
    const originalURL = win.URL.createObjectURL, originalClick = win.HTMLAnchorElement.prototype.click, originalConfirm = win.confirm, originalSavePicker = win.showSaveFilePicker, originalFetch = win.fetch;
    win.confirm = () => true; win.showSaveFilePicker = undefined;
    win.URL.createObjectURL = blob => { const url = originalURL.call(win.URL, blob); urls.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: urls.get(this.href) }); else originalClick.call(this); };
    restore = () => { win.URL.createObjectURL = originalURL; win.HTMLAnchorElement.prototype.click = originalClick; win.confirm = originalConfirm; win.showSaveFilePicker = originalSavePicker; win.fetch = originalFetch; for (const url of urls.keys()) win.URL.revokeObjectURL(url); };
    const open = async deck => {
      const files = new win.DataTransfer(); files.items.add(new win.File([JSON.stringify(deck)], 'test.figure.json', { type: 'application/json' }));
      get('project-input').files = files.files; await get('project-input').onchange({ target: get('project-input') });
      if (get('project-name').value !== deck.name) throw new Error(`Fixture did not open: ${get('status').textContent}`);
    };
    const choose = format => { get('export-format').value = format; get('export-format').onchange(); };
    const setDPI = dpi => { get('export-dpi').value = String(dpi); get('export-dpi').onchange(); };
    const deck = fixture(); await open(deck);
    check('Synthetic two-slide project opens with slide 2 active', doc.querySelectorAll('.slide-card').length === 2 && doc.querySelector('.slide-card[aria-current="true"]')?.textContent.includes('PDF selected slide'));
    get('export-open').click();
    check('PDF appears beside the existing export formats', ['png', 'svg', 'pdf', 'pptx', 'html'].every(format => [...get('export-format').options].some(option => option.value === format)));
    choose('pdf'); setDPI(150);
    check('PDF describes vector outlines, current-slide scope, and shadow-only resolution', get('export-title').textContent === 'Export current slide' && get('export-slide-name').textContent.includes('Slide 2 of 2') && get('export-dpi-label').textContent === 'PDF shadow resolution' && !get('export-dpi').disabled && /outlines/.test(get('export-info').textContent) && /not searchable/.test(get('export-info').textContent) && /only to images with shadows/.test(get('export-info').textContent));
    get('export-cancel').click();
    check('Cancel leaves both slides intact and produces no download', !get('export-dialog').open && downloads.length === 0 && doc.querySelectorAll('.slide-card').length === 2);
    get('export-open').click();
    const exporting = get('export-submit').onclick();
    check('PDF progress blocks repeated submissions and format changes', get('export-submit').disabled && get('export-format').disabled && get('export-dpi').disabled && get('export-cancel').disabled && get('export-submit').textContent === 'Exporting…');
    await get('export-submit').onclick(); await exporting;
    const lowOutput = downloads.at(-1);
    if (!lowOutput?.blob) throw new Error(`PDF download missing: ${get('status').textContent}`);
    const low = await pdfDetails(lowOutput.blob);
    check('PDF exports once with the current-slide filename and MIME type', downloads.length === 1 && lowOutput.name === 'PDF export check-slide-2.pdf' && lowOutput.blob.type === 'application/pdf');
    check('Successful PDF export closes the dialog and restores its controls', !get('export-dialog').open && !get('export-submit').disabled && !get('export-dpi').disabled && get('status').textContent.includes('PDF'));
    check('Downloaded file has a PDF header, trailer, and exactly one page', low.text.startsWith('%PDF-') && /%%EOF\s*$/.test(low.text) && low.pages === 1);
    check('PDF page uses the selected slide’s physical dimensions (4 × 2⅔ inches)', JSON.stringify(low.mediaBox) === JSON.stringify([0, 0, 288, 192]));
    check('PDF has native rectangle, line, and curved text paths', ['re', 'm', 'l', 'c', 'h'].every(operator => pathOperator(low, operator)));
    check('PDF embeds separate images and transparency without a full-page bitmap', low.images.length > 0 && low.images.every(image => image.width < 600 && image.height < 400) && /\/SMask\s+\d+\s+0\s+R/.test(low.text));
    check('Unshadowed image keeps its original 192 × 128 pixels', low.images.some(image => image.rgb && image.width === 192 && image.height === 128));
    get('export-open').click(); setDPI(300); await get('export-submit').onclick();
    const highOutput = downloads.at(-1), high = await pdfDetails(highOutput.blob);
    const lowShadow = low.images.find(image => image.rgb && (image.width !== 192 || image.height !== 128));
    const highShadow = high.images.find(image => image.rgb && (image.width !== 192 || image.height !== 128));
    check('300 DPI doubles only the shadow image dimensions; source image and page size stay unchanged', !!lowShadow && !!highShadow && Math.abs(highShadow.width - lowShadow.width * 2) <= 1 && Math.abs(highShadow.height - lowShadow.height * 2) <= 1 && high.images.some(image => image.rgb && image.width === 192 && image.height === 128) && high.images.every(image => image.width < 1200 && image.height < 800) && JSON.stringify(high.mediaBox) === JSON.stringify(low.mediaBox) && high.pages === 1);
    window.pdfChecks.sample = await dataURL(highOutput.blob);
    window.pdfChecks.reference = await dataURL(await exportPNG(slideProject(deck), 300));
    window.pdfChecks.project = deck;
    const sampleLink = document.createElement('a'); sampleLink.href = window.pdfChecks.sample; sampleLink.download = highOutput.name; sampleLink.textContent = 'Download synthetic PDF';
    const referenceLink = document.createElement('a'); referenceLink.href = window.pdfChecks.reference; referenceLink.download = 'PDF-export-reference.png'; referenceLink.textContent = 'Download matching PNG';
    const preview = document.createElement('img'); preview.src = window.pdfChecks.reference; preview.alt = 'Synthetic current-slide reference with transparent background';
    document.querySelector('#samples').append(sampleLink, referenceLink, preview);
    get('export-open').click(); choose('png');
    check('PNG restores its own label and current-slide resolution controls', get('export-dpi-label').textContent === 'PNG resolution' && !get('export-dpi').disabled && get('export-slide-name').textContent.includes('Slide 2 of 2'));
    choose('svg');
    check('SVG disables raster resolution and retains current-slide scope', get('export-dpi').disabled && !get('export-submit').disabled && get('export-slide-name').textContent.includes('Slide 2 of 2'));
    choose('pptx');
    check('PPT keeps all-slide scope and disables raster resolution', get('export-dpi').disabled && !get('export-submit').disabled && get('export-slide-name').textContent.includes('All 2 slides'));
    choose('html');
    check('HTML report keeps all-slide scope and disables raster resolution', get('export-dpi').disabled && !get('export-submit').disabled && get('export-slide-name').textContent.includes('All 2 slides'));
    await get('export-submit').onclick();
    const report = downloads.at(-1);
    check('HTML report still contains both slides', report.name.endsWith('-report.html') && (await report.blob.text()).includes('FIRST SLIDE ONLY') && (await report.blob.text()).includes('PDF selected slide'));
    await get('save-project').onclick();
    check('PDF exports and format switching do not mutate the project or active slide', JSON.stringify(JSON.parse(await downloads.at(-1).blob.text())) === JSON.stringify(validateDeck(deck)));
    const shapes = createDeck(); shapes.name = 'Vector shapes check'; shapes.slides[0].canvas = { width: 384, height: 256, background: 'transparent' };
    shapes.slides[0].items = deck.slides[1].items.filter(item => item.type === 'rect' || item.type === 'line');
    await open(shapes); get('export-open').click(); choose('pdf'); await get('export-submit').onclick();
    const shapePDF = await pdfDetails(downloads.at(-1).blob);
    check('Shapes-only PDF contains native geometry and no image objects', downloads.at(-1).name === 'Vector shapes check.pdf' && shapePDF.images.length === 0 && ['re', 'm', 'l'].every(operator => pathOperator(shapePDF, operator)));
    window.pdfChecks.shapeSample = await dataURL(downloads.at(-1).blob);
    const shapeSampleLink = document.createElement('a'); shapeSampleLink.href = window.pdfChecks.shapeSample; shapeSampleLink.download = 'Vector-shapes.pdf'; shapeSampleLink.textContent = 'Download vector shapes PDF'; document.querySelector('#samples').append(shapeSampleLink);
    const text = createDeck(); text.name = 'Vector text check'; text.slides[0].canvas = { width: 384, height: 256, background: 'transparent' };
    text.slides[0].items = [
      { id: 'greek-text', type: 'text', x: 24, y: 24, width: 336, height: 40, text: 'Greek: α β Ω μ χ²', fontFamily: 'Arial', fontSize: 24, color: '#241c2c' },
      { id: 'cjk-text', type: 'text', x: 24, y: 90, width: 336, height: 40, text: '中文矢量文字', fontFamily: 'Arial', fontSize: 24, color: '#327caa' },
    ];
    await open(text); get('export-open').click(); choose('pdf'); await get('export-submit').onclick();
    const textPDF = await pdfDetails(downloads.at(-1).blob);
    check('Greek and Chinese text exports as vector outlines without image objects', downloads.at(-1).name === 'Vector text check.pdf' && textPDF.images.length === 0 && ['m', 'l', 'c', 'h'].every(operator => pathOperator(textPDF, operator)) && (textPDF.vectorContent.match(/(?:^|\s)m(?:\s|$)/g) || []).length > 20);
    window.pdfChecks.textSample = await dataURL(downloads.at(-1).blob);
    const textSampleLink = document.createElement('a'); textSampleLink.href = window.pdfChecks.textSample; textSampleLink.download = 'Vector-text-Greek-Chinese.pdf'; textSampleLink.textContent = 'Download vector text PDF'; document.querySelector('#samples').append(textSampleLink);
    // The request is intercepted only in the generated test editor, to model a
    // static server or unavailable local font-outline service without stopping it.
    win.fetch = (input, init) => String(input?.url || input).includes('/api/pdf-text') ? Promise.resolve(new win.Response(JSON.stringify({ error: 'Local macOS font-outline service unavailable.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })) : originalFetch.call(win, input, init);
    const unavailable = structuredClone(text); unavailable.name = 'Unavailable font outlines'; unavailable.slides[0].items[0].text += ' service-failure';
    await open(unavailable); get('export-open').click(); choose('pdf'); const beforeUnavailable = downloads.length; await get('export-submit').onclick();
    check('Unavailable text-outline service gives an error without silently exporting a bitmap', downloads.length === beforeUnavailable && get('export-dialog').open && get('export-info').textContent.startsWith('Export failed:') && !get('export-submit').disabled && !get('export-format').disabled);
    win.fetch = originalFetch; get('export-cancel').click();
    const oversized = createDeck(); oversized.name = 'Oversized shadow check'; oversized.slides[0].canvas = { width: 16000, height: 16000, background: 'transparent' }; oversized.assets = deck.assets;
    oversized.slides[0].items = [{ ...deck.slides[1].items.find(item => item.id === 'spectrum-image'), width: 16000, height: 16000, x: 0, y: 0 }];
    await open(oversized); get('export-open').click(); choose('pdf'); setDPI(600);
    const beforeFailure = downloads.length;
    if (!get('export-submit').disabled) await get('export-submit').onclick();
    check('Oversized PDF shadow shows an error, creates no download, and leaves the dialog usable', downloads.length === beforeFailure && get('export-dialog').open && /exceed|limit|reduce|large|maximum/i.test(get('export-info').textContent) && !get('export-format').disabled && !get('export-cancel').disabled);
    choose('svg');
    check('Switching to SVG recovers after an oversized PDF error', !get('export-submit').disabled && get('export-dpi').disabled);
    get('export-cancel').click(); await open(deck); get('export-open').click(); choose('pdf'); setDPI(150); await get('export-submit').onclick();
    check('PDF export succeeds after restoring font service and correcting shadow size', downloads.length === beforeFailure + 1 && downloads.at(-1).name === 'PDF export check-slide-2.pdf' && !get('export-dialog').open && !get('export-dpi').disabled);
  } catch (error) { check(error.stack || error.message, false); }
  finally {
    restore(); run.disabled = false; window.pdfChecks.finished = true;
    document.title = `${window.pdfChecks.checks.every(result => result.pass) ? 'PASS' : 'FAIL'} — Figure Editor PDF checks`;
  }
};
