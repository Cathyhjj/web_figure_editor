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
import { describeProject, prepareBatch } from '../automation.js';

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

test('single-edge settings survive save, duplication, clipboard and live edit operations', () => {
  const input = fixture({softEdgeMode:'single', softEdgeAngle:37, softEdgeStrength:176});
  const deck = validateDeck(input), slideId = deck.activeSlideId;
  const paste = decodeSelection(encodeSelection(createSelection(input,new Set(['image']))));
  assert.deepEqual([paste.items[0].softEdgeMode,paste.items[0].softEdgeAngle],['single',37]);
  assert.equal(paste.items[0].softEdgeStrength,176);
  duplicateSlide(deck);
  const edited = prepareBatch(deck,[{op:'set',slideId,itemIds:['image'],properties:{softEdge:15,softEdgeAngle:90,softEdgeStrength:250}}]);
  const saved = validateDeck(JSON.parse(serializeDeck(edited.project)));
  assert.deepEqual(saved.slides.map(s => [s.items[0].softEdge,s.items[0].softEdgeMode,s.items[0].softEdgeAngle]),
    [[15,'single',90],[5,'single',37]]);
  assert.deepEqual(saved.slides.map(s => s.items[0].softEdgeStrength),[250,176]);
  assert.equal(describeProject(saved,slideId).slide.items[0].softEdgeAngle,90);
  assert.equal(describeProject(saved,slideId).slide.items[0].softEdgeStrength,250);
  for (const invalid of [{softEdgeMode:'other'},{softEdgeMode:null},{softEdgeAngle:-1},{softEdgeAngle:361},{softEdgeAngle:'90'}]) {
    assert.throws(() => validateProject(fixture(invalid)),/softEdge/);
  }
  assert.throws(() => validateProject({...input,items:[{id:'rect',type:'rect',x:0,y:0,width:40,height:30,softEdgeMode:'single'}]}),/require an image/);
});

test('single-edge strength controls initial alpha independently of fade width', () => {
  const input = fixture({softEdgeMode:'single',softEdge:15});
  const item = input.items[0];
  const mask = () => projectToSVG(input).match(/<linearGradient [^>]+>[\s\S]*?<\/linearGradient>/)?.[0];
  const original = mask();
  assert.match(original,/x1="0" y1="0" x2="20" y2="0"/);
  assert.match(original,/stop-opacity="0"/);
  assert.equal(Object.hasOwn(validateProject(input).items[0],'softEdgeStrength'),false);
  item.softEdgeStrength = 100;
  assert.equal(mask(),original);
  item.softEdgeStrength = 37.5;
  assert.equal(mask(),original.replace('stop-opacity="0"', 'stop-opacity="0.625"'));
  item.softEdgeStrength = 0;
  assert.doesNotMatch(projectToSVG(input),/<mask/);
  item.softEdgeMode = 'all';
  assert.match(projectToSVG(input),/result="soft-edge-mask"/);
  for (const value of [-1,300.01,NaN,Infinity,'50',null]) {
    assert.throws(() => validateProject(fixture({softEdgeStrength:value})),/softEdgeStrength/);
  }
  assert.throws(() => validateProject({...input,items:[{id:'rect',type:'rect',x:0,y:0,width:40,height:30,softEdgeStrength:0}]}),/require an image/);
});

