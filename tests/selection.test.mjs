import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionRect, enclosedItemIds } from '../selection.js';

const item = (id, changes = {}) => ({ id, type: 'image', x: 20, y: 30, width: 40, height: 50, ...changes });

test('marquees normalize all four drag directions without changing their endpoints', () => {
  for (const [start, end] of [
    [{ x: -10, y: 20 }, { x: 90, y: 80 }],
    [{ x: 90, y: 20 }, { x: -10, y: 80 }],
    [{ x: -10, y: 80 }, { x: 90, y: 20 }],
    [{ x: 90, y: 80 }, { x: -10, y: 20 }],
  ]) {
    const before = structuredClone([start, end]);
    assert.deepEqual(selectionRect(start, end), { x: -10, y: 20, width: 100, height: 60 });
    assert.deepEqual([start, end], before);
  }
});

test('full enclosure includes boundary contact, but rejects partial overlaps and outside items', () => {
  const items = [
    item('inside'), item('touches', { x: 0, y: 0, width: 100, height: 100 }),
    item('left-overlap', { x: -1 }), item('top-overlap', { y: -1 }),
    item('right-overlap', { x: 61 }), item('bottom-overlap', { y: 51 }),
    item('outside', { x: 200 }),
  ];
  const before = structuredClone(items);
  assert.deepEqual(enclosedItemIds(items, { x: 0, y: 0, width: 100, height: 100 }), ['inside', 'touches']);
  assert.deepEqual(items, before);
});

test('hidden and locked items are excluded regardless of object type', () => {
  const items = ['image', 'text', 'rect', 'line'].flatMap(type => [
    item(type, { type }), item(`${type}-hidden`, { type, hidden: true }),
    item(`${type}-locked`, { type, locked: true }),
  ]);
  assert.deepEqual(enclosedItemIds(items, { x: 0, y: 0, width: 100, height: 100 }), ['image', 'text', 'rect', 'line']);
});

test('non-square objects rotate around their center, so 90-degree enclosure uses the visible bounds', () => {
  for (const rotation of [90, -90, 270]) {
    const object = item('rotated', { x: 20, y: 40, width: 80, height: 20, rotation });
    assert.deepEqual(enclosedItemIds([object], { x: 50, y: 10, width: 20, height: 80 }), ['rotated']);
    assert.deepEqual(enclosedItemIds([object], { x: 20, y: 40, width: 80, height: 20 }), []);
    assert.deepEqual(enclosedItemIds([object], { x: 51, y: 10, width: 20, height: 80 }), []);
  }
});

test('diagonally rotated corners must all fit, including corners beyond the unrotated bounds', () => {
  const object = item('diamond', { x: 10, y: 10, width: 10, height: 10, rotation: 45 });
  const radius = Math.sqrt(50);
  assert.deepEqual(enclosedItemIds([object], { x: 15 - radius, y: 15 - radius, width: 2 * radius, height: 2 * radius }), ['diamond']);
  assert.deepEqual(enclosedItemIds([object], { x: 8, y: 8, width: 14, height: 14 }), []);
});

test('zero-area marquees select nothing, including zero-width or zero-height lines', () => {
  const items = [item('horizontal', { type: 'line', x: 0, y: 0, width: 10, height: 0 }), item('vertical', { type: 'line', x: 0, y: 0, width: 0, height: 10 })];
  for (const rect of [
    { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 0 },
    selectionRect({ x: 0, y: 0 }, { x: 0, y: 0 }),
  ]) assert.deepEqual(enclosedItemIds(items, rect), []);
  assert.deepEqual(enclosedItemIds(items, { x: 0, y: 0, width: 10, height: 10 }), ['horizontal', 'vertical']);
});

test('enclosure works at negative canvas coordinates and with explicit zero rotation', () => {
  const items = [item('negative', { x: -80, y: -60, width: 20, height: 30, rotation: 0 }), item('partial', { x: -80, y: -61, width: 20, height: 30 })];
  assert.deepEqual(enclosedItemIds(items, { x: -80, y: -60, width: 20, height: 30 }), ['negative']);
});

test('floating-point boundary noise is tolerated without including visibly protruding items', () => {
  const items = [
    item('tiny-left', { x: -5e-8 }), item('tiny-top', { y: -5e-8 }),
    item('tiny-right', { x: 60 + 5e-8 }), item('tiny-bottom', { y: 50 + 5e-8 }),
    item('outside-left', { x: -1e-5 }), item('outside-top', { y: -1e-5 }),
    item('outside-right', { x: 60 + 1e-5 }), item('outside-bottom', { y: 50 + 1e-5 }),
  ];
  assert.deepEqual(enclosedItemIds(items, { x: 0, y: 0, width: 100, height: 100 }), ['tiny-left', 'tiny-top', 'tiny-right', 'tiny-bottom']);
});
