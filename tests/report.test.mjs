import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../core.js';
import { createDeck, currentSlide, addSlide, cloneDeck } from '../deck.js';
import { generateHTMLReport } from '../report.js';
import { validateSVGDocument, svgDataURL } from '../svg-vector.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = id => ({ id, name: 'source.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 1, height: 1, size: 68, lastModified: 0, sourceKind: 'copy' });
const text = (id, value) => ({ id, type: 'text', x: 10, y: 20, width: 300, height: 80, text: value, fontSize: 20, color: '#111111' });
const picture = (id, assetId) => ({ id, type: 'image', assetId, x: 200, y: 100, width: 80, height: 80 });

function fixture() {
  const deck = createDeck();
  deck.name = 'Research report';
  deck.assets.push(asset('asset-a'));
  currentSlide(deck).name = 'Microscopy';
  currentSlide(deck).items.push(text('text-a', 'Panel A'), picture('image-a', 'asset-a'));
  const second = addSlide(deck);
  second.name = 'Comparison';
  second.canvas = { width: 480, height: 320, background: '#ffffff' };
  second.items.push(text('text-b', 'Panel B'), { id: 'rect-b', type: 'rect', x: 20, y: 50, width: 80, height: 50, fill: '#123456', stroke: '#000000', strokeWidth: 1 });
  return deck;
}

test('generates an offline report with all slides in order, linked contents and printable SVG figures', () => {
  const report = generateHTMLReport(fixture());
  assert.ok(report.startsWith('<!doctype html>'));
  assert.match(report, /<title>Research report — Figure report<\/title>/);
  assert.match(report, /Read-only report/);
  assert.match(report, /keep the \.figure\.json project/);
  assert.equal((report.match(/class="report-slide"/g) || []).length, 2);
  assert.equal((report.match(/<svg /g) || []).length, 2);
  assert.match(report, /href="#slide-1"/);
  assert.match(report, /href="#slide-2"/);
  assert.ok(report.indexOf('id="slide-1-title">Microscopy') < report.indexOf('id="slide-2-title">Comparison'));
  assert.match(report, /<tspan[^>]*>Panel A<\/tspan>/);
  assert.match(report, /<tspan[^>]*>Panel B<\/tspan>/);
  assert.match(report, /<rect[^>]*fill="#123456"/);
  assert.match(report, /width="127mm" height="84\.666667mm" viewBox="0 0 480 320"/);
  assert.match(report, /@media print/);
  assert.match(report, /break-before:page/);
  assert.match(report, /Fonts are not embedded/);
  assert.match(report, /may rasterize some content when printing/);
});

