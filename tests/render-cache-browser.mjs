// Run against a dedicated `python3 server.py --port 18766`, never the editing origin.
// All projects and source replacements are synthetic; the browser profile is isolated.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await page.addInitScript(() => {
  if (window !== window.top) return;
  window.showSaveFilePicker = undefined;
  window.showOpenFilePicker = undefined;
  localStorage.setItem('figure-editor-autosave', 'off');
});
const checks = [];
function passed(name) { checks.push(name); console.log('PASS', name); }
const order = () => page.locator('#stage > g[data-item]').evaluateAll(nodes => nodes.map(node => node.dataset.item));
const select = id => page.locator(`[data-layer="${id}"] .layer-select`).click();
async function matchingLayerOrder() {
  const layers = await page.locator('#layer-list [data-layer]').evaluateAll(nodes => nodes.map(node => node.dataset.layer).reverse());
  assert.deepEqual(await order(), layers);
  assert.equal(new Set(await order()).size, layers.length);
}
try {
  await page.goto('http://127.0.0.1:18766/');
  await page.waitForFunction(() => !document.getElementById('open-project').disabled);
  const fixture = await page.evaluate(async () => {
    const { createDeck, validateDeck } = await import('/deck.js');
    const { importFiles } = await import('/assets.js?v=locate-1');
    const source = fill => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${fill}"/></svg>`;
    const red = source('#cc3344'), blue = source('#3355cc');
    const { assets, errors } = await importFiles([new File([red], 'shared.svg'), new File([blue], 'shared.svg')]);
    if (errors.length) throw new Error(JSON.stringify(errors));
    const [original, replacement] = assets;
    original.id = 'shared';
    const deck = createDeck();
    const picture = id => ({ id, type: 'image', assetId: 'shared', name: id, x: 50, y: 50, width: 180, height: 180 });
    const text = id => ({ id, type: 'text', name: id, text: 'Independent label', x: 80, y: 280, width: 300, height: 60 });
    deck.assets = [original]; deck.activeSlideId = 'first';
    deck.slides = [
      { id: 'first', name: 'First', canvas: deck.slides[0].canvas, items: [picture('picture-a'), text('label-a')] },
      { id: 'second', name: 'Second', canvas: deck.slides[0].canvas, items: [picture('picture-b')] },
      { id: 'third', name: 'Unrelated', canvas: deck.slides[0].canvas, items: [text('label-b')] },
    ];
    return { json: JSON.stringify(validateDeck(deck)), blue, original: original.dataUrl, replacement: replacement.dataUrl };
  });
  assert.equal(fixture.original.length, fixture.replacement.length, 'fixture must replace bytes without changing data URL length');
  assert.notEqual(fixture.original, fixture.replacement);
  await page.locator('#project-input').setInputFiles({ name: 'render-cache.figure.json', mimeType: 'application/json', buffer: Buffer.from(fixture.json) });
  await page.locator('#stage [data-item="picture-a"] image').waitFor();
  const sources = () => page.locator('#slide-list .slide-preview image').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  assert.deepEqual(await sources(), [fixture.original, fixture.original]);
  await page.evaluate(() => {
    window.retainedImage = document.querySelector('#stage [data-item="picture-a"] image');
    window.retainedPreview = document.querySelector('[data-slide="third"] .slide-preview');
    window.retainedFirstPreview = document.querySelector('[data-slide="first"] .slide-preview');
  });
  await select('label-a');
  await page.locator('#zoom-in').click();
  assert.equal(await page.evaluate(() => window.retainedImage === document.querySelector('#stage [data-item="picture-a"] image') && window.retainedFirstPreview === document.querySelector('[data-slide="first"] .slide-preview')), true);
  passed('Selection and zoom retain the image and unchanged slide preview');

  await page.locator('[data-asset="shared"] [data-action="relink"]').click();
  await page.locator('#relink-input').setInputFiles({ name: 'shared.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(fixture.blue) });
  await page.waitForFunction(source => document.querySelector('#stage [data-item="picture-a"] image')?.getAttribute('href') === source, fixture.replacement);
  assert.deepEqual(await sources(), [fixture.replacement, fixture.replacement]);
  assert.equal(await page.locator('[data-asset="shared"] .asset-thumb').getAttribute('src'), fixture.replacement);
  assert.equal(await page.evaluate(() => window.retainedPreview === document.querySelector('[data-slide="third"] .slide-preview')), true);
  passed('Same-length shared source replacement updates canvas, asset card and all referencing thumbnails');
  await page.locator('#undo').click();
  assert.deepEqual(await sources(), [fixture.original, fixture.original]);
  assert.equal(await page.locator('#stage [data-item="picture-a"] image').getAttribute('href'), fixture.original);
  passed('Undo restores source pixels in canvas and thumbnails');

  await page.locator('[data-layer="picture-a"] [data-action="hide"]').click();
  assert.equal(await page.locator('#stage [data-item="picture-a"]').count(), 0);
  assert.equal(await page.locator('[data-slide="first"] .slide-preview image').count(), 0);
  assert.deepEqual(await sources(), [fixture.original]);
  await page.locator('[data-layer="picture-a"] [data-action="hide"]').click();
  assert.equal(await page.locator('#stage [data-item="picture-a"] image').getAttribute('href'), fixture.original);
  await select('label-a'); await page.locator('#send-backward').click();
  assert.deepEqual(await order(), ['label-a', 'picture-a']);
  await matchingLayerOrder();
  await select('picture-a'); await page.locator('#duplicate').click();
  assert.equal(await page.locator('#stage > g[data-item] > image').count(), 2);
  assert.equal(await page.locator('[data-slide="first"] .slide-preview image').count(), 2);
  await matchingLayerOrder();
  await page.locator('#undo').click();
  assert.deepEqual(await order(), ['label-a', 'picture-a']);
  passed('Visibility, layer order, duplication and Undo keep canvas and previews consistent');

  await page.locator('#new-project').click();
  await page.locator('#html-file-input').setInputFiles(fileURLToPath(new URL('./fixtures/interactive-chart.html', import.meta.url)));
  const iframe = page.locator('#html-chart-overlay iframe'), frame = iframe.contentFrame();
  await frame.locator('#peak').waitFor();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('snapshot saved'));
  const chartId = await page.locator('#html-chart-overlay').evaluate(node => node.parentElement.dataset.item);
  const runId = await frame.locator('body').getAttribute('data-run-id');
  assert.equal(await page.locator(`#stage > [data-item="${chartId}"]`).count(), 1);
  for (const label of ['First label', 'Second label']) {
    await page.locator('#add-text').click();
    await page.locator('#text-content').fill(label);
    await page.locator('#text-content').blur();
  }
  await select(chartId);
  await page.locator('#interact-html').click();
  for (const command of ['bring-forward', 'bring-forward', 'send-backward', 'send-backward']) {
    await page.locator(`#${command}`).click();
    await matchingLayerOrder();
    assert.equal(await page.locator(`#stage > [data-item="${chartId}"]`).count(), 1);
    assert.equal(await page.locator('#html-chart-overlay iframe').count(), 1);
    assert.equal(await frame.locator('body').getAttribute('data-run-id'), runId);
  }
  const before = await frame.locator('body').evaluate(() => window.animationFrames);
  await page.waitForTimeout(120);
  assert.ok(await frame.locator('body').evaluate(() => window.animationFrames) > before);
  passed('Reordering around a live chart keeps exactly one object group and preserves the running iframe');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error('Status:', await page.locator('#status').textContent().catch(() => ''));
  console.error('Page errors:', errors);
  throw error;
} finally { await context.close(); await browser.close(); }
