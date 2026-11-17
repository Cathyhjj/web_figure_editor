// Regression coverage for retained selection/inspector DOM and deferred drag snapshots.
// Owns an ephemeral localhost server, isolated Chrome and synthetic OPFS/files only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, serializeDeck, validateDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'figure-selection-regression-'));
const server = spawn('python3', ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()']);
let stderr = '', browser, page;
server.stderr.on('data', value => { stderr += value; });
const errors = [], checks = [];
const pass = value => { checks.push(value); console.log('PASS', value); };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
function fixture() {
  const deck = createDeck(); deck.name = 'Selection cache regression';
  deck.assets = [{ id: 'source', name: 'original.png', mime: 'image/png', width: 1, height: 1, dataUrl: `data:image/png;base64,${pixel}` }];
  deck.slides[0].items = [
    { id: 'rectangle', name: 'Rectangle', type: 'rect', x: 60, y: 70, width: 180, height: 110, fill: '#c9dfef', stroke: '#36556e' },
    { id: 'label', name: 'Label', type: 'text', text: 'Spectrum label', x: 330, y: 70, width: 270, height: 80, fontSize: 24 },
    { id: 'picture', name: 'Picture', type: 'image', assetId: 'source', x: 70, y: 290, width: 190, height: 130 },
  ];
  return validateDeck(deck);
}
const original = fixture();
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Server startup timed out')), 10000);
    createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1050 } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('figure-editor-autosave', 'off');
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('selection.figure.json', { create: true });
  });
  const idle = () => page.waitForFunction(() => !document.querySelector('#save-project-as').disabled);
  const stageItem = id => page.locator(`#stage > [data-item="${id}"]`);
  const center = async id => { const rect = await stageItem(id).boundingBox(); assert.ok(rect); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
  const clickObject = async id => { const point = await center(id); await page.mouse.click(point.x, point.y); };
  const selectLayer = id => page.locator(`[data-layer="${id}"] .layer-select`).click();
  const field = name => page.locator(`#inspector [data-property="${name}"]`);
  const sizeTab = async () => { if (await page.locator('[data-format-tab="size"]').count()) await page.locator('[data-format-tab="size"]').click(); };
  const load = async () => { await page.locator('#project-input').setInputFiles({ name: 'selection.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(original)) }); await idle(); };
  async function save() {
    await page.locator('#save-project-as').click(); await idle();
    return page.evaluate(async () => JSON.parse(await (await (await navigator.storage.getDirectory()).getFileHandle('selection.figure.json')).getFile().then(file => file.text())));
  }
  await page.goto(`http://127.0.0.1:${port}/`); await idle(); await load();
  await clickObject('rectangle'); await sizeTab();
  await page.evaluate(() => {
    window.selectionNodes = { inspector: document.querySelector('#inspector [data-property="x"]'), layer: document.querySelector('[data-layer="rectangle"]') };
  });
  for (let index = 0; index < 6; index++) await clickObject('rectangle');
  assert.equal(await page.locator('#undo').isDisabled(), true);
  if (process.env.PERFORMANCE_ASSERT_REUSE === '1') assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(window.selectionNodes).map(([key,node]) => [key,node.isConnected]))), { inspector: true, layer: true });
  pass('repeated object clicks keep empty history and optionally retain layer/inspector nodes');

  const start = await center('rectangle'); await page.mouse.move(start.x,start.y); await page.mouse.down();
  await page.mouse.move(start.x+17,start.y+11); await page.mouse.move(start.x+34,start.y+22); await page.mouse.up();
  const moved = await save(), movedItem = moved.slides[0].items[0];
  assert.ok(movedItem.x > 60 && movedItem.y > 70);
  assert.ok(Math.abs(Number(await field('x').inputValue())-movedItem.x)<.11, 'inspector geometry refreshes at drag end');
  await page.locator('#undo').click();
  assert.equal(await page.locator('#undo').isDisabled(),true,'one Undo consumes the complete drag');
  assert.deepEqual((await save()).slides[0].items,original.slides[0].items);
  await page.locator('#redo').click(); assert.deepEqual((await save()).slides[0].items,moved.slides[0].items);
  pass('pointerdown then movement records one full drag and updates inspector geometry');

  await selectLayer('rectangle'); await sizeTab();
  await field('x').fill('210'); await field('x').dispatchEvent('change');
  assert.equal((await save()).slides[0].items[0].x,210);
  await page.locator('#undo').click(); await selectLayer('rectangle');
  assert.ok(Math.abs(Number(await field('x').inputValue())-movedItem.x)<.11);
  await field('x').fill('235'); await field('x').dispatchEvent('change');
  assert.equal((await save()).slides[0].items[0].x,235,'inspector callback after Undo edits the current item');
  await page.locator('[data-layer="rectangle"] [data-action="lock"]').click();
  assert.equal((await save()).slides[0].items[0].locked,true,'retained layer callback targets current item');
  await page.locator('#undo').click(); await selectLayer('rectangle');
  assert.equal(await field('x').isDisabled(),false);
  pass('property changes, Undo and retained layer callbacks use current model objects');

  await load(); await selectLayer('picture');
  async function relink(name,width,height,color) {
    await page.evaluate(async ({name,width,height,color}) => {
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const file=new File([blob],name,{type:'image/png'});
      window.showOpenFilePicker=async()=>[{kind:'file',name,getFile:async()=>file,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted'}];
      const card=document.querySelector('[data-asset="source"]');
      await card.onclick({target:card.querySelector('[data-action="relink"]')});
    },{name,width,height,color});
  }
  await relink('replacement.png',200,100,'#2478a1');
  assert.match(await page.locator('#inspector').textContent(),/replacement\.png/);
  assert.match(await page.locator('#inspector').textContent(),/200 × 100/);
  let saved=await save(); assert.equal(saved.assets[0].id,'source');assert.equal(saved.assets[0].width,200);
  await page.locator('#undo').click();await selectLayer('picture');
  assert.match(await page.locator('#inspector').textContent(),/original\.png/);
  await relink('second-replacement.png',80,40,'#a14624');
  assert.match(await page.locator('#inspector').textContent(),/second-replacement\.png/);
  saved=await save();assert.equal(saved.assets[0].id,'source');assert.equal(saved.assets[0].width,80);
  await page.locator('#undo').click();await selectLayer('picture');
  assert.match(await page.locator('#inspector').textContent(),/original\.png/);
  await page.locator('#redo').click();await selectLayer('picture');
  assert.match(await page.locator('#inspector').textContent(),/second-replacement\.png/);
  pass('same-ID asset replacement and history refresh source inspector and callback identity');

  await load();await selectLayer('label');await stageItem('label').dblclick();
  const editor=page.locator('#canvas-text-editor');await editor.waitFor();
  await editor.evaluate(input=>{window.originalTextEditor=input;input.setSelectionRange(4,4);window.compositionEvents=[];for(const name of ['compositionstart','compositionupdate','compositionend'])input.addEventListener(name,event=>window.compositionEvents.push({type:event.type,data:event.data}));});
  await page.keyboard.type('X');
  assert.equal(await editor.inputValue(),'SpecXtrum label');
  assert.equal(await editor.evaluate(input=>input.selectionStart),5);
  await page.evaluate(()=>document.querySelector('#zoom-in').click());
  assert.deepEqual(await editor.evaluate(input=>({same:input===window.originalTextEditor,focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd})),{same:true,focused:true,start:5,end:5});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'谱',selectionStart:1,selectionEnd:1,replacementStart:5,replacementEnd:5});
  assert.ok((await editor.inputValue()).includes('谱'));
  const compositionSelection=await editor.evaluate(input=>[input.selectionStart,input.selectionEnd]);
  await page.evaluate(()=>document.querySelector('#zoom-out').click());
  assert.deepEqual(await editor.evaluate(input=>[input.selectionStart,input.selectionEnd]),compositionSelection);
  assert.deepEqual(await editor.evaluate(input=>({same:input===window.originalTextEditor,focused:document.activeElement===input})),{same:true,focused:true});
  assert.equal(await page.evaluate(()=>window.compositionEvents.filter(event=>event.type==='compositionend').length),0,'redraw must not end IME composition');
  await cdp.send('Input.insertText',{text:'谱图'});
  const typed=await editor.inputValue();assert.ok(typed.includes('谱图'));
  assert.equal(await page.evaluate(()=>window.compositionEvents.filter(event=>event.type==='compositionend').length),1);
  await page.keyboard.press('Escape');saved=await save();assert.equal(saved.slides[0].items[1].text,typed);
  await page.locator('#undo').click();assert.equal((await save()).slides[0].items[1].text,original.slides[0].items[1].text);
  pass('text caret, focused textarea and real Chromium IME composition survive zoom redraw; one Undo restores text');
  assert.deepEqual(errors,[]);console.log(`${checks.length} selection regression checks passed. ${output}`);
} catch(error) {
  if(page){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error('Status:',await page.locator('#status').textContent(),'Errors:',errors,'Artifacts:',output);}
  throw error;
} finally {await browser?.close();server.kill();}
