// Isolated browser acceptance. Start: python3 server.py --port 18796
// Optional SAMANTHA_ZIP exercises all ten real Figures; no user draft is touched.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'figure-html-edit-')); console.log('Artifacts:', output);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
page.on('console', m => { if (m.type() === 'error') console.log('BROWSER', m.text()); });
await page.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log('PASS', ++checks, name); };
async function save(name) {
  const waiting = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await waiting;
  const filename = path.join(output, name + '.figure.json'); await download.saveAs(filename);
  return { filename, deck: JSON.parse(await fs.readFile(filename, 'utf8')) };
}
async function inspect(file) {
  await page.locator('#html-figure-input').setInputFiles(file);
  await page.waitForFunction(() => document.querySelector('#html-import-dialog').getAttribute('aria-busy') === 'false', null, { timeout: 120000 });
  assert.match(await page.locator('#html-import-status').textContent(), /Found/);
  await page.locator('#html-import-submit').click(); await page.locator('#html-import-dialog').waitFor({ state: 'hidden', timeout: 180000 });
}
async function open(index) {
  await page.locator('#slide-list [data-slide]').nth(index).click();
  await page.locator('#stage [data-item]').first().click({ force: true });
  await page.locator('#edit-html-figure').click();
  await page.waitForFunction(() => !document.querySelector('#html-figure-apply').disabled, null, { timeout: 30000 });
  return page.frameLocator('#html-figure-preview');
}
async function select(frame, selector) {
  const id = await frame.locator(selector).first().getAttribute('data-fe-node'); assert.ok(id, selector);
  await page.locator('#html-figure-elements').selectOption(id);
  await page.waitForFunction(id => document.querySelector('#html-figure-elements').value === id && document.querySelector('.html-figure-properties h3'), id);
}
async function field(key, value) {
  const input = page.locator(`[data-html-field="${key}"]`).first(); await input.fill(String(value)); await input.press('Tab');
}
async function apply() {
  await page.locator('#html-figure-apply').click(); await page.locator('#html-figure-editor').waitFor({ state: 'hidden', timeout: 120000 });
}
async function comparePixels(a, b) {
  return page.evaluate(async ([a, b]) => {
    const images = await Promise.all([a, b].map(async src => { const image = new Image(); image.src = src; await image.decode(); return image; }));
    if (images[0].width !== images[1].width || images[0].height !== images[1].height) return 1;
    const pixels = images.map(i => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; });
    let changed = 0; for (let i = 0; i < pixels[0].length; i += 4) if ([0, 1, 2].some(c => Math.abs(pixels[0][i + c] - pixels[1][i + c]) > 12)) changed++;
    return changed / (pixels[0].length / 4);
  }, [a, b]);
}
try {
  await page.goto(process.env.FIGURE_TEST_URL || 'http://127.0.0.1:18796/'); await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  const fixture = path.join(output, 'editable.html');
  await fs.writeFile(fixture, `<!doctype html><html><head><style>body{margin:0;font:20px Arial;--accent:#352060}main{width:1000px;margin:auto}figure{margin:20px 0;padding:30px;background:#fff;border:1px solid #ddd}h2{color:var(--accent)!important}.row{display:flex;gap:20px}.box{padding:20px;background:#eef;flex:1}.gap{height:950px}svg{width:500px;height:200px}#second h2{height:10vh}@media(min-height:1000px){#second h2{color:red!important}}a[href]{color:#d02020}</style></head><body><main><figure><h2>Original heading</h2><p>Keep <b>bold child</b> and this tail.</p><a href="https://example.invalid/">Styled link</a><div class="row"><div class="box">First card</div><div class="box">Second card</div></div><svg viewBox="0 0 500 200"><defs><linearGradient id="base"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><linearGradient id="inherited" href="#base"/><path id="curve" d="M200 150 Q250 80 350 150"/></defs><g transform="translate(20 10) scale(1.2)"><rect id="rect" transform="rotate(10 60 40)" x="20" y="10" width="120" height="80" fill="url(#inherited)"/><text x="30" y="150">SVG label</text></g><text><textPath href="#curve">Curved label</textPath></text></svg></figure><div class="gap"></div><figure id="second"><h2>Second Figure</h2><table><tr><td>Cell text</td></tr></table><p>Below viewport</p></figure></main><script>window.untrustedScript=true</script></body></html>`);
  await inspect(fixture); let { deck, filename } = await save('initial');
  check('Imports retain native documents for both Figures', deck.assets.every(a => a.htmlFigure?.html.includes('data-fe-root')));
  check('Native sources remove scripts and preserve inherited CSS', deck.assets.every(a => !a.htmlFigure.html.includes('<script') && a.htmlFigure.html.includes('--accent')));
  const original = deck.assets[0], sourceBytes = original.originalDataUrl;
  // No-edit round-trip must preserve the original appearance before testing edits.
  const baseline = await page.evaluate(async f => { const { renderEditedHTML } = await import('/html-figure-model.js'); return renderEditedHTML(f, f.html); }, original.htmlFigure);
  const baselineDifference = await comparePixels(original.dataUrl, baseline.dataUrl);
  check(`Frozen native document preserves original pixels (${baselineDifference})`, baselineDifference < .005);
  let frame = await open(1);
  await select(frame, 'h2'); await field('text', 'Edited heading'); await field('color', '#c02040');
  check('Text and important color update in the preview', await frame.locator('h2').first().textContent() === 'Edited heading' && await frame.locator('h2').first().evaluate(n => getComputedStyle(n).color) === 'rgb(192, 32, 64)');
  await field('text', ''); await page.getByRole('button', { name: 'Undo edit', exact: true }).click(); await page.getByRole('button', { name: 'Redo edit', exact: true }).click();
  check('Empty text survives draft Undo/Redo and remains editable', await frame.locator('h2').first().textContent() === '' && await page.locator('[data-html-field="text"]').count() === 1);
  await field('text', 'Edited heading');
  await select(frame, 'p'); await field('text', '<img onerror=alert(1)> literal ');
  check('Text edits remain literal and retain nested bold nodes', await frame.locator('p b').count() === 1 && await frame.locator('p img').count() === 0);
  await select(frame, '.box'); const before = await frame.locator('.box').first().boundingBox(); await field('x', 24); await field('y', 12);
  check('HTML offset changes position without changing flex structure', await frame.locator('.row > .box').count() === 2 && await frame.locator('.box').first().getAttribute('data-fe-x') === '24');
  await select(frame, '#rect'); await field('fill', '#008866'); await field('x', 15);
  check('SVG color and position retain ancestor transforms', await frame.locator('#rect').evaluate(n => getComputedStyle(n).fill) === 'rgb(0, 136, 102)' && await frame.locator('#rect').locator('..').getAttribute('transform') === 'translate(20 10) scale(1.2)');
  const dragBefore = await frame.locator('#rect').boundingBox(); await page.mouse.move(dragBefore.x + dragBefore.width / 2, dragBefore.y + dragBefore.height / 2); await page.mouse.down(); await page.mouse.move(dragBefore.x + dragBefore.width / 2 + 30, dragBefore.y + dragBefore.height / 2 + 15, { steps: 5 }); await page.mouse.up();
  const dragAfter = await frame.locator('#rect').boundingBox(); check('Dragging rotated SVG inside a scaled group follows the pointer', Math.abs(dragAfter.x - dragBefore.x - 30) < 2 && Math.abs(dragAfter.y - dragBefore.y - 15) < 2);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  check('Draft Undo restores SVG position', await frame.locator('#rect').getAttribute('data-fe-x') === null);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'native-editor.png') }); await apply();
  ({ deck, filename } = await save('edited')); let edited = deck.assets.find(a => a.id === deck.slides[1].items[0].assetId);
  check('Apply commits new pixels and edited HTML with original bytes intact', edited.dataUrl !== original.dataUrl && edited.htmlFigure.html.includes('Edited heading') && edited.originalDataUrl === sourceBytes);
  await page.locator('#undo').click(); const undone = (await save('undone')).deck;
  check('Project Undo restores source and capture together', undone.slides[1].items[0].assetId === original.id);
  await page.locator('#redo').click(); await page.locator('#new-project').click(); await page.locator('#project-input').setInputFiles(filename);
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  frame = await open(1); check('Reopening starts from the edited HTML', await frame.locator('h2').first().textContent() === 'Edited heading');
  await select(frame, 'h2'); await field('text', 'Cancelled heading'); await page.locator('#html-figure-cancel').click();
  check('Cancel leaves the saved asset unchanged', (await save('cancelled')).deck.assets.find(a => a.id === edited.id).htmlFigure.html === edited.htmlFigure.html);
  frame = await open(1); await select(frame, 'h2'); await field('text', 'Late render must not commit');
  let release, observed; const paused = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { observed = resolve; });
  await page.route('**/api/html-import', async route => { observed(); await paused; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...baseline, htmlFigure: edited.htmlFigure }) }).catch(() => {}); });
  await page.locator('#html-figure-apply').click(); await requested; await page.locator('#html-figure-cancel').click(); release(); await page.unrouteAll({ behavior: 'wait' });
  check('Cancelling an in-flight render cannot commit a late result', (await save('cancelled-render')).deck.slides[1].items[0].assetId === edited.id);
  frame = await open(1); await select(frame, 'p'); await field('text', ''); await apply();
  frame = await open(1); await select(frame, 'p');
  check('Cleared mixed-content text retains both editable slots after Apply/reopen', await page.locator('[data-html-field="text"]').count() === 2 && await page.locator('[data-html-field="text"]').first().inputValue() === '' && await frame.locator('p b').textContent() === 'bold child');
  await field('text', 'Restored text '); await apply();
  frame = await open(2); check('Lower Figure retains the renderer viewport for vh and media queries', await frame.locator('#second h2').evaluate(n => getComputedStyle(n).height) === '90px' && await frame.locator('#second h2').evaluate(n => getComputedStyle(n).color) === 'rgb(53, 32, 96)'); await select(frame, 'td'); await field('text', 'Changed cell'); await field('y', 18); await apply();
  check('Figure below viewport edits the correct element and crop', (await save('second')).deck.assets.some(a => a.htmlFigure?.html.includes('Changed cell')));
  if (process.env.SAMANTHA_ZIP) {
    await page.locator('#new-project').click(); await inspect(process.env.SAMANTHA_ZIP); ({ deck } = await save('Samantha-native'));
    check('Samantha imports all ten editable Figures', deck.assets.length === 10 && deck.assets.every(a => a.htmlFigure));
    for (let i = 1; i <= 10; i++) {
      const originalAsset = deck.assets[i - 1];
      const unchanged = await page.evaluate(async f => { const { renderEditedHTML } = await import('/html-figure-model.js'); return renderEditedHTML(f, f.html); }, originalAsset.htmlFigure);
      const difference = await comparePixels(originalAsset.dataUrl, unchanged.dataUrl);
      check(`Samantha Figure ${i} native appearance preserved (${difference})`, difference < .005);
      frame = await open(i); await select(frame, '[data-fe-root] h2'); await field('text', `Samantha edited Figure ${i}`); await field('color', '#007766'); await field('x', 8); await apply();
    }
    ({ deck, filename } = await save('Samantha-edited')); await page.locator('#new-project').click(); await page.locator('#project-input').setInputFiles(filename); await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
    for (let i = 1; i <= 10; i++) {
      frame = await open(i); check(`Samantha Figure ${i} reopens with its text, color and offset`, await frame.locator('[data-fe-root] h2').textContent() === `Samantha edited Figure ${i}` && await frame.locator('[data-fe-root] h2').getAttribute('data-fe-x') === '8' && await frame.locator('[data-fe-root] h2').evaluate(n => getComputedStyle(n).color) === 'rgb(0, 119, 102)'); await page.locator('#html-figure-cancel').click();
    }
  }
  if (process.env.LEGACY_PROJECT) {
    const legacy = JSON.parse(await fs.readFile(process.env.LEGACY_PROJECT, 'utf8'));
    const upgraded = await page.evaluate(async asset => { const { editableHTMLFigure } = await import('/html-figure-model.js'); return editableHTMLFigure(asset); }, legacy.assets[0]);
    check('Previous Samantha screenshot project upgrades from embedded source with appearance check', upgraded.version === 1 && upgraded.html.includes('data-fe-root'));
  }
  await page.locator('#slide-list [data-slide]').nth(1).click(); ({ deck } = await save('final')); edited = deck.assets.find(a => a.id === deck.slides[1].items[0].assetId);
  for (const format of ['png', 'svg', 'pdf', 'pptx', 'html']) {
    await page.locator('#export-open').click(); await page.locator('#export-format').selectOption(format);
    const waiting = page.waitForEvent('download', { timeout: 120000 }); await page.locator('#export-submit').click(); const download = await waiting;
    const file = path.join(output, 'edited-export.' + format); await download.saveAs(file); check(`${format} exports after edits`, (await fs.stat(file)).size > 1000);
    if (['svg', 'html'].includes(format)) { const text = await fs.readFile(file, 'utf8'); check(`${format} contains the edited image only`, text.includes(edited.dataUrl) && !text.includes(edited.originalDataUrl)); }
    if (format === 'pptx') { const hashes = execFileSync('python3', ['-c', 'import sys,zipfile,hashlib,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith("ppt/media/")]))', file]).toString(); const { createHash } = await import('node:crypto'); check('PPTX embeds the exact edited capture', JSON.parse(hashes).includes(createHash('sha256').update(Buffer.from(edited.dataUrl.split(',')[1], 'base64')).digest('hex'))); }
  }
  check('No uncaught application errors', errors.length === 0); console.log(JSON.stringify({ checks, output }));
} catch (error) { console.error(error); console.error('ERRORS', errors); console.error('STATUS', await page.locator('#status').textContent()); if (await page.locator('#html-figure-status').count()) console.error('HTML', await page.locator('#html-figure-status').textContent()); await page.screenshot({ path: path.join(output, 'error.png') }); process.exitCode = 1; }
finally { await browser.close(); }
