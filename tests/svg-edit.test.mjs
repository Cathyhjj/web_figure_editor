import test from 'node:test';
import assert from 'node:assert/strict';
import { svgDataURL } from '../svg-vector.js';
import { inspectSVGAsset, patchSVGAsset } from '../svg-edit.js';
import { createDeck, validateDeck } from '../deck.js';
import { inspectSVG, prepareBatch } from '../automation.js';

function fixture() {
  const svgDocument = { tag: 'svg', attrs: { width: '200', height: '100' }, children: [
    { tag: 'style', attrs: {}, children: ['text {fill: #123456 !important}'] },
    { tag: 'text', attrs: { id: 'axis', x: '10', y: '50', 'font-size': '20' }, children: ['Fe ',
      { tag: 'tspan', attrs: {}, children: ['K'] }, ' 边'] },
    { tag: 'path', attrs: { d: 'M0 0L100 100', stroke: '#123456' }, children: [] },
  ] };
  const deck = createDeck();
  deck.assets = [{ id: 'source', name: 'plot.svg', mime: 'image/svg+xml', width: 200, height: 100,
    svgDocument, dataUrl: svgDataURL(svgDocument), sourceKind: 'linked', relativePath: 'results/plot.svg', fingerprint: 'a'.repeat(64) }];
  deck.slides[0].items = ['a', 'b'].map((id, index) => ({ id, type: 'image', assetId: 'source', x: index * 220, y: 0, width: 200, height: 100 }));
  return validateDeck(deck);
}

test('SVG inspection pages original paths and bounds potentially large values', () => {
  const deck = fixture(), asset = deck.assets[0];
  const view = inspectSVG(deck, { slideId: deck.activeSlideId, itemId: 'a', offset: 2, limit: 2 });
  assert.equal(view.totalNodes, 5);
  assert.equal(view.nextOffset, 4);
  assert.deepEqual(view.nodes.map(row => row.path), [[1], [1, 1]]);
  assert.deepEqual(view.nodes[0].textSegments.map(row => [row.index, row.text]), [[0, 'Fe '], [2, ' 边']]);
  assert.ok(view.nodes[0].editableAttributes.includes('font-size'));
  assert.ok(!JSON.stringify(view).includes('base64'));
  asset.svgDocument.children[2].attrs.d = 'M0 0 '.repeat(1000);
  asset.svgDocument.children[1].children[0] = 'a'.repeat(3000);
  const long = inspectSVGAsset(asset, { offset: 2, limit: 3 });
  assert.equal(long.nodes[0].textSegments[0].text.length, 2000);
  assert.equal(long.nodes[0].textSegments[0].truncated, true);
  assert.deepEqual(long.nodes[2].truncatedAttributes, ['d']);
  assert.throws(() => inspectSVGAsset(asset, { limit: 101 }));
  assert.throws(() => inspectSVGAsset(asset, { offset: -1 }));
});

test('SVG patch preserves mixed text structure, overrides stylesheet, and derives only one placement', () => {
  const deck = fixture(), before = structuredClone(deck);
  const result = prepareBatch(deck, [{ op: 'edit_svg', slideId: deck.activeSlideId, itemId: 'a', assetId: 'source', patches: [
    { path: [1], attributes: { 'font-size': '24', fill: '#aa0000' }, textIndex: 2, text: ' edge μ' },
    { path: [2], attributes: { stroke: '#cc0000', 'stroke-width': '2' } },
  ] }]);
  const derived = result.project.assets.at(-1), text = derived.svgDocument.children[1];
  assert.deepEqual(text.children, ['Fe ', before.assets[0].svgDocument.children[1].children[1], ' edge μ']);
  assert.match(text.attrs.style, /font-size:24 !important/);
  assert.match(text.attrs.style, /fill:#aa0000 !important/);
  assert.equal(derived.dataUrl, svgDataURL(derived.svgDocument));
  assert.equal(derived.sourceKind, 'copy');
  for (const key of ['relativePath', 'fingerprint', 'mcpRootId', 'linkToken']) assert.equal(key in derived, false);
  assert.equal(derived.originalDataUrl, before.assets[0].dataUrl);
  assert.deepEqual(result.createdAssetIds, [derived.id]);
  assert.equal(result.project.slides[0].items[0].assetId, derived.id);
  assert.equal(result.project.slides[0].items[1].assetId, 'source');
  assert.deepEqual(result.project.assets[0], before.assets[0]);
  assert.deepEqual(deck, before);
});

test('unsafe or malformed SVG patches fail atomically, including stale assets and locked objects', () => {
  const deck = fixture(), before = structuredClone(deck), source = deck.assets[0];
  const good = { path: [1], attributes: { fill: '#112233' } };
  for (const patch of [
    { path: [999], attributes: { fill: 'red' } }, { path: [1, 0], attributes: { fill: 'red' } },
    { path: [-1], attributes: { fill: 'red' } }, { path: [1], attributes: { onclick: 'alert(1)' } },
    { path: [1], attributes: { style: 'fill:red' } }, { path: [1], attributes: { fill: 'url(https://example.com/a)' } },
    { path: [1], attributes: { fill: 'red;stroke:blue' } }, { path: [1], attributes: { fill: 'r/**/ed' } },
    { path: [1], attributes: { fill: 3 } }, { path: [1], attributes: {} },
    { path: [1], textIndex: 1, text: 'flatten' }, { path: [2], textIndex: 0, text: 'path is not text' },
    { path: [1], text: 'no index' }, { path: [1], textIndex: 0, text: '\u0000' },
  ]) {
    assert.throws(() => patchSVGAsset(source, [good, patch], 'new'));
    assert.deepEqual(deck, before);
  }
  const operation = { op: 'edit_svg', slideId: deck.activeSlideId, itemId: 'a', assetId: 'source', patches: [good] };
  assert.throws(() => prepareBatch(deck, [{ ...operation, assetId: 'wrong' }]), /asset changed/);
  assert.throws(() => prepareBatch(deck, [operation, { ...operation, itemId: 'b', patches: [{ path: [8] }] }]));
  assert.deepEqual(deck, before);
  deck.slides[0].items[0].locked = true;
  assert.throws(() => prepareBatch(deck, [operation]), /locked/);
});
