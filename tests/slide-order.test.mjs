import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, validateDeck, moveSlides, serializeDeck, deckSourceManifest } from '../deck.js';
import { pptxLayout } from '../pptx.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
function fixture() {
  const deck = createDeck();
  deck.id = 'slide-order-project';
  deck.name = 'Slide ordering';
  deck.assets = [{
    id: 'shared-asset', name: 'original.svg', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`,
    width: 1, height: 1, size: 68, lastModified: 42, sourceKind: 'linked', linkToken: 'local-link',
    linkPersistence: 'browser', relativePath: 'source/original.svg', fingerprint: 'source-fingerprint',
    originalMime: 'image/svg+xml', originalDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', rasterized: true,
  }];
  deck.slides = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
    id, name: `Slide ${id}`, canvas: { width: 600 + index * 20, height: 400, background: index % 2 ? '#ffffff' : 'transparent' },
    items: index === 2 ? [] : [{
      id: `image-${id}`, type: 'image', name: `Image ${id}`, assetId: 'shared-asset',
      x: 5 + index, y: 30, width: 100, height: 50, opacity: .7, rotation: 12, hidden: index === 1, locked: index === 3,
      crop: { x: .1, y: .2, width: .5, height: .4 }, shadow: { enabled: true, distance: 5 },
    }],
  }));
  deck.activeSlideId = 'c';
  return validateDeck(deck);
}
const order = deck => deck.slides.map(slide => slide.id);

test('single-slide moves use original-order boundaries for forward, backward, front and end drops', () => {
  for (const [id, boundary, expected] of [
    ['b', 4, ['a', 'c', 'd', 'b', 'e']],
    ['d', 1, ['a', 'd', 'b', 'c', 'e']],
    ['c', 0, ['c', 'a', 'b', 'd', 'e']],
    ['a', 5, ['b', 'c', 'd', 'e', 'a']],
  ]) {
    const deck = fixture();
    assert.equal(moveSlides(deck, new Set([id]), boundary), true);
    assert.deepEqual(order(deck), expected);
    assert.equal(deck.activeSlideId, 'c');
  }
});

test('group moves preserve source order even when selected IDs arrive in reverse order', () => {
  for (const [selected, boundary, expected] of [
    [['c', 'b'], 5, ['a', 'd', 'e', 'b', 'c']],
    [['d', 'c'], 0, ['c', 'd', 'a', 'b', 'e']],
    [['d', 'b'], 5, ['a', 'c', 'e', 'b', 'd']],
    [['e', 'b'], 1, ['a', 'b', 'e', 'c', 'd']],
    [['d', 'b'], 3, ['a', 'c', 'b', 'd', 'e']],
  ]) {
    const deck = fixture();
    assert.equal(moveSlides(deck, new Set(selected), boundary), true);
    assert.deepEqual(order(deck), expected);
  }
});

test('own-range and all-selected drops are no-ops and retain the original slides array', () => {
  for (const [selected, boundaries] of [
    [['c'], [2, 3]],
    [['b', 'c', 'd'], [1, 2, 3, 4]],
    [['a', 'b'], [0, 1, 2]],
    [['d', 'e'], [3, 4, 5]],
    [['e', 'c', 'a', 'd', 'b'], [0, 1, 2, 3, 4, 5]],
  ]) for (const boundary of boundaries) {
    const deck = fixture(), originalSlides = deck.slides, before = structuredClone(deck);
    assert.equal(moveSlides(deck, new Set(selected), boundary), false);
    assert.equal(deck.slides, originalSlides);
    assert.deepEqual(deck, before);
  }
});

test('invalid selections and boundaries reject atomically without replacing any arrays or records', () => {
  for (const [ids, boundary] of [
    [[], 0], [['missing'], 1], [['b', 'missing'], 2],
    [['b'], -1], [['b'], 6], [['b'], 1.5], [['b'], NaN], [['b'], Infinity], [['b'], '2'], [['b'], undefined],
  ]) {
    const deck = fixture(), originalSlides = deck.slides, originalAssets = deck.assets, before = structuredClone(deck);
    assert.throws(() => moveSlides(deck, new Set(ids), boundary));
    assert.equal(deck.slides, originalSlides);
    assert.equal(deck.assets, originalAssets);
    assert.deepEqual(deck, before);
  }
});

test('reorder preserves every slide, object, canvas, crop, shadow and source-asset reference and byte', () => {
  const deck = fixture(), before = structuredClone(deck), originalSlides = deck.slides, originalAssets = deck.assets;
  const references = new Map(deck.slides.map(slide => [slide.id, {
    slide, canvas: slide.canvas, items: slide.items,
    item: slide.items[0], crop: slide.items[0]?.crop, shadow: slide.items[0]?.shadow,
  }]));
  assert.equal(moveSlides(deck, new Set(['e', 'b', 'c']), 0), true);
  assert.notEqual(deck.slides, originalSlides);
  assert.equal(deck.assets, originalAssets);
  assert.deepEqual(deck.assets, before.assets);
  assert.equal(deck.activeSlideId, before.activeSlideId);
  assert.equal(deck.id, before.id);
  assert.equal(deck.name, before.name);
  for (const slide of deck.slides) {
    const previous = references.get(slide.id);
    assert.equal(slide, previous.slide);
    assert.equal(slide.canvas, previous.canvas);
    assert.equal(slide.items, previous.items);
    assert.equal(slide.items[0], previous.item);
    assert.equal(slide.items[0]?.crop, previous.crop);
    assert.equal(slide.items[0]?.shadow, previous.shadow);
    assert.deepEqual(slide, before.slides.find(value => value.id === slide.id));
  }
  assert.deepEqual(order(deck), ['b', 'c', 'e', 'a', 'd']);
  assert.doesNotThrow(() => validateDeck(deck));
});

test('serialization, source manifest and export layout follow the reordered slide array', () => {
  const deck = fixture();
  moveSlides(deck, new Set(['d', 'e']), 0);
  const expected = ['d', 'e', 'a', 'b', 'c'];
  const reopened = validateDeck(JSON.parse(serializeDeck(deck)));
  assert.deepEqual(order(reopened), expected);
  assert.deepEqual(deckSourceManifest(deck).slides.map(slide => slide.id), expected);
  assert.deepEqual(pptxLayout(deck).slides.map(slide => slide.id), expected);
  assert.equal(reopened.activeSlideId, 'c');
});
