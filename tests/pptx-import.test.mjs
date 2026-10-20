import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTextBlock } from '../pptx-import.js';
import { createDeck, validateDeck, cloneDeck } from '../deck.js';
import { pasteSlides } from '../clipboard.js';

const run = (text, extra={}) => ({text,fontFamily:'Arial',fontSize:20,fontWeight:400,fontStyle:'normal',color:'#123456',baseline:0,spacing:0,...extra});
const block = (runs=[run('Editable text')], extra={}) => ({name:'Text',x:100,y:200,width:300,height:100,rotation:0,opacity:1,insets:{left:10,right:10,top:5,bottom:5},anchor:'t',wrap:true,scaleY:1,
  paragraphs:[{runs,align:'left',marginLeft:0,marginRight:0,indent:0,spacing:{}}],...extra});
const measure = (text,run) => ({width:[...text].length*run.fontSize*.5,ascent:run.fontSize*.8,descent:run.fontSize*.2});

test('PPT text remains editable with explicit wrapping and the original text content',()=>{
  const result=layoutTextBlock(block([run('First line\nSecond line')]),measure);
  assert.equal(result.length,1); assert.equal(result[0].text,'First line\nSecond line');
  assert.equal(result[0].x,110); assert.equal(result[0].y,201);assert.equal(result[0].fontSize,20);
  const wrapped=layoutTextBlock(block([run('ABCDEFGHIJK')],{width:60}),measure);
  assert.equal(wrapped[0].text,'ABCD\nEFGH\nIJK');
});

test('mixed styles and superscripts retain independent styles and baseline positions',()=>{
  const result=layoutTextBlock(block([run('Fe'),run('3+',{fontSize:13,baseline:.3,color:'#ff0000'}),run(' sample',{fontWeight:700})]),measure);
  assert.equal(result.map(x=>x.text).join(''),'Fe3+ sample');assert.equal(result.length,3);
  assert.equal(result[1].fontSize,13);assert.equal(result[1].color,'#ff0000');assert.equal(result[2].fontWeight,700);
  assert.ok(result[1].y+result[1].fontSize<result[0].y+result[0].fontSize);
});

test('line spacing uses each line font size and keeps trailing explicit breaks',()=>{
  const mixed=layoutTextBlock(block([run('Large\n',{fontSize:30}),run('small\nsmall',{fontSize:10})]),measure);
  assert.equal(mixed[2].y-mixed[1].y,12);
  const trailing=layoutTextBlock(block([run('end\n')]),measure);
  assert.equal(trailing[0].text,'end\n');assert.equal(trailing[0].height,48);
});

test('centered rotated text keeps the shape rotation and does not lose characters',()=>{
  const value=block([run('α β 中文')],{rotation:90,anchor:'ctr'});
  value.paragraphs[0].align='center';
  const result=layoutTextBlock(value,measure);
  assert.equal(result[0].rotation,90);assert.equal(result[0].align,'center');assert.equal(result[0].text,'α β 中文');
  assert.ok(Number.isFinite(result[0].x+result[0].y));
});

test('imported slide insertion preserves destination and gets independent object ids',()=>{
  const destination=createDeck(), before=cloneDeck(destination);
  const imported=createDeck();imported.slides[0].items=layoutTextBlock(block(),measure);
  imported.slides[0].canvas={width:1280,height:720,background:'#abcdef'};
  const inserted=pasteSlides(destination,validateDeck(imported));
  assert.equal(destination.slides.length,2);assert.deepEqual(destination.slides[0],before.slides[0]);
  assert.equal(destination.activeSlideId,inserted[0].id);assert.notEqual(inserted[0].items[0].id,imported.slides[0].items[0].id);
  assert.equal(inserted[0].canvas.width,1280);inserted[0].items[0].text='Changed';
  assert.equal(imported.slides[0].items[0].text,'Editable text');
});

test('project limits reject slide insertion atomically',()=>{
  const destination=createDeck(), imported=createDeck();
  for(let i=1;i<100;i++)destination.slides.push({...structuredClone(destination.slides[0]),id:'slide-'+i});
  const before=cloneDeck(destination);
  assert.throws(()=>pasteSlides(destination,imported),/100/);
  assert.deepEqual(destination,before);
});
