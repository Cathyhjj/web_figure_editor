import test from 'node:test';
import assert from 'node:assert/strict';
import { itemContentKey, assetVisualInputs, sameInputs, createAssetLibrarySnapshot, assetLibraryMatches } from '../render-cache.js';

test('moving or fading a group preserves its content while rotation invalidates it', () => {
  const item = { id: 'figure', type: 'image', x: 5, y: 10, width: 100, height: 80, opacity: 1, rotation: 0 };
  const key = itemContentKey(item);
  assert.equal(itemContentKey({ ...item, x: 40, y: 50, opacity: 0.5 }), key);
  assert.notEqual(itemContentKey({ ...item, rotation: 90 }), key);
  assert.notEqual(itemContentKey({ ...item, width: 120 }), key);
});

test('nested crop, shape and effect edits invalidate cached content', () => {
  for (const [property, before, after] of [
    ['crop', { x: 0, y: 0, width: 1, height: 1 }, { x: 0.1, y: 0, width: 0.9, height: 1 }],
    ['editableArrow', { points: [{ x: 0, y: 0 }, { x: 10, y: 20 }] }, { points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] }],
    ['shadow', { color: '#000000', blur: 2 }, { color: '#000000', blur: 5 }],
  ]) {
    const item = { id: 'figure', [property]: before };
    const key = itemContentKey(item);
    item[property] = after;
    assert.notEqual(itemContentKey(item), key, property);
  }
});

test('shared asset sources invalidate even when the replacement has the same length', () => {
  const asset = { id: 'shared', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10 };
  const original = assetVisualInputs(asset);
  assert.ok(sameInputs(original, assetVisualInputs({ ...asset })));
  asset.dataUrl = 'data:image/png;base64,BBBB';
  assert.equal(original[2].length, asset.dataUrl.length);
  assert.equal(sameInputs(original, assetVisualInputs(asset)), false);
  assert.equal(sameInputs(original, assetVisualInputs(undefined)), false);
  assert.ok(sameInputs(assetVisualInputs(undefined), assetVisualInputs(undefined)));
});

test('posters and source dimensions invalidate visuals but names do not', () => {
  const asset = { id: 'chart', name: 'Chart', mime: 'text/html', dataUrl: 'source', posterDataUrl: 'poster-a', width: 10, height: 20 };
  const original = assetVisualInputs(asset);
  assert.ok(sameInputs(original, assetVisualInputs({ ...asset, name: 'Renamed chart' })));
  for (const update of [{ posterDataUrl: 'poster-b' }, { width: 20 }, { height: 30 }, { mime: 'image/png' }]) {
    assert.equal(sameInputs(original, assetVisualInputs({ ...asset, ...update })), false);
  }
});

test('library snapshots detect displayed metadata edits, additions and removals', () => {
  for (const property of ['name', 'relativePath', 'fingerprint', 'sourceKind', 'linkPersistence', 'originalMime', 'dataUrl', 'posterDataUrl']) {
    const asset = { id: 'a', [property]: 'before' };
    const snapshot = createAssetLibrarySnapshot([asset]);
    assert.ok(assetLibraryMatches(snapshot, [asset]));
    asset[property] = 'after';
    assert.equal(assetLibraryMatches(snapshot, [asset]), false, property);
  }
  const asset = { id: 'a', name: 'A' };
  const snapshot = createAssetLibrarySnapshot([asset]);
  asset.relativePath = 'folder/A';
  assert.equal(assetLibraryMatches(snapshot, [asset]), false);
  delete asset.relativePath;
  assert.ok(assetLibraryMatches(snapshot, [asset]));
  delete asset.name;
  assert.equal(assetLibraryMatches(snapshot, [asset]), false);
});

test('library cache rejects replacement identities and reordering to keep callbacks current', () => {
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' };
  const snapshot = createAssetLibrarySnapshot([a, b]);
  assert.ok(assetLibraryMatches(snapshot, [a, b]));
  assert.equal(assetLibraryMatches(snapshot, [{ ...a }, b]), false);
  assert.equal(assetLibraryMatches(snapshot, [b, a]), false);
  assert.equal(assetLibraryMatches(snapshot, [a]), false);
  assert.equal(assetLibraryMatches(undefined, []), false);
  assert.ok(assetLibraryMatches(createAssetLibrarySnapshot([]), []));
});

test('library snapshots do not traverse or serialize embedded source documents', () => {
  const document = { toJSON() { throw new Error('Source document must not be serialized'); } };
  document.self = document;
  const asset = { id: 'svg', svgDocument: document, dataUrl: 'large immutable source' };
  const snapshot = createAssetLibrarySnapshot([asset]);
  assert.ok(assetLibraryMatches(snapshot, [asset]));
  assert.ok(sameInputs(assetVisualInputs(asset), assetVisualInputs(asset)));
});
