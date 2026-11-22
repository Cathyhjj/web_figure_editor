import test from 'node:test';
import assert from 'node:assert/strict';
import { SAC_PALETTE, SAC_TEXT_STYLE, sacShapeStyle } from '../sac-theme.js';
import { createCatalogShape } from '../shape-catalog.js';
import { createDrawingShape } from '../shape-drawing.js';
import { createArrowPreset, fadeArrow } from '../vector-arrow.js';
import { createDeck, serializeDeck, validateDeck } from '../deck.js';
import { prepareBatch } from '../automation.js';

const paint = item => Object.fromEntries(Object.keys(sacShapeStyle()).map(key => [key, item[key]]));
const points = [{x:10,y:10},{x:80,y:30},{x:100,y:80}];

test('manual drawing and automation share SAC paints while lines remain unfilled', () => {
  const deck = createDeck(), slideId = deck.activeSlideId;
  const result = prepareBatch(deck, [
    ...['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'doubleArrow'].map(shapeType => ({op:'add_shape', slideId, shapeType})),
    {op:'add_text', slideId, properties:{text:'Native caption'}},
  ]);
  const items = result.project.slides[0].items;
  for (const item of items.slice(0, 6)) {
    const line = ['line', 'arrow', 'doubleArrow'].includes(item.type);
    assert.deepEqual(paint(item), paint(createCatalogShape(item.type)));
    assert.equal(item.stroke, '#232425');
    assert.equal(item.fill, line ? 'none' : '#ffffff');
  }
  assert.deepEqual(paint(createDrawingShape('scribble', points)), paint(items[3]));
  assert.deepEqual(paint(createDrawingShape('freeform', points, true)), paint(items[0]));
  for (const [key, value] of Object.entries(SAC_TEXT_STYLE)) assert.equal(items.at(-1)[key], value);
  assert.equal(items.at(-1).color, '#232425');
  assert.ok(Object.isFrozen(SAC_PALETTE));
  assert.ok(Object.isFrozen(SAC_TEXT_STYLE));
  const modified = sacShapeStyle(); modified.stroke = '#ff0000';
  assert.equal(sacShapeStyle().stroke, '#232425');
});

test('vector arrows use SAC navy and fading preserves an explicit arrow color', () => {
  const preset = createArrowPreset('fadedVectorArrow');
  assert.equal(preset.fill, '#00609C');
  assert.equal(preset.fillGradient.stops.at(-1).color, '#00609C');
  const drawn = createDrawingShape('drawCurveArrow', points);
  assert.equal(drawn.fill, preset.fill);
  drawn.fill = '#ab1234'; fadeArrow(drawn);
  assert.equal(drawn.fillGradient.stops.at(-1).color, '#ab1234');
  drawn.fill = 'none'; fadeArrow(drawn);
  assert.equal(drawn.fillGradient.stops.at(-1).color, '#00609C');
});

test('explicit authoring styles win and existing documents retain legacy rendering defaults', () => {
  const input = createDeck(), slideId = input.activeSlideId;
  input.slides[0].items = [
    {id:'legacy-box',type:'rect',x:10,y:10,width:100,height:80,fill:'#f3e5d1',stroke:'#252735'},
    {id:'legacy-text',type:'text',x:20,y:20,width:100,height:40,text:'Existing'},
    {id:'legacy-line',type:'line',x:10,y:100,width:150,height:0},
  ];
  const before = validateDeck(input), legacy = structuredClone(before.slides[0].items);
  assert.equal(legacy[1].color, '#111827');
  assert.equal(legacy[2].stroke, '#111827');
  const result = prepareBatch(before, [
    {op:'add_shape',slideId,shapeType:'rect',properties:{fill:'#eeddaa',stroke:'#765432',strokeWidth:5,fillOpacity:.6}},
    {op:'add_text',slideId,properties:{text:'Custom',fontFamily:'Helvetica',color:'#123456',fontWeight:700,align:'center'}},
  ]);
  const reopened = validateDeck(JSON.parse(serializeDeck(result.project)));
  assert.deepEqual(reopened.slides[0].items.slice(0, 3), legacy);
  assert.deepEqual(before.slides[0].items, legacy);
  const [shape, text] = reopened.slides[0].items.slice(3);
  assert.equal(shape.fill, '#eeddaa'); assert.equal(shape.stroke, '#765432');
  assert.equal(shape.strokeWidth, 5); assert.equal(shape.fillOpacity, .6);
  assert.equal(text.fontFamily, 'Helvetica'); assert.equal(text.color, '#123456');
  assert.equal(text.fontWeight, 700); assert.equal(text.align, 'center');
});
