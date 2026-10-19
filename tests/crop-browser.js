import { createDeck, validateDeck, slideProject } from '../deck.js';
import { exportPNG, projectToSVG } from '../core.js';
import { selectionToPNG } from '../clipboard-image.js';
import { generateHTMLReport } from '../report.js';
const checks = [], results = document.querySelector('#results');
function check(name, pass) { checks.push({name, pass:!!pass}); const el=document.createElement('li');el.textContent=`${pass?'PASS':'FAIL'} — ${name}`;el.dataset.pass=String(!!pass);results.append(el); }
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let j=0;j<100;j++){if(fn())return;await pause(50);}throw new Error('Timed out waiting for editor.'); }
function fixture() {
 const canvas=document.createElement('canvas');canvas.width=200;canvas.height=120;const ctx=canvas.getContext('2d');
 for(const [color,x,y] of [['red',0,0],['#00ff00',100,0],['blue',0,60],['yellow',100,60]]){ctx.fillStyle=color;ctx.fillRect(x,y,100,60);}
 const deck=createDeck();deck.assets=[{id:'source',name:'quadrants.png',mime:'image/png',dataUrl:canvas.toDataURL(),width:200,height:120,sourceKind:'copy'}];
 deck.slides[0].items=[{id:'picture',type:'image',name:'Quadrants',assetId:'source',x:100,y:80,width:400,height:240,rotation:0,opacity:1}];return validateDeck(deck);
}
async function raster(blob) {
 const url=URL.createObjectURL(blob);try{const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {width:c.width,height:c.height,pixel:(x,y)=>[...ctx.getImageData(x,y,1,1).data]};}finally{URL.revokeObjectURL(url);}
}
const green = p => p[0]<10&&p[1]>245&&p[2]<10&&p[3]>245;
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').disabled=true;results.replaceChildren();checks.length=0;
 try{
  const original=fixture();
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('figure-editor-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(original,'current');tx.objectStore('drafts').delete('project-file');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  const frame=document.createElement('iframe');frame.title='Crop test editor';
  const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Editor frame did not load. Reload and try again.')),15000);frame.onload=()=>{clearTimeout(timer);resolve();};frame.onerror=()=>{clearTimeout(timer);reject(new Error('Editor frame failed to load.'));};});
  frame.src='../index.html?crop-test='+Date.now();document.querySelector('#editor-host').replaceChildren(frame);await loaded;
  const win=frame.contentWindow, doc=frame.contentDocument, $=id=>doc.getElementById(id);
  await until(()=>$('status').textContent.includes('draft restored'));
  Object.defineProperty(win,'showSaveFilePicker',{configurable:true,value:undefined});Object.defineProperty(win,'showOpenFilePicker',{configurable:true,value:undefined});win.confirm=()=>true;
  const downloads=[];const create=win.URL.createObjectURL.bind(win.URL);win.URL.createObjectURL=blob=>{downloads.push(blob);return create(blob);};win.HTMLAnchorElement.prototype.click=function(){};
  async function saved(){const n=downloads.length;$('save-project').click();await until(()=>downloads.length>n);await pause(30);return JSON.parse(await downloads.at(-1).text());}
  // Layer selection avoids generating an artificial canvas drag.
  const layer=()=>[...doc.querySelectorAll('#layer-list .layer-row')].find(el=>el.textContent.includes('Quadrants'));
  function selectImage(){layer().click();}
  function drag(handle,from,to){
   const svg=$('crop-preview'),capture=svg.setPointerCapture,release=svg.releasePointerCapture;svg.setPointerCapture=()=>{};svg.releasePointerCapture=()=>{};
   const client=([x,y])=>new win.DOMPoint(x*200,y*120).matrixTransform(svg.getScreenCTM());
   const a=client(from),b=client(to),el=svg.querySelector(`[data-crop-handle="${handle}"]`);
   el.dispatchEvent(new win.PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:2,clientX:a.x,clientY:a.y}));
   svg.dispatchEvent(new win.PointerEvent('pointermove',{bubbles:true,pointerId:2,clientX:b.x,clientY:b.y}));
   svg.dispatchEvent(new win.PointerEvent('pointerup',{bubbles:true,pointerId:2,clientX:b.x,clientY:b.y}));
   svg.setPointerCapture=capture;svg.releasePointerCapture=release;
  }
  selectImage();$('crop-image').click();
  check('Selected image opens crop preview with eight handles', $('crop-dialog').open&&doc.querySelectorAll('.crop-handle').length===8);
  drag('nw',[0,0],[.5,0]);drag('se',[1,1],[1,.5]);
  $('crop-cancel').click();await pause(30);
  check('Cancel leaves image and source unchanged',JSON.stringify((await saved()).slides[0].items)===JSON.stringify(original.slides[0].items));
  selectImage();$('crop-image').click();drag('nw',[0,0],[.5,0]);drag('se',[1,1],[1,.5]);
  // Move the crop away and back; its dimensions must be retained.
  drag('move',[.75,.25],[.5,.5]);drag('move',[.5,.5],[.75,.25]);
  win.document.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Delete',bubbles:true}));
  $('crop-apply').click();await pause(30);
  const cropped=await saved(),i=cropped.slides[0].items[0];
  check('Edges, corners and frame movement set the expected crop',Math.abs(i.crop.x-.5)<1e-8&&Math.abs(i.crop.y)<1e-8&&Math.abs(i.crop.width-.5)<1e-8&&Math.abs(i.crop.height-.5)<1e-8);
  check('Crop retains source bytes, scale and position',cropped.assets[0].dataUrl===original.assets[0].dataUrl&&Math.abs(i.x-300)<1e-8&&Math.abs(i.y-80)<1e-8&&Math.abs(i.width-200)<1e-8&&Math.abs(i.height-120)<1e-8);
  check('Stage and slide preview both clip to the same source region',doc.querySelectorAll('#stage [data-item="picture"] svg[overflow="hidden"],.slide-preview svg[overflow="hidden"]').length===2);
  $('undo').click();const undone=await saved();check('Apply is one undo step',!undone.slides[0].items[0].crop&&undone.slides[0].items[0].width===400);
  $('redo').click();check('Redo restores crop',!!(await saved()).slides[0].items[0].crop);
  selectImage();$('restore-image').click();const restored=await saved();check('Restore original restores full geometry and bytes',!restored.slides[0].items[0].crop&&restored.slides[0].items[0].x===100&&restored.slides[0].items[0].width===400&&restored.assets[0].dataUrl===original.assets[0].dataUrl);
  $('undo').click();selectImage();check('Restore can be undone',!!(await saved()).slides[0].items[0].crop);
  const transfer=new win.DataTransfer();transfer.items.add(new win.File([JSON.stringify(cropped)],'crop.figure.json',{type:'application/json'}));$('project-input').files=transfer.files;$('project-input').dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>$('status').textContent.includes('opened'));
  selectImage();$('crop-image').click();check('Save and reopen retains an editable crop',Math.abs(Number(doc.querySelector('.crop-frame').getAttribute('width'))-100)<1e-7);$('crop-cancel').click();await pause(30);
  $('object-locked').click();check('Locked images cannot crop or restore',$('crop-image').disabled&&$('restore-image').disabled);$('object-locked').click();
  const p=slideProject(cropped),png=await raster(await exportPNG(p,96));
  check('PNG export renders selected green area and excludes source red',green(png.pixel(350,110))&&png.pixel(120,100).slice(0,3).every(v=>v===255));
  const copied=await raster(await selectionToPNG(p));check(`Clipboard output excludes cropped pixels and retains source density (${copied.width} × ${copied.height}; center ${copied.pixel(Math.floor(copied.width/2),Math.floor(copied.height/2)).join(',')})`,copied.width===100&&copied.height===60&&green(copied.pixel(50,30)));
  const svg=await raster(new Blob([projectToSVG(p)],{type:'image/svg+xml'}));check('SVG rasterization matches crop',green(svg.pixel(350,110)));
  const html=new DOMParser().parseFromString(generateHTMLReport(cropped),'text/html'),reportSVG=html.querySelector('figure svg');reportSVG.setAttribute('width','960');reportSVG.setAttribute('height','640');
  const report=await raster(new Blob([new XMLSerializer().serializeToString(reportSVG)],{type:'image/svg+xml'}));check('Offline HTML report renders the crop',green(report.pixel(350,110)));
  // Leave the actual app ready for a manual pointer check.
  selectImage();$('crop-image').click();$('crop-reset').click();
 }catch(e){check(e.message,false);console.error(e);}
 window.__cropChecks=checks;document.querySelector('#run').disabled=false;
};
