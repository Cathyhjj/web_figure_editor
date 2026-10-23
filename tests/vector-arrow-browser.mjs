// Synthetic project in an isolated browser context and ephemeral local server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'vector-arrow-check-'));
const server=spawn('python3',['-u','-c','import server; from pathlib import Path; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(stderr||'Server startup timed out')),10000);
  createInterface({input:server.stdout}).once('line',line=>{clearTimeout(timer);resolve(Number(line));});
  server.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});
});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1550,height:1050}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
await page.addInitScript(()=>localStorage.setItem('figure-editor-autosave','off'));
const selected=()=>page.locator('#stage .figure-item.selected');
const path=()=>selected().locator('path[fill-opacity]').first().getAttribute('d');
const insert=async key=>{await page.locator('#shapes-toggle').click();await page.locator(`[data-shape-choice="${key}"]`).click();};
const set=async(selector,value)=>{await page.locator(selector).fill(String(value));await page.locator(selector).dispatchEvent('change');};
let checks=0;
const pass=name=>{checks++;console.log('PASS',name);};
try {
  await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>!document.querySelector('#open-project').disabled);
  await insert('fadedVectorArrow');
  assert.equal(await selected().locator('[data-arrow-point]').count(),4);
  assert.equal(await selected().locator('linearGradient').count(),1);
  assert.equal(await selected().locator('stop').first().getAttribute('stop-color'),'#59667500');
  await set('[data-arrow-property="shaftWidth"]',10);
  await page.locator('[data-arrow-property="heads"]').selectOption('both');
  await page.locator('[data-arrow-property="headStyle"]').selectOption('triangle');
  await page.locator('[data-arrow-action="solid"]').click();
  assert.equal(await selected().locator('linearGradient').count(),0);
  await page.locator('[data-arrow-action="fade"]').click();
  pass('insert, filled tips, taper controls and fading paint');

  await page.locator('[data-format-tab="size"]').click();await set('[data-property="rotation"]',37);
  const before=await path();
  const handle=await selected().locator('[data-arrow-point="1"]').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2+38,handle.y+handle.height/2+24,{steps:6});await page.mouse.up();
  const after=await path();assert.notEqual(after,before);
  await page.locator('#undo').click();await page.locator('#layer-list .layer-select').first().click();assert.equal(await path(),before);
  await page.locator('#redo').click();await page.locator('#layer-list .layer-select').first().click();assert.equal(await path(),after);
  const cancelled=await selected().locator('[data-arrow-point="2"]').boundingBox();
  await page.mouse.move(cancelled.x+cancelled.width/2,cancelled.y+cancelled.height/2);await page.mouse.down();
  await page.mouse.move(cancelled.x+50,cancelled.y+10);await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await path(),after);
  for(const cancel of ['blur','lostpointercapture']){
    const node=await selected().locator('[data-arrow-point="1"]').boundingBox();
    await page.mouse.move(node.x+node.width/2,node.y+node.height/2);await page.mouse.down();await page.mouse.move(node.x+30,node.y+20);
    await page.evaluate(type=>{
      if(type==='blur')window.dispatchEvent(new Event('blur'));
      else {const stage=document.querySelector('#stage');stage.releasePointerCapture(1);}
    },cancel);
    await page.mouse.up();assert.equal(await path(),after);
  }
  pass('rotated node drag, one-step Undo/Redo, Escape cancellation');

  await selected().locator('[data-arrow-insert="1"]').click();assert.equal(await selected().locator('[data-arrow-point]').count(),5);
  await selected().locator('[data-arrow-point="2"]').click({modifiers:['Alt']});assert.equal(await selected().locator('[data-arrow-point]').count(),4);
  const sourceId=await selected().getAttribute('data-item'),sourcePath=await path();
  await page.locator('#duplicate').click();await page.locator('[data-format-tab="paint"]').click();
  await set('[data-arrow-property="headWidth"]',44);
  assert.equal(await page.locator(`#stage [data-item="${sourceId}"] path[fill-opacity]`).first().getAttribute('d'),sourcePath);
  await page.locator('[data-format-tab="size"]').click();await page.locator('#object-locked').check();
  assert.equal(await selected().locator('[data-arrow-point]').count(),0);
  assert.ok(await page.locator('[data-arrow-property="shaftWidth"]').isDisabled());
  await page.locator('#object-locked').uncheck();
  pass('insert/remove points, independent duplication and object locking');

  for(const tool of ['drawCurveArrow','drawPolylineArrow']){
    await insert(tool);
    const stage=await page.locator('#stage').boundingBox();
    for(const [x,y] of [[280,70],[360,90],[340,170],[420,190]])await page.mouse.click(stage.x+x,stage.y+y);
    await page.keyboard.press('Enter');
    assert.equal(await selected().locator('[data-arrow-point]').count(),4);
    assert.ok((await path()).endsWith('Z'));
  }
  pass('draw arbitrary curves and multi-segment arrows');
  const count=await page.locator('#stage .figure-item').count();
  await page.waitForTimeout(1000);await page.reload();await page.waitForFunction(()=>!document.querySelector('#open-project').disabled);
  assert.equal(await page.locator('#stage .figure-item').count(),count);
  await page.locator('#layer-list .layer-select').first().click();
  assert.equal(await selected().locator('[data-arrow-point]').count(),4);
  pass('saved draft reload restores arrow editing');

  const exports=await page.evaluate(async()=>{
    const {createArrowPreset}=await import('./vector-arrow.js');
    const {createProject,exportPNG,projectToSVG}=await import('./core.js');
    const {exportPDF}=await import('./pdf.js');const {exportPPTX}=await import('./pptx.js');
    const project={...createProject(),items:[{id:'faded',opacity:1,...createArrowPreset('fadedVectorArrow')}]};
    return {png:(await exportPNG(project,96)).size,pdf:(await exportPDF(project)).size,pptx:(await exportPPTX(project)).size,svg:projectToSVG(project)};
  });
  assert.ok(exports.png>100&&exports.pdf>100&&exports.pptx>100);assert.doesNotMatch(exports.svg,/<image/);
  pass('faded-arrow PNG/PDF/PPTX export and vector SVG');
  await page.screenshot({path:join(output,'editor.png')});
  const sample=await page.evaluate(async()=>{
    const {createVectorArrow}=await import('./vector-arrow.js');
    const {createDeck,serializeDeck,slideProject}=await import('./deck.js');
    const {exportPNG}=await import('./core.js');
    const deck=createDeck();deck.name='Editable vector arrow examples';deck.slides[0].canvas={width:760,height:440,background:'#ffffff'};
    deck.slides[0].items=[
      ['curve',[{x:270,y:145},{x:235,y:95},{x:185,y:100},{x:160,y:145}],true],
      ['curve',[{x:70,y:220},{x:110,y:265},{x:205,y:290}],true],
      ['curve',[{x:460,y:155},{x:370,y:160},{x:330,y:235},{x:350,y:340}],true],
      ['polyline',[{x:690,y:220},{x:525,y:285}],true],
      ['polyline',[{x:520,y:350},{x:585,y:350},{x:585,y:385},{x:690,y:385}],false],
    ].map(([kind,points,fade],i)=>({id:'example-'+i,opacity:1,...createVectorArrow(kind,points,{fade}),
      shadow:{enabled:true,color:'#000000',transparency:78,size:100,blur:2,angle:90,distance:2}}));
    const blob=await exportPNG(slideProject(deck),96);
    return {project:serializeDeck(deck),png:Array.from(new Uint8Array(await blob.arrayBuffer()))};
  });
  await writeFile(join(output,'examples.figure.json'),sample.project);
  await writeFile(join(output,'examples.png'),Buffer.from(sample.png));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({output,passed:checks}));
} catch(error) {
  await page.screenshot({path:join(output,'failure.png')});
  console.error('Status:',await page.locator('#status').textContent(),'Errors:',errors,'Output:',output);throw error;
} finally {await browser.close();server.kill();}
