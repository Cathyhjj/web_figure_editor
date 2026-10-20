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
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('snapshot saved'),null,{timeout:20000});
 check('HTML import renders chart and captures real PNG',await frame.locator('#zoom-level').textContent()==='Zoom: 1');
 async function chartPointer(child,selector,click=false){const outer=await page.locator('#html-chart-overlay iframe').boundingBox();const inner=await child.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}});const x=outer.x+inner.x*outer.width/inner.width,y=outer.y+inner.y*outer.height/inner.height;await page.mouse.move(x,y);if(click)await page.mouse.click(x,y);}
 await chartPointer(frame,'#peak');await frame.locator('#tooltip').waitFor({state:'visible'});check('Real pointer hover shows chart tooltip',true);
 await chartPointer(frame,'#zoom-chart',true);await page.waitForTimeout(100);check('Chart zoom changes data view',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 await page.locator('#zoom-in').click();check('Editor zoom preserves live chart state',await frame.locator('#zoom-level').textContent()==='Zoom: 1.2');
 check('Sandbox blocks parent DOM and localStorage',await frame.locator('body').evaluate(()=>!window.parentAccess&&!window.storageAccess)&&!(await page.locator('body').getAttribute('data-html-escaped')));
 await page.locator('#html-chart-snapshot').click();await page.waitForFunction(()=>!document.getElementById('html-chart-snapshot').disabled);
 await page.screenshot({path:path.join(output,'interactive.png'),fullPage:true});
 await frame.locator('#zoom-chart').press('Escape');check('Escape inside iframe returns to layout',await page.locator('#html-chart-overlay').isHidden());
 await page.locator('#interact-html').click();await page.locator('#html-chart-overlay iframe').waitFor();
 await page.locator('#html-chart-done').click();check('Done returns to layout',await page.locator('#html-chart-overlay').isHidden());
 const saved=page.waitForEvent('download');await page.locator('#save-project').click();const download=await saved;const savedPath=path.join(output,'saved.figure.json');await download.saveAs(savedPath);const deck=JSON.parse(await fs.readFile(savedPath,'utf8'));
 check('Saved project retains source and generated PNG',deck.assets[0].mime==='text/html'&&deck.assets[0].hasSnapshot&&deck.assets[0].posterWidth===1920&&deck.slides[0].items[0].type==='html');
 await page.locator('#new-project').click();await page.locator('#project-input').setInputFiles(savedPath);await page.locator('.layer-select').click();await page.locator('#interact-html').click();
 const reopened=page.locator('#html-chart-overlay iframe').contentFrame();await reopened.locator('#zoom-chart').waitFor();await chartPointer(reopened,'#zoom-chart',true);await page.waitForTimeout(100);check('Reopened chart still executes zoom',await reopened.locator('#zoom-level').textContent()==='Zoom: 1.2');await page.locator('#html-chart-done').click();
 for(const format of ['png','svg','pdf','pptx','html']){
  await page.locator('#export-open').click();await page.locator('#export-format').selectOption(format);const promise=page.waitForEvent('download');await page.locator('#export-submit').click();const result=await promise;const out=path.join(output,'export.'+format);await result.saveAs(out);check(format.toUpperCase()+' export succeeds with chart snapshot',(await fs.stat(out)).size>1000);
 }
 check('No uncaught editor/iframe errors',errors.length===0);
 console.log(JSON.stringify({checks,errors},null,2));
}catch(error){console.error(error);console.error('PAGE ERRORS',errors);console.error('STATUS',await page.locator('#status').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'error.png'),fullPage:true});process.exitCode=1;}finally{await browser.close();}
