import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, projectToSVG } from '../core.js';
import { createDeck, validateDeck, cloneDeck, currentSlide, slideProject, serializeDeck, deckSourceManifest, addSlide, duplicateSlide, deleteSlide } from '../deck.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const image = () => ({ id: 'asset-a', name: 'original.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 1, height: 1, size: 68, lastModified: 42, sourceKind: 'linked', linkToken: 'binding-a', fingerprint: 'sha256-original' });
const text = (id = 'text-a', value = 'First slide') => ({ id, type: 'text', x: 20, y: 30, width: 200, height: 40, text: value, fontSize: 20 });
const legacy = () => ({ ...createProject(), id: 'legacy-a', name: 'Research figure', assets: [image()], items: [text(), { id: 'image-a', type: 'image', x: 100, y: 80, width: 120, height: 120, assetId: 'asset-a' }] });

test('new decks start with one independent empty slide', () => {
  const deck = createDeck();
  const other = createDeck();
  assert.equal(deck.version, 2);
  assert.equal(deck.slides.length, 1);
  assert.equal(currentSlide(deck).id, deck.activeSlideId);
  assert.equal(currentSlide(deck).name, 'Slide 1');
  currentSlide(deck).canvas.width = 123;
  assert.equal(currentSlide(other).canvas.width, 960);
});

test('v1 migrates without losing original material, geometry, or editable content', () => {
  const original = legacy();
  const deck = validateDeck(original);
  assert.equal(deck.version, 2);
  assert.equal(deck.id, original.id);
  assert.equal(deck.name, original.name);
  assert.equal(deck.slides.length, 1);
  assert.equal(currentSlide(deck).items[0].text, 'First slide');
  assert.equal(currentSlide(deck).items[1].assetId, original.assets[0].id);
  assert.deepEqual(deck.assets[0], original.assets[0]);
  currentSlide(deck).items[0].x = 999;
  assert.equal(original.items[0].x, 20);
});

test('multi-slide serialization round-trips active slide, independent canvases, and one shared asset registry', () => {
  const deck = validateDeck(legacy());
  const second = addSlide(deck);
  second.canvas.width = 640;
  second.items.push(text('second-text', 'Second slide'));
  const file = serializeDeck(deck);
  const reopened = validateDeck(JSON.parse(file));
  assert.deepEqual(reopened, validateDeck(deck));
  assert.equal(reopened.activeSlideId, second.id);
  assert.equal(reopened.slides[0].canvas.width, 960);
  assert.equal(reopened.slides[1].canvas.width, 640);
  assert.equal(file.split('data:image/png;base64,').length - 1, 1);
});

test('blank and duplicate slides insert after active; duplicates have independent objects and identities', () => {
  const deck = validateDeck(legacy());
  const first = currentSlide(deck);
  const last = addSlide(deck);
  assert.deepEqual(last.canvas, first.canvas);
  assert.notEqual(last.canvas, first.canvas);
  assert.deepEqual(last.items, []);
  deck.activeSlideId = first.id;
  const copy = duplicateSlide(deck);
  assert.deepEqual(deck.slides.map(slide => slide.id), [first.id, copy.id, last.id]);
  assert.equal(deck.activeSlideId, copy.id);
  assert.notEqual(copy.items[0].id, first.items[0].id);
  assert.notEqual(copy.items[1].id, first.items[1].id);
  assert.equal(copy.items[1].assetId, first.items[1].assetId);
  assert.equal(deck.assets.length, 1);
  copy.canvas.background = '#000000';
  copy.items[0].text = 'Changed duplicate';
  copy.items[1].x = 400;
  assert.equal(first.canvas.background, '#ffffff');
  assert.equal(first.items[0].text, 'First slide');
  assert.equal(first.items[1].x, 100);
  assert.doesNotThrow(() => validateDeck(deck));
});

test('undo snapshots copy all mutable deck records while keeping binary strings intact', () => {
  const deck = validateDeck(legacy());
  const snapshot = cloneDeck(deck);
  deck.assets[0].linkToken = 'replacement-binding';
  currentSlide(deck).name = 'Renamed';
  currentSlide(deck).canvas.height = 123;
  currentSlide(deck).items[0].text = 'Changed';
  addSlide(deck);
  assert.equal(snapshot.assets[0].linkToken, 'binding-a');
  assert.equal(snapshot.slides.length, 1);
  assert.equal(currentSlide(snapshot).name, 'Slide 1');
  assert.equal(currentSlide(snapshot).canvas.height, 640);
  assert.equal(currentSlide(snapshot).items[0].text, 'First slide');
  assert.equal(snapshot.assets[0].dataUrl, deck.assets[0].dataUrl);
});

test('delete selects adjacent slide, keeps original assets, and refuses to delete the last', () => {
  const deck = validateDeck(legacy());
  const first = currentSlide(deck);
  const second = addSlide(deck);
  const third = addSlide(deck);
  deck.activeSlideId = second.id;
  assert.equal(deleteSlide(deck).id, third.id);
  assert.equal(deleteSlide(deck).id, first.id);
  assert.equal(deck.assets.length, 1);
  assert.throws(() => deleteSlide(deck), /last slide/);
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.activeSlideId, first.id);
});

test('v1 export view is scoped to the requested slide and preserves live editable references', () => {
  const deck = validateDeck(legacy());
  const firstId = deck.activeSlideId;
  const second = addSlide(deck);
  second.items.push(text('second-text', 'Second slide only'));
  const activeView = slideProject(deck);
  assert.equal(activeView.version, 1);
  assert.equal(activeView.assets, deck.assets);
  assert.equal(activeView.canvas, second.canvas);
  assert.equal(activeView.items, second.items);
  const svg = projectToSVG(activeView);
  assert.match(svg, /Second slide only/);
  assert.equal(svg.includes('First slide'), false);
  assert.equal(svg.includes('<image '), false);
  const firstSVG = projectToSVG(slideProject(deck, firstId));
  assert.match(firstSVG, /First slide/);
  assert.equal(firstSVG.includes('Second slide only'), false);
  assert.throws(() => slideProject(deck, 'missing'), /does not exist/);
});

test('source manifest tracks cross-slide image usage and records portable copies only once', () => {
  const deck = validateDeck(legacy());
  duplicateSlide(deck);
  currentSlide(deck).items[1].hidden = true;
  const manifest = deckSourceManifest(deck);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.slides.length, 2);
  assert.equal(manifest.sources.length, 1);
  assert.equal(manifest.sources[0].usedBy.length, 2);
  assert.equal(manifest.sources[0].usedBy[1].hidden, true);
  assert.notEqual(manifest.sources[0].usedBy[0].slideId, manifest.sources[0].usedBy[1].slideId);
  assert.equal(manifest.sources[0].linkToken, 'binding-a');
  assert.equal(manifest.sources[0].dataUrl, undefined);
  assert.equal(manifest.slides[0].canvas.widthMM, 254);
  assert.match(manifest.exportNotes.slides, /only the selected slide/);
});

test('rejects unsupported versions, bad slide identity/active state, missing assets, and cross-slide duplicate items', () => {
  for (const mutate of [
    deck => deck.version = 3,
    deck => deck.format = 'other',
    deck => deck.id = '../bad',
    deck => deck.slides = [],
    deck => deck.slides[0].id = '<script>',
    deck => deck.slides.push({ ...deck.slides[0] }),
    deck => deck.activeSlideId = 'missing',
    deck => delete deck.activeSlideId,
    deck => deck.slides[0].canvas.width = NaN,
    deck => deck.slides[0].items[1].assetId = 'missing',
    deck => deck.assets[0].dataUrl = 'https://example.com/image.png',
    deck => { const items = deck.slides[0].items; addSlide(deck).items = items; },
  ]) {
    const deck = validateDeck(legacy());
    mutate(deck);
    assert.throws(() => validateDeck(deck));
  }
});

test('enforces slide and aggregate object limits without partial mutation', () => {
  const full = createDeck();
  for (let i = 1; i < 100; i++) addSlide(full);
  assert.equal(validateDeck(full).slides.length, 100);
  assert.throws(() => addSlide(full), /100 slides/);
  assert.throws(() => duplicateSlide(full), /100 slides/);
  assert.equal(full.slides.length, 100);
  const tooMany = cloneDeck(full);
  tooMany.slides.push({ id: 'extra-slide', name: 'Extra', canvas: { ...tooMany.slides[0].canvas }, items: [] });
  assert.throws(() => validateDeck(tooMany), /1–100 slides/);
  const manyItems = createDeck();
  for (let s = 0; s < 5; s++) {
    if (s) addSlide(manyItems);
    currentSlide(manyItems).items = Array.from({ length: 2000 }, (_, i) => text(`item-${s}-${i}`));
  }
  assert.doesNotThrow(() => validateDeck(manyItems));
  assert.throws(() => duplicateSlide(manyItems), /10,000 objects/);
  assert.equal(manyItems.slides.length, 5);
  currentSlide(manyItems).items.push(text('one-too-many'));
  assert.throws(() => validateDeck(manyItems), /10,000 objects/);
});

test('shared asset bytes are checked once per validation batch, while later-slide references are still checked', () => {
  const deck = validateDeck(legacy());
  for (let i = 0; i < 9; i++) addSlide(deck);
  let reads = 0;
  const dataUrl = deck.assets[0].dataUrl;
  Object.defineProperty(deck.assets[0], 'dataUrl', { enumerable: true, get() { reads++; return dataUrl; } });
  validateDeck(deck);
  assert.equal(reads, 1);
  currentSlide(deck).items.push({ id: 'invalid-image', type: 'image', x: 0, y: 0, width: 100, height: 100, assetId: 'not-shared' });
  assert.throws(() => validateDeck(deck), /missing asset/);
});
