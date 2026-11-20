import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createProject, validateProject, serializeProject } from '../core.js';
import { createSelection, encodeSelection, decodeSelection } from '../clipboard.js';
import { exportPPTX } from '../pptx.js';
import { attachPosterPictures, loadPosterPictures } from '../sac-poster.js';
import { SAC_STYLES, createSACStyle, sacStylePreview } from '../sac-styles.js';

async function pictureBytes(file) {
  const bytes = await readFile(new URL('../assets/sac-poster/' + file, import.meta.url));
  return 'data:image/png;base64,' + bytes.toString('base64');
}

async function allStyles(canvas) {
  const project = createProject();
  if (canvas) project.canvas = canvas;
  for (const entry of SAC_STYLES) {
    const items = createSACStyle(entry.id, project.canvas);
    attachPosterPictures(project, items, await loadPosterPictures(items, pictureBytes));
    project.items.push(...items);
  }
  return validateProject(project);
}

test('SAC components save, reopen and copy as editable native objects with independent paints',async()=>{
  const project=await allStyles();
  assert.equal(SAC_STYLES.length,40);
  assert.equal(project.assets.length,4);
  assert.equal(new Set(project.items.map(i=>i.id)).size,project.items.length);
  assert.deepEqual(validateProject(JSON.parse(serializeProject(project))),project);
  assert.deepEqual(decodeSelection(encodeSelection(createSelection(project,new Set(project.items.map(i=>i.id))))).items,project.items);
  for(const entry of SAC_STYLES) {
    const original=createSACStyle(entry.id),copy=createSACStyle(entry.id);
    assert.notEqual(copy[0].id,original[0].id);
    if(copy[0].paths)copy[0].paths[0].commands[0][1]=99;
    if(copy[0].fillGradient)copy[0].fillGradient.stops[0].color='#000000';
    assert.notDeepEqual(copy,original);
    const fresh=createSACStyle(entry.id);
    assert.deepEqual(fresh.map(({id,...i})=>i),original.map(({id,...i})=>i));
    const preview=sacStylePreview(entry.id);
    assert.doesNotMatch(preview,/NaN|Infinity|undefined/);
    assert.equal(preview.includes('<image'),original.some(i=>i.type==='image'));
  }
});

test('components fit small portrait canvases and preserve multi-layer effects',async()=>{
  const canvas={width:100,height:160,background:'#ffffff'};
  for(const entry of SAC_STYLES) {
    const items=createSACStyle(entry.id,canvas);
    const assets=await loadPosterPictures(items,pictureBytes);
    validateProject({...createProject(),canvas,items,assets});
    for(const i of items) {
      const a=i.rotation*Math.PI/180,rx=(Math.abs(Math.cos(a)*i.width)+Math.abs(Math.sin(a)*i.height))/2,ry=(Math.abs(Math.sin(a)*i.width)+Math.abs(Math.cos(a)*i.height))/2;
      assert.ok(i.x+i.width/2-rx>=-1e-6&&i.x+i.width/2+rx<=canvas.width+1e-6,entry.id);
      assert.ok(i.y+i.height/2-ry>=-1e-6&&i.y+i.height/2+ry<=canvas.height+1e-6,entry.id);
    }
  }
  const orb=createSACStyle('purple-orb');
  assert.equal(orb.length,2);assert.equal(orb[1].fillGradient.type,'radial');
  assert.equal(createSACStyle('panel-outline')[0].strokeWidth,2);
  for(const color of ['peach','coral','magenta','purple']) {
    const [line,dot]=createSACStyle(`connector-${color}`);
    assert.equal(line.strokeWidth,2.7);assert.equal(dot.width,8);assert.equal(dot.height,8);
  }
});

test('SAC library exports to editable PowerPoint without rasterizing or dropping layers',async()=>{
  const project=await allStyles();
  const blob=await exportPPTX(project);
  const script="import sys,json,base64\nfrom pptx_import import import_pptx\nprint(json.dumps(import_pptx({'name':'sac.pptx','data':base64.b64encode(sys.stdin.buffer.read()).decode(),'slide':1})))";
  const result=JSON.parse(execFileSync('python3',['-c',script],{input:Buffer.from(await blob.arrayBuffer()),cwd:new URL('..',import.meta.url),maxBuffer:16*1024*1024}));
  const items=result.items.filter(i=>i.name!=='Slide background');
  assert.equal(items.length,project.items.length);
  assert.equal(result.media.length,4);
  assert.ok(result.warnings.every(w=>w.startsWith('Fonts must be installed')),result.warnings.join('\n'));
  assert.equal(items.filter(i=>i.type==='textBlock').length,project.items.filter(i=>i.type==='text').length);
  assert.equal(items.filter(i=>i.fillGradient).length,project.items.filter(i=>i.fillGradient).length);
});


test('the full reference and its three sections retain every original layer and all four pictures',async()=>{
  const full=createSACStyle('poster-reference-layout');
  const sections=['ecosystem-ring','method-table','application-matrix'].flatMap(id=>createSACStyle(id));
  assert.equal(full.length,103);
  assert.equal(sections.length,full.length);
  assert.equal(full.filter(i=>i.type==='text').length,49);
  assert.equal(full.filter(i=>i.type==='image').length,4);
  assert.equal(createSACStyle('ecosystem-ring').filter(i=>i.name.endsWith('Teardrop node') && i.paths).length,4);
  assert.equal(createSACStyle('application-matrix').filter(i=>i.name.endsWith('Hexagonal badge')).length,3);
  assert.equal(createSACStyle('method-table').filter(i=>i.name.endsWith('Gradient strip')).length,12);
  const read=await loadPosterPictures(full,pictureBytes);
  const project=createProject();
  // A preexisting, unrelated asset can already occupy a library ID.
  project.assets.push({...read[0],dataUrl:'different'});
  attachPosterPictures(project,full,read);
  assert.equal(project.assets.length,5);
  assert.notEqual(full.find(i=>i.name.endsWith('Vascular image')).assetId,read[0].id);
  const repeat=createSACStyle('poster-reference-layout');
  attachPosterPictures(project,repeat,read);
  assert.equal(project.assets.length,5);
  assert.deepEqual(full.filter(i=>i.type==='image').map(i=>i.assetId),repeat.filter(i=>i.type==='image').map(i=>i.assetId));
  const swappedProject=createProject();
  const [first,second]=read;
  swappedProject.assets=[{...first,id:second.id},{...second,id:first.id}];
  const swappedItems=createSACStyle('poster-reference-layout');
  attachPosterPictures(swappedProject,swappedItems,read);
  for(const item of swappedItems.filter(i=>i.type==='image')){
    const original=full.find(i=>i.name===item.name);
    assert.equal(swappedProject.assets.find(a=>a.id===item.assetId).dataUrl,
      project.assets.find(a=>a.id===original.assetId).dataUrl);
  }

});
