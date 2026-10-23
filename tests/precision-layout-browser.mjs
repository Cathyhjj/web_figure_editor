// Uses an ephemeral local server, an isolated browser context and synthetic project files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, validateDeck, serializeDeck } from '../deck.js';
import { itemBounds } from '../layout.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'precision-layout-'));
const server = spawn('python3', ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let stderr = ''; server.stderr.on('data', data => { stderr += data; });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(stderr || 'Server startup timed out')), 10000);
  createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
  server.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1700, height: 1050 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
await page.addInitScript(() => {
  localStorage.setItem('figure-editor-autosave', 'off');
  window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('precision.figure.json', { create: true });
});
const idle = () => page.waitForFunction(() => !document.querySelector('#save-project-as').disabled);
const set = async (selector, value) => { await page.locator(selector).fill(String(value)); await page.locator(selector).dispatchEvent('change'); };
const select = async (...ids) => {
  for (const [index, id] of ids.entries()) await page.locator(`[data-layer="${id}"] .layer-select`).click({ modifiers: index ? ['Shift'] : [] });
};
const menu = async () => { if (!await page.locator('#precision-menu').evaluate(el => el.matches(':popover-open'))) await page.locator('#precision-toggle').click(); };
const closeMenus = () => page.evaluate(() => { for (const el of document.querySelectorAll('[popover]:popover-open')) el.hidePopover(); });
async function save() {
  await closeMenus(); await page.locator('#save-project-as').click(); await idle();
  return page.evaluate(async () => JSON.parse(await (await (await navigator.storage.getDirectory()).getFileHandle('precision.figure.json')).getFile().then(file => file.text())));
}
function fixture() {
  const deck = createDeck(); deck.name = 'Precision layout synthetic';
  deck.slides[0].canvas = { width: 960.123456789, height: 640.987654321, background: '#ffffff' };
  deck.slides[0].items = [
    { id: 'a', type: 'text', name: 'A', text: 'A', x: 40.123456789, y: 30.987654321, width: 120.123456789, height: 45.987654321, fontSize: 20.123456789 },
    { id: 'b', type: 'text', name: 'B', text: 'B', x: 270, y: 180, width: 180, height: 75, fontSize: 24 },
    { id: 'c', type: 'text', name: 'C', text: 'C', x: 530, y: 420, width: 90, height: 60, fontSize: 18 },
  ];
  return validateDeck(deck);
}
async function load(deck = fixture()) {
  await closeMenus();
  await page.locator('#project-input').setInputFiles({ name: 'synthetic.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(deck)) });
  await idle(); await page.locator('#measurement-unit').selectOption('px');
}
let checks = 0;
const pass = message => { checks++; console.log('PASS', message); };
const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
try {
  await page.goto(`http://127.0.0.1:${port}/`); await idle();
  const original = fixture(); await load(original); await select('a');
  assert.equal(await page.locator('#undo').isDisabled(), true);
  for (const unit of ['mm', 'pt', 'px', 'mm', 'px']) {
    await page.locator('#measurement-unit').selectOption(unit);
    for (const property of ['x', 'y', 'width', 'height', 'fontSize']) await page.locator(`[data-property="${property}"]`).dispatchEvent('change');
    await page.locator('#font-size').dispatchEvent('change');
    assert.equal(await page.locator('#undo').isDisabled(), true);
  }
  const unchanged = await save();
  assert.deepEqual(unchanged.slides[0].items, original.slides[0].items);
  assert.deepEqual(unchanged.slides[0].canvas, original.slides[0].canvas);
  pass('px/mm/pt switches and unchanged blur preserve exact geometry, fonts and Undo');

  await page.locator('#measurement-unit').selectOption('mm');
  await set('[data-property="x"]', 25.4); await set('[data-property="width"]', 50.8);
  await page.locator('#measurement-unit').selectOption('pt'); await set('#font-size', 18);
  let result = await save(), item = result.slides[0].items[0];
  near(item.x, 96); near(item.width, 192); near(item.fontSize, 24);
  assert.match(await page.locator('[data-property="width"]').locator('..').textContent(), /pt/);
  await page.locator('#measurement-unit').selectOption('mm'); await set('#canvas-width', 180); await set('#canvas-height', 120);
  await page.locator('#measurement-unit').selectOption('pt');
  await page.locator('#apply-canvas').click(); result = await save();
  near(result.slides[0].canvas.width, 180 * 96 / 25.4); near(result.slides[0].canvas.height, 120 * 96 / 25.4);
  pass('mm object inputs, pt font inputs and pending canvas values convert correctly');

  await load(); await select('a');
  await page.locator('[data-property="x"]').fill('96');
  await page.locator('#measurement-unit').selectOption('mm'); await page.locator('#undo').click();
  result = await save(); near(result.slides[0].items[0].x, original.slides[0].items[0].x);
  pass('pending object edit commits once before a unit switch and Undo restores it');

  await select('a'); await page.locator('#measurement-unit').selectOption('px');
  await page.locator('#font-size').fill('18'); await page.locator('#measurement-unit').selectOption('pt');
  near(Number(await page.locator('#font-size').inputValue()), 13.5);
  near((await save()).slides[0].items[0].fontSize, 18);
  await page.locator('#undo').click(); near((await save()).slides[0].items[0].fontSize, original.slides[0].items[0].fontSize);
  pass('pending toolbar font entry commits in its original unit before switching');

  await load(); await select('a'); await page.locator('#align-right').click(); await page.locator('#align-bottom').click();
  result = await save(); item = result.slides[0].items[0];
  near(item.x + item.width, result.slides[0].canvas.width); near(item.y + item.height, result.slides[0].canvas.height);
  await page.locator('#undo').click(); await page.locator('#redo').click();
  assert.deepEqual((await save()).slides[0].items, result.slides[0].items);
  pass('single-object right/bottom canvas alignment and Undo/Redo');

  const rotated = fixture(); rotated.slides[0].items[1].rotation = 37;
  await load(rotated); await select('a', 'b', 'c'); await page.locator('#align-right').click(); await page.locator('#align-bottom').click();
  result = await save(); const boxes = result.slides[0].items.map(itemBounds);
  for (const box of boxes) { near(box.x + box.width, boxes[0].x + boxes[0].width); near(box.y + box.height, boxes[0].y + boxes[0].height); }
  pass('multi-object right/bottom align uses rotated visual frame bounds');

  await load(); await select('a', 'b', 'c'); await page.locator('#distribute-y').click();
  result = await save(); let [a, b, c] = result.slides[0].items;
  near(b.y - a.y - a.height, c.y - b.y - b.height); near(a.y, original.slides[0].items[0].y); near(c.y, 420);
  await page.locator('#undo').click(); assert.deepEqual((await save()).slides[0].items, original.slides[0].items);
  pass('vertical equal spacing preserves endpoints and is one Undo step');

  await load(); await select('b', 'a', 'c'); await menu(); await page.locator('#equal-width').click(); await page.locator('#equal-height').click();
  result = await save();
  for (const item of result.slides[0].items) { assert.equal(item.width, 180); assert.equal(item.height, 75); }
  pass('equal width/height follow first selection, independent of z-order');

  await load(); await select('a', 'b', 'c'); await page.locator('#measurement-unit').selectOption('mm');
  await menu(); await set('#layout-gap', 5); await page.locator('#space-x').click(); await page.locator('#space-y').click();
  result = await save(); [a, b, c] = result.slides[0].items;
  for (const [left, right] of [[a, b], [b, c]]) { near(right.x - left.x - left.width, 5 * 96 / 25.4); near(right.y - left.y - left.height, 5 * 96 / 25.4); }
  await select('a', 'b'); await menu(); assert.equal(await page.locator('#space-x').isEnabled(), true);
  assert.equal(await page.locator('#distribute-x').isDisabled(), true);
  await set('#layout-gap', -1); await page.locator('#space-x').click(); assert.match(await page.locator('#status').textContent(), /zero or greater/);
  assert.deepEqual((await save()).slides[0].items, result.slides[0].items);
  pass('explicit mm gaps work on both axes; two objects allowed and invalid gaps are atomic');

  const locked = fixture(); locked.slides[0].items[1].locked = true;
  await load(locked); await select('a', 'b', 'c'); await menu();
  for (const id of ['align-right', 'align-bottom', 'distribute-y', 'equal-width', 'equal-height', 'space-x']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  assert.deepEqual((await save()).slides[0].items, locked.slides[0].items);
  pass('mixed locked selection cannot be partially rearranged');

  const imageDeck = fixture();
  const dataUrl = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#345cad'; ctx.fillRect(0, 0, 200, 100); return canvas.toDataURL(); });
  imageDeck.assets.push({ id: 'source', name: 'sample.png', mime: 'image/png', width: 200, height: 100, dataUrl, sourceKind: 'copy' });
  imageDeck.slides[0].items[2] = { id: 'c', type: 'image', name: 'Image', assetId: 'source', x: 530, y: 420, width: 200, height: 100 };
  await load(validateDeck(imageDeck)); await select('b', 'c'); await menu(); await page.locator('#equal-width').click();
  result = await save(); near(result.slides[0].items[2].width, 180); near(result.slides[0].items[2].height, 90);
  await select('c'); await page.locator('[data-format-tab="size"]').click(); await page.locator('#measurement-unit').selectOption('mm');
  await set('[data-property="width"]', 25.4); result = await save();
  near(result.slides[0].items[2].width, 96); near(result.slides[0].items[2].height, 48);
  pass('equal dimensions and Format Picture measurement fields preserve media aspect ratio');
  await page.screenshot({ path: join(output, 'precision-layout.png'), fullPage: true });
  assert.deepEqual(errors, []); console.log(`${checks} precision layout browser checks passed. ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  console.error('Status:', await page.locator('#status').textContent(), 'Errors:', errors, 'Artifacts:', output); throw error;
} finally { await browser.close(); server.kill(); }
