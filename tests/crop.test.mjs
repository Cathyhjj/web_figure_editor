import test from 'node:test';
import assert from 'node:assert/strict';
import { FULL_CROP, imageCrop, cropImage, dragCrop, validateCrop } from '../crop.js';
import { createProject, validateProject, projectToSVG } from '../core.js';
import { validateDeck, cloneDeck, duplicateSlide, serializeDeck, slideProject } from '../deck.js';
import { createSelection, encodeSelection, decodeSelection, pasteSelection } from '../clipboard.js';
import { selectionToPNG } from '../clipboard-image.js';
import { generateHTMLReport } from '../report.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = { id: 'source', name: 'source.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG}`, width: 400, height: 200, sourceKind: 'copy' };
const item = { id: 'picture', type: 'image', assetId: 'source', x: 55, y: 90, width: 400, height: 200, rotation: 0, opacity: 1 };
const region = { x: .25, y: .1, width: .5, height: .6 };
const fixture = () => ({ ...createProject(), assets: [{ ...asset }], items: [{ ...item, crop: { ...region } }] });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function sourcePoint(object, u, v) {
  const c = imageCrop(object), angle = object.rotation * Math.PI / 180;
  const x = (u - c.x) * object.width / c.width - object.width / 2;
  const y = (v - c.y) * object.height / c.height - object.height / 2;
  return [object.x + object.width / 2 + x * Math.cos(angle) - y * Math.sin(angle), object.y + object.height / 2 + x * Math.sin(angle) + y * Math.cos(angle)];
}

test('crop validation round-trips independently and rejects corrupt/out-of-image rectangles', () => {
  const p = fixture(), v = validateProject(p);
  assert.deepEqual(v.items[0].crop, region);
  v.items[0].crop.x = .1;
  assert.equal(p.items[0].crop.x, .25);
  for (const crop of [null, [], {}, { ...region, x: NaN }, { ...region, y: -.1 }, { ...region, width: 0 }, { ...region, height: Infinity }, { ...region, x: .8 }, { ...region, y: .8 }]) {
    p.items[0].crop = crop; assert.throws(() => validateProject(p), /crop/i);
  }
  delete p.items[0].crop;
  assert.equal(validateProject(p).items[0].crop, undefined);
});

test('crop, recrop and restore preserve source scale and world position at any rotation', () => {
  for (const rotation of [0, 90, 37, -145]) {
    const original = { ...item, rotation }, before = structuredClone(original);
    const cropped = cropImage(original, region);
    const recropped = cropImage(cropped, { x: .1, y: .3, width: .8, height: .4 });
    for (const result of [cropped, recropped, cropImage(recropped)]) {
      const c = imageCrop(result);
      near(result.width / c.width, item.width); near(result.height / c.height, item.height);
      for (const [u, v] of [[0, 0], [.35, .48], [1, 1]]) sourcePoint(result, u, v).forEach((value, j) => near(value, sourcePoint(original, u, v)[j]));
    }
    const restored = cropImage(recropped);
    assert.equal(restored.crop, undefined);
    ['x','y','width','height'].forEach(key => near(restored[key], original[key]));
    assert.deepEqual(original, before);
  }
});

test('all eight drag handles clamp to source boundaries and cannot cross', () => {
  for (const handle of ['n','ne','e','se','s','sw','w','nw']) for (const delta of [-10, 10]) {
    const c = dragCrop(region, handle, delta, delta, .01, .01);
    assert.doesNotThrow(() => validateCrop(c));
    assert.ok(c.width >= .01 - 1e-12 && c.height >= .01 - 1e-12);
  }
  assert.deepEqual(dragCrop(region, 'move', -10, -10), { ...region, x: 0, y: 0 });
  assert.deepEqual(dragCrop(region, 'move', 10, 10), { ...region, x: .5, y: .4 });
  assert.deepEqual(dragCrop(FULL_CROP, 'move', 10, 10), FULL_CROP);
  for (const c of [dragCrop(FULL_CROP, 'nw', 1, 1), { x: .99999, y: 0, width: .00001, height: 1 }]) {
    const valid = validateCrop(c);
    assert.deepEqual(validateCrop(valid), valid);
  }
});

test('snapshots, slide duplicates, saved projects and editable clipboard retain independent crops and original bytes', () => {
  const deck = validateDeck(fixture()), snapshot = cloneDeck(deck);
  snapshot.slides[0].items[0].crop.x = .1;
  assert.equal(deck.slides[0].items[0].crop.x, .25);
  const duplicate = duplicateSlide(deck);
  duplicate.items[0].crop.x = .15;
  assert.equal(deck.slides[0].items[0].crop.x, .25);
  const loaded = validateDeck(JSON.parse(serializeDeck(deck)));
  assert.deepEqual(loaded, deck);
  const view = slideProject(deck), copied = decodeSelection(encodeSelection(createSelection(view, new Set([duplicate.items[0].id]))));
  const [id] = pasteSelection(deck, copied);
  const pasted = deck.slides[1].items.find(i => i.id === id);
  assert.deepEqual(pasted.crop, duplicate.items[0].crop);
  assert.equal(deck.assets[0].dataUrl, asset.dataUrl);
  pasted.crop.x = 0;
  assert.equal(copied.items[0].crop.x, .15);
});

test('SVG and HTML exports clip using source coordinates and retain full embedded originals', () => {
  const p = fixture(), svg = projectToSVG(p), html = generateHTMLReport(p);
  for (const text of [svg, html]) {
    assert.match(text, /viewBox="0.25 0.1 0.5 0.6" preserveAspectRatio="none" overflow="hidden"/);
    assert.match(text, /<image x="0" y="0" width="1" height="1"/);
    assert.ok(text.includes(asset.dataUrl));
  }
});

test('same-aspect crops cannot use the original PNG clipboard fast path', async () => {
  const p = fixture();
  p.items[0].crop = { x: .25, y: .25, width: .5, height: .5 };
  await assert.rejects(selectionToPNG(p), /requires a browser/);
});
