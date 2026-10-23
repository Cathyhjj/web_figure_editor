// Start python3 server.py --port 18792; use a separate browser context and synthetic data.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output=await fs.mkdtemp(path.join(os.tmpdir(),'figure-soft-edge-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1550,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{window.showSaveFilePicker=undefined;window.showOpenFilePicker=undefined;});
let count=0;
function check(name,pass){if(!pass)throw new Error(name);count++;console.log('PASS',name);}
try{
  await page.goto('http://127.0.0.1:18792/');
  await page.waitForFunction(()=>!document.getElementById('open-project').disabled);
  const fixture=await page.evaluate(async()=>{
    const {createDeck}=await import('./deck.js');const deck=createDeck();deck.name='Soft edges verification';
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#2864dc';ctx.fillRect(20,20,160,120);
    ctx.fillStyle='#000000';ctx.fillRect(100,60,1,40);ctx.fillStyle='#ffffff';ctx.fillRect(101,60,1,40);
    deck.assets=[{id:'image-source',name:'transparent-detail.png',mime:'image/png',width:200,height:160,dataUrl:canvas.toDataURL()}];
    deck.slides[0].canvas={width:320,height:240,background:'transparent'};
    deck.slides[0].items=[{id:'picture',type:'image',name:'Feathered image',assetId:'image-source',x:40,y:40,width:200,height:160,rotation:0,opacity:1}];
    return deck;
  });
  async function open(deck){
    await page.locator('#project-input').setInputFiles({name:'soft-edge.figure.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(deck))});
    await page.waitForFunction(()=>document.getElementById('project-name').value==='Soft edges verification');
    await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');
    await page.locator('#format-tab-effects').click();
  }
  async function saved(){const download=page.waitForEvent('download');await page.locator('#save-project').click();return JSON.parse(await fs.readFile(await (await download).path(),'utf8'));}
  await open(fixture);
  check('PPT-style presets and default-off size are exposed',await page.locator('#soft-edge-preset option').count()===8&&await page.locator('#soft-edge-size').inputValue()==='0');
  await page.locator('#soft-edge-preset').selectOption('10');
  check('Preset renders feathering in live canvas and slide thumbnail',await page.locator('#stage filter[id^="soft-edge-"]').count()===1&&await page.locator('.slide-preview filter[id^="soft-edge-"]').count()===1);
  const slider=page.locator('[data-soft-edge][type="range"]');
  await slider.evaluate(el=>{for(const value of ['15','20']){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}el.dispatchEvent(new Event('change',{bubbles:true}));});
  check('Slider synchronizes numeric size live',await page.locator('#soft-edge-size').inputValue()==='20');
  await page.locator('#undo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');check('One undo restores the slider gesture',await page.locator('#soft-edge-size').inputValue()==='10');
  await page.locator('#redo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');check('Redo restores soft edges',await page.locator('#soft-edge-size').inputValue()==='20');
  const snapshot=await saved();check('Saved project retains editable radius',snapshot.slides[0].items[0].softEdge===20);
  await open(snapshot);check('Reopen restores the soft edge control',await page.locator('#soft-edge-size').inputValue()==='20');
  await page.locator('#duplicate').click();await page.locator('#soft-edge-preset').selectOption('5');
  const duplicates=await saved();check('Duplicates have independent radii',duplicates.slides[0].items.map(i=>i.softEdge).join(',')==='20,5');
  await page.locator('#format-tab-size').click();await page.locator('#object-locked').check();await page.locator('#format-tab-effects').click();
  check('Locked object disables all feather controls',await page.locator('#soft-edge-preset').isDisabled()&&await page.locator('#soft-edge-size').isDisabled()&&await slider.isDisabled());
  await page.locator('#format-tab-size').click();await page.locator('#object-locked').uncheck();await page.locator('#format-tab-effects').click();
  await page.locator('#soft-edge-preset').selectOption('0');
  check('No soft edges removes the selected object filter',await page.locator('#stage .figure-item.selected filter').count()===0);
  snapshot.slides[0].items[0].softEdge=10;
  await open(snapshot);
  await page.screenshot({path:path.join(output,'soft-edge-editor.png')});
  const raster=await page.evaluate(async fixture=>{
    const {slideProject}=await import('./deck.js');const {exportPNG,projectToSVG}=await import('./core.js');
    const {selectionToPNG}=await import('./clipboard-image.js');const {exportPDF}=await import('./pdf.js');
    const {exportPPTX}=await import('./pptx.js');const {preparePPTXSlide}=await import('./pptx-import.js');
    const {DEFAULT_SHADOW}=await import('./shadow.js');
    const p=slideProject(fixture);p.items[0].softEdge=10;
    const results=[];const check=(name,pass)=>results.push({name,pass:!!pass});
    async function pixels(blob){const bitmap=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const data=ctx.getImageData(0,0,c.width,c.height).data;return (x,y)=>[...data.slice((y*c.width+x)*4,(y*c.width+x)*4+4)];}
    const plain=structuredClone(p);plain.items[0].softEdge=0;
    const before=await pixels(await exportPNG(plain,96)),after=await pixels(await exportPNG(p,96));
    check('PNG feather follows transparent image content, leaving outside pixels clear',after(50,120)[3]===0&&after(60,120)[3]<80&&after(66,120)[3]>after(60,120)[3]&&after(66,120)[3]<255);
    check('PNG preserves opaque center and sharp one-pixel source detail',JSON.stringify(after(140,120))===JSON.stringify(before(140,120))&&JSON.stringify(after(141,120))===JSON.stringify(before(141,120))&&after(141,120)[0]>240&&after(140,120)[0]<10);
    const high=await pixels(await exportPNG(p,192));check('Higher DPI preserves physical feather width',Math.abs(high(132,240)[3]-after(66,120)[3])<25);
    const cropped=structuredClone(p);cropped.items[0].crop={x:.25,y:0,width:.5,height:1};
    const crop=await pixels(await exportPNG(cropped,96));check('Crop edges feather after cropping',crop(40,120)[3]<80&&crop(65,120)[3]>245);
    const faded=structuredClone(p);faded.items[0].opacity=.5;const fade=await pixels(await exportPNG(faded,96));
    check('Object transparency is applied once',Math.abs(fade(100,120)[3]-128)<2&&fade(66,120)[3]<after(66,120)[3]);
    const shapes={...p,assets:[],items:[{id:'rect',type:'rect',x:40,y:40,width:200,height:160,fill:'#2864dc80',stroke:'none',strokeWidth:0,softEdge:10}]};
    const shape=await pixels(await exportPNG(shapes,96));check('Semitransparent shape interior retains original alpha',Math.abs(shape(140,120)[3]-128)<2&&shape(40,120)[3]<50);
    const shadow=structuredClone(p);shadow.items[0].shadow={...DEFAULT_SHADOW,enabled:true,color:'#00cc44',transparency:0,distance:30,angle:0,blur:0};
    const combined=await pixels(await exportPNG(shadow,96));check('Feather and shadow compose without losing the shadow',combined(250,120)[3]>0&&combined(250,120)[1]>150);
    const copied=await pixels(await selectionToPNG(p));check('Copy as PNG retains feather rather than raw image bytes',copied(20,80)[3]<80&&copied(40,80)[3]>245);
    const svg=projectToSVG(p);check('SVG retains an editable embedded effect',svg.includes('soft-edge-mask')&&svg.includes('data:image/png;base64,'));
    const pdf=await exportPDF(p,96);check('PDF contains a transparency mask for the feathered bitmap',/\/SMask/.test(await pdf.text()));
    const local=await (await fetch('/api/local')).json();
    const ppt=await exportPPTX(cropped), encoded=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(ppt);});
    const response=await fetch('/api/pptx-import',{method:'POST',headers:{'Content-Type':'application/json','X-Figure-Token':local.token},body:JSON.stringify({name:'soft-edge.pptx',data:encoded,slide:1})});
    const converted=await response.json();if(!response.ok)throw new Error(JSON.stringify(converted));
    const reopened=await preparePPTXSlide(converted);
    check('PPTX export and real import preserve editable soft edges and crop',reopened.deck.slides[0].items[0].softEdge===10&&reopened.deck.slides[0].items[0].crop.x===.25);
    const data=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
    return {results,png:await data(await exportPNG(p,96)),pdf:await data(pdf)};
  },fixture);
  for(const result of raster.results)check(result.name,result.pass);
  await fs.writeFile(path.join(output,'soft-edge.png'),Buffer.from(raster.png));await fs.writeFile(path.join(output,'soft-edge.pdf'),Buffer.from(raster.pdf));
  check('Browser has no uncaught errors',errors.length===0);
  console.log(`${count} checks passed. Artifacts: ${output}`);
}finally{await browser.close();}
