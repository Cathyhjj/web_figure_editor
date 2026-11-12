import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addSlide, createDeck, validateDeck } from '../deck.js';
import { prepareBatch, describeProject } from '../automation.js';
import { svgDataURL } from '../svg-vector.js';
import { imageContentRect, cropImage } from '../crop.js';

function fixture() {
  const deck = createDeck();
  deck.slides[0].items = ['a', 'b', 'c'].map((id, n) => ({ id, type: 'text', x: n * 100, y: n * 30, width: 40, height: 20, text: id }));
  return validateDeck(deck);
}
const op = (deck, operation) => ({ slideId: deck.activeSlideId, ...operation });

test('object operations preserve stacking, isolate copies, and require explicit unlock', () => {
  const deck = fixture(), before = structuredClone(deck);
  deck.slides[0].items[0].locked = true;
  const result = prepareBatch(deck, [
    op(deck, { op: 'set_locked', itemIds: ['a'], locked: false }),
    op(deck, { op: 'duplicate', itemIds: ['c', 'a'], offsetX: 7, offsetY: -3 }),
    op(deck, { op: 'set_hidden', itemIds: ['b'], hidden: true }),
    op(deck, { op: 'reorder', itemIds: ['c', 'a'], direction: 'front' }),
    op(deck, { op: 'delete', itemIds: ['b'] }),
  ]);
  const items = result.project.slides[0].items;
  assert.deepEqual(items.slice(-2).map(item => item.id), ['a', 'c']);
  assert.deepEqual(result.duplicatedItems.map(item => item.sourceItemId), ['a', 'c']);
  assert.deepEqual(result.createdItemIds, items.slice(0, 2).map(item => item.id));
  assert.deepEqual(result.deletedItemIds, ['b']);
  assert.deepEqual(items.slice(0, 2).map(item => [item.text, item.x, item.y]), [['a', 7, -3], ['c', 207, 57]]);
  assert.equal(deck.slides[0].items[0].locked, true);
  assert.deepEqual(deck.slides[0].items.slice(1), before.slides[0].items.slice(1));
});

test('layer moves keep relative order for adjacent and nonadjacent selections', () => {
  const deck = fixture();
  deck.slides[0].items.push({ ...deck.slides[0].items[0], id: 'd' });
  for (const [ids, direction, expected] of [
    [['a', 'b'], 'forward', ['c', 'a', 'b', 'd']],
    [['b', 'd'], 'backward', ['b', 'a', 'd', 'c']],
    [['d', 'b'], 'back', ['b', 'd', 'a', 'c']],
    [['d', 'b'], 'front', ['a', 'c', 'b', 'd']],
  ]) assert.deepEqual(prepareBatch(deck, [op(deck, { op: 'reorder', itemIds: ids, direction })]).project.slides[0].items.map(item => item.id), expected);
});

test('locked, missing, or malformed object operations reject the whole candidate', () => {
  const deck = fixture(); deck.slides[0].items[1].locked = true;
  const before = structuredClone(deck);
  for (const operation of [
    { op: 'delete', itemIds: ['a', 'b'] }, { op: 'duplicate', itemIds: ['a', 'b'] },
    { op: 'set_hidden', itemIds: ['b'], hidden: true }, { op: 'reorder', itemIds: ['b'], direction: 'back' },
    { op: 'set_locked', itemIds: ['a'], locked: 'false' }, { op: 'set_hidden', itemIds: ['a'], hidden: 0 },
    { op: 'duplicate', itemIds: ['a'], offsetX: Infinity }, { op: 'reorder', itemIds: ['a'], direction: 'invalid' },
    { op: 'delete', itemIds: ['missing'] },
  ]) {
    assert.throws(() => prepareBatch(deck, [op(deck, { op: 'delete', itemIds: ['c'] }), op(deck, operation)]));
    assert.deepEqual(deck, before);
  }
});

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

function swapFixture() {
  const deck = vectorDeck();
  deck.assets.push({ id: 'revision', name: 'plot.png', mime: 'image/png', width: 200, height: 400, dataUrl: png });
  const panel = { id: 'panel', name: 'EXAFS fit', type: 'image', assetId: 'vector', x: 70, y: 40, width: 240, height: 120,
    rotation: 20, opacity: 0.8, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, strokeWidth: 2, stroke: '#ff0000' };
  deck.slides[0].items.push(panel, { id: 'label', type: 'text', x: 74, y: 44, width: 20, height: 20, text: 'b' });
  addSlide(deck).items.push({ ...panel, id: 'other' });
  return validateDeck(deck);
}

