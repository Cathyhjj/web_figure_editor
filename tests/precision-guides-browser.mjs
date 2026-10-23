// Synthetic decks and OPFS files in fresh browser contexts on an ephemeral origin.
// Run from the app root; PLAYWRIGHT_MODULE can point at a local Playwright install.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'precision-guides-check-'));
const server = spawn('python3', ['-u', '-c', 'import server; from pathlib import Path; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let serverError = '';
server.stderr.on('data', chunk => serverError += chunk);
let browser;
const checks = [];

function fixture({ guides = true, slides = 1 } = {}) {
  return {
    format: 'figure-editor', version: 2, id: 'guide-test-deck', name: 'Guide regression', assets: [], activeSlideId: 'slide-a',
    slides: Array.from({ length: slides }, (_, i) => ({
      id: `slide-${i ? 'b' : 'a'}`, name: `Slide ${i + 1}`, canvas: { width: 400, height: 300, background: '#ffffff' },
      items: i ? [] : [{ id: 'rect-a', type: 'rect', name: 'Test panel', x: 80, y: 100, width: 40, height: 30, fill: '#245670' }],
      ...(guides && !i ? { guides: [{ id: 'guide-x', axis: 'x', position: 200 }, { id: 'guide-y', axis: 'y', position: 220 }] } : {}),
    })),
  };
}

const idle = page => page.waitForFunction(() => !document.querySelector('#open-project').disabled);
// Browser pointer coordinates and SVG matrices round at fractional zoom levels.
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} != ${expected}`);
async function upload(page, deck) {
  await page.locator('#project-input').setInputFiles({ name: 'guides.figure.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(deck)) });
  await idle(page);
  assert.equal(await page.locator('#project-name').inputValue(), deck.name);
}
async function save(page, { first = false } = {}) {
  // Calling the actual button handler also works during pointer capture and
  // verifies that a guide preview cannot leak into a saved project.
  await page.evaluate(async first => { await document.getElementById(first ? 'save-project-as' : 'save-project').onclick(); }, first);
  await idle(page);
  assert.match(await page.locator('#status').textContent(), /^Saved to /);
  return page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('guides-saved.figure.json')).getFile()).text()));
}
async function menu(page, open = true) {
  if (await page.locator('#guides-menu').evaluate(el => el.matches(':popover-open')) === open) return;
  await page.evaluate(open => {
    window.guideMenuToggled = new Promise(resolve => {
      const menu = document.getElementById('guides-menu');
      const done = event => { if (event.newState === (open ? 'open' : 'closed')) { menu.removeEventListener('toggle', done); resolve(); } };
      menu.addEventListener('toggle', done);
    });
  }, open);
  await page.locator('#guides-toggle').click(); await page.evaluate(() => window.guideMenuToggled);
}
async function changeNumber(page, selector, value) {
  await page.locator(selector).fill(String(value)); await page.locator(selector).dispatchEvent('change');
}
async function point(page, x, y) {
  return page.locator('#stage').evaluate((stage, p) => {
    const transformed = new DOMPoint(p.x, p.y).matrixTransform(stage.getScreenCTM());
    return { x: transformed.x, y: transformed.y };
  }, { x, y });
}
async function startGuideDrag(page, { axis = 'x', position = 200, delta = 35 } = {}) {
  await menu(page, false);
  const start = await point(page, axis === 'x' ? position : 25, axis === 'y' ? position : 25);
  const end = await point(page, axis === 'x' ? position + delta : 25, axis === 'y' ? position + delta : 25);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 });
}
async function guidePosition(page, id = 'guide-x', axis = 'x') {
  return Number(await page.locator(`#stage [data-guide="${id}"] .layout-guide`).getAttribute(axis + '1'));
}
async function dragPanel(page, { alt = false, dx = 117, dy = 0 } = {}) {
  await menu(page, false);
  const start = await point(page, 100, 115), end = await point(page, 100 + dx, 115 + dy);
  if (alt) await page.keyboard.down('Alt');
  try { await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); }
  finally { if (alt) await page.keyboard.up('Alt'); }
}
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1650, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    if (localStorage.getItem('figure-editor-autosave') === null) localStorage.setItem('figure-editor-autosave', 'off');
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('guides-saved.figure.json', { create: true });
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('guides-saved.figure.json')];
    document.addEventListener('pointerdown', event => { window.lastGuideTestPointer = event.pointerId; }, true);
  });
  try {
    await page.goto(baseURL); await idle(page); await run(page); assert.deepEqual(errors, []);
    checks.push(name); console.log('PASS', name);
  } catch (error) {
    await page.screenshot({ path: join(output, `failure-${checks.length + 1}.png`) });
    console.error('FAIL', name, '\nStatus:', await page.locator('#status').textContent(), '\nPage errors:', errors, '\nOutput:', output);
    throw error;
  } finally { await context.close(); }
}

