import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createProject, validateProject, projectToSVG } from '../core.js';
import { cloneShape, shapeSVG as vectorSVG } from '../shape.js';
import { shapeSVG, shapeBounds } from '../shapes.js';
import { exportPPTX } from '../pptx.js';

const gradient={angle:0,stops:[{offset:0,color:'#ff000080'},{offset:1,color:'#0000ff'}]};
const item=(type='line',extra={})=>({id:type,name:type,type,x:20,y:20,width:200,height:type==='line'?0:100,rotation:0,opacity:1,fill:'none',stroke:'none',strokeWidth:6,strokeGradient:structuredClone(gradient),...extra});
const project=(...items)=>({...createProject(),items});

test('gradient strokes survive serialization and independent copies for native and custom shapes',()=>{
  for(const type of ['line','rect','shape']){
    const source=item(type,type==='shape'?{paths:[{fillMode:'none',stroke:true,commands:[['M',0,0],['L',1,1]]}]}:{});
    const p=validateProject(JSON.parse(JSON.stringify(project(source))));
    assert.deepEqual(p.items[0].strokeGradient,gradient);
    const copy={...p.items[0],...cloneShape(p.items[0])};
    copy.strokeGradient.stops[0].color='#00ff00';
    assert.equal(p.items[0].strokeGradient.stops[0].color,'#ff000080');
    assert.match(projectToSVG(p),/stroke="url\(#/);
  }
});

test('invalid gradient properties cannot bypass project validation',()=>{
  for(const value of [null,{},false,{...gradient,angle:NaN},{...gradient,stops:[{offset:1,color:'red'},{offset:0,color:'blue'}]}]){
    assert.throws(()=>validateProject(project(item('line',{strokeGradient:value}))),/gradient/);
  }
  assert.throws(()=>validateProject(project(item('shape',{paths:[{fillMode:'norm',stroke:true,commands:[['M',0,0],['L',1,1]]}],fillGradient:null}))),/gradient/);
});

test('horizontal and vertical lines use nonzero user-space gradient servers with scoped IDs',()=>{
  for(const shape of [item(),item('line',{width:0,height:200,strokeGradient:{...gradient,angle:90}})]){
    const svg=shapeSVG(shape,'stage-line');
    assert.match(svg,/gradientUnits="userSpaceOnUse"/);
    assert.doesNotMatch(svg,/NaN|Infinity/);
    const ends=[...svg.matchAll(/[xy][12]="([\d.-]+)"/g)].slice(0,4).map(match=>+match[1]);
    assert.notDeepEqual(ends.slice(0,2),ends.slice(2,4));
    assert.ok(shapeBounds(shape).width>0&&shapeBounds(shape).height>0);
    assert.match(shapeSVG(shape,'preview-line'),/id="preview-line-stroke-gradient"/);
  }
  const arrow=shapeSVG(item('doubleArrow',{height:0,strokeDash:'dash',strokeOpacity:.4}),'arrow');
  assert.match(arrow,/fill="url\(#arrow-stroke-gradient\)"/);
  assert.match(arrow,/mask="url\(#arrow-stroke-mask\)"/);
  assert.match(arrow,/opacity="0.4"/);
  assert.match(arrow,/stroke-dasharray="24 18"/);
});

test('custom unfilled paths retain gradient strokes without adding a fill',()=>{
  const svg=vectorSVG(item('shape',{paths:[{fillMode:'none',stroke:true,commands:[['M',0,0],['L',1,1]]}]}),'custom');
  assert.match(svg,/fill="none"/);
  assert.match(svg,/stroke="url\(#custom-stroke-gradient\)"/);
});

test('native PPTX export and parser roundtrip preserve gradient line paint, stops and opacity',async()=>{
  for(const shape of [item(),item('rect',{strokeOpacity:.5}),item('arrow',{height:100,connector:'elbow',connectorFlipX:true,strokeGradient:{...gradient,angle:30}})]){
    const blob=await exportPPTX(project(shape));
    const python="import sys,json,base64,io,zipfile; from pptx_import import import_pptx; b=sys.stdin.read(); z=zipfile.ZipFile(io.BytesIO(base64.b64decode(b))); print(json.dumps({'xml':z.read('ppt/slides/slide1.xml').decode(),'result':import_pptx({'data':b,'slide':1})}))";
    const {xml,result}=JSON.parse(execFileSync('python3',['-c',python],{input:Buffer.from(await blob.arrayBuffer()).toString('base64'),encoding:'utf8'}));
    assert.match(xml,/<a:ln[^>]*><a:gradFill/);
    const converted=result.items.find(i=>i.name===shape.name);
    assert.equal(converted.strokeGradient.angle,shape.strokeGradient.angle);
    assert.equal(converted.strokeGradient.stops[0].color,shape.strokeOpacity===.5?'#ff000040':'#ff000080');
    assert.equal(converted.strokeGradient.stops[1].color,shape.strokeOpacity===.5?'#0000ff80':'#0000ff');
    assert.equal(result.media.length,0);
  }
});
