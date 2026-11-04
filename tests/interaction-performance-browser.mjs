// Isolated synthetic interaction benchmark; never uses the user's editing origin/files.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/interaction-performance-browser.mjs
// PERFORMANCE_APP_SNAPSHOT=/tmp/before-app.js runs the same workload against an earlier app.js.
// PERFORMANCE_ASSERT_REUSE=1 additionally checks that unrelated rendered content survives edits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, serializeDeck, validateDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const objectsPerSlide = Number(process.env.PERFORMANCE_OBJECTS_PER_SLIDE || 40);
assert.ok(Number.isInteger(objectsPerSlide) && objectsPerSlide >= 12 && objectsPerSlide <= 300);
const output = await mkdtemp(join(tmpdir(), 'figure-interaction-performance-'));
const server = spawn('python3', ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let stderr = ''; server.stderr.on('data', data => { stderr += data; });
let browser;
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
function fixture() {
  const columns = objectsPerSlide === 40 ? 8 : Math.ceil(Math.sqrt(objectsPerSlide * 1.6));
  const stepX = objectsPerSlide === 40 ? 145 : 1150 / columns;
  const stepY = objectsPerSlide === 40 ? 135 : 700 / Math.ceil(objectsPerSlide / columns);
  const deck = createDeck(); deck.name = 'Interaction performance synthetic';
  deck.assets = Array.from({ length: 20 }, (_, index) => ({ id: `asset-${index}`, name: `Figure ${index + 1}.png`, mime: 'image/png', width: 1, height: 1, dataUrl: `data:image/png;base64,${pixel}` }));
  deck.slides = Array.from({ length: 30 }, (_, page) => ({
    id: `slide-${page}`, name: `Slide ${page + 1}`, canvas: { width: 1200, height: 750, background: '#ffffff' },
    items: Array.from({ length: objectsPerSlide }, (_, index) => ({
      id: `item-${page}-${index}`, name: `Object ${index + 1}`, type: index % 3 === 0 ? 'image' : index % 3 === 1 ? 'rect' : 'text',
      x: 25 + (index % columns) * stepX, y: 25 + Math.floor(index / columns) * stepY, width: objectsPerSlide === 40 ? 110 : stepX - 10, height: objectsPerSlide === 40 ? 85 : stepY - 10,
      ...(index % 3 === 0 ? { assetId: `asset-${index % 20}` } : index % 3 === 1 ? { fill: '#dcebf4', stroke: '#305c75', strokeWidth: 2 } : { text: `Figure ${page + 1}\nLabel ${index + 1}`, fontSize: objectsPerSlide === 40 ? 18 : 12 }),
    })),
  }));
  deck.activeSlideId = deck.slides[0].id;
  return validateDeck(deck);
}
const original = fixture();
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Server startup timed out')), 10000);
    createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  if (process.env.PERFORMANCE_APP_SNAPSHOT) {
    const snapshot = await readFile(process.env.PERFORMANCE_APP_SNAPSHOT, 'utf8');
    await page.route('**/app.js*', route => route.fulfill({ contentType: 'text/javascript', body: snapshot }));
  }
  await page.addInitScript(() => {
    localStorage.setItem('figure-editor-autosave', 'off');
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('performance.figure.json', { create: true });
  });
  const idle = () => page.waitForFunction(() => !document.querySelector('#save-project-as').disabled);
  const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tag = label => page.evaluate(label => { window.performancePhase = label; }, label);
  const item = id => page.locator(`#stage > [data-item="${id}"]`);
  const center = async id => { const box = await item(id).boundingBox(); assert.ok(box); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const clickItem = async id => { const point = await center(id); await page.mouse.click(point.x, point.y); await painted(); };
  async function save() {
    await page.locator('#save-project-as').click(); await idle();
    return page.evaluate(async () => JSON.parse(await (await (await navigator.storage.getDirectory()).getFileHandle('performance.figure.json')).getFile().then(file => file.text())));
  }
  await page.goto(`http://127.0.0.1:${port}/`); await idle();
  await page.locator('#project-input').setInputFiles({ name: 'synthetic.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(original)) });
  await idle(); await painted();
  // Allow initial recovery-draft persistence to finish before timing interactions.
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.performanceSamples = [];
    window.performancePhase = 'warmup';
    const wrap = (element, property, eventName) => {
      const handler = element[property];
      element[property] = function(event) {
        if (eventName === 'pointermove' && !event.buttons) return handler.call(this, event);
        const phase = window.performancePhase, start = performance.now();
        const value = handler.call(this, event);
        const sample = { phase, event: eventName, synchronousMs: performance.now() - start };
        window.performanceSamples.push(sample);
        requestAnimationFrame(() => requestAnimationFrame(() => { sample.nextPaintOpportunityMs = performance.now() - start; }));
        return value;
      };
    };
    const workspace = document.querySelector('#workspace');
    for (const name of ['pointerdown', 'pointermove', 'pointerup']) wrap(workspace, `on${name}`, name);
    for (const id of ['zoom-in', 'zoom-out']) wrap(document.getElementById(id), 'onclick', 'zoom');
    window.wrapPerformanceText = () => wrap(document.querySelector('#canvas-text-editor'), 'oninput', 'text');
    window.capturePerformanceNodes = () => { window.retainedPerformanceNodes = {
      stage: document.querySelector('#stage > [data-item="item-0-10"]'),
      content: document.querySelector('#stage > [data-item="item-0-10"]').firstElementChild,
      thumbnail: document.querySelector('[data-slide="slide-29"] .slide-preview'),
      asset: document.querySelector('[data-asset="asset-19"]'),
    }; };
    window.capturePerformanceNodes();
  });
  const captureNodes = () => page.evaluate(() => window.capturePerformanceNodes());
  const retainedNodes = () => page.evaluate(() => Object.fromEntries(Object.entries(window.retainedPerformanceNodes).map(([key, node]) => [key, node.isConnected])));
  const reuse = {};
  await clickItem('item-0-1');
  await captureNodes();
  await tag('selection');
  for (let i = 0; i < 10; i++) await clickItem(`item-0-${i % 2 ? 1 : 4}`);
  reuse.selection = await retainedNodes();
  await captureNodes();
  await tag('drag');
  const start = await center('item-0-1');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(start.x + i * 3, start.y + i * 2); await painted(); }
  await page.mouse.up(); await painted();
  reuse.drag = await retainedNodes();
  const moved = await save();
  const movedObject = moved.slides[0].items.find(value => value.id === 'item-0-1');
  assert.ok(movedObject.x > original.slides[0].items[1].x && movedObject.y > original.slides[0].items[1].y, 'drag changed saved geometry');
  await page.locator('#undo').click();
  const undone = await save(); assert.deepEqual(undone.slides[0].items, original.slides[0].items, 'one Undo restores the whole drag');
  await page.locator('#redo').click();
  assert.deepEqual((await save()).slides[0].items, moved.slides[0].items, 'one Redo restores the whole drag');
  await captureNodes();
  await tag('zoom');
  for (let i = 0; i < 10; i++) { await page.locator(i % 2 ? '#zoom-out' : '#zoom-in').click(); await painted(); }
  reuse.zoom = await retainedNodes();
  await tag('text-entry');
  await clickItem('item-0-2');
  if (!await page.locator('#canvas-text-editor').count()) await item('item-0-2').dblclick();
  await page.waitForSelector('#canvas-text-editor'); await page.evaluate(() => window.wrapPerformanceText());
  await captureNodes();
  await tag('typing');
  for (const character of ' performance') { await page.keyboard.type(character); await painted(); }
  reuse.typing = await retainedNodes();
  const typed = await page.locator('#canvas-text-editor').inputValue();
  assert.ok(typed.includes('performance'));
  await page.keyboard.press('Escape'); await painted();
  assert.equal((await save()).slides[0].items.find(value => value.id === 'item-0-2').text, typed, 'typed content survives saving');
  await page.locator('#undo').click();
  assert.equal((await save()).slides[0].items.find(value => value.id === 'item-0-2').text, original.slides[0].items[2].text, 'one Undo restores a text-edit session');
  await painted();
  const samples = await page.evaluate(() => window.performanceSamples);
  if (process.env.PERFORMANCE_ASSERT_REUSE === '1') {
    for (const [phase, nodes] of Object.entries(reuse)) {
      for (const [kind, retained] of Object.entries(nodes)) assert.ok(retained, `${phase}: unmodified ${kind} must remain connected`);
    }
  }
  const percentile = (values, p) => values.slice().sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  const summary = {};
  for (const [phase, event] of [['selection','pointerdown'],['selection','pointerup'],['drag','pointermove'],['drag','pointerup'],['zoom','zoom'],['typing','text']]) {
    const matching = samples.filter(value => value.phase === phase && value.event === event);
    summary[`${phase}:${event}`] = { samples: matching.length,
      synchronousMedianMs: percentile(matching.map(value => value.synchronousMs), .5),
      synchronousP95Ms: percentile(matching.map(value => value.synchronousMs), .95),
      nextPaintOpportunityMedianMs: percentile(matching.map(value => value.nextPaintOpportunityMs).filter(Number.isFinite), .5),
    };
  }
  assert.deepEqual(errors, [], 'no browser script errors');
  const result = { fixture: { slides: 30, objectsPerSlide, assets: 20 }, browser: await browser.version(), baselineApp: process.env.PERFORMANCE_APP_SNAPSHOT || null, summary, reuse, samples };
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined, output }, null, 2));
  console.log('PASS drag save/Undo/Redo, text save/Undo and browser errors');
} finally { await browser?.close(); server.kill(); }
