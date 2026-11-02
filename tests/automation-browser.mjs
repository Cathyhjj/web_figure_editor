// Owns an ephemeral localhost server, isolated Chrome contexts and synthetic files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addSlide, createDeck, validateDeck, serializeDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'figure-mcp-test-'));
const python = process.env.PYTHON || 'python3';
const server = spawn(python, ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()'], { cwd: resolve('.') });
let serverErrors = ''; server.stderr.on('data', chunk => { serverErrors = (serverErrors + chunk).slice(-10000); });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Test server did not start: ' + serverErrors)), 10000);
  createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
});
const mcp = spawn(python, ['figure_mcp.py', '--port', String(port), '--output-dir', output]);
const pending = new Map(); let sequence = 0, stderr = '';
mcp.stderr.on('data', chunk => { stderr += chunk; });
createInterface({ input: mcp.stdout }).on('line', line => {
  const response = JSON.parse(line), slot = pending.get(response.id);
  if (slot) { clearTimeout(slot.timer); pending.delete(response.id); slot.resolve(response); }
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, timer: setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out: ' + method)); }, 60000) });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}, errorPattern) {
  const reply = await rpc('tools/call', { name: 'figure_' + name, arguments: args });
  assert.ok(!reply.error, JSON.stringify(reply));
  if (errorPattern) { assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, errorPattern); return reply.result; }
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
  return reply.result;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sessions(count) {
  for (let n = 0; n < 100; n++) {
    const result = (await call('sessions')).structuredContent.sessions;
    if (result.length === count) return result;
    await pause(100);
  }
  throw new Error('Expected ' + count + ' connected sessions.');
}
function fixture(name = 'MCP synthetic') {
  const deck = createDeck(); deck.name = name;
  deck.slides[0].items = ['a', 'b', 'c'].map((id, index) => ({ id, type: 'text', name: 'Panel ' + id, text: '(' + id + ') Synthetic data', x: 40 + index * 230, y: 30 + index * 50, width: 180, height: 55, fontSize: 20 }));
  return validateDeck(deck);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log('PASS', name); };
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('figure-editor-autosave', 'off');
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')];
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  return { page, context };
}
async function checkImagePixels(page, preview, filename, samples) {
  const data = preview.content.find(block => block.type === 'image').data;
  await writeFile(join(output, filename), Buffer.from(data, 'base64'));
  const colors = await page.evaluate(async ({ data, samples }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return samples.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)));
  }, { data, samples });
  assert.deepEqual(colors, samples.map(([, , color]) => Array.from(Buffer.from(color.slice(1), 'hex'))), filename);
}
async function checkPreviewPixels(page, sessionId, state, filename, samples) {
  const preview = await call('preview', { sessionId, slideId: state.slide.id, maxSize: 1600 });
  assert.equal(preview.structuredContent.renderedRevision, state.revision);
  assert.equal(preview.structuredContent.width, state.slide.canvas.width);
  await checkImagePixels(page, preview, filename, samples);
}
async function checkPanelPlacement(page, sessionId) {
  const folder = await mkdtemp(join(output, 'svg-sources-'));
  const panels = [
    { label: 'a', file: 'third.svg', color: '#a02828', x: 60, y: 50 },
    { label: 'b', file: 'first.svg', color: '#187038', x: 320, y: 50 },
    { label: 'c', file: 'fourth.svg', color: '#3040c0', x: 60, y: 210 },
    { label: 'd', file: 'second.svg', color: '#cc8822', x: 320, y: 210 },
  ];
  for (const { file, color } of panels) {
    await writeFile(join(folder, file), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="${color}"/></svg>`);
  }
  await page.locator('#folder-input').setInputFiles(folder);
  await page.waitForFunction(() => document.querySelectorAll('#asset-list .asset-card').length === 4
    && document.querySelector('#assets-panel').getAttribute('aria-busy') === 'false');
  const library = (await call('get_state', { sessionId })).structuredContent;
  const slideId = library.activeSlideId;
  assert.equal(library.slide.items.length, 0);
  const assets = new Map(library.assets.map(asset => [asset.name, asset.id]));
  const operations = panels.flatMap(({ file, label, x, y }) => [
    { op: 'place_asset', slideId, assetId: assets.get(file), properties: { x, y, width: 200 } },
    { op: 'add_text', slideId, properties: { x: x + 8, y: y + 4, width: 30, height: 30, text: label } },
  ]);
  const edited = (await call('batch_edit', { sessionId, expectedRevision: library.revision, operations })).structuredContent;
  assert.equal(edited.history.undo, library.history.undo + 1);
  assert.deepEqual(edited.assets, library.assets.map(asset => ({ ...asset, usedBy: [
    { slideId, slideName: edited.slide.name, itemId: edited.slide.items.find(item => item.assetId === asset.id).id, hidden: false },
  ] })));
  assert.deepEqual(edited.createdItemIds, edited.slide.items.map(item => item.id));
  assert.equal(edited.slide.items.length, 8);
  for (const [index, { file, label, x, y }] of panels.entries()) {
    const [image, text] = edited.slide.items.slice(index * 2, index * 2 + 2);
    assert.deepEqual([image.type, image.assetId, image.x, image.y, image.width, image.height],
      ['image', assets.get(file), x, y, 200, 100]);
    assert.deepEqual([text.type, text.text, text.x, text.y], ['text', label, x + 8, y + 4]);
  }
  await checkPreviewPixels(page, sessionId, edited, 'panels-preview.png',
    panels.map(({ x, y, color }) => [x + 100, y + 50, color]));
  const undone = (await call('history', { sessionId, expectedRevision: edited.revision, action: 'undo' })).structuredContent;
  assert.deepEqual(undone.slide.items, library.slide.items);
  assert.deepEqual(undone.assets, library.assets);
  const redone = (await call('history', { sessionId, expectedRevision: undone.revision, action: 'redo' })).structuredContent;
  assert.deepEqual(redone.slide.items, edited.slide.items);
  pass('place four imported SVG assets and a–d labels as one undoable batch with a color-verified 2×2 preview');
}
async function openTestProject(page, deck) {
  if (deck) await page.evaluate(async contents => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close();
  }, serializeDeck(deck));
  await page.locator('#open-project').click();
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
}
async function readTestProject(page) {
  return page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile();
    return JSON.parse(await file.text());
  });
}
async function saveTestProject(page, sessionId, revision) {
  const result = (await call('save', { sessionId, expectedRevision: revision, destination: 'file' })).structuredContent;
  assert.equal(result.saved, true);
  return readTestProject(page);
}
async function checkPanelSwap(page, sessionId) {
  const state = async (slideId) => (await call('get_state', { sessionId, slideId })).structuredContent;
  const deck = createDeck(), main = deck.slides[0], supplement = addSlide(deck);
  deck.activeSlideId = main.id;
  await openTestProject(page, deck);
  const folder = await mkdtemp(join(output, 'swap-sources-'));
  const sources = {
    original: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#c03018"/></svg>',
    revised: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200" fill="#3050a0"/><rect width="100" height="20" fill="#189040"/></svg>',
  };
  for (const [directory, svg] of Object.entries(sources)) {
    await mkdir(join(folder, directory));
    await writeFile(join(folder, directory, 'panel.svg'), svg);
  }
  await page.locator('#folder-input').setInputFiles(folder);
  await page.waitForFunction(() => document.querySelectorAll('#asset-list .asset-card').length === 2
    && document.querySelector('#assets-panel').getAttribute('aria-busy') === 'false');
  const library = await state();
  const [original, revised] = Object.entries(sources).map(([directory, svg]) => {
    const asset = library.assets.find(asset => asset.relativePath?.split('/').slice(-2).join('/') === directory + '/panel.svg');
    assert.ok(asset, directory); assert.equal(asset.name, 'panel.svg');
    assert.equal(asset.fingerprint, createHash('sha256').update(svg).digest('hex'));
    assert.deepEqual(asset.usedBy, []);
    return asset;
  });
  // Start from a saved editable project containing a cropped, rotated panel and other uses of the same original.
  const fixture = await saveTestProject(page, sessionId, library.revision);
  const panel = { id: 'target', type: 'image', name: 'Panel A', assetId: original.id,
    x: 60, y: 50, width: 200, height: 100, rotation: 180 };
  fixture.slides[0].items = [
    { ...panel, crop: { x: 0, y: 0, width: 0.5, height: 1 } },
    { id: 'label', type: 'text', text: 'a', x: 25, y: 50, width: 20, height: 30 },
    { ...panel, id: 'sibling', x: 360, rotation: 0 },
  ];
  fixture.slides[1].items = [{ ...panel, id: 'hidden-copy', hidden: true }];
  await openTestProject(page, fixture);
  const before = await state(), otherBefore = await state(supplement.id);
  const use = (slide, itemId, hidden = false) => ({ slideId: slide.id, slideName: slide.name, itemId, hidden });
  const targetUse = use(main, 'target'), siblingUse = use(main, 'sibling'), hiddenUse = use(supplement, 'hidden-copy', true);
  const usage = (info, asset) => info.assets.find(entry => entry.id === asset.id).usedBy.slice()
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  assert.deepEqual(usage(before, original), [hiddenUse, siblingUse, targetUse]);
  assert.deepEqual(usage(before, revised), []);
  const oldSamples = [[70, 100, '#c03018'], [160, 100, '#c03018'], [250, 100, '#c03018'], [400, 100, '#c03018']];
  await checkPreviewPixels(page, sessionId, before, 'swap-before.png', oldSamples);

  const swap = { op: 'swap_asset', slideId: main.id, itemId: 'target', assetId: revised.id };
  const edit = (revision, operations, errorPattern) => call('batch_edit', { sessionId, expectedRevision: revision, operations }, errorPattern);
  await edit(library.revision, [swap], /revision changed/);
  await edit(before.revision, [swap, { ...swap, itemId: 'missing' }], /missing|does not exist/i);
  const failed = await state();
  assert.equal(failed.revision, before.revision); assert.deepEqual(failed.slide, before.slide);
  assert.deepEqual(failed.assets, before.assets); assert.deepEqual(failed.history, before.history);
  const after = (await edit(before.revision, [swap])).structuredContent;
  assert.deepEqual(after.changedItemIds, ['target']);
  assert.deepEqual(after.createdItemIds, []);
  assert.equal(after.history.undo, before.history.undo + 1);
  assert.deepEqual(after.slide.items.slice(1), before.slide.items.slice(1));
  assert.deepEqual((await state(supplement.id)).slide, otherBefore.slide);
  const target = after.slide.items[0];
  assert.deepEqual([target.id, target.assetId, target.x, target.y, target.width, target.height, target.rotation],
    ['target', revised.id, 60, 50, 200, 100, 180]);
  assert.deepEqual(usage(after, original), [hiddenUse, siblingUse]);
  assert.deepEqual(usage(after, revised), [targetUse]);
  // A 1:2 source in a 200×100 frame covers x=[135,185]. Its thin green top stripe appears at the bottom after rotation.
  const fitSamples = [[130, 100, '#ffffff'], [138, 100, '#3050a0'], [160, 54, '#3050a0'], [160, 145, '#189040'],
    [182, 100, '#3050a0'], [190, 100, '#ffffff'], [400, 100, '#c03018']];
  await checkPreviewPixels(page, sessionId, after, 'swap-after.png', fitSamples);
  const history = async (revision, action) => (await call('history', { sessionId, expectedRevision: revision, action })).structuredContent;
  const undone = await history(after.revision, 'undo');
  assert.deepEqual(undone.slide, before.slide); assert.deepEqual(undone.assets, before.assets);
  assert.deepEqual((await saveTestProject(page, sessionId, undone.revision)).slides, validateDeck(fixture).slides);
  const redone = await history(undone.revision, 'redo');
  assert.deepEqual(redone.slide, after.slide); assert.deepEqual(redone.assets, after.assets);
  const saved = await saveTestProject(page, sessionId, redone.revision);
  assert.deepEqual(saved.assets, fixture.assets);
  assert.equal(saved.slides[0].items[0].crop, undefined);
  await openTestProject(page);
  const reopened = await state();
  assert.deepEqual(reopened.slide, after.slide); assert.deepEqual(reopened.assets, after.assets);
  await checkPreviewPixels(page, sessionId, reopened, 'swap-reopened.png', fitSamples);
  pass('swap a single shared SVG by source path, preserve its frame, clear old crop, preview contain, undo/redo and save/reopen');
}
async function designFixture(page) {
  const deck = createDeck(), source = deck.slides[0], active = addSlide(deck);
  source.name = 'Source design';
  source.guides = [{ id: 'margin', axis: 'x', position: 30 }, { id: 'baseline', axis: 'y', position: 40 }];
  const pngs = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const context = canvas.getContext('2d');
    return ['#a03020', '#2850b0', '#187050', '#8a549b'].map(color => {
      context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    });
  });
  deck.assets = ['original', 'revised', 'third', 'fourth'].map((id, index) => ({
    id, name: id + '.png', mime: 'image/png', width: 200, height: 100, dataUrl: pngs[index],
  }));
  deck.assets.push({ id: 'chart', name: 'pending.html', mime: 'text/html', width: 200, height: 100,
    dataUrl: 'data:text/html;base64,' + Buffer.from('<!doctype html><html><body>Plot</body></html>').toString('base64'),
    posterDataUrl: pngs[0], posterWidth: 200, posterHeight: 100, hasSnapshot: false });
  source.items = [
    { id: 'panel', type: 'image', name: 'Panel', assetId: 'original', x: 30, y: 40, width: 100, height: 50 },
    { id: 'outside', type: 'text', text: 'Clipped', x: 950, y: 10, width: 50, height: 30 },
  ];
  active.items = [
    { id: 'anchor', type: 'rect', name: 'Selection anchor', fill: '#111111', locked: true, x: 30, y: 40, width: 100, height: 50 },
    { id: 'pending', type: 'html', assetId: 'chart', x: 200, y: 40, width: 100, height: 50 },
  ];
  await openTestProject(page, deck);
  await page.locator('#stage [data-item="anchor"]').click();
  return { source, active };
}
async function checkPrintSize(sessionId, source, active, revision) {
  const check = async (params) => (await call('check_export', { sessionId, ...params })).structuredContent;
  const options = { format: 'png', slideId: source.id, minRasterDpi: 250 };
  const wide = await check({ ...options, finalWidthMm: 254 });
  assert.equal(wide.revision, revision); assert.equal(wide.slides.length, 1);
  const low = wide.findings.find(finding => finding.code === 'low_raster_dpi' && finding.itemId === 'panel');
  assert.equal(low.slideId, source.id);
  for (const field of ['dpiX', 'dpiY', 'effectiveDpi']) assert.ok(Math.abs(low[field] - 192) < 1e-8, field);
  assert.ok(wide.findings.some(f => f.code === 'outside_canvas' && f.itemId === 'outside' && f.slideId === source.id));
  const narrow = await check({ ...options, finalWidthMm: 127 });
  assert.ok(!narrow.findings.some(f => f.code === 'low_raster_dpi'));
  const raster = narrow.slides[0].rasters.find(item => item.itemId === 'panel');
  assert.ok(Math.abs(raster.effectiveDpi - 384) < 1e-8);
  const both = await check({ format: 'pptx' });
  assert.equal(both.slides.length, 2);
  assert.ok(both.findings.some(f => f.code === 'missing_html_snapshot' && f.itemId === 'pending' && f.slideId === active.id));
  pass('export check measures raster DPI at two print widths, flags a clipped object and finds an unsaved chart snapshot on another slide');
}
async function checkProposedLayouts(page, sessionId, source, before) {
  const state = async (slideId) => (await call('get_state', { sessionId, slideId })).structuredContent;
  const fileBefore = await readTestProject(page);
  const sourceBefore = await state(source.id);
  const options = { sessionId, expectedRevision: before.revision, slideId: source.id, maxSize: 1600 };
  const layout = (width, positions) => [
    { op: 'set', slideId: source.id, itemIds: ['outside'], properties: { x: 52, y: 30, width: 450, text: 'Four-panel layout', fontSize: 28 } },
    ...['original', 'revised', 'third', 'fourth'].flatMap((assetId, index) => {
      const [x, y] = positions[index], properties = { x, y, width };
      const panel = index === 0 ? { op: 'set', itemIds: ['panel'] } : { op: 'place_asset', assetId };
      return [{ ...panel, slideId: source.id, properties },
        { op: 'add_text', slideId: source.id, properties: { x, y: y - 32, text: 'abcd'[index], width: 30, height: 28, fontSize: 21, fontWeight: 700 } }];
    }),
  ];
  const grid = layout(340, [[92, 118], [528, 118], [92, 393], [528, 393]]);
  const row = layout(200, [[32, 270], [264, 270], [496, 270], [728, 270]]);
  const gridSamples = [[200, 180, '#a03020'], [600, 180, '#2850b0'], [200, 450, '#187050'], [600, 450, '#8a549b']];
  const rowSamples = [[130, 320, '#a03020'], [360, 320, '#2850b0'], [590, 320, '#187050'], [820, 320, '#8a549b']];
  const gridPreview = await call('preview_batch', { ...options, operations: grid });
  const rowPreview = await call('preview_batch', { ...options, operations: row });
  for (const { structuredContent: info } of [gridPreview, rowPreview]) {
    assert.equal(info.proposed, true); assert.equal(info.baseRevision, before.revision);
    assert.equal(info.currentRevision, before.revision);
    assert.equal(info.createdItemIds, undefined); assert.equal(info.changedItemIds, undefined);
  }
  await checkImagePixels(page, gridPreview, 'proposed-grid.png', gridSamples);
  await checkImagePixels(page, rowPreview, 'proposed-row.png', rowSamples);
  await call('preview_batch', { ...options, expectedRevision: 'outdated', operations: grid }, /revision changed/i);
  await call('preview_batch', { ...options, operations: [...row, { ...row[0], itemIds: ['missing'] }] }, /missing|does not exist/i);
  assert.deepEqual(await state(), before);
  assert.deepEqual(await state(source.id), sourceBefore);
  assert.deepEqual(await readTestProject(page), fileBefore);
  const applied = (await call('batch_edit', { sessionId, expectedRevision: before.revision, operations: grid })).structuredContent;
  assert.equal(applied.history.undo, before.history.undo + 1); assert.equal(applied.createdItemIds.length, 7);
  await checkPreviewPixels(page, sessionId, await state(source.id), 'applied-grid.png', gridSamples);
  assert.deepEqual(await readFile(join(output, 'applied-grid.png')), await readFile(join(output, 'proposed-grid.png')));
  const undone = (await call('history', { sessionId, expectedRevision: applied.revision, action: 'undo' })).structuredContent;
  assert.deepEqual((await state(source.id)).slide, sourceBefore.slide);
  pass('two preview batches produce different PNGs without changing file, selection, history or revision; applying one matches its preview');
  return undone;
}
async function checkSlideCopy(page, sessionId, source, before) {
  const getSource = async () => (await call('get_state', { sessionId, slideId: source.id })).structuredContent.slide;
  const original = await getSource();
  assert.notEqual(before.activeSlideId, source.id);
  const request = { sessionId, slideId: source.id, expectedRevision: before.revision, name: 'Publication variant' };
  await call('duplicate_slide', { ...request, expectedRevision: 'outdated' }, /revision changed/i);
  const copy = (await call('duplicate_slide', request)).structuredContent;
  assert.equal(copy.sourceSlideId, source.id); assert.notEqual(copy.newSlideId, source.id);
  assert.equal(copy.activeSlideId, copy.newSlideId); assert.equal(copy.slide.id, copy.newSlideId);
  assert.equal(copy.slide.name, request.name); assert.deepEqual(copy.selectedSlideIds, [copy.newSlideId]);
  assert.equal(copy.history.undo, before.history.undo + 1);
  assert.deepEqual(copy.slides.map(slide => slide.id), [source.id, copy.newSlideId, before.activeSlideId]);
  assert.deepEqual(Object.keys(copy.itemIdMap).sort(), original.items.map(item => item.id).sort());
  assert.equal(new Set(Object.values(copy.itemIdMap)).size, original.items.length);
  for (const item of original.items) {
    const id = copy.itemIdMap[item.id];
    assert.ok(!original.items.some(other => other.id === id));
    assert.deepEqual(copy.slide.items.find(copied => copied.id === id), { ...item, id });
  }
  const links = info => info.assets.find(asset => asset.id === 'original').usedBy.map(use => [use.slideId, use.itemId]);
  assert.deepEqual(links(copy), [[source.id, 'panel'], [copy.newSlideId, copy.itemIdMap.panel]]);
  const saved = await saveTestProject(page, sessionId, copy.revision);
  const guides = saved.slides.find(slide => slide.id === copy.newSlideId).guides;
  assert.deepEqual(guides.map(({ axis, position }) => [axis, position]), source.guides.map(({ axis, position }) => [axis, position]));
  assert.ok(guides.every(guide => !source.guides.some(originalGuide => originalGuide.id === guide.id)));
  const swap = { op: 'swap_asset', slideId: copy.newSlideId, itemId: copy.itemIdMap.panel, assetId: 'revised' };
  const replaced = (await call('batch_edit', { sessionId, expectedRevision: copy.revision, operations: [swap] })).structuredContent;
  assert.equal(replaced.slide.items.find(item => item.id === swap.itemId).assetId, 'revised');
  assert.deepEqual(links(replaced), [[source.id, 'panel']]);
  assert.deepEqual(await getSource(), original);
  await checkPreviewPixels(page, sessionId, replaced, 'variant-swapped.png', [[80, 65, '#2850b0']]);
  const undo = async revision => (await call('history', { sessionId, expectedRevision: revision, action: 'undo' })).structuredContent;
  const restoredCopy = await undo(replaced.revision);
  assert.deepEqual(restoredCopy.slide, copy.slide);
  const removed = await undo(restoredCopy.revision);
  assert.deepEqual(removed.slides, before.slides); assert.deepEqual(removed.assets, before.assets);
  assert.equal(removed.activeSlideId, before.activeSlideId);
  pass('duplicate an inactive slide with new object and guide IDs, swap only its copy, then undo swap and duplication independently');
}
try {
  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } })).result.serverInfo.name, 'figure-editor');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list')).result.tools.length, 10);
  const { page } = await newPage();
  const sessionId = (await sessions(1))[0].sessionId;
  const deck = fixture();
  await page.locator('#project-input').setInputFiles({ name: 'synthetic.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(deck)) });
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  const state = async () => (await call('get_state', { sessionId })).structuredContent;
  const initial = await state(), slideId = initial.activeSlideId;
  assert.equal(initial.project.name, deck.name); assert.equal(initial.slide.items.length, 3);
  pass('stdio MCP reads the live page and object IDs');
  const operations = [{ op: 'set', slideId, itemIds: ['a', 'b', 'c'], properties: { width: 200, fontSize: 18 } },
    { op: 'align', slideId, itemIds: ['a', 'b', 'c'], alignment: 'top' },
    { op: 'distribute', slideId, itemIds: ['a', 'b', 'c'], axis: 'x', gap: 16 }];
  const edited = (await call('batch_edit', { sessionId, expectedRevision: initial.revision, operations })).structuredContent;
  assert.deepEqual(edited.slide.items.map(i => [i.x, i.y, i.width]), [[40, 30, 200], [256, 30, 200], [472, 30, 200]]);
  assert.equal(edited.history.undo, 1);
  assert.equal(await page.locator('#stage [data-item="b"]').getAttribute('transform'), 'translate(256 30) rotate(0 100 27.5)');
  await call('batch_edit', { sessionId, expectedRevision: initial.revision, operations }, /revision changed/);
  const invalid = [...operations, { op: 'set', slideId, itemIds: ['missing'], properties: { x: 5 } }];
  await call('batch_edit', { sessionId, expectedRevision: edited.revision, operations: invalid }, /does not exist/);
  assert.deepEqual((await state()).slide.items, edited.slide.items);
  pass('batch applies exact geometry; stale and invalid batches leave state intact');
  const undone = (await call('history', { sessionId, expectedRevision: edited.revision, action: 'undo' })).structuredContent;
  assert.deepEqual(undone.slide.items, initial.slide.items);
  const redone = (await call('history', { sessionId, expectedRevision: undone.revision, action: 'redo' })).structuredContent;
  assert.deepEqual(redone.slide.items, edited.slide.items);
  pass('one Undo/Redo restores the entire batch');
  await page.locator('#export-open').click();
  await call('batch_edit', { sessionId, expectedRevision: redone.revision, operations }, /Close the open dialog/);
  await page.locator('#export-cancel').click();
  pass('an open modal prevents conflicting edits');
  const preview = await call('preview', { sessionId, maxSize: 800 });
  const png = Buffer.from(preview.content.find(block => block.type === 'image').data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(preview.structuredContent.width <= 800);
  await writeFile(join(output, 'preview.png'), png);
  await page.screenshot({ path: join(output, 'editor.png') });
  for (const format of ['png', 'svg', 'pdf', 'pptx', 'html']) {
    const exported = (await call('export', { sessionId, format, dpi: 150 })).structuredContent;
    assert.equal((await readFile(exported.path)).length, exported.bytes);
    assert.equal(exported.renderedRevision, redone.revision);
  }
  pass('preview and all five existing export formats produce actual files');
  await call('save', { sessionId, expectedRevision: redone.revision, destination: 'file' }, /No project file is authorized/);
  const savedDraft = (await call('save', { sessionId, expectedRevision: redone.revision, destination: 'draft' })).structuredContent;
  assert.equal(savedDraft.destination, 'draft'); assert.equal(savedDraft.state.save.draftCurrent, true); assert.equal(savedDraft.state.save.savedToFile, false);
  pass('draft save is explicit; unauthorized file save does not open a picker');
  await page.evaluate(async contents => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close();
  }, serializeDeck(fixture('Authorized file')));
  await page.locator('#open-project').click(); await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  let current = await state();
  await call('batch_edit', { sessionId, expectedRevision: redone.revision, operations }, /revision changed/);
  const setX = (s, x) => ({ sessionId, expectedRevision: s.revision, operations: [{ op: 'set', slideId: s.activeSlideId, itemIds: ['a'], properties: { x } }] });
  current = (await call('batch_edit', setX(current, 123))).structuredContent;
  const savedFile = (await call('save', { sessionId, expectedRevision: current.revision, destination: 'file' })).structuredContent;
  assert.equal(savedFile.saved, true); assert.equal(savedFile.state.save.savedToFile, true); assert.equal(savedFile.state.save.autoSave, false);
  assert.equal(await page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).slides[0].items[0].x), 123);
  await page.locator('#autosave-toggle').check();
  current = (await call('batch_edit', setX(await state(), 234))).structuredContent;
  await page.waitForFunction(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).slides[0].items[0].x === 234);
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  pass('project epochs prevent stale edits; explicit save and AutoSave persist MCP edits');
  await page.locator('#autosave-toggle').uncheck();
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json');
    const document = JSON.parse(await (await handle.getFile()).text()); document.name = 'External update';
    const writer = await handle.createWritable(); await writer.write(JSON.stringify(document)); await writer.close();
  });
  current = (await call('batch_edit', setX(await state(), 345))).structuredContent;
  await call('save', { sessionId, expectedRevision: current.revision, destination: 'file' }, /changed outside/);
  assert.equal((await state()).slide.items[0].x, 345);
  assert.equal(await page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).name), 'External update');
  pass('external file conflicts preserve both external bytes and live edits');
  const second = await newPage();
  const secondId = (await sessions(2)).find(s => s.sessionId !== sessionId).sessionId;
  assert.equal((await call('get_state', { sessionId: secondId })).structuredContent.slide.items.length, 0);
  await call('batch_edit', setX(await state(), 456));
  assert.equal((await call('get_state', { sessionId: secondId })).structuredContent.slide.items.length, 0);
  await checkPanelPlacement(second.page, secondId);
  await checkPanelSwap(second.page, secondId);
  const { source, active } = await designFixture(second.page);
  const designState = (await call('get_state', { sessionId: secondId })).structuredContent;
  assert.deepEqual(designState.selectedItemIds, ['anchor']);
  const settled = (await call('save', { sessionId: secondId, expectedRevision: designState.revision, destination: 'draft' })).structuredContent.state;
  await checkPrintSize(secondId, source, active, settled.revision);
  const baseline = await checkProposedLayouts(second.page, secondId, source, settled);
  await checkSlideCopy(second.page, secondId, source, baseline);
  await second.page.locator('#ai-control-toggle').click();
  await sessions(1);
  await call('get_state', { sessionId: secondId }, /disconnected|expired/);
  await second.page.locator('#ai-control-toggle').click();
  assert.notEqual((await sessions(2)).find(s => s.sessionId !== sessionId).sessionId, secondId);
  pass('multiple pages are isolated; pause/reconnect invalidates old sessions');
  assert.deepEqual(errors, []); assert.equal(stderr, '');
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  console.error('Server diagnostics:', serverErrors); throw error;
} finally {
  await browser.close(); mcp.stdin.end(); mcp.kill(); server.kill();
  for (const slot of pending.values()) clearTimeout(slot.timer);
}
