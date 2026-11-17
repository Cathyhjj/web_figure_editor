// Dedicated test server: python3 server.py --port 18796. No production draft is used.
// Optional: SAMANTHA_ZIP=/path/to/Samantha_HTML_Figures_5_versions.zip
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'figure-html-import-'));
console.log('Artifacts:', output);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1550, height: 1050 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await page.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
let count = 0;
function check(name, pass) { assert.ok(pass, name); console.log('PASS', ++count, name); }
async function inspect(file) {
  await page.locator('#html-figure-input').setInputFiles(file);
  await page.waitForFunction(() => document.getElementById('html-import-dialog').getAttribute('aria-busy') === 'false', null, { timeout: 120000 });
  const text = await page.locator('#html-import-status').textContent();
  assert.match(text, /Found/, text);
}
async function save(name) {
  const waiting = page.waitForEvent('download'); await page.locator('#save-project').click();
  const downloaded = await waiting, filename = path.join(output, name + '.figure.json'); await downloaded.saveAs(filename);
  return { filename, deck: JSON.parse(await fs.readFile(filename, 'utf8')) };
}
async function insert() {
  await page.locator('#html-import-submit').click();
  await page.locator('#html-import-dialog').waitFor({ state: 'hidden', timeout: 180000 });
}
try {
  await page.goto(process.env.FIGURE_TEST_URL || 'http://127.0.0.1:18796/');
  await page.waitForFunction(() => !document.getElementById('open-project').disabled);
  const fixture = fileURLToPath(new URL('./fixtures/html-figures.html', import.meta.url));
  await inspect(fixture);
  check('Single HTML detects both Figures', await page.locator('.html-import-card').count() === 2);
  await page.locator('#html-import-mode').selectOption('pages');
  check('Whole-page option is available', await page.locator('.html-import-card').count() === 1);
  await page.locator('#html-import-mode').selectOption('figures');
  await page.screenshot({ path: path.join(output, 'html-preview.png') });
  await page.locator('#html-import-cancel').click();
  check('Cancel leaves the project unchanged', (await save('cancelled')).deck.slides.length === 1);
  await inspect(fixture); await insert();
  let { deck, filename } = await save('html-figures');
  check('Both Figures insert as separate slides', deck.slides.length === 3 && deck.assets.length === 2);
  check('Full-height Figure captures content below the viewport', deck.assets[1].height >= 3500);
  check('300 DPI pixels and original HTML are saved', deck.assets.every(a => a.width > 2500 && a.originalMime === 'text/html' && a.originalName === 'html-figures.html'));
  await page.locator('#undo').click(); check('All imported Figures undo together', (await save('undone')).deck.slides.length === 1);
  await page.locator('#redo').click(); check('Redo restores all Figures', (await save('redone')).deck.slides.length === 3);
  await page.locator('#new-project').click(); await page.locator('#project-input').setInputFiles(filename);
  await page.waitForFunction(() => !document.getElementById('open-project').disabled);
  const reopened = await save('reopened');
  check('Save/reopen preserves capture and original bytes', reopened.deck.assets.every((asset, index) => asset.dataUrl === deck.assets[index].dataUrl && asset.originalDataUrl === deck.assets[index].originalDataUrl));

  // Independent Chrome rendering of the source, compared against imported pixels.
  const source = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const sourceSession = await source.context().newCDPSession(source);
  await source.goto('file://' + fixture); await source.evaluate(() => document.fonts.ready);
  for (const [index, selector] of ['#first', '#second'].entries()) {
    const clip = await source.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.floor(r.x + scrollX), y: Math.floor(r.y + scrollY), width: Math.ceil(r.width), height: Math.ceil(r.height) }; });
    // Use screenshot scaling rather than device-DPR scaling: fractional DPR can
    // change text rasterization even when layout and capture pixels are identical.
    const expected = Buffer.from((await sourceSession.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: deck.assets[index].rasterizationScale } })).data, 'base64');
    const stats = await page.evaluate(async ([a, b]) => {
      const images = await Promise.all([a, b].map(async src => { const image = new Image(); image.src = src; await image.decode(); return image; }));
      if (images[0].width !== images[1].width || images[0].height !== images[1].height) return { dimensions: false, sizes: images.map(i => [i.width, i.height]) };
      const pixels = images.map(image => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; });
      let different = 0; for (let i = 0; i < pixels[0].length; i += 4) if (Math.max(...[0, 1, 2].map(c => Math.abs(pixels[0][i + c] - pixels[1][i + c]))) > 12) different++;
      return { dimensions: true, fraction: different / (pixels[0].length / 4) };
    }, [deck.assets[index].dataUrl, 'data:image/png;base64,' + expected.toString('base64')]);
    check(`Figure ${index + 1} pixels match independent rendering (${JSON.stringify(stats)})`, stats.dimensions && stats.fraction < .015);
  }
  await source.close();
  const fullPage = await page.evaluate(async data => {
    const local = await (await fetch('/api/local')).json();
    return (await fetch('/api/html-import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token }, body: JSON.stringify({ name: 'whole.html', data, target: { page: 'whole.html', figure: -1 }, dpi: 150 }) })).json();
  }, (await fs.readFile(fixture)).toString('base64'));
  check('Whole-page capture includes the complete long document', fullPage.width === 1440 && fullPage.height > 1700 && fullPage.pixelHeight >= fullPage.height * 150 / 96 - 1);

  if (process.env.SAMANTHA_ZIP) {
    await page.locator('#new-project').click(); await inspect(process.env.SAMANTHA_ZIP);
    check('Samantha ZIP yields exactly ten Figure choices', await page.locator('.html-import-card').count() === 10);
    check('Samantha ZIP has no missing-resource warnings', await page.locator('#html-import-notes').isHidden());
    await page.screenshot({ path: path.join(output, 'samantha-preview.png') });
    await insert(); ({ deck, filename } = await save('Samantha-imported'));
    check('All ten Samantha Figures import', deck.slides.length === 11 && deck.assets.length === 10);
    check('All Samantha captures retain original ZIP and at least 300 DPI', deck.assets.every(a => a.originalMime === 'application/zip' && a.rasterizationScale >= 300 / 96) && deck.slides.filter(s => s.items.length).every(s => { const a = deck.assets.find(a => a.id === s.items[0].assetId); return Math.min(a.width / s.canvas.width, a.height / s.canvas.height) * 96 >= 300; }));
    await page.screenshot({ path: path.join(output, 'samantha-editor.png') });
    const original = Buffer.from(deck.assets[0].originalDataUrl.split(',')[1], 'base64');
    check('Embedded Samantha ZIP is byte-identical to the source', original.equals(await fs.readFile(process.env.SAMANTHA_ZIP)));
    // Exercise the single-file gallery independently through the same API.
    const gallery = execFileSync('python3', ['-c', 'import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("Samantha_Figures_5_versions.html"))', process.env.SAMANTHA_ZIP], { maxBuffer: 25 * 1024 * 1024 });
    const api = await page.evaluate(async data => {
      const local = await (await fetch('/api/local')).json();
      return (await fetch('/api/html-import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token }, body: JSON.stringify({ name: 'gallery.html', data }) })).json();
    }, gallery.toString('base64'));
    check('Standalone Samantha gallery also exposes ten Figures', api.candidates?.filter(c => c.figure !== -1).length === 10);
  }
  for (const format of ['png', 'svg', 'pdf', 'pptx', 'html']) {
    await page.locator('#export-open').click(); await page.locator('#export-format').selectOption(format);
    const waiting = page.waitForEvent('download', { timeout: 120000 }); await page.locator('#export-submit').click();
    const download = await waiting, filename = path.join(output, 'export.' + format); await download.saveAs(filename);
    check(`${format.toUpperCase()} export succeeds`, (await fs.stat(filename)).size > 1000);
    if (format === 'svg' || format === 'html') {
      const contents = await fs.readFile(filename, 'utf8');
      check(`${format.toUpperCase()} export uses the preserved figure capture`, contents.includes(deck.assets[0].dataUrl));
      check(`${format.toUpperCase()} export does not embed executable originals`, !contents.includes(deck.assets[0].originalDataUrl));
    }
  }
  check('No uncaught editor errors', errors.length === 0);
  console.log(JSON.stringify({ checks: count, output }));
} catch (error) {
  console.error(error); console.error('EDITOR ERRORS', errors); console.error('STATUS', await page.locator('#status').textContent());
  console.error('IMPORT STATUS', await page.locator('#html-import-status').textContent());
  await page.screenshot({ path: path.join(output, 'error.png') }); process.exitCode = 1;
} finally { await browser.close(); }
