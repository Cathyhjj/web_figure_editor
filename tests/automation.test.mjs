import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addSlide, createDeck, validateDeck } from '../deck.js';
import { prepareBatch, describeProject } from '../automation.js';
import { svgDataURL } from '../svg-vector.js';

function fixture() {
  const deck = createDeck();
  deck.slides[0].items = ['a', 'b', 'c'].map((id, n) => ({ id, type: 'text', x: n * 100, y: n * 30, width: 40, height: 20, text: id }));
  return validateDeck(deck);
}
const op = (deck, operation) => ({ slideId: deck.activeSlideId, ...operation });

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';

function vectorDeck() {
  const deck = createDeck();
  const svgDocument = { tag: 'svg', attrs: { width: '1000', height: '500' }, children: [] };
  deck.slides[0].canvas = { width: 1000, height: 400, background: '#ffffff' };
  deck.assets.push({ id: 'vector', name: 'plot.svg', mime: 'image/svg+xml', width: 1000, height: 500,
    svgDocument, dataUrl: svgDataURL(svgDocument), relativePath: 'panels/plot.svg', sourceKind: 'linked' });
  return validateDeck(deck);
}

test('place_asset uses Place defaults and retains the source for each media type', () => {
  const deck = vectorDeck();
  const poster = { posterDataUrl: png, posterWidth: 1, posterHeight: 1 };
  const mp4 = readFileSync(new URL('./fixtures/video.mp4', import.meta.url));
  deck.assets.push(
    { id: 'chart', name: 'chart.html', mime: 'text/html', width: 960, height: 600,
      dataUrl: 'data:text/html;base64,' + btoa('<!doctype html><html></html>'), ...poster, hasSnapshot: true },
    { id: 'movie', name: 'movie.mp4', mime: 'video/mp4', width: 320, height: 180,
      dataUrl: 'data:video/mp4;base64,' + mp4.toString('base64'), ...poster, duration: 6 },
    { id: 'raster', name: 'pixel.png', mime: 'image/png', width: 1, height: 1, dataUrl: png }
  );
  // Leave a different-sized slide active while placing objects on the first.
  addSlide(deck).canvas.width = 200;
  const source = validateDeck(deck), before = structuredClone(source);
  const result = prepareBatch(source, source.assets.map(asset => ({ op: 'place_asset', slideId: source.slides[0].id, assetId: asset.id })));
  const items = result.project.slides[0].items;
  assert.deepEqual(items.map(({ assetId, type, name, x, y, width, height }) => [assetId, type, name, x, y, width, height]), [
    ['vector', 'image', 'plot.svg', 60, 60, 430, 215],
    ['chart', 'html', 'chart.html', 78, 78, 416, 260],
    ['movie', 'video', 'movie.mp4', 96, 96, 320, 180],
    ['raster', 'image', 'pixel.png', 114, 114, 1, 1],
  ]);
  assert.deepEqual(result.createdItemIds, items.map(item => item.id));
  assert.equal(new Set(result.createdItemIds).size, 4);
  assert.deepEqual(result.changedItemIds, result.createdItemIds);
  assert.deepEqual(result.project.assets, before.assets);
  assert.deepEqual(result.project.slides[1], before.slides[1]);
  assert.deepEqual(source, before);
});

test('place_asset preserves the aspect ratio for one dimension and accepts explicit frames', () => {
  const deck = vectorDeck();
  const placements = [
    { name: 'Panel A', x: 20, y: 40, width: 160, rotation: 15, opacity: 0.5 },
    { height: 100 },
    { width: 250, height: 250 },
    {},
  ];
  const result = prepareBatch(deck, placements.map(properties => op(deck, { op: 'place_asset', assetId: 'vector', properties })));
  const items = result.project.slides[0].items;
  assert.deepEqual(items.map(item => [item.width, item.height]), [[160, 80], [200, 100], [250, 250], [430, 215]]);
  assert.ok(items.every(item => item.assetId === 'vector'));
  const { name, x, y, rotation, opacity } = items[0];
  assert.deepEqual({ name, x, y, rotation, opacity }, { name: 'Panel A', x: 20, y: 40, rotation: 15, opacity: 0.5 });
  assert.deepEqual(result.project.assets, deck.assets);
});

test('invalid placements reject the entire batch without modifying library or slide', () => {
  const deck = vectorDeck(), before = structuredClone(deck);
  const place = op(deck, { op: 'place_asset', assetId: 'vector' });
  for (const override of [{ assetId: 'missing' }, { properties: { text: 'invalid' } },
    { properties: { width: 0 } }, { properties: { width: 0.01 } }, { properties: { height: 100000 } },
    { properties: { assetId: 'other' } }, { properties: { opacity: 2 } },
    { properties: null }]) {
    assert.throws(() => prepareBatch(deck, [place, { ...place, ...override }]));
    assert.deepEqual(deck, before);
  }
});

