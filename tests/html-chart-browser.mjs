// Run against the dedicated localhost:18766 server, never the user's editing origin.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'figure-html-checks-'));
console.log('Test artifacts:', output);
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1550,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',dialog=>dialog.accept());
await page.addInitScript(()=>{window.showSaveFilePicker=undefined;window.showOpenFilePicker=undefined;});
const checks=[];function check(name,pass){checks.push({name,pass});if(!pass)throw new Error(name);console.log('PASS',name);}
try{
 await page.goto('http://127.0.0.1:18766/');await page.waitForFunction(()=>!document.getElementById('open-project').disabled);
 await page.locator('#html-file-input').setInputFiles(fileURLToPath(new URL('./fixtures/interactive-chart.html', import.meta.url)));
 await page.locator('#html-chart-overlay iframe').waitFor();
 const frame=await page.locator('#html-chart-overlay iframe').contentFrame();
 await frame.locator('#peak').waitFor();
 const runId=await frame.locator('body').getAttribute('data-run-id');
 const chartId=await page.locator('#html-chart-overlay').evaluate(el=>el.parentElement.dataset.item);
 const chart=page.locator(`#stage [data-item="${chartId}"]`);
 async function checkAnimation(name){const before=await frame.locator('body').evaluate(()=>window.animationFrames);await page.waitForTimeout(180);check(name,await frame.locator('body').evaluate(()=>window.animationFrames)>before&&await frame.locator('body').getAttribute('data-run-id')===runId);}
 async function checkLayout(name){check(name,await page.locator('#html-chart-controls').isHidden()&&await page.locator('#html-chart-overlay iframe').isVisible()&&await page.locator('#html-chart-overlay iframe').getAttribute('inert')!==null);await checkAnimation(name+' preserves animation and document');}
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('snapshot saved'),null,{timeout:20000});
 check('HTML import renders chart and captures real PNG',await frame.locator('#zoom-level').textContent()==='Zoom: 1');
 async function chartPointer(child,selector,click=false){const outer=await page.locator('#html-chart-overlay iframe').boundingBox();const inner=await child.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}});const x=outer.x+inner.x*outer.width/inner.width,y=outer.y+inner.y*outer.height/inner.height;await page.mouse.move(x,y);if(click)await page.mouse.click(x,y);}
 await chartPointer(frame,'#peak');await frame.locator('#tooltip').waitFor({state:'visible'});check('Real pointer hover shows chart tooltip',true);
 await chartPointer(frame,'#zoom-chart',true);await page.waitForTimeout(100);check('Chart zoom changes data view',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 await page.mouse.move(20,20);await checkAnimation('Pointer leaving chart keeps animation running');
 await page.locator('#zoom-in').click();check('Editor zoom preserves live chart state',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 check('Sandbox blocks parent DOM and localStorage',await frame.locator('body').evaluate(()=>!window.parentAccess&&!window.storageAccess)&&!(await page.locator('body').getAttribute('data-html-escaped')));
 await page.locator('#html-chart-snapshot').click();await page.waitForFunction(()=>!document.getElementById('html-chart-snapshot').disabled);
 await page.screenshot({path:path.join(output,'interactive.png'),fullPage:true});
 await frame.locator('#zoom-chart').press('Escape');await checkLayout('Escape inside iframe returns to layout with live preview');
 await page.locator('#interact-html').click();await page.locator('#html-chart-overlay iframe').waitFor();
 check('Re-entering after Escape preserves chart zoom',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 await page.locator('#html-chart-done').click();await checkLayout('Done returns to layout with live preview');
 const beforeDrag=await page.locator('#html-chart-overlay').boundingBox();
 await page.mouse.move(beforeDrag.x+beforeDrag.width*.6,beforeDrag.y+beforeDrag.height*.7);await page.mouse.down();await page.mouse.move(beforeDrag.x+beforeDrag.width*.6+36,beforeDrag.y+beforeDrag.height*.7+24,{steps:5});await page.mouse.up();
 const afterDrag=await page.locator('#html-chart-overlay').boundingBox();
 check('Layout drag moves chart without reloading it',Math.abs(afterDrag.x-beforeDrag.x-36)<2&&Math.abs(afterDrag.y-beforeDrag.y-24)<2&&await frame.locator('body').getAttribute('data-run-id')===runId);
 await page.mouse.dblclick(afterDrag.x+afterDrag.width*.6,afterDrag.y+afterDrag.height*.7);
 check('Double-click resumes the same zoomed chart',await page.locator('#html-chart-controls').isVisible()&&await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 const stageBox=await page.locator('#stage').boundingBox();await page.mouse.click(stageBox.x+20,stageBox.y+stageBox.height-20);
 await checkLayout('Deselecting keeps a live chart preview');check('Blank canvas click deselects the chart',await page.locator('#stage .figure-item.selected').count()===0);
 await chart.locator('.item-hit').dblclick();check('Re-entering after deselection preserves chart zoom',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 // Put a real editable label over the live iframe. It must paint and receive clicks
 // in front of the chart according to the slide's object order.
 const chartPosition=await chart.evaluate(el=>{const m=el.transform.baseVal.getItem(0).matrix;return {x:m.e,y:m.f};});
 await page.locator('#add-text').click();
 async function setProperty(key,value){const input=page.locator(`[data-property="${key}"]`);await input.fill(String(value));await input.dispatchEvent('change');}
 await setProperty('x',chartPosition.x+20);await setProperty('y',chartPosition.y+25);await setProperty('color','#00aa33');
 await page.locator('#text-content').fill('FOREGROUND');await page.locator('#text-content').blur();
 const label=page.locator('#stage .figure-item').filter({has:page.locator('text')});
 const labelId=await label.getAttribute('data-item');const labelBox=await label.boundingBox();
 const topItem=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('[data-item]')?.dataset.item,{x:labelBox.x+20,y:labelBox.y+20});
 check('Foreground label receives pointer hits over live chart',topItem===labelId);
 const foregroundPng=await page.screenshot({path:path.join(output,'foreground.png'),clip:labelBox});
 const greenPixels=await page.evaluate(async dataUrl=>{const image=new Image();image.src=dataUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<40&&pixels[i+1]>140&&pixels[i+1]<195&&pixels[i+2]<90)count++;return count;},'data:image/png;base64,'+foregroundPng.toString('base64'));
 check('Foreground label paints above the live chart',greenPixels>30);
 await page.mouse.click(labelBox.x+20,labelBox.y+20);check('Foreground label stays independently selectable',await label.getAttribute('class')==='figure-item selected');await checkAnimation('Editing foreground object preserves chart animation');
 const saved=page.waitForEvent('download');await page.locator('#save-project').click();const download=await saved;const savedPath=path.join(output,'saved.figure.json');await download.saveAs(savedPath);const deck=JSON.parse(await fs.readFile(savedPath,'utf8'));
 check('Saved project retains source and generated PNG',deck.assets[0].mime==='text/html'&&deck.assets[0].hasSnapshot&&deck.assets[0].posterWidth===1920&&deck.slides[0].items[0].type==='html');
 await page.locator('#new-project').click();await page.locator('#project-input').setInputFiles(savedPath);await page.locator(`[data-layer="${chartId}"] .layer-select`).click();await page.locator('#interact-html').click();
 const reopened=page.locator('#html-chart-overlay iframe').contentFrame();await reopened.locator('#zoom-chart').waitFor();await chartPointer(reopened,'#zoom-chart',true);await page.waitForTimeout(100);check('Reopened chart still executes zoom',await reopened.locator('#zoom-level').textContent()==='Zoom: 1.2');await page.locator('#html-chart-done').click();
 for(const format of ['png','svg','pdf','pptx','html']){
  await page.locator('#export-open').click();await page.locator('#export-format').selectOption(format);const promise=page.waitForEvent('download');await page.locator('#export-submit').click();const result=await promise;const out=path.join(output,'export.'+format);await result.saveAs(out);check(format.toUpperCase()+' export succeeds with chart snapshot',(await fs.stat(out)).size>1000);
 }
 check('No uncaught editor/iframe errors',errors.length===0);
 console.log(JSON.stringify({checks,errors},null,2));
}catch(error){console.error(error);console.error('PAGE ERRORS',errors);console.error('STATUS',await page.locator('#status').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'error.png'),fullPage:true});process.exitCode=1;}finally{await browser.close();}
