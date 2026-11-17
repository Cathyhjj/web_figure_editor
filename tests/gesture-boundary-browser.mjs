// Isolated real-pointer checks: unfinished drags must not leak into later commands.
// Run from the app root; PLAYWRIGHT_MODULE can point to an installed Playwright.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn('python3', ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let stderr = '', browser, baseURL;
server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
const checks = [];
const fixture = (name = 'Gesture boundaries') => ({
  format: 'figure-editor', version: 2, id: 'gesture-deck', name, assets: [], activeSlideId: 'first',
  slides: [
    { id: 'first', name: 'First', canvas: { width: 500, height: 350, background: '#ffffff' }, items: [
      { id: 'panel', type: 'rect', name: 'Panel', x: 80, y: 100, width: 100, height: 60, fill: '#245670' },
      { id: 'unrelated', type: 'rect', name: 'Unrelated', x: 310, y: 210, width: 40, height: 40, fill: '#cc6677' },
    ] },
    { id: 'second', name: 'Second', canvas: { width: 500, height: 350, background: '#ffffff' }, items: [] },
  ],
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`);
const panel = deck => deck.slides[0].items.find(item => item.id === 'panel');
const idle = page => page.waitForFunction(() => !document.getElementById('open-project').disabled);
async function upload(page, deck = fixture()) {
  await page.locator('#project-input').setInputFiles({ name: 'gesture.figure.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(deck)) });
  await idle(page);
}
async function save(page) {
  await page.evaluate(async () => { await document.getElementById('save-project').onclick(); });
  await idle(page);
  return page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('gesture-saved.figure.json')).getFile()).text()));
}
async function drag(page, { dx = 30, dy = 20, resize = false } = {}) {
  await page.locator('[data-layer="panel"] .layer-select').click();
  const start = await page.locator(resize ? '#stage [data-item="panel"] [data-resize-handle="se"]' : '#stage [data-item="panel"] .item-hit').boundingBox();
  assert.ok(start);
  const scale = await page.locator('#stage').evaluate(stage => stage.getScreenCTM().a);
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx * scale, y + dy * scale, { steps: 3 });
}
async function waitDraft(page, expectedX, expectedWidth = 100) {
  await page.waitForFunction(async ({ expectedX, expectedWidth }) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('figure-editor-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const deck = await new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const item = deck?.slides[0]?.items.find(item => item.id === 'panel');
      return item && Math.abs(item.x - expectedX) < 0.001 && Math.abs(item.width - expectedWidth) < 0.001;
    } finally { db.close(); }
  }, { expectedX, expectedWidth }, { timeout: 10000 });
}
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('figure-editor-autosave', 'off');
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('gesture-saved.figure.json', { create: true });
    document.addEventListener('pointerdown', event => { window.gestureTestPointerId = event.pointerId; }, true);
  });
  try {
    await page.goto(baseURL); await idle(page); await upload(page);
    await run(page); assert.deepEqual(errors, []);
    checks.push(name); console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, '\nStatus:', await page.locator('#status').textContent(), '\nErrors:', errors);
    throw error;
  } finally { await context.close(); }
}
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Server startup timed out')), 10000);
    createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  baseURL = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  await scenario('Undo during the first held drag settles and undoes it even with initially empty history', async page => {
    assert.equal(await page.locator('#undo').isDisabled(), true);
    await drag(page);
    await page.keyboard.press('ControlOrMeta+z');
    await page.mouse.up();
    let saved = await save(page); near(panel(saved).x, 80); near(panel(saved).y, 100);
    assert.equal(await page.locator('#undo').isDisabled(), true);
    assert.equal(await page.locator('#redo').isDisabled(), false);
    await page.locator('#redo').click(); saved = await save(page);
    near(panel(saved).x, 110); near(panel(saved).y, 120);
  });

  await scenario('a keyboard geometry edit follows a held drag as a separate Undo step', async page => {
    await drag(page); await page.keyboard.press('ArrowRight'); await page.mouse.up();
    let saved = await save(page); near(panel(saved).x, 111); near(panel(saved).y, 120);
    const unrelated = saved.slides[0].items.find(item => item.id === 'unrelated');
    await page.locator('#undo').click(); saved = await save(page); near(panel(saved).x, 110);
    assert.deepEqual(saved.slides[0].items.find(item => item.id === 'unrelated'), unrelated);
    await page.locator('#undo').click(); saved = await save(page); near(panel(saved).x, 80); near(panel(saved).y, 100);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('switching slides during a held drag commits the old slide and ignores late pointer events', async page => {
    await drag(page);
    await page.evaluate(() => document.querySelector('[data-slide="second"]').click());
    await page.mouse.move(700, 600); await page.mouse.up();
    const saved = await save(page);
    assert.equal(saved.activeSlideId, 'second'); near(panel(saved).x, 110); near(panel(saved).y, 120);
    assert.deepEqual(saved.slides[1].items, []);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 80);
  });

  await scenario('manual save during a held resize saves one completed resize', async page => {
    await drag(page, { resize: true, dx: 30, dy: 20 });
    let saved = await save(page); near(panel(saved).width, 130); near(panel(saved).height, 80);
    await page.mouse.up();
    await page.locator('#undo').click(); saved = await save(page); near(panel(saved).width, 100); near(panel(saved).height, 60);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  for (const boundary of ['capture loss', 'window blur']) await scenario(`${boundary} completes the drag and releases a deferred recovery draft`, async page => {
    await page.locator('[data-layer="panel"] .layer-select').click(); await page.keyboard.press('ArrowRight');
    await drag(page);
    // The pre-drag edit's 650 ms timer fires while geometry is transient.
    await page.waitForTimeout(750);
    if (boundary === 'capture loss') {
      await page.evaluate(() => document.getElementById('stage').releasePointerCapture(window.gestureTestPointerId));
      await page.mouse.move(700, 600);
    } else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitDraft(page, 111);
    await page.mouse.up();
    near(panel(await save(page)).x, 111);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 81);
  });

  await scenario('replacing a project during a held drag cannot restore objects from the old project', async page => {
    await drag(page);
    const replacement = fixture('Replacement project'); replacement.id = 'replacement'; replacement.slides[0].items[0].x = 210;
    await upload(page, replacement); await page.mouse.move(700, 600); await page.mouse.up();
    const saved = await save(page); assert.equal(saved.name, replacement.name); near(panel(saved).x, 210);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('unrelated metadata edits survive held-drag completion and Undo in order', async page => {
    await drag(page);
    await page.evaluate(() => { const input = document.getElementById('project-name'); input.value = 'Independent rename'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.mouse.up();
    let saved = await save(page); assert.equal(saved.name, 'Independent rename'); near(panel(saved).x, 110);
    await page.locator('#undo').click(); saved = await save(page); assert.equal(saved.name, fixture().name); near(panel(saved).x, 110);
    await page.locator('#undo').click(); saved = await save(page); near(panel(saved).x, 80);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('editing inspector geometry during a held drag refreshes the replacement control', async page => {
    await drag(page);
    await page.evaluate(() => { const input = document.querySelector('#inspector [data-property="x"]'); input.value = '225'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('#inspector [data-property="x"]').inputValue(), '225');
    await page.mouse.up(); near(panel(await save(page)).x, 225);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 110);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 80);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('editing inspector style during a held drag refreshes the replacement controls', async page => {
    await drag(page);
    await page.evaluate(() => { const input = document.querySelector('#inspector [data-shape-color="fill"]'); input.value = '#11aa66'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('#inspector [data-shape-color="fill"]').inputValue(), '#11aa66');
    assert.equal(await page.locator('#stage [data-item="panel"] rect[fill="#11aa66"]').count(), 1);
    await page.mouse.up(); let saved = await save(page); assert.equal(panel(saved).fill, '#11aa66'); near(panel(saved).x, 110);
    await page.locator('#undo').click(); saved = await save(page); assert.equal(panel(saved).fill, '#245670'); near(panel(saved).x, 110);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 80);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('editing inspector text during a held drag refreshes the replacement textarea', async page => {
    const textFixture = fixture();
    Object.assign(textFixture.slides[0].items[0], { type: 'text', text: 'Before', fontSize: 20 });
    await upload(page, textFixture); await drag(page);
    await page.evaluate(() => { const input = document.getElementById('text-content'); input.value = 'After'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('#text-content').inputValue(), 'After');
    await page.mouse.up(); let saved = await save(page); assert.equal(panel(saved).text, 'After'); near(panel(saved).x, 110);
    await page.locator('#undo').click(); saved = await save(page); assert.equal(panel(saved).text, 'Before'); near(panel(saved).x, 110);
    await page.locator('#undo').click(); near(panel(await save(page)).x, 80);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  console.log(JSON.stringify({ checks }, null, 2));
} finally { await browser?.close(); server.kill(); }
