import test from 'node:test';
import assert from 'node:assert/strict';
import { resizeItem, resizeMediaDimension } from '../resize.js';
import { createProject, projectToSVG, validateProject } from '../core.js';
import { serializeDeck, validateDeck } from '../deck.js';

const item = { id: 'picture', type: 'image', assetId: 'source', x: 55, y: 90, width: 400, height: 200, rotation: 0, opacity: 1 };
const crop = { x: .25, y: .1, width: .5, height: .6 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('proportional inspector edits bound both dimensions and preserve extreme aspect ratios', () => {
  for (const [width, height] of [[1000, 10], [10, 1000], [100000, .01], [.01, 100000], [1, 1]]) {
    for (const dimension of ['width', 'height']) for (const value of [1, 2000, 20000]) {
      const original = { ...item, width, height }, resized = resizeMediaDimension(original, dimension, value);
      assert.ok(resized.width >= .01 && resized.width <= 100000);
      assert.ok(resized.height >= .01 && resized.height <= 100000);
      assert.ok(Math.abs(resized.width / resized.height / (width / height) - 1) < 1e-12);
      assert.equal(original.width, width);
      assert.equal(original.height, height);
    }
  }
  assert.deepEqual(resizeMediaDimension({ ...item, width: 1000, height: 10 }, 'height', 2000), { width: 100000, height: 1000 });
  assert.deepEqual(resizeMediaDimension({ ...item, width: 10, height: 1000 }, 'width', 2000), { width: 1000, height: 100000 });
});
const rotate = (x, y, angle) => { const a = angle * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]; };
function world(object, u, v) {
  const [dx, dy] = rotate((u - .5) * object.width, (v - .5) * object.height, object.rotation);
  return [object.x + object.width / 2 + dx, object.y + object.height / 2 + dy];
}
function anchored(before, after, points) {
  for (const [u, v] of points) world(after, u, v).forEach((n, j) => near(n, world(before, u, v)[j]));
}

test('each image edge stretches one local axis and keeps its opposite edge fixed at any rotation', () => {
  const cases = [
    ['e', 440, 200, [[0, 0], [0, 1]]], ['w', 360, 200, [[1, 0], [1, 1]]],
    ['s', 400, 230, [[0, 0], [1, 0]]], ['n', 400, 170, [[0, 1], [1, 1]]],
  ];
  for (const rotation of [0, 90, 37, -145]) for (const [handle, width, height, points] of cases) {
    const original = { ...item, rotation }, delta = rotate(40, 30, rotation);
    const result = { ...original, ...resizeItem(original, handle, ...delta) };
    near(result.width, width); near(result.height, height); anchored(original, result, points);
    // Shift affects corner sizing only; edge stretching is always independent.
    assert.deepEqual(resizeItem(original, handle, ...delta, { free: true }), resizeItem(original, handle, ...delta));
  }
});

test('corner scaling preserves image proportions and its top-left anchor; Shift and shapes resize freely', () => {
  for (const rotation of [0, 90, 37, -145]) {
    const original = { ...item, rotation }, delta = rotate(40, 30, rotation);
    const scaled = { ...original, ...resizeItem(original, 'se', ...delta) };
    near(scaled.width / scaled.height, original.width / original.height);
    assert.ok(scaled.width > original.width); anchored(original, scaled, [[0, 0]]);
    for (const [object, options] of [[original, { free: true }], [{ ...original, type: 'rect' }, {}]]) {
      const result = { ...object, ...resizeItem(object, 'se', ...delta, options) };
      near(result.width, 440); near(result.height, 230); anchored(object, result, [[0, 0]]);
    }
  }
});

test('edge clamps prevent crossing or oversizing while keeping the opposite edge stationary', () => {
  const anchors = { e: [[0, 0], [0, 1]], w: [[1, 0], [1, 1]], n: [[0, 1], [1, 1]], s: [[0, 0], [1, 0]] };
  for (const rotation of [0, 37]) for (const handle of Object.keys(anchors)) for (const amount of [-1e6, 1e6]) {
    const original = { ...item, rotation }, delta = rotate(amount, amount, rotation);
    const result = { ...original, ...resizeItem(original, handle, ...delta) };
    const horizontal = handle === 'e' || handle === 'w';
    const affected = result[horizontal ? 'width' : 'height'];
    assert.ok(affected === 4 || affected === 20000);
    near(result[horizontal ? 'height' : 'width'], original[horizontal ? 'height' : 'width']);
    anchored(original, result, anchors[handle]);
  }
  const thin = { ...item, height: 1 };
  near(resizeItem(thin, 'e', 40, 20).height, 1);
});

test('corner limits constrain both dimensions without distorting proportional images', () => {
  for (const original of [item, { ...item, width: 200, height: 400 }]) for (const amount of [-1e6, 1e6]) {
    const result = { ...original, ...resizeItem(original, 'se', amount, amount) };
    near(result.width / result.height, original.width / original.height);
    assert.ok(result.width >= 4 && result.height >= 4 && result.width <= 20000 && result.height <= 20000);
    near(amount < 0 ? Math.min(result.width, result.height) : Math.max(result.width, result.height), amount < 0 ? 4 : 20000);
    anchored(original, result, [[0, 0]]);
  }
  assert.deepEqual(resizeItem(item, 'se', -1e6, 1e6, { free: true }), { x: item.x, y: item.y, width: 4, height: 20000 });
});

test('extremely narrow crops retain their ratio without exceeding the upper size bound', () => {
  for (const original of [{ ...item, width: .1, height: 20000 }, { ...item, width: 20000, height: .1 }]) {
    const result = { ...original, ...resizeItem(original, 'se', 100, 100) };
    near(result.width / result.height, original.width / original.height);
    assert.ok(result.width > 0 && result.height > 0 && result.width <= 20000 && result.height <= 20000);
    anchored(original, result, [[0, 0]]);
  }
});

test('stretch changes geometry only; crop, source bytes and saved/reopened dimensions survive', () => {
  const asset = { id: 'source', name: 'source.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', width: 400, height: 200, sourceKind: 'copy' };
  const project = { ...createProject(), assets: [asset], items: [{ ...item, crop: { ...crop } }] };
  const before = structuredClone(project);
  const result = resizeItem(project.items[0], 'w', -80, 35);
  assert.deepEqual(project, before);
  assert.deepEqual(Object.keys(result).sort(), ['height', 'width', 'x', 'y']);
  Object.assign(project.items[0], result);
  const reopened = validateDeck(JSON.parse(serializeDeck(validateDeck(project))));
  const restored = reopened.slides[0].items[0];
  assert.deepEqual(restored.crop, crop); assert.equal(reopened.assets[0].dataUrl, asset.dataUrl);
  for (const key of ['x', 'y', 'width', 'height']) near(restored[key], project.items[0][key]);
  assert.doesNotThrow(() => validateProject(project));
  assert.match(projectToSVG(project), /<svg width="480" height="200" viewBox="0.25 0.1 0.5 0.6" preserveAspectRatio="none"/);
});
