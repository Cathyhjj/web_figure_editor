// Run against a dedicated `python3 server.py --port 18766`, never the editing origin.
// Each case owns a fresh browser context and synthetic OPFS files only.
import assert from 'node:assert/strict';
import { createDeck, serializeDeck, validateDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const fixture = name => ({ ...createDeck(), name });
function pictureFixture(name = 'Image project', width = 1000, height = 10) {
  const deck = fixture(name);
  deck.assets = [{ id: 'source', name: 'original.png', mime: 'image/png', width: 1, height: 1, dataUrl: `data:image/png;base64,${pixel}` }];
  deck.slides[0].items = [{ id: 'picture', type: 'image', assetId: 'source', x: 20, y: 30, width, height }];
  return validateDeck(deck);
}
const idle = page => page.waitForFunction(() => !document.getElementById('open-project').disabled);
async function readDraft(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('figure-editor-drafts', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const store = db.transaction('drafts').objectStore('drafts');
      return await Promise.all(['current', 'current-file'].map(key => new Promise((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); })));
    } finally { db.close(); }
  });
}
async function untilDraft(page, predicate) {
  for (let n = 0; n < 100; n++) { const records = await readDraft(page); if (predicate(...records)) return records; await page.waitForTimeout(40); }
  throw new Error('Expected draft state was not persisted.');
}
async function writeFile(page, deck, name = 'original.figure.json') {
  await page.evaluate(async ({ contents, name }) => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close();
  }, { contents: serializeDeck(deck), name });
}
async function readFile(page, name = 'original.figure.json') {
  return page.evaluate(async name => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).text()), name);
}
async function open(page, deck) {
  await writeFile(page, deck); await page.locator('#open-project').click(); await idle(page);
  await untilDraft(page, project => project?.name === deck.name);
}
async function upload(page, deck) {
  await page.locator('#project-input').setInputFiles({ name: 'copy.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(deck)) });
  await idle(page); await untilDraft(page, project => project?.name === deck.name);
}
async function reload(page) { await page.reload(); await idle(page); }
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.addInitScript(() => {
    if (localStorage.getItem('figure-editor-autosave') === null) localStorage.setItem('figure-editor-autosave', 'off');
    window.saveTargetName = 'copy.figure.json';
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')];
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle(window.saveTargetName, { create: true });
  });
  try {
    await page.goto('http://127.0.0.1:18766/'); await idle(page);
    await run(page); assert.deepEqual(errors, []);
    checks.push(name); console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, '\nStatus:', await page.locator('#status').textContent(), '\nPage errors:', errors);
    throw error;
  } finally { await context.close(); }
}
function externalCopy(deck) {
  const external = structuredClone(deck); external.name = 'External revision';
  external.slides[0].items.push({ id: 'external', type: 'text', text: 'External scientific correction', x: 10, y: 10, width: 300, height: 40 });
  return external;
}
async function linkImage(page) {
  await page.evaluate(pixel => {
    window.png = Uint8Array.from(atob(pixel), c => c.charCodeAt(0));
    window.imageFile = name => new File([window.png], name, { type: 'image/png' });
    window.imageHandle = { kind: 'file', name: 'linked.png', getFile: async () => window.imageFile('linked.png') };
    window.showOpenFilePicker = async () => [window.imageHandle];
  }, pixel);
  await page.evaluate(async () => { const card = document.querySelector('.asset-card'); await card.onclick({ target: card.querySelector('[data-action="relink"]') }); });
  await page.waitForFunction(() => document.querySelector('.asset-name').textContent === 'linked.png');
}
async function startAssetAction(page, action) {
  await page.evaluate(action => {
    const card = document.querySelector('.asset-card');
    (window.pendingActions ??= []).push(card.onclick({ target: card.querySelector(`[data-action="${action}"]`) }));
  }, action);
}
async function releaseAssetAction(page, index, name) {
  await page.evaluate(async ({ index, name }) => { window.readReleases[index](window.imageFile(name)); await window.pendingActions[index]; }, { index, name });
}
try {
  await scenario('clean draft reload reads the latest external file before AutoSave', async page => {
    const original = fixture('Original'); await open(page, original); await writeFile(page, externalCopy(original));
    await reload(page);
    assert.equal(await page.locator('#project-name').inputValue(), 'External revision');
    assert.equal(await page.locator('.layer-row').count(), 1);
    await page.locator('#autosave-toggle').check(); await page.locator('#project-name').fill('Small title edit');
    await page.waitForFunction(() => document.getElementById('autosave-status').dataset.state === 'saved');
    assert.equal((await readFile(page)).slides[0].items.length, 1);
  });
  await scenario('dirty draft conflict survives reload, manual Save and toggles; Save As preserves both versions', async page => {
    const original = fixture('Original'); await open(page, original);
    await page.locator('#project-name').fill('Unsaved local edit'); await untilDraft(page, p => p?.name === 'Unsaved local edit');
    await writeFile(page, externalCopy(original)); await reload(page);
    assert.equal(await page.locator('#project-name').inputValue(), 'Unsaved local edit');
    assert.equal(await page.locator('#autosave-status').getAttribute('data-state'), 'conflict');
    await page.locator('#save-project').click(); await idle(page);
    assert.equal((await readFile(page)).name, 'External revision');
    await page.locator('#autosave-toggle').check();
    assert.equal(await page.locator('#autosave-status').getAttribute('data-state'), 'conflict');
    await page.locator('#save-project-as').click(); await idle(page);
    assert.equal((await readFile(page, 'copy.figure.json')).name, 'Unsaved local edit');
    assert.equal((await readFile(page)).slides[0].items.length, 1);
    await page.locator('#project-name').fill('Autosave after recovery');
    await page.waitForFunction(() => document.getElementById('autosave-status').dataset.state === 'saved');
    assert.equal((await readFile(page, 'copy.figure.json')).name, 'Autosave after recovery');
    assert.equal((await readFile(page)).name, 'External revision');
  });
  await scenario('AutoSave detects external changes made while the editor stays open', async page => {
    const original = fixture('Original'); await open(page, original); await writeFile(page, externalCopy(original));
    await page.locator('#autosave-toggle').check(); await page.locator('#project-name').fill('Local edit');
    await page.waitForFunction(() => document.getElementById('autosave-status').dataset.state === 'conflict');
    assert.equal((await readFile(page)).name, 'External revision');
    assert.equal((await untilDraft(page, p => p?.name === 'Local edit'))[0].name, 'Local edit');
  });
  await scenario('legacy dirty drafts without a file revision never acquire overwrite authority', async page => {
    const original = fixture('Original'); await open(page, original);
    await page.locator('#project-name').fill('Legacy draft'); await untilDraft(page, p => p?.name === 'Legacy draft');
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('figure-editor-drafts', 1); r.onsuccess = () => resolve(r.result); });
      await new Promise((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts'); const r = store.get('current-file'); r.onsuccess = () => { const file = r.result; delete file.revision; store.put(file, 'current-file'); }; tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    });
    await reload(page); await page.locator('#save-project').click(); await idle(page);
    assert.equal(await page.locator('#project-name').inputValue(), 'Legacy draft');
    assert.equal(await page.locator('#autosave-status').getAttribute('data-state'), 'conflict');
    assert.equal((await readFile(page)).name, 'Original');
  });
  await scenario('old Refresh cannot overwrite a newly opened project with shared asset IDs', async page => {
    const a = pictureFixture('A'), b = structuredClone(a); b.name = 'B'; b.assets[0].name = 'B.png';
    await upload(page, a); await linkImage(page);
    await page.evaluate(() => { window.readReleases = []; window.imageHandle.getFile = () => new Promise(resolve => window.readReleases.push(resolve)); });
    await startAssetAction(page, 'refresh'); await page.waitForFunction(() => window.readReleases.length === 1);
    await upload(page, b); await releaseAssetAction(page, 0, 'stale-A.png');
    assert.equal(await page.locator('.asset-name').textContent(), 'B.png');
    assert.equal((await readDraft(page))[0].assets[0].name, 'B.png');
  });
  await scenario('overlapping Refresh operations retain the newest result when they finish out of order', async page => {
    await upload(page, pictureFixture()); await linkImage(page);
    await page.evaluate(() => { window.readReleases = []; window.imageHandle.getFile = () => new Promise(resolve => window.readReleases.push(resolve)); });
    await startAssetAction(page, 'refresh'); await startAssetAction(page, 'refresh');
    await page.waitForFunction(() => window.readReleases.length === 2);
    await releaseAssetAction(page, 1, 'newest.png'); await releaseAssetAction(page, 0, 'outdated.png');
    assert.equal(await page.locator('.asset-name').textContent(), 'newest.png');
    assert.equal((await untilDraft(page, p => p?.assets[0]?.name === 'newest.png'))[0].assets[0].name, 'newest.png');
  });
  await scenario('Undo cancels an outstanding asset Refresh without restoring the discarded source', async page => {
    await upload(page, pictureFixture()); await linkImage(page);
    await page.evaluate(() => { window.readReleases = []; window.imageHandle.getFile = () => new Promise(resolve => window.readReleases.push(resolve)); });
    await startAssetAction(page, 'refresh'); await page.waitForFunction(() => window.readReleases.length === 1);
    await page.locator('#undo').click(); await releaseAssetAction(page, 0, 'late.png');
    assert.equal(await page.locator('.asset-name').textContent(), 'original.png');
  });
  await scenario('old Link completion cannot modify a copied project', async page => {
    const a = pictureFixture('A'), b = structuredClone(a); b.name = 'B'; b.assets[0].name = 'B.png';
    await upload(page, a); await linkImage(page);
    await page.evaluate(() => { window.readReleases = []; window.imageHandle.getFile = () => new Promise(resolve => window.readReleases.push(resolve)); });
    await startAssetAction(page, 'relink'); await page.waitForFunction(() => window.readReleases.length === 1);
    await upload(page, b); await releaseAssetAction(page, 0, 'late-link.png');
    assert.equal(await page.locator('.asset-name').textContent(), 'B.png');
  });
  await scenario('fallback file input keeps the original Link target across project replacement', async page => {
    const a = pictureFixture('A'), b = structuredClone(a); b.name = 'B'; b.assets[0].name = 'B.png';
    await upload(page, a);
    await page.evaluate(() => { window.showOpenFilePicker = undefined; document.getElementById('relink-input').click = () => { window.fallbackRequested = true; }; });
    await startAssetAction(page, 'relink'); await page.waitForFunction(() => window.fallbackRequested);
    await upload(page, b);
    await page.locator('#relink-input').setInputFiles({ name: 'late-fallback.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') });
    assert.equal(await page.locator('.asset-name').textContent(), 'B.png');
  });
  for (const [width, height, dimension] of [[1000, 10, 'height'], [10, 1000, 'width']]) {
    await scenario(`proportional ${dimension} edits remain valid through draft, Save, Undo, Redo and reload`, async page => {
      await open(page, pictureFixture('Geometry', width, height));
      await page.locator('[data-layer="picture"] .layer-select').click(); await page.locator('[data-format-tab="size"]').click();
      await page.locator(`[data-property="${dimension}"]`).fill('2000'); await page.locator(`[data-property="${dimension}"]`).blur();
      const [draft] = await untilDraft(page, p => p?.slides[0].items[0][dimension] !== (dimension === 'height' ? height : width));
      validateDeck(draft); const resized = draft.slides[0].items[0];
      assert.equal(Math.max(resized.width, resized.height), 100000);
      assert.ok(Math.abs(resized.width / resized.height - width / height) < 1e-8);
      await page.locator('#save-project').click(); await idle(page); validateDeck(await readFile(page));
      await page.locator('#undo').click();
      await untilDraft(page, p => p?.slides[0].items[0].width === width && p.slides[0].items[0].height === height);
      await page.locator('#redo').click(); await page.locator('#save-project').click(); await idle(page);
      await reload(page); assert.equal(await page.locator('.layer-row').count(), 1);
      const [restored] = await readDraft(page); validateDeck(restored);
      assert.equal(restored.slides[0].items[0].width, resized.width);
    });
  }
  await scenario('large multiline text cannot make its automatically expanded frame invalid', async page => {
    const deck = fixture('Text bounds'); deck.slides[0].items = [{ id: 'text', type: 'text', text: 'Text', x: 0, y: 0, width: 100, height: 100, fontSize: 2000 }];
    await open(page, deck); await page.locator('[data-layer="text"] .layer-select').click();
    await page.locator('#text-content').fill('Text\n'.repeat(100)); await page.locator('#text-content').blur();
    const [draft] = await untilDraft(page, p => p?.slides[0].items[0].height === 100000); validateDeck(draft);
    await page.locator('#save-project').click(); await idle(page); await reload(page);
    assert.equal(await page.locator('.layer-row').count(), 1); validateDeck(await readFile(page));
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }
