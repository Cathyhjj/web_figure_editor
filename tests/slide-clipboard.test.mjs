import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../core.js';
import { createDeck, validateDeck, currentSlide, addSlide } from '../deck.js';
import { SLIDE_CLIPBOARD_MIME, SLIDES_CLIPBOARD_MIME, createSlideClipboard, encodeSlide, decodeSlide, pasteSlide, createSlidesClipboard, encodeSlides, decodeSlides, pasteSlides, encodeSelection, decodeSelection } from '../clipboard.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const image = () => ({
  id: 'asset-a', name: 'original.svg', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`,
  width: 1, height: 1, size: 68, lastModified: 42, sourceKind: 'linked', linkToken: 'binding-a',
  linkPersistence: 'browser', relativePath: 'sources/original.svg', fingerprint: 'original-fingerprint',
  originalMime: 'image/svg+xml', originalDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', rasterized: true, rasterizationScale: 3,
});
const text = (id = 'text-a') => ({ id, type: 'text', x: 20, y: 30, width: 120, height: 40, text: 'A & B\n第二行', fontSize: 20, rotation: 32, opacity: .4 });
function fixture() {
  const deck = validateDeck({ ...createProject(), id: 'project-a', name: 'Whole project',
    canvas: { width: 1234, height: 789, background: '#abcdef' },
    assets: [image(), { ...image(), id: 'unused-a' }],
    items: [text(), { id: 'image-a', type: 'image', x: 100, y: 80, width: 120, height: 60,
      assetId: 'asset-a', rotation: -15, opacity: .8, locked: true, hidden: true,
      crop: { x: .1, y: .2, width: .5, height: .4 }, shadow: { enabled: true, distance: 5 } }],
  });
  currentSlide(deck).name = 'Panel comparison';
  return deck;
}

test('whole-slide snapshots capture the requested slide name, canvas, all objects and only used assets independently', () => {
  const deck = fixture();
  const source = currentSlide(deck);
  addSlide(deck);
  const payload = createSlideClipboard(deck, source.id);
  assert.equal(payload.id, source.id);
  assert.equal(payload.name, 'Panel comparison');
  assert.deepEqual(payload.items, source.items);
  assert.deepEqual(payload.canvas, source.canvas);
  assert.deepEqual(payload.assets.map(asset => asset.id), ['asset-a']);
  source.name = 'Changed';
  source.canvas.width = 1;
  source.items[0].text = 'Changed';
  source.items[1].crop.x = .2;
  source.items[1].shadow.distance = 99;
  deck.assets[0].originalDataUrl = 'Changed';
  assert.equal(payload.name, 'Panel comparison');
  assert.equal(payload.canvas.width, 1234);
  assert.equal(payload.items[0].text, 'A & B\n第二行');
  assert.equal(payload.items[1].crop.x, .1);
  assert.equal(payload.items[1].shadow.distance, 5);
  assert.equal(payload.assets[0].originalDataUrl, image().originalDataUrl);
  assert.throws(() => createSlideClipboard(deck, 'missing'), /does not exist/);
});

test('slide payloads round-trip distinctly from editable selections, including blank slides', () => {
  assert.equal(SLIDE_CLIPBOARD_MIME, 'application/x-figure-editor-slide');
  for (const deck of [fixture(), createDeck()]) {
    const payload = createSlideClipboard(deck);
    assert.deepEqual(decodeSlide(encodeSlide(payload)), payload);
    assert.equal(decodeSelection(encodeSlide(payload)), null);
    assert.equal(decodeSlide(encodeSelection(payload)), null);
    assert.equal(decodeSlide(JSON.stringify(payload)), null);
  }
  for (const ordinary of ['', 'ordinary text', null, undefined]) assert.equal(decodeSlide(ordinary), null);
  assert.throws(() => decodeSlide('Figure Editor slide v1\n{bad'), /slide is damaged/);
  assert.throws(() => decodeSlide('Figure Editor slide v1\n' + ' '.repeat(240 * 1024 * 1024)), /240 MB clipboard limit/);
});

test('decoded slides validate hostile data and discard unknown fields before they enter the deck', () => {
  for (const mutate of [
    p => p.assets[0].dataUrl = 'https://example.org/source.png',
    p => p.items[1].assetId = 'missing',
    p => p.items[0].color = 'url(https://example.org/style)',
    p => p.items[0].x = '20',
    p => p.items.push({ ...p.items[0] }),
    p => p.canvas.width = 0,
  ]) {
    const payload = createSlideClipboard(fixture());
    mutate(payload);
    assert.throws(() => decodeSlide('Figure Editor slide v1\n' + JSON.stringify(payload)), /Invalid figure project/);
  }
  const payload = createSlideClipboard(fixture());
  payload.items[0].onclick = 'alert(1)';
  payload.assets[0].fileHandle = { secret: 'local authority' };
  const decoded = decodeSlide('Figure Editor slide v1\n' + JSON.stringify(payload));
  assert.equal(decoded.items[0].onclick, undefined);
  assert.equal(decoded.assets[0].fileHandle, undefined);
});

test('pasted slides insert after active, activate, preserve appearance and state, and receive independent identities', () => {
  const deck = fixture();
  const original = currentSlide(deck);
  const payload = createSlideClipboard(deck);
  const captured = structuredClone(payload);
  const last = addSlide(deck);
  deck.activeSlideId = original.id;
  const copy = pasteSlide(deck, payload);
  assert.deepEqual(deck.slides.map(slide => slide.id), [original.id, copy.id, last.id]);
  assert.equal(deck.activeSlideId, copy.id);
  assert.equal(currentSlide(deck), copy);
  assert.notEqual(copy.id, payload.id);
  assert.equal(copy.name, payload.name);
  assert.deepEqual(copy.canvas, payload.canvas);
  for (let index = 0; index < copy.items.length; index++) {
    assert.notEqual(copy.items[index].id, payload.items[index].id);
    assert.deepEqual({ ...copy.items[index], id: payload.items[index].id }, payload.items[index]);
  }
  assert.equal(deck.assets.length, 2);
  assert.equal(deck.assets[0].linkToken, 'binding-a');
  copy.items[1].crop.x = .2;
  copy.items[1].shadow.distance = 99;
  copy.canvas.width = 1;
  assert.deepEqual(payload, captured);
  assert.deepEqual(deck.slides[0].items, payload.items);
  assert.deepEqual(deck.slides[0].canvas, payload.canvas);
  const second = pasteSlide(deck, payload);
  assert.notEqual(second.id, copy.id);
  assert.equal(new Set(deck.slides.flatMap(slide => slide.items.map(item => item.id))).size, 6);
});

test('blank-slide paste preserves its canvas and name while importing no unrelated source assets', () => {
  const source = fixture();
  const blank = addSlide(source);
  blank.name = '';
  blank.canvas.background = 'transparent';
  const payload = createSlideClipboard(source);
  assert.deepEqual(payload.items, []);
  assert.deepEqual(payload.assets, []);
  const target = createDeck();
  const result = pasteSlide(target, payload);
  assert.equal(target.slides.length, 2);
  assert.equal(result.name, '');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.canvas, blank.canvas);
  assert.deepEqual(target.assets, []);
});

test('cross-project slides retain original bytes and provenance, strip local link authority and reuse portable assets', () => {
  const payload = createSlideClipboard(fixture());
  const deck = createDeck();
  const first = pasteSlide(deck, payload);
  const asset = deck.assets[0];
  assert.notEqual(asset.id, 'asset-a');
  assert.equal(asset.sourceKind, 'copy');
  assert.equal(asset.linkToken, undefined);
  assert.equal(asset.linkPersistence, undefined);
  assert.deepEqual({ ...asset, id: 'asset-a', sourceKind: 'linked', linkToken: 'binding-a', linkPersistence: 'browser' }, payload.assets[0]);
  assert.equal(first.items[1].assetId, asset.id);
  const second = pasteSlide(deck, payload);
  assert.equal(deck.assets.length, 1);
  assert.equal(second.items[1].assetId, asset.id);
  for (const field of ['name', 'relativePath', 'fingerprint', 'lastModified']) {
    const other = structuredClone(payload);
    other.assets[0][field] = field === 'lastModified' ? 43 : `different-${field}`;
    const count = deck.assets.length;
    pasteSlide(deck, other);
    assert.equal(deck.assets.length, count + 1);
  }
});

test('changed original images and same-ID collisions retain both current and clipboard bytes', () => {
  for (const mutate of [
    asset => asset.width = 2,
    asset => asset.height = 3,
    asset => asset.dataUrl = asset.dataUrl.slice(0, -4) + 'AAA=',
    asset => asset.originalDataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  ]) {
    const deck = fixture();
    const payload = createSlideClipboard(deck);
    mutate(deck.assets[0]);
    const previous = structuredClone(deck.assets[0]);
    const copy = pasteSlide(deck, payload);
    assert.notEqual(copy.items[1].assetId, 'asset-a');
    assert.deepEqual(deck.assets[0], previous);
    const added = deck.assets.find(asset => asset.id === copy.items[1].assetId);
    assert.equal(added.dataUrl, payload.assets[0].dataUrl);
    assert.equal(added.originalDataUrl, payload.assets[0].originalDataUrl);
    assert.equal(added.linkToken, undefined);
  }
});

test('slide paste failures leave all deck state untouched at slide, object and asset limits or invalid input', () => {
  const payload = createSlideClipboard(fixture());
  for (const prepare of [
    deck => { for (let i = 1; i < 100; i++) addSlide(deck); },
    deck => {
      for (let s = 0; s < 5; s++) {
        if (s) addSlide(deck);
        currentSlide(deck).items = Array.from({ length: 2000 }, (_, i) => text(`item-${s}-${i}`));
      }
    },
    deck => deck.assets.push(...Array.from({ length: 500 }, (_, i) => ({ ...image(), id: `asset-${i}` }))),
    deck => currentSlide(deck).canvas.width = 0,
    deck => deck.activeSlideId = 'missing',
  ]) {
    const deck = createDeck();
    prepare(deck);
    const before = structuredClone(deck);
    assert.throws(() => pasteSlide(deck, payload), /Invalid figure/);
    assert.deepEqual(deck, before);
  }
  const deck = createDeck();
  const before = structuredClone(deck);
  payload.items[1].assetId = 'missing';
  assert.throws(() => pasteSlide(deck, payload), /missing asset/);
  assert.deepEqual(deck, before);
});

function batchFixture() {
  const deck = fixture();
  const original = currentSlide(deck);
  const blank = addSlide(deck);
  blank.name = 'Blank separator';
  blank.canvas = { width: 320, height: 240, background: 'transparent' };
  const last = addSlide(deck);
  last.name = 'Shared image';
  last.canvas = { width: 720, height: 480, background: '#123456' };
  last.items = [{ ...structuredClone(original.items[1]), id: 'last-image', x: 10, y: 25 }];
  return deck;
}

test('batch capture follows source slide order, excludes unselected content and snapshots shared assets once', () => {
  const deck = batchFixture();
  const [first, blank, last] = deck.slides;
  const payload = createSlidesClipboard(deck, new Set([last.id, first.id]));
  assert.deepEqual(payload.slides.map(slide => slide.id), [first.id, last.id]);
  assert.equal(payload.activeSlideId, last.id);
  assert.deepEqual(payload.assets.map(asset => asset.id), ['asset-a']);
  assert.deepEqual(createSlidesClipboard(deck).slides.map(slide => slide.id), [last.id]);
  deck.activeSlideId = blank.id;
  assert.equal(createSlidesClipboard(deck, new Set([last.id, first.id])).activeSlideId, last.id);
  deck.activeSlideId = first.id;
  assert.equal(createSlidesClipboard(deck, new Set([last.id, first.id])).activeSlideId, first.id);
  first.canvas.width = 99;
  first.items[1].crop.x = .2;
  first.items[1].shadow.distance = 77;
  deck.assets[0].originalDataUrl = 'changed';
  assert.equal(payload.slides[0].canvas.width, 1234);
  assert.equal(payload.slides[0].items[1].crop.x, .1);
  assert.equal(payload.slides[0].items[1].shadow.distance, 5);
  assert.equal(payload.assets[0].originalDataUrl, image().originalDataUrl);
  assert.throws(() => createSlidesClipboard(deck, new Set()), /at least one slide/);
  assert.throws(() => createSlidesClipboard(deck, new Set([first.id, 'missing'])), /does not exist/);
});

test('batch formats round-trip as v2 while one-slide copies preserve the exact legacy encoding and identities', () => {
  const deck = batchFixture();
  assert.equal(SLIDES_CLIPBOARD_MIME, 'application/x-figure-editor-slides');
  const payload = createSlidesClipboard(deck, new Set(deck.slides.map(slide => slide.id)));
  const encoded = encodeSlides(payload);
  assert.ok(encoded.startsWith('Figure Editor slides v1\n'));
  assert.deepEqual(decodeSlides(encoded), payload);
  assert.equal(decodeSlide(encoded), null);
  assert.equal(decodeSelection(encoded), null);
  for (const slide of deck.slides) {
    const single = createSlidesClipboard(deck, new Set([slide.id]));
    const legacy = createSlideClipboard(deck, slide.id);
    const encodedSingle = encodeSlides(single);
    assert.equal(encodedSingle, encodeSlide(legacy));
    assert.deepEqual(decodeSlide(encodedSingle), legacy);
    const decoded = decodeSlides(encodedSingle);
    assert.equal(decoded.version, 2);
    assert.equal(decoded.activeSlideId, slide.id);
    assert.equal(decoded.slides[0].id, slide.id);
    assert.deepEqual(decoded.slides[0], slide);
    assert.deepEqual(decoded.assets, single.assets);
    assert.deepEqual(validateDeck(decoded), decoded);
  }
  for (const value of ['', 'ordinary text', null, undefined, encodeSelection(createSlideClipboard(deck))]) assert.equal(decodeSlides(value), null);
  assert.throws(() => decodeSlides('Figure Editor slides v1\n{bad'), /slides are damaged/);
  assert.throws(() => decodeSlides('Figure Editor slides v1\n' + JSON.stringify(createProject())), /version 2/);
  assert.throws(() => decodeSlides('Figure Editor slides v1\n' + ' '.repeat(240 * 1024 * 1024)), /240 MB clipboard limit/);
  const broken = structuredClone(payload);
  broken.slides[2].items[0].assetId = 'missing';
  assert.throws(() => decodeSlides('Figure Editor slides v1\n' + JSON.stringify(broken)), /missing asset/);
});

test('batch paste preserves ordered independent slides, activates the last and appends repeated blocks', () => {
  const deck = batchFixture();
  const originalIds = deck.slides.map(slide => slide.id);
  const payload = createSlidesClipboard(deck, new Set([...originalIds].reverse()));
  const before = structuredClone(payload);
  deck.activeSlideId = originalIds[0];
  const inserted = pasteSlides(deck, payload);
  assert.equal(inserted.length, 3);
  assert.deepEqual(deck.slides.map(slide => slide.id), [originalIds[0], ...inserted.map(slide => slide.id), ...originalIds.slice(1)]);
  assert.equal(deck.activeSlideId, inserted[2].id);
  assert.equal(currentSlide(deck), inserted[2]);
  assert.equal(deck.assets.length, 2);
  assert.equal(deck.assets[0].linkToken, 'binding-a');
  for (const [index, slide] of inserted.entries()) {
    assert.ok(!originalIds.includes(slide.id));
    assert.equal(slide, deck.slides[index + 1]);
    assert.deepEqual({ ...slide, id: payload.slides[index].id, items: slide.items.map((item, j) => ({ ...item, id: payload.slides[index].items[j].id })) }, payload.slides[index]);
  }
  inserted[0].items[1].crop.x = .2;
  inserted[0].items[1].shadow.distance = 99;
  inserted[1].canvas.width = 321;
  assert.deepEqual(payload, before);
  assert.equal(deck.slides[0].items[1].crop.x, .1);
  assert.equal(deck.slides[0].items[1].shadow.distance, 5);
  const repeated = pasteSlides(deck, payload);
  assert.deepEqual(deck.slides.map(slide => slide.id), [originalIds[0], ...inserted.map(slide => slide.id), ...repeated.map(slide => slide.id), ...originalIds.slice(1)]);
  assert.equal(deck.activeSlideId, repeated[2].id);
  const ids = deck.slides.flatMap(slide => slide.items.map(item => item.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(deck.slides.map(slide => slide.id)).size, 9);
});

test('cross-project batches import shared originals once, strip local links and preserve source provenance', () => {
  const source = batchFixture();
  const payload = createSlidesClipboard(source, new Set(source.slides.map(slide => slide.id)));
  const deck = createDeck();
  const inserted = pasteSlides(deck, payload);
  assert.equal(deck.assets.length, 1);
  const asset = deck.assets[0];
  assert.equal(asset.sourceKind, 'copy');
  assert.equal(asset.linkToken, undefined);
  assert.equal(asset.linkPersistence, undefined);
  assert.deepEqual({ ...asset, id: 'asset-a', sourceKind: 'linked', linkToken: 'binding-a', linkPersistence: 'browser' }, payload.assets[0]);
  assert.equal(inserted[0].items[1].assetId, asset.id);
  assert.equal(inserted[2].items[0].assetId, asset.id);
  assert.deepEqual(inserted[1].items, []);
  assert.deepEqual(inserted.map(slide => slide.canvas), payload.slides.map(slide => slide.canvas));
  assert.deepEqual(inserted.map(slide => slide.name), payload.slides.map(slide => slide.name));
  pasteSlides(deck, payload);
  assert.equal(deck.assets.length, 1);
  assert.equal(deck.slides.length, 7);
  assert.deepEqual(source.assets[0], payload.assets[0]);
});

test('oversized batches fail atomically when only their combined slides, items or assets exceed limits', () => {
  const source = batchFixture();
  const payload = createSlidesClipboard(source, new Set([source.slides[0].id, source.slides[2].id]));
  for (const prepare of [
    deck => { for (let i = 1; i < 99; i++) addSlide(deck); },
    deck => {
      for (let s = 0; s < 5; s++) {
        if (s) addSlide(deck);
        currentSlide(deck).items = Array.from({ length: s === 4 ? 1998 : 2000 }, (_, i) => text(`batch-item-${s}-${i}`));
      }
    },
    deck => deck.assets.push(...Array.from({ length: 500 }, (_, i) => ({ ...image(), id: `full-asset-${i}` }))),
  ]) {
    const deck = createDeck();
    prepare(deck);
    assert.doesNotThrow(() => validateDeck(deck));
    const before = structuredClone(deck);
    assert.throws(() => pasteSlides(deck, payload), /Invalid figure/);
    assert.deepEqual(deck, before);
  }
  const deck = createDeck();
  const before = structuredClone(deck);
  payload.slides[1].items[0].assetId = 'missing';
  assert.throws(() => pasteSlides(deck, payload), /missing asset/);
  assert.deepEqual(deck, before);
});