test('replace_asset preserves crop, frame, fit and effects on explicit placements across slides', () => {
  const deck = swapFixture();
  deck.slides[1].items[0].imageFit = 'contain';
  const before = structuredClone(deck);
  const result = prepareBatch(deck, deck.slides.map(page => ({ op: 'replace_asset', slideId: page.id,
    itemIds: page.items.filter(item => item.type === 'image').map(item => item.id), assetId: 'revision' })));
  for (let n = 0; n < deck.slides.length; n++) {
    assert.deepEqual(result.project.slides[n].items[0], { ...before.slides[n].items[0], assetId: 'revision' });
  }
  assert.equal(result.assetReplacements.length, 2);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every(row => row.code === 'source_aspect_changed'));
  assert.deepEqual(result.project.assets, before.assets);
  assert.deepEqual(deck, before);
  deck.slides[1].items[0].locked = true;
  const locked = structuredClone(deck);
  assert.throws(() => prepareBatch(deck, deck.slides.map(page => ({ op: 'replace_asset', slideId: page.id,
    itemIds: [page.items[0].id], assetId: 'revision' }))), /locked/);
  assert.deepEqual(deck, locked);
  for (const itemIds of [['panel', 'label'], ['missing'], ['panel', 'panel']])
    assert.throws(() => prepareBatch(deck, [{ op: 'replace_asset', slideId: deck.slides[0].id, itemIds, assetId: 'revision' }]));
  assert.throws(() => prepareBatch(deck, [{ op: 'replace_asset', slideId: deck.slides[0].id, itemIds: ['panel'], assetId: 'vector' }]), /already uses/);
});

test('swap_asset retains frame, layer and styling, and fits the full replacement on only the named slide', () => {
  const deck = swapFixture(), before = structuredClone(deck), slide = deck.slides[0];
  const { project, changedItemIds, createdItemIds } = prepareBatch(deck, [
    { op: 'swap_asset', slideId: slide.id, itemId: 'panel', assetId: 'revision' },
  ]);
  const { crop, ...frame } = slide.items[0];
  const expected = { ...frame, assetId: 'revision', imageFit: 'contain' };
  assert.deepEqual(project.slides[0].items, [expected, slide.items[1]]);
  assert.deepEqual(project.slides[1], before.slides[1]);
  assert.deepEqual(project.assets, before.assets);
  assert.deepEqual(deck, before);
  assert.deepEqual(changedItemIds, ['panel']);
  assert.deepEqual(createdItemIds, []);
  assert.deepEqual(imageContentRect(expected, project.assets[1]), { x: 90, y: 0, width: 60, height: 120 });
  assert.deepEqual(validateDeck(JSON.parse(JSON.stringify(project))).slides[0].items[0], expected);
  const again = prepareBatch(project, [{ op: 'swap_asset', slideId: slide.id, itemId: 'panel', assetId: 'vector' }]);
  assert.deepEqual(imageContentRect(again.project.slides[0].items[0], deck.assets[0]), { x: 0, y: 0, width: 240, height: 120 });
  const recrop = cropImage(expected, { x: 0, y: 0.25, width: 1, height: 0.5 });
  assert.deepEqual(imageContentRect(recrop, project.assets[1]), { x: 60, y: 0, width: 120, height: 120 });
  assert.deepEqual(cropImage(recrop), expected);
});

test('invalid swaps leave the original project and earlier operations untouched', () => {
  const deck = swapFixture(), slideId = deck.slides[0].id;
  deck.slides[1].items[0].locked = true;
  const before = structuredClone(deck);
  const swap = { op: 'swap_asset', slideId, itemId: 'panel', assetId: 'revision' };
  for (const [overrides, message] of [
    [{ assetId: 'missing' }, /Unknown asset/], [{ itemId: 'label' }, /image object/],
    [{ assetId: 'vector' }, /already uses/], [{ itemId: 'other', slideId: deck.activeSlideId }, /locked/],
    [{ slideId: deck.activeSlideId }, /does not exist/], [{ itemIds: ['panel'] }, /Unsupported/],
  ]) {
    assert.throws(() => prepareBatch(deck, [{ op: 'set', slideId, itemIds: ['label'], properties: { text: 'new' } },
      { ...swap, ...overrides }]), message);
    assert.deepEqual(deck, before);
  }
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