test('embeds raster material without scripts or remote image/font/style dependencies', () => {
  const report = generateHTMLReport(fixture());
  assert.match(report, /href="data:image\/png;base64,iVBOR/);
  assert.equal(/<script\b/i.test(report), false);
  assert.equal(/<link\b/i.test(report), false);
  assert.equal(/<iframe\b|<object\b|<embed\b|<form\b/i.test(report), false);
  assert.equal(/url\s*\(/i.test(report), false);
  for (const [, value] of report.matchAll(/\b(?:href|src|action)="([^"]*)"/g)) {
    assert.ok(value.startsWith('#') || /^data:image\/(?:png|jpeg|webp);base64,/.test(value), `Unexpected resource reference: ${value.slice(0, 80)}`);
  }
  assert.match(report, /script-src 'none'/);
  assert.match(report, /connect-src 'none'/);
});

test('escapes hostile names and text while keeping them readable, and prevents duplicate user-controlled DOM IDs', () => {
  const deck = fixture();
  deck.name = '</title><script>alert("title")</script>';
  deck.slides[0].name = '<img src=x onerror="alert(1)"> & comparison';
  deck.slides[0].items[0].id = 'slide-1';
  deck.slides[0].items[0].text = '</script><svg onload="alert(2)">\nA & B';
  deck.slides[0].items[0].fontFamily = 'Arial" onload="alert(3)';
  const report = generateHTMLReport(deck);
  assert.match(report, /&lt;\/title&gt;&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(report, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; comparison/);
  assert.match(report, /&lt;\/script&gt;&lt;svg onload=&quot;alert\(2\)&quot;&gt;/);
  assert.match(report, /font-family="Arial&quot; onload=&quot;alert\(3\)[^"]*"/);
  assert.equal(/<script\b|<img\b|<svg\s+onload=/i.test(report), false);
  assert.equal((report.match(/id="slide-1"/g) || []).length, 1);
  assert.equal(/<g id=/.test(report), false);
  assert.equal(/<\?xml/.test(report), false);
});

test('does not expose local source metadata, unused images, hidden objects, or original SVG payloads', () => {
  const deck = fixture();
  Object.assign(deck.assets[0], { sourceKind: 'linked', linkToken: 'private-binding', relativePath: 'private-directory/secret.svg', fingerprint: 'private-fingerprint', originalMime: 'image/svg+xml', originalDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  const unused = asset('unused-asset');
  unused.name = 'private-unused-asset';
  deck.assets.push(unused);
  deck.slides[0].items.push({ ...text('hidden-text', 'HIDDEN PRIVATE NOTE'), hidden: true });
  deck.slides[1].items.push({ ...picture('hidden-image', 'unused-asset'), hidden: true });
  const report = generateHTMLReport(deck);
  for (const secret of ['private-binding', 'private-directory', 'private-fingerprint', 'private-unused-asset', 'HIDDEN PRIVATE NOTE', 'data:image/svg+xml', '<metadata>']) assert.equal(report.includes(secret), false, secret);
  assert.equal((report.match(/data:image\/png;base64,/g) || []).length, 1);
});

test('exports visible SVG assets as vectors while removing their private source metadata', () => {
  const deck = fixture();
  const svgDocument = validateSVGDocument({ tag: 'svg', attrs: { width: '100', height: '100' }, children: [
    { tag: 'rect', attrs: { width: '100', height: '100', fill: '#123456' }, children: [] },
  ] });
  const dataUrl = svgDataURL(svgDocument);
  deck.assets.push({ id: 'vector', name: 'private-vector-name.svg', mime: 'image/svg+xml',
    dataUrl, svgDocument, width: 100, height: 100, sourceKind: 'linked',
    linkToken: 'private-svg-binding', relativePath: 'private-svg-directory/source.svg',
    fingerprint: 'private-svg-fingerprint', lastModified: 123456789 });
  deck.slides[0].items.push(picture('vector-item', 'vector'));
  deck.slides[1].items.push(picture('vector-copy', 'vector'));
  const before = structuredClone(deck);
  const report = generateHTMLReport(deck);
  assert.equal((report.match(/href="data:image\/svg\+xml;base64,/g) || []).length, 2);
  assert.ok(report.includes(`href="${dataUrl}"`));
  assert.match(Buffer.from(dataUrl.split(',')[1], 'base64').toString(), /<rect[^>]*fill="#123456"/);
  for (const secret of ['private-vector-name', 'private-svg-binding', 'private-svg-directory', 'private-svg-fingerprint', '<metadata>']) {
    assert.equal(report.includes(secret), false, secret);
  }
  assert.deepEqual(deck, before);
});

test('report generation does not change deck records, active slide, assets, or source associations', () => {
  const deck = fixture();
  Object.assign(deck.assets[0], { sourceKind: 'linked', linkToken: 'binding-a' });
  const before = cloneDeck(deck);
  const first = generateHTMLReport(deck);
  const second = generateHTMLReport(deck);
  assert.deepEqual(deck, before);
  assert.equal(first, second);
});

test('accepts v1 projects and rejects invalid remote assets or unsupported model versions', () => {
  const legacy = createProject();
  legacy.items.push(text('legacy-text', 'Legacy panel'));
  const report = generateHTMLReport(legacy);
  assert.match(report, /Legacy panel/);
  assert.equal((report.match(/class="report-slide"/g) || []).length, 1);
  const remote = fixture();
  remote.assets[0].dataUrl = 'https://example.com/image.png';
  assert.throws(() => generateHTMLReport(remote), /embedded base64/);
  assert.throws(() => generateHTMLReport({ ...fixture(), version: 999 }), /versions 1 and 2/);
});

test('preflights excessive report output before constructing a huge HTML document', () => {
  const deck = createDeck();
  const longText = '&'.repeat(25000);
  currentSlide(deck).items = Array.from({ length: 2000 }, (_, index) => text(`text-${index}`, longText));
  assert.throws(() => generateHTMLReport(deck), /too large.*240 MB/);
});

test('preflight includes SVG tspan overhead for empty text lines', () => {
  const deck = createDeck();
  const lineBreaks = '\n'.repeat(20000);
  currentSlide(deck).items = Array.from({ length: 500 }, (_, index) => text(`lines-${index}`, lineBreaks));
  assert.throws(() => generateHTMLReport(deck), /too large.*240 MB/);
});
