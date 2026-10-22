import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createSelection, encodeSelection, decodeSelection } from '../clipboard.js';
import { createDeck, cloneDeck } from '../deck.js';
import { exportPPTX } from '../pptx.js';
import { exportPDF } from '../pdf.js';
import { SHAPE_CATEGORIES, DRAWING_TOOLS, createCatalogShape, catalogIcon } from '../shape-catalog.js';
import { createDrawingShape } from '../shape-drawing.js';
import { shapePath, arrowHeads } from '../shapes.js';
import { PRESET_PATHS } from '../shape-presets.js';

const entries=SHAPE_CATEGORIES.flatMap(group=>group.shapes);
const insertable=entries.filter(entry=>entry.id!=='textBox'&&!DRAWING_TOOLS.includes(entry.id));
const item = key => ({id:key,x:30,y:40,rotation:0,opacity:1,...createCatalogShape(key)});
const fixture=()=>validateProject({...createProject(),items:insertable.map(entry=>item(entry.id))});

test('gallery covers each screenshot category and every button has real geometry or a drawing action',()=>{
  assert.deepEqual(SHAPE_CATEGORIES.map(group=>[group.name,group.shapes.length]),[['Lines',12],['Rectangles',9],['Basic Shapes',44],['Block Arrows',31]]);
  assert.equal(new Set(entries.map(entry=>entry.id)).size,entries.length);
  const project=fixture();assert.equal(project.items.length,92);
  for(const entry of entries){assert.match(catalogIcon(entry.id),/<svg/);assert.doesNotMatch(catalogIcon(entry.id),/NaN|Infinity|undefined/);}
  for(const key of ['pie','chord','teardrop','arc','cube','circularArrow','leftCircularArrow','leftRightCircularArrow'])assert.ok(project.items.find(i=>i.id===key).paths.length);
  execFileSync('python3',['scripts/build_shape_catalog.py','--check'],{cwd:new URL('..',import.meta.url)});
});

test('new geometry survives save/reopen, clipboard and independent deck clones',()=>{
  const project=fixture(),saved=validateProject(JSON.parse(serializeProject(project)));
  assert.deepEqual(saved,project);
  const selection=createSelection(project,new Set(project.items.map(i=>i.id)));
  assert.deepEqual(decodeSelection(encodeSelection(selection)).items,project.items);
  const deck=createDeck();deck.slides[0].items=project.items;
  const clone=cloneDeck(deck),original=deck.slides[0].items.find(i=>i.id==='heart');
  clone.slides[0].items.find(i=>i.id==='heart').paths[0].commands[0][1]=42;
  assert.notEqual(original.paths[0].commands[0][1],42);
  const second=item('heart');second.paths[0].commands[0][1]=77;
  assert.notEqual(item('heart').paths[0].commands[0][1],77);
});

test('connector shafts match native PPT paths and arrowheads follow endpoint tangents',()=>{
  for(const [key,preset] of [['elbowDoubleArrow','bentConnector3'],['curvedDoubleArrow','curvedConnector3']]){
    const shape=item(key);
    const expected=PRESET_PATHS[preset][0].commands.map(([op,...values])=>[op,...values.map((v,i)=>v*(i%2?shape.height:shape.width))]);
    assert.deepEqual(shapePath(shape),expected);
    const heads=arrowHeads(shape);assert.deepEqual(heads[0][1],[0,0]);assert.deepEqual(heads[1][1],[shape.width,shape.height]);
    assert.equal(heads[0][0][0],heads[0][2][0]);assert.equal(heads[1][0][0],heads[1][2][0]);
    const svg=projectToSVG({...createProject(),items:[{...shape,strokeDash:'dash'}]});
    assert.equal((svg.match(/stroke-dasharray=/g)||[]).length,1);
  }
});

test('all catalog shapes round-trip through editable PPTX without flattening or omission',async()=>{
  const project=fixture();
  project.items.forEach((i,index)=>{i.fillOpacity=.45;i.strokeOpacity=.65;i.strokeDash='dash';if(i.connector){i.connectorFlipX=index%2===0;i.connectorFlipY=index%3===0;}});
  const script=`import sys,json,base64\nfrom pptx_import import import_pptx\nprint(json.dumps(import_pptx({'name':'catalog.pptx','data':base64.b64encode(sys.stdin.buffer.read()).decode(),'slide':1})))`;
  const blob=await exportPPTX(project);
  const result=JSON.parse(execFileSync('python3',['-c',script],{input:Buffer.from(await blob.arrayBuffer()),cwd:new URL('..',import.meta.url),maxBuffer:4*1024*1024}));
  const imported=result.items.filter(i=>i.name!=='Slide background');
  assert.equal(imported.length,project.items.length);assert.equal(result.media.length,0);
  assert.ok(result.warnings.every(w=>w.startsWith('Fonts must be installed')),result.warnings.join('\n'));
  for(let index=0;index<imported.length;index++){
    const restored=imported[index],source=project.items[index];
    assert.equal(restored.type,source.type,source.name);assert.equal(restored.strokeDash,'dash');
    if(source.connector){assert.equal(restored.connector,source.connector,source.name);assert.equal(restored.connectorFlipX,source.connectorFlipX);assert.equal(restored.connectorFlipY,source.connectorFlipY);}
    if(source.paths){
      assert.equal(restored.paths.length,source.paths.length,source.name);
      for(let p=0;p<source.paths.length;p++){
        assert.equal(restored.paths[p].fillMode,source.paths[p].fillMode);
        assert.equal(restored.paths[p].stroke,source.paths[p].stroke);
        assert.equal(restored.paths[p].commands.length,source.paths[p].commands.length);
        source.paths[p].commands.forEach((command,c)=>{
          assert.equal(restored.paths[p].commands[c][0],command[0]);
          command.slice(1).forEach((n,j)=>assert.ok(Math.abs(restored.paths[p].commands[c][j+1]-n)<.000002,source.name));
        });
      }
    }
  }
});

test('new shapes export as vectors and keep holes and shaded layers',async()=>{
  const project=fixture(),svg=projectToSVG(project),pdf=await(await exportPDF(project)).text();
  assert.doesNotMatch(svg,/<image/);assert.doesNotMatch(pdf,/\/Subtype \/Image/);
  assert.match(pdf,/ c\n/);
  for(const key of ['frame','donut','noSmoking'])assert.ok(item(key).paths.some(p=>p.commands.filter(c=>c[0]==='M').length>=2),key);
  for(const key of ['cube','bevel','curvedDownArrow'])assert.ok(item(key).paths.some(p=>p.fillMode==='darkenLess'||p.fillMode==='lightenLess'),key);
});

test('curve/freeform/scribble gestures generate portable paths with safe flat-axis dimensions',()=>{
  const points=[{x:10,y:30},{x:60,y:10},{x:100,y:70},{x:150,y:30}];
  for(const tool of DRAWING_TOOLS){
    const drawing=createDrawingShape(tool,points,tool==='freeform');
    const project=validateProject({...createProject(),items:[{id:tool,...drawing}]});
    assert.equal(project.items[0].paths[0].commands.at(-1)[0],tool==='curve'?'C':tool==='freeform'?'Z':'L');
    assert.equal(drawing.paths[0].fillMode,tool==='freeform'?'norm':'none');
    assert.doesNotMatch(projectToSVG(project),/NaN|Infinity/);
  }
  assert.equal(createDrawingShape('scribble',[{x:10,y:10}]),null);
  assert.equal(createDrawingShape('scribble',[{x:10,y:10},{x:30,y:10}]).height,1);
});
