import test from 'node:test';
import assert from 'node:assert/strict';
import { itemBounds, selectionBounds, applyLayout } from '../layout.js';

const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≠ ${expected}`);
const item = (id, properties = {}) => ({ id, type: 'text', x: 0, y: 0, width: 40, height: 20, rotation: 0, ...properties });
const slide = (items = [item('a', { x: 10, y: 15, width: 100, height: 30 }),
  item('b', { x: 190, y: 120, width: 60, height: 70 }), item('c', { x: 500, y: 400, width: 30, height: 50 })]) =>
  ({ canvas: { width: 960, height: 640 }, items });
const ids = page => page.items.map(item => item.id);

test('rotated frame bounds retain the center and exclude cosmetic strokes and shadows', () => {
  const shape = item('a', { x: 10, y: 20, width: 100, height: 40, rotation: 90, strokeWidth: 100 });
  assert.deepEqual(itemBounds(shape), { x: 40, y: -10, width: 40, height: 100 });
  assert.deepEqual(itemBounds({ ...shape, rotation: -270 }), itemBounds(shape));
  const diagonal = itemBounds({ ...shape, rotation: 45 });
  close(diagonal.width, 140 / Math.sqrt(2)); close(diagonal.height, 140 / Math.sqrt(2));
  close(diagonal.x + diagonal.width / 2, 60); close(diagonal.y + diagonal.height / 2, 40);
  assert.deepEqual(selectionBounds([shape, item('b', { x: 0, y: 100 })]), { x: 0, y: -10, width: 80, height: 130 });
});

for (const alignment of ['left', 'center', 'right', 'top', 'middle', 'bottom']) {
  test(`${alignment} alignment uses the selection bounds and preserves the other axis`, () => {
    const page = slide(), before = structuredClone(page), bounds = selectionBounds(page.items);
    const horizontal = ['left', 'center', 'right'].includes(alignment), axis = horizontal ? 'x' : 'y';
    const other = horizontal ? 'y' : 'x', size = horizontal ? 'width' : 'height';
    const fraction = ['left', 'top'].includes(alignment) ? 0 : ['right', 'bottom'].includes(alignment) ? 1 : 0.5;
    const returned = applyLayout(page, ['c', 'a', 'b'], { op: 'align', alignment });
    assert.equal(returned[0], page.items[2]);
    page.items.forEach((object, index) => {
      close(object[axis] + fraction * object[size], bounds[axis] + fraction * bounds[size]);
      assert.equal(object[other], before.items[index][other]);
      assert.equal(object.width, before.items[index].width); assert.equal(object.height, before.items[index].height);
    });
  });
}

test('single-object alignment uses the canvas, including rotated visual edges', () => {
  const expectations = { left: ['x', 0], center: ['x', 460], right: ['x', 920], top: ['y', 0], middle: ['y', 270], bottom: ['y', 540] };
  for (const [alignment, [axis, expected]] of Object.entries(expectations)) {
    const page = slide([item('a', { x: 200, y: 100, width: 100, height: 40, rotation: 90 })]);
    applyLayout(page, ['a'], { op: 'align', alignment });
    close(itemBounds(page.items[0])[axis], expected);
  }
});

test('rotated objects align by the visible frame edges and centers', () => {
  for (const alignment of ['left', 'center', 'right', 'top', 'middle', 'bottom']) {
    const page = slide([item('a', { x: 10, y: 30, width: 100, height: 40, rotation: 90 }),
      item('b', { x: 200, y: 100, width: 80, height: 20, rotation: 35 })]);
    const bounds = selectionBounds(page.items), axis = ['left', 'center', 'right'].includes(alignment) ? 'x' : 'y';
    const size = axis === 'x' ? 'width' : 'height', fraction = ['left', 'top'].includes(alignment) ? 0 : ['right', 'bottom'].includes(alignment) ? 1 : 0.5;
    applyLayout(page, ids(page), { op: 'align', alignment });
    for (const object of page.items) {
      const box = itemBounds(object); close(box[axis] + fraction * box[size], bounds[axis] + fraction * bounds[size]);
    }
  }
});

for (const axis of ['x', 'y']) {
  test(`${axis} equal spacing preserves endpoints, array order, and perpendicular positions`, () => {
    const page = slide(), before = structuredClone(page), size = axis === 'x' ? 'width' : 'height', other = axis === 'x' ? 'y' : 'x';
    applyLayout(page, ['c', 'b', 'a'], { op: 'distribute', axis });
    assert.equal(page.items[0][axis], before.items[0][axis]); assert.equal(page.items[2][axis], before.items[2][axis]);
    close(page.items[1][axis] - page.items[0][axis] - page.items[0][size], page.items[2][axis] - page.items[1][axis] - page.items[1][size]);
    assert.deepEqual(ids(page), ids(before));
    assert.deepEqual(page.items.map(item => item[other]), before.items.map(item => item[other]));
  });
  test(`${axis} explicit spacing accepts two objects and uses visual order rather than selection order`, () => {
    const page = slide([item('a', { x: 200, y: 200, width: 80, height: 20, rotation: 30 }),
      item('b', { x: 20, y: 10, width: 100, height: 40, rotation: 90 })]);
    const before = itemBounds(page.items[1]), size = axis === 'x' ? 'width' : 'height';
    applyLayout(page, ['a', 'b'], { op: 'distribute', axis, gap: 3 * 96 / 25.4 });
    const first = itemBounds(page.items[1]), second = itemBounds(page.items[0]);
    close(first[axis], before[axis]); close(second[axis] - first[axis] - first[size], 3 * 96 / 25.4);
  });
}

test('implicit overlapping distribution keeps endpoints and equal negative gaps', () => {
  const page = slide([item('a', { x: 0, width: 100 }), item('b', { x: 10, width: 100 }), item('c', { x: 40, width: 100 })]);
  applyLayout(page, ids(page), { op: 'distribute', axis: 'x' });
  assert.deepEqual(page.items.map(item => item.x), [0, 20, 40]);
});

for (const dimension of ['width', 'height']) {
  test(`matching ${dimension} uses the first selected object and scales only media proportionally`, () => {
    const page = slide([item('text', { width: 200, height: 90, fontSize: 18 }),
      item('image', { type: 'image', width: 80, height: 20, x: 75, y: 92, rotation: 27 }),
      item('reference', { type: 'rect', width: 120, height: 60, strokeWidth: 3 }),
      item('video', { type: 'video', width: 50, height: 100 }), item('html', { type: 'html', width: 70, height: 140 })]);
    const before = structuredClone(page), other = dimension === 'width' ? 'height' : 'width';
    applyLayout(page, ['reference', 'text', 'image', 'video', 'html'], { op: 'match_size', dimension });
    for (const object of page.items) assert.equal(object[dimension], before.items[2][dimension]);
    assert.equal(page.items[0][other], before.items[0][other]); assert.equal(page.items[0].fontSize, 18);
    for (const index of [1, 3, 4]) close(page.items[index].width / page.items[index].height, before.items[index].width / before.items[index].height);
    assert.equal(page.items[1].x, 75); assert.equal(page.items[1].y, 92); assert.equal(page.items[1].rotation, 27);
    assert.equal(page.items[2].strokeWidth, 3);
  });
}

test('locks, stale and duplicate IDs reject the whole operation without changing object identity or geometry', () => {
  for (const requested of [['a', 'a'], ['a', 'missing'], ['a', 'b'], []]) {
    const page = slide(); page.items[1].locked = true;
    const before = structuredClone(page), reference = page.items[0];
    assert.throws(() => applyLayout(page, requested, { op: 'align', alignment: 'right' }));
    assert.deepEqual(page, before); assert.equal(page.items[0], reference);
  }
  const page = slide(); page.items.push({ ...page.items[0] });
  assert.throws(() => applyLayout(page, ['a'], { op: 'align', alignment: 'left' }), /ambiguous/);
  const hidden = slide(); hidden.items[1].hidden = true;
  const before = structuredClone(hidden);
  assert.throws(() => applyLayout(hidden, ['a', 'b'], { op: 'align', alignment: 'right' }), /hidden/);
  assert.deepEqual(hidden, before);
});

test('invalid operations, gaps and selections are rejected without edits', () => {
  for (const operation of [null, { op: 'unknown' }, { op: 'align', alignment: 'outside' },
    { op: 'distribute', axis: 'z' }, ...[-1, Infinity, NaN, '3', 100001].map(gap => ({ op: 'distribute', axis: 'y', gap })),
    { op: 'match_size', dimension: 'depth' }]) {
    const page = slide(), before = structuredClone(page);
    assert.throws(() => applyLayout(page, ids(page), operation)); assert.deepEqual(page, before);
  }
  const page = slide(), before = structuredClone(page);
  assert.throws(() => applyLayout(page, ['a', 'b'], { op: 'distribute', axis: 'y' }), /3 objects/);
  assert.throws(() => applyLayout(page, ['a'], { op: 'distribute', axis: 'x', gap: 2 }), /3 objects/);
  assert.throws(() => applyLayout(page, ['a'], { op: 'match_size', dimension: 'width' }), /2 objects/);
  assert.deepEqual(page, before);
});

test('model-limit failures are atomic even after earlier candidate objects would have moved', () => {
  for (const [page, operation] of [
    [slide([item('a', { x: 99900, width: 100 }), item('b', { x: 99950 }), item('c', { x: 100000 })]), { op: 'distribute', axis: 'x', gap: 1 }],
    [slide([item('a', { width: 100000 }), item('b'), item('c', { type: 'image', width: 1, height: 100000 })]), { op: 'match_size', dimension: 'width' }],
    [slide([item('a', { height: 0.01 }), item('b'), item('c', { type: 'image', width: 0.01, height: 100000 })]), { op: 'match_size', dimension: 'height' }],
    [slide([item('a', { type: 'line', width: 0 }), item('b')]), { op: 'match_size', dimension: 'width' }],
  ]) {
    const before = structuredClone(page);
    assert.throws(() => applyLayout(page, ids(page), operation), /between/); assert.deepEqual(page, before);
  }
});

test('degenerate line frames can align and valid extreme media ratios remain unchanged', () => {
  const page = slide([item('a', { type: 'line', width: 0, height: 60 }), item('b', { type: 'line', width: 0, height: 100, x: 50 })]);
  applyLayout(page, ids(page), { op: 'align', alignment: 'right' });
  assert.deepEqual(page.items.map(item => item.x), [50, 50]);
  applyLayout(page, ids(page), { op: 'match_size', dimension: 'width' });
  const media = slide([item('a', { width: 0.01 }), item('b', { type: 'image', width: 0.01, height: 100000 })]);
  applyLayout(media, ids(media), { op: 'match_size', dimension: 'width' });
  assert.equal(media.items[1].width, 0.01); assert.equal(media.items[1].height, 100000);
});
