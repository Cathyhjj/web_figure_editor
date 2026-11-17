// Dedicated localhost:18766 server and fresh browser profiles; never use the editing origin.
import assert from 'node:assert/strict';
import { createDeck, serializeDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const idle = page => page.waitForFunction(() => !document.getElementById('open-project').disabled);
async function records(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('figure-editor-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { const store = db.transaction('drafts').objectStore('drafts'); const [project, file] = await Promise.all(['current', 'current-file'].map(key => new Promise((resolve, reject) => { const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }))); return [project, file && { ...file, handleName: file.handle?.name }]; }
    finally { db.close(); }
  });
}
async function until(page, predicate) {
  for (let index = 0; index < 150; index++) { const saved = await records(page); if (predicate(...saved)) return saved; await page.waitForTimeout(30); }
  throw new Error('Expected draft was not persisted.');
}
const counts = page => page.evaluate(() => ({ ...window.draftStats.committed }));
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('figure-editor-autosave', 'off');
    window.saveTargetName = 'original.figure.json'; window.openTargetName = 'original.figure.json';
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle(window.openTargetName)];
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle(window.saveTargetName, { create: true });
    window.resetDraftStats = () => { window.draftStats = { committed: { current: 0, file: 0, transactions: 0 } }; };
    window.resetDraftStats(); window.failDraftMetadata = 0;
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (this.name === 'figure-editor-drafts' && args[1] === 'readwrite') {
        const stats = window.draftStats, writes = { current: 0, file: 0 };
        tx.draftTestWrites = writes;
        tx.addEventListener('complete', () => { stats.committed.current += writes.current; stats.committed.file += writes.file; if (writes.current || writes.file) stats.committed.transactions++; });
      }
      return tx;
    };
    IDBObjectStore.prototype.put = function (value, key) {
      const writes = this.transaction.draftTestWrites;
      if (writes && key === 'current-file' && window.failDraftMetadata > 0) {
        window.failDraftMetadata--; throw new DOMException('Synthetic draft metadata failure', 'QuotaExceededError');
      }
      const result = put.call(this, value, key);
      if (writes) { if (key === 'current') writes.current++; else if (key === 'current-file') writes.file++; }
      return result;
    };
    window.requestRepeatedDrafts = () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      for (let index = 0; index < 8; index++) document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
    };
  });
  try {
    await page.goto('http://127.0.0.1:18766/'); await idle(page);
    const deck = createDeck(); deck.name = 'Draft fixture';
    deck.slides[0].items = [{ id: 'box', type: 'rect', name: 'Box', x: 80, y: 80, width: 180, height: 140, fill: '#cc3344', stroke: '#222222', strokeWidth: 2 }];
    await page.evaluate(async content => { const file = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json', { create: true }); const writer = await file.createWritable(); await writer.write(content); await writer.close(); }, serializeDeck(deck));
    await page.locator('#open-project').click(); await idle(page); await until(page, saved => saved?.name === deck.name);
    await page.evaluate(() => window.resetDraftStats());
    await run(page); assert.deepEqual(errors, []); checks.push(name); console.log('PASS', name);
  } catch (error) { console.error('FAIL', name, 'Status:', await page.locator('#status').textContent(), 'Errors:', errors, 'Counts:', await counts(page)); throw error; }
  finally { await context.close(); }
}

try {
  await scenario('blurring an already saved focused edit does not rewrite content and still records Undo', async page => {
    await page.locator('#project-name').fill('Edit kept focused');
    assert.equal(await page.locator('#project-name').evaluate(input => input === document.activeElement), true);
    await until(page, saved => saved?.name === 'Edit kept focused');
    assert.deepEqual(await counts(page), { current: 1, file: 1, transactions: 1 });
    await page.locator('#project-name').blur();
    await page.waitForTimeout(800);
    assert.deepEqual(await counts(page), { current: 1, file: 1, transactions: 1 });
    assert.equal(await page.locator('#undo').isEnabled(), true);
    await page.locator('#undo').click();
    await until(page, saved => saved?.name === 'Draft fixture');
    assert.equal(await page.locator('#project-name').inputValue(), 'Draft fixture');
    assert.equal((await counts(page)).current, 2);
  });
  await scenario('repeated draft requests coalesce; Save, AutoSave and Save As only update metadata for saved content', async page => {
    await page.locator('#project-name').fill('One content change'); await page.locator('#project-name').blur();
    await page.evaluate(() => window.requestRepeatedDrafts());
    await until(page, saved => saved?.name === 'One content change');
    await page.waitForTimeout(750);
    assert.deepEqual(await counts(page), { current: 1, file: 1, transactions: 1 });
    await page.locator('#save-project').click(); await idle(page); await until(page, (_saved, file) => file?.dirty === false);
    assert.deepEqual(await counts(page), { current: 1, file: 2, transactions: 2 });
    await page.locator('#autosave-toggle').check();
    await page.locator('#project-name').fill('Automatic content change'); await page.locator('#project-name').blur();
    await page.waitForFunction(() => document.getElementById('autosave-status').dataset.state === 'saved');
    await until(page, (saved, file) => saved?.name === 'Automatic content change' && file?.dirty === false);
    assert.deepEqual(await counts(page), { current: 2, file: 4, transactions: 4 });
    await page.evaluate(() => { window.saveTargetName = 'copy.figure.json'; });
    await page.locator('#save-project-as').click(); await idle(page);
    await until(page, (_saved, file) => file?.handleName === 'copy.figure.json');
    assert.deepEqual(await counts(page), { current: 2, file: 5, transactions: 5 });
    await page.reload(); await idle(page);
    assert.equal(await page.locator('#project-name').inputValue(), 'Automatic content change');
    assert.match(await page.locator('#save-project').getAttribute('title'), /copy.figure.json/);
  });
  await scenario('failed metadata transaction retries without rewriting the successfully saved project', async page => {
    await page.locator('#project-name').fill('Retry metadata'); await page.locator('#project-name').blur();
    await until(page, saved => saved?.name === 'Retry metadata');
    await page.evaluate(() => { window.failDraftMetadata = 1; });
    await page.locator('#save-project').click(); await idle(page);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Synthetic draft metadata failure'));
    assert.deepEqual(await counts(page), { current: 1, file: 1, transactions: 1 });
    assert.equal((await records(page))[1].dirty, true);
    await page.locator('#save-project').click(); await idle(page); await until(page, (_saved, file) => file?.dirty === false);
    assert.deepEqual(await counts(page), { current: 1, file: 2, transactions: 2 });
  });
  await scenario('two tabs atomically retain matching project and file metadata, including repeated unchanged requests', async page => {
    await page.locator('#project-name').fill('Tab A edit'); await page.locator('#project-name').blur();
    await until(page, saved => saved?.name === 'Tab A edit');
    const other = await page.context().newPage(), errors = [];
    other.on('pageerror', error => errors.push(error.message)); other.on('dialog', dialog => dialog.accept());
    try {
      await other.goto('http://127.0.0.1:18766/'); await idle(other);
      const second = createDeck(); second.name = 'Tab B project';
      await other.evaluate(async content => {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle('second.figure.json', { create: true });
        const writer = await handle.createWritable(); await writer.write(content); await writer.close();
        window.openTargetName = 'second.figure.json';
      }, serializeDeck(second));
      await other.locator('#open-project').click(); await idle(other);
      await other.locator('#project-name').fill('Tab B unsaved'); await other.locator('#project-name').blur();
      await until(other, (saved, file) => saved?.name === 'Tab B unsaved' && file?.handleName === 'second.figure.json');
      await page.evaluate(() => window.resetDraftStats());
      await page.locator('#save-project').click(); await idle(page);
      await until(page, (saved, file) => saved?.name === 'Tab A edit' && file?.handleName === 'original.figure.json' && !file.dirty);
      assert.deepEqual(await counts(page), { current: 1, file: 1, transactions: 1 }, 'metadata update must restore A content after B took ownership');
      await other.evaluate(() => { window.resetDraftStats(); window.requestRepeatedDrafts(); });
      await until(other, (saved, file) => saved?.name === 'Tab B unsaved' && file?.handleName === 'second.figure.json' && file.dirty);
      assert.deepEqual(await counts(other), { current: 1, file: 1, transactions: 1 }, 'an unchanged completed request must notice another tab took ownership');
      await page.locator('#save-project').click(); await idle(page);
      await until(page, (saved, file) => saved?.name === 'Tab A edit' && file?.handleName === 'original.figure.json');
      assert.deepEqual(await counts(page), { current: 2, file: 2, transactions: 2 });
      await page.locator('#save-project').click(); await idle(page);
      assert.deepEqual(await counts(page), { current: 2, file: 2, transactions: 2 }, 'owned identical content and metadata need no put');
      assert.deepEqual(errors, []);
    } finally { await other.close(); }
  });
  await scenario('draft timer waits for validated drag completion and Undo survives reload', async page => {
    await page.locator('#project-name').fill('Pending before drag'); await page.locator('#project-name').blur();
    const box = await page.locator('#stage [data-item="box"]').boundingBox();
    await page.mouse.move(box.x + 35, box.y + 35); await page.mouse.down(); await page.mouse.move(box.x + 95, box.y + 75, { steps: 4 });
    await page.waitForTimeout(850);
    assert.equal((await records(page))[0].name, 'Draft fixture');
    assert.deepEqual(await counts(page), { current: 0, file: 0, transactions: 0 });
    await page.mouse.up();
    await until(page, saved => saved?.name === 'Pending before drag' && saved.slides[0].items[0].x > 80);
    assert.equal((await counts(page)).current, 1);
    await page.locator('#undo').click(); await until(page, saved => saved?.slides[0].items[0].x === 80);
    assert.equal((await counts(page)).current, 2);
    await page.reload(); await idle(page);
    const [saved] = await until(page, saved => saved?.name === 'Pending before drag');
    assert.equal(saved.slides[0].items[0].x, 80);
    assert.equal(await page.locator('#project-name').inputValue(), 'Pending before drag');
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }
