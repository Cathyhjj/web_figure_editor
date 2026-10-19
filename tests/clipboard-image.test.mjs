import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../core.js';
import { selectionImageProject, selectionToPNG } from '../clipboard-image.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = { id: 'source', name: 'source.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 1, height: 1, size: 68, sourceKind: 'copy' };
const image = (extra = {}) => ({ id: 'image', type: 'image', assetId: 'source', x: -70, y: 120, width: 200, height: 100, ...extra });
const selection = items => validateProject({ ...createProject(), assets: [asset], items });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);

test('crop contains only selected visible geometry and original source bytes on transparency', () => {
  const input = selection([image({ opacity: .45 }), image({ id: 'hidden', x: 1000, hidden: true })]);
  const before = structuredClone(input);
  const result = selectionImageProject(input);
  assert.deepEqual(result.canvas, { width: 200, height: 100, background: 'transparent' });
  assert.equal(result.items.length, 1);
  assert.deepEqual({ ...result.items[0], x: -70, y: 120 }, input.items[0]);
  assert.equal(result.items[0].x, 0); assert.equal(result.items[0].y, 0);
  assert.equal(result.assets[0].dataUrl, input.assets[0].dataUrl);
  result.items[0].width = 300;
  assert.deepEqual(input, before);
});

test('rotated image bounds use all corners and keep the original rotation center', () => {
  const result = selectionImageProject(selection([image({ rotation: 90 })]));
  near(result.canvas.width, 100); near(result.canvas.height, 200);
  near(result.items[0].x, -50); near(result.items[0].y, 50);
  assert.equal(result.items[0].width, 200); assert.equal(result.items[0].height, 100);
  assert.equal(result.items[0].rotation, 90);
  const diagonal = selectionImageProject(selection([image({ rotation: 45 })]));
  near(diagonal.canvas.width, 300 / Math.sqrt(2));
  near(diagonal.canvas.height, 300 / Math.sqrt(2));
});

test('rectangle and line crops include rotated stroke extents', () => {
  const rect = { id: 'shape', type: 'rect', x: 50, y: 70, width: 100, height: 50, stroke: '#000', strokeWidth: 10, rotation: 90 };
  const result = selectionImageProject(selection([rect]));
  near(result.canvas.width, 60); near(result.canvas.height, 110);
  near(result.items[0].x, -20); near(result.items[0].y, 30);
  assert.deepEqual(result.assets, []);
  const line = selectionImageProject(selection([{ ...rect, type: 'line', rotation: 0, width: 0, height: 50 }]));
  assert.deepEqual(line.canvas, { width: 10, height: 60, background: 'transparent' });
  const noStroke = selectionImageProject(selection([{ ...rect, stroke: 'none', rotation: 0 }]));
  assert.deepEqual(noStroke.canvas, { width: 100, height: 50, background: 'transparent' });
});

test('multi-object crops preserve offsets, layer order, transforms and stretch', () => {
  const items = [image(), { id: 'label', type: 'text', x: 300, y: -50, width: 120, height: 40, text: 'Label', fontSize: 24 }];
  const result = selectionImageProject(selection(items));
  assert.deepEqual(result.canvas, { width: 490, height: 270, background: 'transparent' });
  assert.deepEqual(result.items.map(item => [item.id, item.x, item.y]), [['image', 0, 170], ['label', 370, 0]]);
  assert.equal(result.items[0].width / result.items[0].height, 2);
});

test('empty, hidden-only and excessively spread selections are rejected before rendering', () => {
  assert.throws(() => selectionImageProject(selection([])), /visible object/);
  assert.throws(() => selectionImageProject(selection([image({ hidden: true })])), /visible object/);
  assert.throws(() => selectionImageProject(selection([image(), image({ id: 'far', x: 20000 })])), /16,000 canvas pixels/);
});

test('eligible single PNG retains exact original pixels without requiring browser rendering', async () => {
  const result = await selectionToPNG(selection([image({ width: 100, height: 100 })]));
  assert.equal(result.type, 'image/png');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from(PIXEL, 'base64'));
  for (const change of [{ rotation: 12 }, { opacity: .5 }, { width: 200 }]) {
    await assert.rejects(selectionToPNG(selection([image({ width: 100, height: 100, ...change })])), /requires a browser/);
  }
});
