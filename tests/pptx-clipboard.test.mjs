import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePowerPointClipboard,clipboardImageDigest } from '../pptx-clipboard.js';
import { createProject,validateProject,projectToSVG } from '../core.js';
import { validateDeck,cloneDeck,duplicateSlide } from '../deck.js';
import { shapeSVG,validateShape } from '../shape.js';

const shape=()=>({id:'vector',type:'shape',x:10,y:20,width:200,height:100,fill:'#6699cc',stroke:'#000000',strokeWidth:2,
  paths:[{commands:[['M',0,0],['L',1,0],['C',1,1,.5,1,0,1],['Z']],fillMode:'norm',stroke:true}],
  fillGradient:{angle:90,stops:[{offset:0,color:'#00ff0080'},{offset:1,color:'#005500'}]}});
test('Office MIME decodes embedded package only, ignoring lookup IDs and MiB size hints',()=>{
  assert.equal(decodePowerPointClipboard(''),null);
  assert.deepEqual(decodePowerPointClipboard(JSON.stringify({ccpid:'/etc/password',packageKey:'https://bad',packageSize:2.1,isDataCompressed:false,data:'UEs='})),{data:'UEs='});
  for(const value of ['null','{bad',JSON.stringify({isDataCompressed:true,data:'UEs='}),JSON.stringify({isDataCompressed:false,data:'http://bad'})])assert.throws(()=>decodePowerPointClipboard(value));
});
test('PNG fingerprints refer to exact event bytes and skip other formats',async()=>{
  const a=new Blob(['a'],{type:'image/png'}),b=new Blob(['b'],{type:'image/png'});
  assert.notEqual(await clipboardImageDigest(a),await clipboardImageDigest(b));
  assert.equal(await clipboardImageDigest(new Blob(['a'],{type:'image/jpeg'})),null);
});
test('vector geometry survives model, SVG, save, duplicate and undo snapshots without shared mutations',()=>{
  const project=createProject();project.items=[shape()];
  const canonical=validateProject(project),deck=validateDeck(canonical),copy=cloneDeck(deck);
  duplicateSlide(deck);
  deck.slides[1].items[0].paths[0].commands[0][1]=.25;
  deck.slides[1].items[0].fillGradient.stops[0].color='#ff0000';
  assert.equal(deck.slides[0].items[0].paths[0].commands[0][1],0);
  assert.equal(copy.slides[0].items[0].fillGradient.stops[0].color,'#00ff0080');
  assert.deepEqual(validateDeck(JSON.parse(JSON.stringify(copy))),copy);
  assert.match(projectToSVG(canonical),/gradientUnits="userSpaceOnUse"/);
  assert.match(shapeSVG(canonical.items[0],'unique'),/C200 100 100 100 0 100/);
});
test('untrusted geometry/gradient cannot inject markup or exceed bounded command budgets',()=>{
  for(const mutate of [
    s=>s.paths[0].commands.push(['X',0,0]),
    s=>s.paths[0].commands[0][1]=Infinity,
    s=>s.paths[0].commands[0][1]=101,
    s=>s.paths[0].commands=Array.from({length:2049},()=>['M',0,0]),
    s=>s.fillGradient.stops[0].color='url(http://bad)',
    s=>s.fillGradient.stops[0].offset=2,
  ]){const item=shape();mutate(item);assert.throws(()=>validateShape(item));}
});
