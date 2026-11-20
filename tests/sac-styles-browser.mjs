// Isolated synthetic project and ephemeral server; never attaches to a user page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAC_STYLES, createSACStyle } from '../sac-styles.js';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=await mkdtemp(join(tmpdir(),'sac-styles-browser-'));
const server=spawn(process.env.PYTHON||'python3',['-u','-c','import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()'],{cwd:resolve('.')});
let serverErrors='';server.stderr.on('data',chunk=>serverErrors+=chunk);
let browser;
try {
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(serverErrors||'Server timeout')),10000);
    createInterface({input:server.stdout}).once('line',line=>{clearTimeout(timer);resolve(Number(line));});
    server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exit ${code}: ${serverErrors}`));});
  });
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1500,height:1050}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>{localStorage.setItem('figure-editor-autosave','off');window.showSaveFilePicker=undefined;});
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(()=>!document.querySelector('#open-project').disabled);
  const items=page.locator('#stage .figure-item');
  const insert=async id=>{await page.locator('#sac-styles-toggle').click();await page.locator(`[data-sac-style="${id}"]`).click();};
  await page.locator('#sac-styles-toggle').click();
  assert.equal(await page.locator('[data-sac-style]').count(),SAC_STYLES.length);
  await page.locator('[data-sac-style="poster-reference-layout"] > svg').waitFor({timeout:5000});
  await page.screenshot({path:join(output,'gallery.png')});
  const search=page.getByRole('searchbox',{name:'Search SAC styles'});
  await search.fill('connector');assert.equal(await page.locator('[data-sac-style]:visible').count(),4);
  await search.fill('no such style');assert.equal(await page.locator('[data-sac-style]:visible').count(),0);
  await search.fill('section');await page.locator('[data-sac-style="section-panel"]').click();
  assert.equal(await items.count(),3);assert.equal(await page.locator('#stage .figure-item.selected').count(),3);
  await page.locator('#undo').click();assert.equal(await items.count(),0);
  await page.locator('#redo').click();assert.equal(await items.count(),3);
  const title=page.locator('#stage .figure-item').filter({has:page.locator('text')});
  await title.click();await page.locator('#text-content').fill('Editable SAC heading');await page.locator('#workspace').click({position:{x:10,y:10}});
  assert.match(await title.textContent(),/Editable SAC heading/);
  for(const entry of SAC_STYLES.filter(e=>e.id!=='section-panel'))await insert(entry.id);
  const count=SAC_STYLES.reduce((sum,entry)=>sum+createSACStyle(entry.id).length,0);
  await page.waitForFunction(n=>document.querySelectorAll('#stage .figure-item').length===n,count);
  const downloadPromise=page.waitForEvent('download');await page.locator('#save-project').click();
  const download=await downloadPromise,file=join(output,'saved.figure.json');await download.saveAs(file);
  const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.assets.length,4);assert.equal(saved.slides[0].items.length,count);
  await page.locator('#new-project').click();assert.equal(await items.count(),0);
  await page.locator('#project-input').setInputFiles(file);
  await page.waitForFunction(n=>document.querySelectorAll('#stage .figure-item').length===n,count);
  assert.match(await page.locator('#stage').textContent(),/Editable SAC heading/);
  await page.setViewportSize({width:720,height:700});await page.locator('#sac-styles-toggle').click();
  // Native popover toggle events are queued; wait for the positioning handler.
  await page.waitForFunction(()=>{
    const r=document.querySelector('#sac-styles-menu').getBoundingClientRect();
    return r.width>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;
  });
  const rect=await page.locator('#sac-styles-menu').boundingBox();
  assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=720&&rect.y+rect.height<=700);
  await page.getByRole('searchbox',{name:'Search SAC styles'}).press('Escape');
  assert.equal(await page.locator('#sac-styles-menu').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: gallery/search, native text editing, atomic undo/redo, all SAC insertions, save/reopen, responsive bounds, keyboard dismissal.');
  console.log('Evidence:',output);
}finally{if(browser)await browser.close();server.kill();}