let baseURL;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverError || 'Server startup timed out')), 10000);
    createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(serverError || 'Server exited')); });
  });
  baseURL = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  await scenario('add vertical/horizontal guides, physical-unit positions, deletion and Undo', async page => {
    await upload(page, fixture({ guides: false }));
    await menu(page); await page.locator('#guide-add-x').click();
    near(Number(await page.locator('#guide-position').inputValue()), 200);
    await menu(page, false); await page.locator('#measurement-unit').selectOption('mm');
    await menu(page); await changeNumber(page, '#guide-position', 25.4);
    await page.locator('#guide-add-y').click();
    await menu(page, false); await page.locator('#measurement-unit').selectOption('pt');
    await menu(page); await changeNumber(page, '#guide-position', 72);
    const saved = await save(page, { first: true });
    assert.deepEqual(saved.slides[0].guides.map(({ axis, position }) => ({ axis, position })), [{ axis: 'x', position: 96 }, { axis: 'y', position: 96 }]);
    const horizontal = saved.slides[0].guides[1].id;
    await page.locator('#guide-delete').click();
    assert.equal(await page.locator('#stage [data-guide]').count(), 1);
    await menu(page, false); await page.locator('#undo').click();
    assert.equal(await page.locator('#stage [data-guide]').count(), 2);
    near(await guidePosition(page, horizontal, 'y'), 96);
    await page.locator('#redo').click();
    assert.equal(await page.locator('#stage [data-guide]').count(), 1);
    await menu(page); await changeNumber(page, '#guide-position', 75001);
    assert.match(await page.locator('#status').textContent(), /outside the supported range/);
    near((await save(page)).slides[0].guides[0].position, 96);
  });

  await scenario('guide drag previews stay unsaved; one Undo/Redo restores the committed position', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    assert.equal(await page.locator('#undo').isDisabled(), true);
    await startGuideDrag(page, { delta: 41 });
    near(await guidePosition(page), 241);
    near((await save(page)).slides[0].guides[0].position, 200, 'drag preview stays out of file');
    await page.mouse.up(); near((await save(page)).slides[0].guides[0].position, 241);
    await page.locator('#undo').click(); near(await guidePosition(page), 200);
    assert.equal(await page.locator('#undo').isDisabled(), true, 'one pointer gesture adds one Undo entry');
    await page.locator('#redo').click(); near(await guidePosition(page), 241);
    assert.equal(await page.locator('#redo').isDisabled(), true);
  });

  await scenario('pending numeric guide position commits in the old unit before switching units', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    await menu(page); await page.locator('#guide-position').fill('144');
    // selectOption does not itself blur an input; the app must flush its pending
    // value before replacing the unit used to interpret that value.
    await page.locator('#measurement-unit').selectOption('pt');
    near((await save(page)).slides[0].guides[0].position, 144);
    await menu(page); near(Number(await page.locator('#guide-position').inputValue()), 108);
    await menu(page, false); await page.locator('#undo').click();
    near(await guidePosition(page), 200);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('keyboard Delete removes the selected guide while keeping selected figure objects', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    await page.locator('[data-layer="rect-a"] .layer-select').click();
    await startGuideDrag(page, { delta: 0 }); await page.mouse.up();
    assert.equal(await page.locator('#stage .figure-item.selected').count(), 1);
    await page.keyboard.press('Delete');
    const saved = await save(page); assert.deepEqual(saved.slides[0].guides.map(guide => guide.id), ['guide-y']);
    assert.deepEqual(saved.slides[0].items.map(item => item.id), ['rect-a']);
    await page.locator('#undo').click(); assert.equal(await page.locator('#stage [data-guide]').count(), 2);
    assert.equal(await page.locator('#stage .figure-item').count(), 1);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('object keyboard shortcuts cannot modify the selection during a guide drag', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    await page.locator('[data-layer="rect-a"] .layer-select').click();
    await startGuideDrag(page);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+d');
    near(await guidePosition(page), 235);
    const preview = await save(page); assert.equal(preview.slides[0].items.length, 1); near(preview.slides[0].items[0].x, 80);
    near(preview.slides[0].guides[0].position, 200);
    await page.mouse.up(); near((await save(page)).slides[0].guides[0].position, 235);
    await page.locator('#undo').click(); near(await guidePosition(page), 200);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    await scenario(`guide drag ${cancellation} cancels without changing project or Undo history`, async page => {
      await upload(page, fixture()); await save(page, { first: true });
      await startGuideDrag(page); near(await guidePosition(page), 235);
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else await page.evaluate(type => {
        const stage = document.querySelector('#stage'), pointerId = window.lastGuideTestPointer;
        if (type === 'blur') window.dispatchEvent(new Event('blur'));
        else if (type === 'lostpointercapture') stage.releasePointerCapture(pointerId);
        else stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId, bubbles: true }));
      }, cancellation);
      await page.mouse.move((await point(page, 245, 25)).x, (await point(page, 245, 25)).y);
      await page.mouse.up(); near(await guidePosition(page), 200);
      near((await save(page)).slides[0].guides[0].position, 200);
      assert.equal(await page.locator('#undo').isDisabled(), true);
      assert.equal(await page.locator('#redo').isDisabled(), true);
    });
  }

  await scenario('switching slides during guide drag discards its preview and stale pointer completion', async page => {
    await upload(page, fixture({ slides: 2 })); await save(page, { first: true });
    await startGuideDrag(page); near(await guidePosition(page), 235);
    await page.locator('[data-slide="slide-b"]').evaluate(button => button.click());
    assert.equal(await page.locator('#stage [data-guide]').count(), 0);
    const end = await point(page, 260, 25); await page.mouse.move(end.x, end.y); await page.mouse.up();
    const saved = await save(page);
    assert.equal(saved.activeSlideId, 'slide-b');
    near(saved.slides[0].guides[0].position, 200);
    assert.equal(saved.slides[1].guides, undefined);
    assert.equal(await page.locator('#undo').isDisabled(), true);
    await page.locator('[data-slide="slide-a"]').click(); near(await guidePosition(page), 200);
  });

  await scenario('guide snapping uses object edges, Alt bypass, Show and Snap switches', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    await dragPanel(page); near((await save(page)).slides[0].items[0].x, 200);
    await page.locator('#undo').click();
    await dragPanel(page, { alt: true }); near((await save(page)).slides[0].items[0].x, 197);
    await page.locator('#undo').click();
    await menu(page); await page.locator('#guides-snap').uncheck();
    await dragPanel(page); near((await save(page)).slides[0].items[0].x, 197);
    await page.locator('#undo').click();
    await menu(page); await page.locator('#guides-snap').check(); await page.locator('#guides-visible').uncheck();
    assert.equal(await page.locator('#stage [data-guide]').count(), 0);
    await dragPanel(page); near((await save(page)).slides[0].items[0].x, 197);
    await page.locator('#undo').click();
    await menu(page); await page.locator('#guides-visible').check();
    await dragPanel(page); near((await save(page)).slides[0].items[0].x, 200);
  });

  await scenario('multi-selection snaps as one group and horizontal guides snap object centers', async page => {
    const deck = fixture();
    deck.slides[0].items.push({ ...deck.slides[0].items[0], id: 'rect-b', x: 140, name: 'Second panel' });
    await upload(page, deck); await save(page, { first: true });
    await page.locator('[data-layer="rect-a"] .layer-select').click();
    await page.locator('[data-layer="rect-b"] .layer-select').click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('#stage .figure-item.selected').count(), 2);
    await dragPanel(page, { dx: 17 });
    const moved = (await save(page)).slides[0].items;
    near(moved[0].x, 100); near(moved[1].x, 160);
    near(moved[1].x - moved[0].x, 60, 'selection retains relative placement');
    await page.locator('#undo').click();
    await dragPanel(page, { dx: 0, dy: 102 });
    const centered = (await save(page)).slides[0].items;
    near(centered[0].y, 205); near(centered[0].y + centered[0].height / 2, 220);
    near(centered[1].y, 100, 'only the dragged panel moves after Undo clears selection');
  });

  await scenario('snap tolerance stays six screen pixels when zoom changes', async page => {
    await upload(page, fixture()); await save(page, { first: true });
    assert.equal(await page.locator('#zoom-value').textContent(), '100%');
    await dragPanel(page, { dx: 115 }); near((await save(page)).slides[0].items[0].x, 200);
    await page.locator('#undo').click();
    await page.locator('#zoom-in').click(); await page.locator('#zoom-in').click();
    assert.equal(await page.locator('#zoom-value').textContent(), '144%');
    await dragPanel(page, { dx: 115 }); near((await save(page)).slides[0].items[0].x, 195);
  });

  await scenario('hidden selected objects cannot change guide snapping or move with visible objects', async page => {
    const deck = fixture();
    deck.slides[0].items.push({ ...deck.slides[0].items[0], id: 'hidden-panel', x: -140, hidden: true, name: 'Hidden panel' });
    await upload(page, deck); await save(page, { first: true });
    await page.locator('[data-layer="rect-a"] .layer-select').click();
    await page.locator('[data-layer="hidden-panel"] .layer-select').click({ modifiers: ['Shift'] });
    await dragPanel(page);
    const saved = await save(page); near(saved.slides[0].items[0].x, 200); near(saved.slides[0].items[1].x, -140);
  });

  await scenario('double-clicking a guide never opens the previously selected text editor', async page => {
    const deck = fixture();
    deck.slides[0].items = [{ id: 'text-a', type: 'text', text: 'Panel label', x: 80, y: 100, width: 90, height: 30, fontSize: 20 }];
    await upload(page, deck);
    const label = await point(page, 100, 115); await page.mouse.click(label.x, label.y);
    assert.equal(await page.locator('#stage .figure-item.selected').count(), 1);
    const guide = await point(page, 200, 25); await page.mouse.dblclick(guide.x, guide.y);
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'text-content');
    assert.equal(await page.locator('#stage [data-guide]').count(), 2);
    assert.equal(await page.locator('#undo').isDisabled(), true);
  });

  await scenario('guide settings persist locally, guide records survive file reopen, exports omit overlays', async page => {
    await upload(page, fixture({ slides: 2 }));
    await startGuideDrag(page, { axis: 'y', position: 220, delta: -24 }); await page.mouse.up();
    const saved = await save(page, { first: true }); near(saved.slides[0].guides[1].position, 196);
    await menu(page); await page.locator('#guides-visible').uncheck(); await page.locator('#guides-snap').uncheck();
    await page.reload(); await idle(page); await menu(page);
    assert.equal(await page.locator('#guides-visible').isChecked(), false);
    assert.equal(await page.locator('#guides-snap').isChecked(), false);
    await page.locator('#guides-visible').check(); await menu(page, false);
    await page.locator('#new-project').click(); await page.locator('#open-project').click(); await idle(page);
    assert.equal(await page.locator('#stage [data-guide]').count(), 2);
    near(await guidePosition(page, 'guide-y', 'y'), 196);
    assert.equal(await page.locator('#slide-list [data-guide]').count(), 0, 'slide thumbnails contain no guides');
    await page.locator('#export-open').click(); await page.locator('#export-format').selectOption('svg');
    const downloading = page.waitForEvent('download'); await page.locator('#export-submit').click();
    const download = await downloading, path = join(output, 'guide-free-export.svg'); await download.saveAs(path);
    const svg = await readFile(path, 'utf8');
    assert.match(svg, /#245670/); assert.doesNotMatch(svg, /layout-guide|data-guide|guide-x|guide-y|#21a0b3|#b63e8d/);
    const clean = await page.evaluate(async deck => {
      const { projectToSVG } = await import('./core.js'); const { validateDeck, slideProject } = await import('./deck.js');
      const source = validateDeck(deck); delete source.slides[0].guides; return projectToSVG(slideProject(source));
    }, saved);
    assert.equal(svg, clean, 'actual exported bytes match rendering without guide metadata');
    await page.screenshot({ path: join(output, 'guides-editor.png') });
  });

  await scenario('off-canvas guides stay saved and the 100-guide limit disables additions', async page => {
    const deck = fixture(); deck.slides[0].guides = Array.from({ length: 100 }, (_, i) => ({ id: `guide-${i}`, axis: 'x', position: i - 50 }));
    await upload(page, deck); await menu(page);
    assert.equal(await page.locator('#guide-add-x').isDisabled(), true);
    assert.equal(await page.locator('#guide-add-y').isDisabled(), true);
    assert.equal(await page.locator('#stage [data-guide]').count(), 50);
    const saved = await save(page, { first: true }); assert.equal(saved.slides[0].guides.length, 100); near(saved.slides[0].guides[0].position, -50);
    await page.locator('#guide-delete').click(); assert.equal(await page.locator('#guide-add-x').isDisabled(), false);
  });

  console.log(JSON.stringify({ output, passed: checks.length, checks }));
} finally { await browser?.close(); server.kill(); }