test('boosted strength lowers opacity throughout the same directional band', () => {
  for (const strength of [100.01,125,200,250,300]) {
    const svg = projectToSVG(fixture({softEdgeMode:'single',softEdge:15,softEdgeStrength:strength}));
    const gradient = svg.match(/<linearGradient [^>]+>[\s\S]*?<\/linearGradient>/)[0];
    assert.match(gradient,/x1="0" y1="0" x2="20" y2="0"/);
    const stops = [...gradient.matchAll(/<stop offset="([^"]+)" stop-color="white" stop-opacity="([^"]+)"/g)]
      .map(([,offset,alpha]) => [Number(offset),Number(alpha)]);
    assert.deepEqual(stops[0],[0,0]);
    assert.deepEqual(stops.at(-1),[1,1]);
    for (let i = 1; i < stops.length; i++) {
      const [x0,a0] = stops[i-1], [x1,a1] = stops[i];
      assert.ok(x1 > x0 && a1 >= a0);
      for (const fraction of [0,.25,.5,.75,1]) {
        const t = x0 + fraction * (x1 - x0);
        const alpha = a0 + fraction * (a1 - a0);
        assert.ok(Math.abs(alpha - t ** (strength / 100)) < 1/255);
      }
    }
  }
});

test('radial feather follows the image perimeter with a circular radius relative to the short edge', () => {
  const input = fixture({width:240,height:80,softEdgeMode:'radial',softEdgeStrength:200});
  const item = input.items[0];
  delete item.softEdge;  // Independent of the all-edge/linear width setting.
  for (const [angle,cx,cy] of [[0,0,40],[45,0,0],[90,120,0],[135,240,0],[180,240,40],[225,240,80],[270,120,80],[315,0,80],[360,0,40]]) {
    item.softEdgeAngle = angle;
    assert.ok(projectToSVG(input).includes(`gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="40"`));
  }
  item.softEdgeRadius = 200;
  const largest = projectToSVG(input);
  assert.match(largest,/<radialGradient [^>]* r="160">/);
  assert.match(largest,/<stop offset="0.5" stop-color="white" stop-opacity="0.25"/);
  item.softEdgeStrength = 0;
  assert.doesNotMatch(projectToSVG(input),/<mask/);
  Object.assign(item,{softEdge:15,softEdgeStrength:200,softEdgeRadius:0});
  assert.doesNotMatch(projectToSVG(input),/<mask/);
  item.softEdgeMode = 'single';
  assert.match(projectToSVG(input),/<linearGradient/);
  for (const value of [-1,200.01,NaN,Infinity,'50',null]) {
    assert.throws(() => validateProject(fixture({softEdgeRadius:value})),/softEdgeRadius/);
  }
});

test('radial settings can be authored, described, and reopened on an image', () => {
  const deck = validateDeck(fixture());
  const op = {op:'place_asset',slideId:deck.activeSlideId,assetId:'source',properties:{
    softEdgeMode:'radial',softEdgeAngle:315,softEdgeRadius:75,softEdgeStrength:270}};
  const {project,createdItemIds} = prepareBatch(deck,[op]);
  const restored = validateDeck(JSON.parse(serializeDeck(project)));
  const {slide} = describeProject(restored, restored.activeSlideId);
  const item = slide.items.find(i => i.id === createdItemIds[0]);
  assert.ok(item);
  for (const [key,value] of Object.entries(op.properties)) assert.equal(item[key],value);
});

test('directional mask uses the visible content of a contained picture and its shadow', () => {
  const input = fixture({width:200,height:80,imageFit:'contain',stroke:'#225566',strokeWidth:4,softEdgeMode:'single',softEdgeAngle:0,softEdge:15,
    shadow:{...DEFAULT_SHADOW,enabled:true,size:50,angle:0,distance:0}});
  const svg = projectToSVG(input);
  // 100x80 pixels sit at x=50 in this frame. A 15 pt edge fades over 20 CSS px.
  assert.match(svg,/gradientUnits="userSpaceOnUse" x1="50" y1="0" x2="70" y2="0"/);
  // The 50% centered shadow scales both the content boundary and feather width.
  assert.match(svg,/gradientUnits="userSpaceOnUse" x1="75" y1="20" x2="85" y2="20"/);
  assert.match(generateHTMLReport(validateDeck(input)),/maskContentUnits="userSpaceOnUse"/);
  assert.doesNotMatch(projectToSVG(fixture({softEdgeMode:'single',softEdge:0})),/<mask/);
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
