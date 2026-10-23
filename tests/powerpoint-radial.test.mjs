import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gradientSVG,gradientColorAt} from '../shape.js';
import {gradientBounds} from '../shape-geometry.js';
import {interpolatedStop} from '../gradient-editor.js';
const manifest=JSON.parse(readFileSync(new URL('./fixtures/powerpoint-radial/cases.json',import.meta.url),'utf8'));

test('radial coordinates match geometry emitted by native PowerPoint PDF export',()=>{
  for(const entry of manifest.cases.filter(c=>c.nativeGeometry)){
    const item=entry.project.items[0],g=item.fillGradient;
    const svg=gradientSVG(item,g,'native-reference');
    const value=k=>Number(svg.match(new RegExp(` ${k}="([^"]+)"`))[1]);
    const angle=(g.rotateWithShape===false ? -item.rotation : 0)*Math.PI/180;
    const point=(x,y)=>[item.width/2+(x-item.width/2)*Math.cos(angle)-(y-item.height/2)*Math.sin(angle),item.height/2+(x-item.width/2)*Math.sin(angle)+(y-item.height/2)*Math.cos(angle)];
    const actual=[...point(value('fx'),value('fy')),0,...point(value('cx'),value('cy')),value('r')];
    actual.forEach((v,i)=>assert.ok(Math.abs(v-entry.nativeGeometry[i])<.1,`${entry.project.name} coordinate ${i}: ${v} vs native ${entry.nativeGeometry[i]}`));
  }
});

test('native two-endpoint blend preserves editable stops and samples the visible color on insertion',()=>{
  const g={angle:0,type:'radial',stops:[{offset:0,color:'#ff000000'},{offset:1,color:'#0000ff'}]};
  const saved=structuredClone(g);
  assert.equal(gradientColorAt(g,.5),'#b900b980');
  assert.deepEqual(interpolatedStop(g,.5),{offset:.5,color:'#b900b980'});
  const svg=gradientSVG({type:'rect',width:200,height:100,rotation:0},g,'test');
  assert.match(svg,/offset="0.5" stop-color="#b900b980"/);
  assert.deepEqual(g,saved,'paint samples never become editable or exported stops');
  const inset={...g,stops:[{offset:.1,color:'#ff000000'},{offset:.9,color:'#0000ff'}]};
  assert.equal(gradientColorAt(inset,.5),'#80008080');
  const multi={...g,stops:[g.stops[0],{offset:.5,color:'#808080'},g.stops[1]]};
  assert.equal(gradientColorAt(multi,.25),'#c0404080');
});

test('radial bounds exclude unused shape frame and use cubic extrema instead of control points',()=>{
  const inset=manifest.cases.find(c=>c.project.name==='custom-offset').project.items[0];
  const box=gradientBounds(inset);
  assert.deepEqual(box,{x:50,y:20,width:300,height:120});
  const curve=manifest.cases.find(c=>c.project.name==='custom-curve').project.items[0];
  assert.deepEqual(gradientBounds(curve),{x:0,y:0,width:500,height:300});
});