test('batch layout changes a candidate only and precisely spaces objects', () => {
  const deck = fixture(), before = structuredClone(deck);
  const result = prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['a', 'b', 'c'], properties: { width: 50, fontSize: 16 } }),
    op(deck, { op: 'align', itemIds: ['a', 'b', 'c'], alignment: 'top' }),
    op(deck, { op: 'distribute', itemIds: ['a', 'b', 'c'], axis: 'x', gap: 12 })]);
  assert.deepEqual(deck, before);
  assert.deepEqual(result.project.slides[0].items.map(i => [i.x, i.y, i.width, i.fontSize]), [[0, 0, 50, 16], [62, 0, 50, 16], [124, 0, 50, 16]]);
  assert.deepEqual(result.changedItemIds, ['a', 'b', 'c']);
});

test('late invalid operations and locked objects leave the source untouched', () => {
  for (const invalid of [{ op: 'set', itemIds: ['missing'], properties: { x: 5 } },
    { op: 'set', itemIds: ['a'], properties: { width: -1 } },
    { op: 'set', itemIds: ['a'], properties: { assetId: 'evil' } },
    { op: 'set', itemIds: ['a', 'a'], properties: { x: 3 } }]) {
    const deck = fixture(), before = structuredClone(deck);
    assert.throws(() => prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['a'], properties: { x: 70 } }), op(deck, invalid)]));
    assert.deepEqual(deck, before);
  }
  const deck = fixture(); deck.slides[0].items[1].locked = true;
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a', 'b'], alignment: 'left' })]), /locked/);
});

test('add_text creates unique IDs, cross-slide edits are explicit, and rotation is guarded', () => {
  const deck = fixture();
  const next = prepareBatch(deck, [op(deck, { op: 'add_text', properties: { text: '(a)', x: 10, y: 20 } })]);
  assert.equal(next.createdItemIds.length, 1);
  assert.equal(next.project.slides[0].items.at(-1).text, '(a)');
  assert.throws(() => prepareBatch(deck, [{ op: 'set', slideId: 'other', itemIds: ['a'], properties: { x: 8 } }]), /Unknown slide/);
  deck.slides[0].items[0].rotation = 15;
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a', 'b'], alignment: 'left' })]), /unrotated/);
});

test('single media dimension preserves aspect ratio; state excludes embedded asset data', () => {
  const deck = fixture();
  deck.assets = [{ id: 'image', name: 'panel.png', mime: 'image/png', width: 1, height: 1,
    dataUrl: png }];
  deck.slides[0].items.push({ id: 'picture', type: 'image', assetId: 'image', x: 0, y: 0, width: 100, height: 50 });
  const next = prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['picture'], properties: { width: 200 } })]);
  assert.equal(next.project.slides[0].items.at(-1).height, 100);
  const state = describeProject(next.project);
  assert.equal(state.assets[0].name, 'panel.png');
  assert.equal(JSON.stringify(state).includes('base64'), false);
  assert.equal('dataUrl' in state.assets[0], false);
});

test('shared layout supports right/bottom alignment and vertical fixed spacing without expanding the AI vocabulary', () => {
  const deck = fixture();
  const aligned = prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a', 'b', 'c'], alignment: 'right' }),
    op(deck, { op: 'align', itemIds: ['b', 'c'], alignment: 'bottom' })]).project.slides[0].items;
  assert.deepEqual(aligned.map(item => item.x), [200, 200, 200]);
  assert.deepEqual(aligned.map(item => item.y), [0, 60, 60]);
  const spaced = prepareBatch(deck, [op(deck, { op: 'distribute', itemIds: ['c', 'a', 'b'], axis: 'y', gap: 3 * 96 / 25.4 })]).project.slides[0].items;
  assert.equal(spaced[0].y, 0);
  assert.ok(Math.abs(spaced[1].y - spaced[0].y - spaced[0].height - 3 * 96 / 25.4) < 1e-9);
  assert.ok(Math.abs(spaced[2].y - spaced[1].y - spaced[1].height - 3 * 96 / 25.4) < 1e-9);
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'match_size', itemIds: ['a', 'b'] })]), /Supported operations/);
});

test('single AI alignment still aligns to the canvas and invalid spacing leaves the source unchanged', () => {
  const deck = fixture(), before = structuredClone(deck);
  const aligned = prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a'], alignment: 'right' }),
    op(deck, { op: 'align', itemIds: ['a'], alignment: 'bottom' })]).project.slides[0].items[0];
  assert.equal(aligned.x + aligned.width, deck.slides[0].canvas.width);
  assert.equal(aligned.y + aligned.height, deck.slides[0].canvas.height);
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'distribute', itemIds: ['a', 'b', 'c'], axis: 'x', gap: 100000 })]), /between/);
  assert.deepEqual(deck, before);
});
