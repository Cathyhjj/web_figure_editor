import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { validateGradient, cloneShape, gradientStopColor, gradientSVG } from '../shape.js';
import { exportPPTX } from '../pptx.js';
import { exportPDF } from '../pdf.js';

const legacy={angle:45,stops:[{offset:0,color:'#80000080'},{offset:1,color:'#4488cc'}]};
const radial={...legacy,type:'radial',center:{x:.25,y:.75},rotateWithShape:false,stops:[{...legacy.stops[0],brightness:50},{...legacy.stops[1],brightness:-25}]};
const item=(type='rect',extra={})=>({id:type,name:type,type,x:20,y:20,width:200,height:100,rotation:30,opacity:1,fill:'#ffffff',stroke:'none',strokeWidth:0,fillGradient:structuredClone(radial),...extra});
const project=(...items)=>({...createProject(),items});
const paths=[{fillMode:'norm',stroke:true,commands:[['M',0,0],['L',1,0],['L',.5,1],['Z']]}];

test('native and custom shape fills survive save and independent cloning with optional metadata',()=>{
  assert.deepEqual(validateGradient(legacy),legacy,'older project files keep their original gradient model');
  for(const type of ['rect','ellipse','roundRect','shape']){
    const source=item(type,type==='shape'?{paths}:{});
    const restored=validateProject(JSON.parse(serializeProject(project(source)))).items[0];
    assert.deepEqual(restored.fillGradient,radial);
    const copy={...restored,...cloneShape(restored)};
    copy.fillGradient.center.x=1;
    copy.fillGradient.stops[0].brightness=-100;
    copy.fillGradient.stops[0].color='#000000';
    assert.deepEqual(restored.fillGradient,radial,'the duplicate cannot mutate source paint');
    const svg=projectToSVG(project(restored));
    assert.match(svg,/<radialGradient /);
    assert.match(svg,/fill="url\(#/);
    assert.doesNotMatch(svg,/<image /);
  }
});

test('gradient validation rejects invalid optional metadata and copies accepted centers',()=>{
  for(const extra of [{type:'conical'},{type:null},{center:null},{center:{x:-.1,y:.5}},{center:{x:.5,y:Infinity}},{center:{x:0}},{rotateWithShape:0},{stops:[{offset:0,color:'red',brightness:101},{offset:1,color:'blue'}]},{stops:[{offset:0,color:'red',brightness:NaN},{offset:1,color:'blue'}]}]){
    assert.throws(()=>validateProject(project(item('ellipse',{fillGradient:{...legacy,...extra}}))),/gradient/);
  }
  const source=structuredClone(radial),copy=validateGradient(source);
  source.center.x=1;source.stops[0].brightness=-100;
  assert.deepEqual(copy,radial);
  assert.throws(()=>validateProject(project(item('roundRect',{fillGradient:null}))),/gradient/);
});

test('brightness changes HSL luminance non-destructively and retains stop transparency',()=>{
  const base={color:'#80000080',brightness:50};
  assert.equal(gradientStopColor(base),'#ff404080');
  assert.equal(gradientStopColor({...base,brightness:-50}),'#40000080');
  assert.equal(gradientStopColor({...base,brightness:100}),'#ffffff80');
  assert.equal(gradientStopColor({...base,brightness:-100}),'#00000080');
  assert.equal(gradientStopColor({color:'#8888',brightness:0}),'#88888888');
  assert.equal(base.color,'#80000080');
});

test('radial SVG uses the DrawingML circumscribing circle and fixed orientation for rotated shapes',()=>{
  const svg=gradientSVG(item(),radial,'unsafe" paint');
  assert.match(svg,/id="unsafe--paint"/);
  assert.match(svg,/cx="100" cy="50" r="145.465646" fx="44.19873" fy="96.650635"/);
  assert.match(svg,/gradientTransform="rotate\(-30 100 50\)"/);
  assert.match(svg,/stop-color="#ff404080"/);
  const defaultRadial=gradientSVG(item(),{...legacy,type:'radial'},'radial');
  assert.match(defaultRadial,/cx="100" cy="50" r="111.803399" fx="100" fy="50"/);
  assert.doesNotMatch(defaultRadial,/rotate\(/);
  const linear=gradientSVG(item(),{...legacy,rotateWithShape:false},'linear');
  assert.match(linear,/<linearGradient /);
  assert.match(linear,/gradientTransform="rotate\(-30 100 50\)"/);
  assert.doesNotMatch(svg+defaultRadial+linear,/NaN|Infinity/);
});

async function pptxXML(input){
  const blob=await exportPPTX(input);
  const python="import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'xml':z.read('ppt/slides/slide1.xml').decode(),'media':[s for s in z.namelist() if s.startswith('ppt/media/')]}))";
  return JSON.parse(execFileSync('python3',['-c',python],{input:Buffer.from(await blob.arrayBuffer()),encoding:'utf8'}));
}

test('PPTX keeps radial fills editable with native center, rotation, brightness and alpha',async()=>{
  const {xml,media}=await pptxXML(project(item('ellipse',{opacity:.5,fillOpacity:.5})));
  assert.deepEqual(media,[]);
  assert.match(xml,/<a:prstGeom prst="ellipse"/);
  assert.match(xml,/<a:gradFill rotWithShape="0">/);
  assert.match(xml,/<a:path path="circle"><a:fillToRect l="25000" t="75000" r="75000" b="25000"\/><\/a:path>/);
  assert.match(xml,/<a:srgbClr val="800000"><a:alpha val="12549"\/><a:lumMod val="50000"\/><a:lumOff val="50000"\/><\/a:srgbClr>/);
  assert.match(xml,/<a:srgbClr val="4488CC"><a:alpha val="25000"\/><a:lumMod val="75000"\/><\/a:srgbClr>/);
  assert.doesNotMatch(xml,/<a:lin /);
  const linear=await pptxXML(project(item('roundRect',{fillGradient:legacy})));
  assert.match(linear.xml,/<a:gradFill rotWithShape="1">/);
  assert.match(linear.xml,/<a:lin ang="2700000" scaled="1"\/>/);
  assert.doesNotMatch(linear.xml,/<a:path path="circle"/);
});

test('PDF native gradient patches preserve the world orientation while rendering local geometry',async()=>{
  const saved=new Map(['document','Image'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,blobs=[],canvases=[],revoked=[];
  globalThis.document={createElement(type){
    assert.equal(type,'canvas');
    const canvas={width:0,height:0,getContext(){return {drawImage(){},getImageData(){return {data:new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255)};}};}};
    canvases.push(canvas);return canvas;
  }};
  globalThis.Image=class{set src(value){queueMicrotask(()=>this.onload());}};
  URL.createObjectURL=blob=>{blobs.push(blob);return `blob:gradient-fill-${blobs.length}`;};
  URL.revokeObjectURL=url=>revoked.push(url);
  try {
    for(const type of ['linear','radial']){
      const source=item('rect',{width:20,height:10,rotation:90,fillGradient:{...radial,type},strokeGradient:{...legacy,rotateWithShape:false},strokeWidth:2});
      const pdf=await exportPDF(project(source),96);
      assert.equal(pdf.type,'application/pdf');
      const svg=await blobs.at(-1).text();
      assert.match(svg,/rotate\(0 10 5\)/,'patch shape remains local');
      assert.equal((svg.match(/gradientTransform="rotate\(-90 10 5\)/g)||[]).length,2,'fill and border keep world orientation');
      assert.deepEqual(source.fillGradient,{...radial,type},'export leaves project metadata intact');
    }
    assert.equal(revoked.length,blobs.length);
    assert.ok(canvases.every(canvas=>canvas.width===0&&canvas.height===0));
  } finally {
    for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;
  }
});
