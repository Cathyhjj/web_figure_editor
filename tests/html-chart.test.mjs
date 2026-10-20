import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, validateDeck, slideProject } from '../deck.js';
import { createSelection, encodeSelection, decodeSelection, pasteSelection, createSlidesClipboard, pasteSlides } from '../clipboard.js';
import { projectToSVG } from '../core.js';
import { generateHTMLReport } from '../report.js';
import { exportPPTX } from '../pptx.js';
import { looksLikeHTML, chartDocument, htmlSource, validateSnapshot, requireHTMLSnapshots } from '../html-chart.js';
import { posterProject } from '../video.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nxsAAAAASUVORK5CYII=';
const source = '<!doctype html><html><body><svg><text>中文 α</text></svg><script>window.chart=true;</script></body></html>';
function fixture(hasSnapshot = true) {
  const deck = createDeck();
  deck.assets = [{ id: 'chart', name: 'chart.html', mime: 'text/html', dataUrl: `data:text/html;base64,${Buffer.from(source).toString('base64')}`, width: 960, height: 600, posterDataUrl: png, posterWidth: 1, posterHeight: 1, hasSnapshot }];
  deck.slides[0].items = [{ id: 'plot', type: 'html', assetId: 'chart', name: 'Chart', x: 20, y: 30, width: 480, height: 300 }];
  return deck;
}
test('HTML source, Unicode and snapshot survive save/reopen and both clipboard routes', () => {
  const deck = validateDeck(JSON.parse(JSON.stringify(fixture())));
  assert.equal(htmlSource(deck.assets[0]), source);
  const selection = decodeSelection(encodeSelection(createSelection(slideProject(deck), new Set(['plot']))));
  const target = createDeck(); pasteSelection(target, selection);
  assert.equal(htmlSource(target.assets[0]), source);
  assert.equal(target.slides[0].items[0].type, 'html');
  assert.equal(target.assets[0].hasSnapshot, true);
  pasteSlides(target, createSlidesClipboard(deck, [deck.activeSlideId]));
  assert.equal(target.slides[1].items[0].type, 'html');
});
test('HTML detection precedes inline SVG and accepts standalone Plotly fragments', () => {
  for (const html of [source, '<div><script>chart()</script></div>', '\uFEFF<!DOCTYPE html><html></html>']) assert.equal(looksLikeHTML(new TextEncoder().encode(html)), true);
  assert.equal(looksLikeHTML(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), false);
  assert.equal(looksLikeHTML(new TextEncoder().encode('<svg><metadata><![CDATA[<body>Metadata</body>]]></metadata></svg>')), false);
});
test('HTML model rejects mismatched types, corrupt posters and excessive viewport sizes', () => {
  for (const mutate of [
    d => d.slides[0].items[0].type = 'image',
    d => d.assets[0].posterDataUrl = 'data:image/png;base64,SGVsbG8=',
    d => d.assets[0].posterWidth = 8,
    d => d.assets[0].width = 10000,
    d => d.slides[0].items[0].crop = { x: 0, y: 0, width: 1, height: 1 },
  ]) { const deck = fixture(); mutate(deck); assert.throws(() => validateDeck(deck)); }
  assert.throws(() => validateSnapshot('data:image/svg+xml;base64,SGVsbG8='));
});
test('sandbox policy precedes all source markup; channel cannot inject a script', () => {
  const html = chartDocument('<base href="http://localhost/"><script>parent.attack()</script>', '</script><script>attack()</script>');
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<base href="http://localhost/'));
  assert.match(html, /base-uri https:\/\/figure-editor.invalid/);
  assert.match(html, /frame-src 'none'/);
  assert.ok(!html.includes('})("</script>'));
});
test('visible charts require real snapshots; hidden and unused assets do not', async () => {
  const deck = fixture(false);
  assert.throws(() => projectToSVG(slideProject(deck)), /needs a chart snapshot/);
  assert.throws(() => generateHTMLReport(deck), /needs a chart snapshot/);
  await assert.rejects(exportPPTX(deck), /needs a chart snapshot/);
  deck.slides[0].items[0].hidden = true;
  assert.doesNotThrow(() => requireHTMLSnapshots(deck));
  assert.doesNotThrow(() => projectToSVG(slideProject(deck)));
  assert.doesNotThrow(() => generateHTMLReport(deck));
});
test('static output contains the PNG without executable chart source', async () => {
  const deck = validateDeck(fixture()), view = slideProject(deck);
  assert.ok(projectToSVG(view).includes(png));
  assert.ok(!projectToSVG(view).includes(deck.assets[0].dataUrl));
  const poster = posterProject(view);
  assert.equal(poster.items[0].type, 'image');
  assert.equal(poster.assets[0].mime, 'image/png');
  const report = generateHTMLReport(deck);
  assert.ok(report.includes(png)); assert.ok(!report.includes(deck.assets[0].dataUrl));
  const pptx = Buffer.from(await (await exportPPTX(deck)).arrayBuffer());
  assert.ok(pptx.includes(Buffer.from('image1.png')));
  assert.ok(!pptx.includes(Buffer.from('window.chart')));
});
