import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createDeck, duplicateSlide, serializeDeck, validateDeck } from '../deck.js';
import { createSelection, encodeSelection, decodeSelection } from '../clipboard.js';
import { selectionToPNG } from '../clipboard-image.js';
import { exportPPTX } from '../pptx.js';
import { generateHTMLReport } from '../report.js';
import { layoutTextBlock } from '../pptx-import.js';
import { DEFAULT_SHADOW } from '../shadow.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = { id:'source', name:'source.png', mime:'image/png', width:100, height:80, dataUrl:`data:image/png;base64,${PNG}` };
const picture = { id:'image',type:'image',assetId:'source',x:20,y:20,width:100,height:80,softEdge:5 };
const fixture = (extra={}) => ({...createProject(),assets:[asset],items:[{...picture,...extra}]});

test('soft edges validate optional point radii and preserve old projects', () => {
  const legacy=fixture(); delete legacy.items[0].softEdge;
  assert.equal(Object.hasOwn(validateProject(legacy).items[0],'softEdge'),false);
  for(const radius of [0,1,2.5,5,10,25,50,100]) assert.equal(validateProject(fixture({softEdge:radius})).items[0].softEdge,radius);
  for(const radius of [-1,101,NaN,Infinity,'5',null,{}]) assert.throws(()=>validateProject(fixture({softEdge:radius})),/softEdge/);
  assert.equal(JSON.parse(serializeProject(fixture())).items[0].softEdge,5);
});

test('save, duplicate and editable clipboard retain independently editable soft edges', () => {
  const deck=validateDeck(fixture()); duplicateSlide(deck);
  deck.slides[1].items[0].softEdge=25;
  const reopened=validateDeck(JSON.parse(serializeDeck(deck)));
  assert.deepEqual(reopened.slides.map(s=>s.items[0].softEdge),[5,25]);
  assert.equal(decodeSelection(encodeSelection(createSelection(fixture(),new Set(['image'])))).items[0].softEdge,5);
});

test('feathered PNG cannot bypass rendering; zero feather keeps original source bytes', async () => {
  await assert.rejects(selectionToPNG(fixture()),/requires a browser/);
  assert.deepEqual(Buffer.from(await (await selectionToPNG(fixture({softEdge:0}))).arrayBuffer()),Buffer.from(PNG,'base64'));
});

test('SVG and HTML retain masks for cropped pictures and shapes without blurring source colors', () => {
  const input=fixture({crop:{x:.25,y:0,width:.5,height:1},shadow:{...DEFAULT_SHADOW,enabled:true}});
  input.items.push({id:'shape',type:'ellipse',x:150,y:0,width:100,height:80,fill:'#33669980',stroke:'none',softEdge:10});
  const svg=projectToSVG(input);
  assert.match(svg,/in="SourceGraphic" in2="soft-edge-mask" operator="in"/);
  assert.match(svg,/viewBox="0.25 0 0.5 1"/);
  const ids=[...svg.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size);
  assert.match(generateHTMLReport(validateDeck(input)),/soft-edge-mask/);
  assert.doesNotMatch(projectToSVG(fixture({softEdge:0})),/soft-edge-mask/);
});

test('PPTX exports editable native soft edges for images, shapes and text with one effect list', async () => {
  const input=fixture({shadow:{...DEFAULT_SHADOW,enabled:true}});
  input.items.push({id:'shape',type:'rect',x:150,y:20,width:100,height:80,softEdge:10});
  input.items.push({id:'text',type:'text',x:20,y:150,width:100,height:40,text:'Soft',softEdge:1});
  const bytes=Buffer.from(await (await exportPPTX(input)).arrayBuffer());
  // The package uses stored ZIP members, so native XML can be inspected directly.
  const xml=bytes.toString('utf8').match(/<p:sld\b[\s\S]*?<\/p:sld>/)[0];
  assert.equal((xml.match(/<a:effectLst>/g)||[]).length,3);
  assert.match(xml,/<\/a:outerShdw><a:softEdge rad="63500"\/><\/a:effectLst>/);
  assert.match(xml,/<a:softEdge rad="127000"/);
  assert.match(xml,/<a:softEdge rad="12700"/);
  assert.match(xml,/<a:t[^>]*>Soft<\/a:t>/);
  const deck=validateDeck(input);duplicateSlide(deck);
  deck.slides[1].canvas.width*=2;deck.slides[1].canvas.height*=2;
  const slides=[...Buffer.from(await (await exportPPTX(deck)).arrayBuffer()).toString('utf8').matchAll(/<p:sld\b[\s\S]*?<\/p:sld>/g)];
  assert.match(slides[1][0],/<a:softEdge rad="31750"/);
});

test('imported text runs retain distinct soft edges and explicit zero overrides', () => {
  const run=(text,extra={})=>({text,fontFamily:'Arial',fontSize:20,fontWeight:400,fontStyle:'normal',color:'#123456',baseline:0,...extra});
  const block={name:'Text',x:0,y:0,width:300,height:100,rotation:0,opacity:1,softEdge:5,insets:{left:0,right:0,top:0,bottom:0},anchor:'t',wrap:false,scaleY:1,
    paragraphs:[{runs:[run('A'),run('B',{softEdge:0}),run('C',{softEdge:2})],align:'left',marginLeft:0,marginRight:0,indent:0,spacing:{}}]};
  const items=layoutTextBlock(block,(text,r)=>({width:text.length*10,ascent:16,descent:4}));
  assert.deepEqual(items.map(i=>i.softEdge),[5,0,2]);
});
