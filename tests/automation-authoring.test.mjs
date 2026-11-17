import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, serializeDeck, validateDeck } from '../deck.js';
import { prepareBatch, describeProject } from '../automation.js';

const composition = [
  { op: 'add_slide', slideId: 'agent-figure', name: 'Editable figure', canvas: { width: 720, height: 360, background: '#fafafa' } },
  { op: 'add_shape', slideId: 'agent-figure', shapeType: 'roundRect', properties: { name: 'Sample', x: 40, y: 80, fill: '#dcecff', stroke: '#24558a', cornerRadius: 0.2 } },
  { op: 'add_shape', slideId: 'agent-figure', shapeType: 'arrow', properties: { x: 230, y: 130, width: 180, height: 0, strokeWidth: 4 } },
  { op: 'add_text', slideId: 'agent-figure', properties: { name: 'Panel label', text: 'a', x: 40, y: 30 } },
];

test('a complete editable composition is created atomically and round-trips through project files', () => {
  const deck = createDeck(), before = structuredClone(deck);
  const result = prepareBatch(deck, composition), view = describeProject(result.project);
  assert.deepEqual(deck, before);
  assert.equal(view.activeSlideId, 'agent-figure');
  assert.deepEqual(view.slide.canvas, composition[0].canvas);
  assert.deepEqual(result.createdSlideIds, ['agent-figure']);
  assert.deepEqual(result.changedSlideIds, ['agent-figure']);
  assert.deepEqual(view.slide.items.map(i => i.type), ['roundRect', 'arrow', 'text']);
  assert.equal(view.slide.items[0].fill, '#dcecff');
  assert.equal(view.slide.items[0].cornerRadius, 0.2);
  assert.equal(view.slide.items[1].height, 0);
  assert.equal(view.slide.items[1].strokeWidth, 4);
  assert.deepEqual(validateDeck(JSON.parse(serializeDeck(result.project))), result.project);
});

test('set_slide and solid paint updates preserve geometry and make gradient changes visible', () => {
  const deck = prepareBatch(createDeck(), composition).project, slide = deck.slides[1], item = slide.items[0];
  item.fillGradient = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };
  const result = prepareBatch(deck, [
    { op: 'set_slide', slideId: slide.id, name: 'Revised', canvas: { width: 900 } },
    { op: 'set', slideId: slide.id, itemIds: [item.id], properties: { fill: '#00aa66', strokeDash: 'dash', fillOpacity: 0.6 } },
  ]);
  const revised = result.project.slides[1];
  assert.equal(revised.name, 'Revised');
  assert.deepEqual(revised.canvas, { ...slide.canvas, width: 900 });
  assert.deepEqual([revised.items[0].x, revised.items[0].y, revised.items[0].width], [item.x, item.y, item.width]);
  assert.equal(revised.items[0].fillGradient, undefined);
  assert.equal(revised.items[0].strokeDash, 'dash');
  assert.ok(item.fillGradient);
});

test('invalid authoring operations roll back all preceding operations', () => {
  const deck = createDeck(), before = structuredClone(deck), slideId = 'agent-figure';
  for (const bad of [
    { op: 'add_slide', slideId },
    { op: 'add_slide', slideId: '../escape' },
    { op: 'set_slide', slideId },
    { op: 'set_slide', slideId, canvas: { width: 0 } },
    { op: 'set_slide', slideId, canvas: { width: 63 } },
    { op: 'set_slide', slideId, canvas: { height: 8001 } },
    { op: 'set_slide', slideId, canvas: { width: NaN } },
    { op: 'set_slide', slideId, canvas: { background: 'url(https://example.com)' } },
    { op: 'set_slide', slideId, canvas: { width: 600, script: 'no' } },
    { op: 'set_slide', slideId, name: ' ' },
    { op: 'add_shape', slideId, shapeType: 'script' },
    { op: 'add_shape', slideId, shapeType: 'rect', properties: { width: 0 } },
    { op: 'add_shape', slideId, shapeType: 'arrow', properties: { fill: '#fff' } },
    { op: 'add_shape', slideId, shapeType: 'ellipse', properties: { cornerRadius: 0.2 } },
    { op: 'add_text', slideId, properties: { text: 'a', stroke: '#000' } },
    { op: 'add_shape', slideId, shapeType: 'rect', properties: { fillOpacity: 2 } },
  ]) {
    assert.throws(() => prepareBatch(deck, [...composition, bad]), JSON.stringify(bad));
    assert.deepEqual(deck, before);
  }
});

test('new slides inherit the active canvas, insert in order and preserve untouched slides', () => {
  const deck = createDeck();
  const result = prepareBatch(deck, [
    { op: 'add_slide', slideId: 'first' },
    { op: 'add_slide', slideId: 'second', canvas: { height: 500 } },
    { op: 'set_slide', slideId: deck.activeSlideId, name: 'Original' },
  ]);
  assert.deepEqual(result.project.slides.map(s => s.id), [deck.activeSlideId, 'first', 'second']);
  assert.equal(result.project.activeSlideId, 'second');
  assert.deepEqual(result.project.slides[1].canvas, deck.slides[0].canvas);
  assert.deepEqual(result.project.slides[2].canvas, { ...deck.slides[0].canvas, height: 500 });
  assert.equal(deck.slides[0].name, 'Slide 1');
});
