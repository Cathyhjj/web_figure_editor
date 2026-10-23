import { createDeck, addSlide } from '../deck.js';
import { exportPPTX } from '../pptx.js';

const run=document.querySelector('#run'),results=document.querySelector('#results');
function check(name,pass){window.pptxImportChecks.checks.push({name,pass:!!pass});const li=document.createElement('li');li.dataset.pass=String(!!pass);li.textContent=`${pass?'PASS':'FAIL'} — ${name}`;results.append(li);if(!pass)throw new Error(name);}
async function wait(predicate){const deadline=Date.now()+20000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Timed out waiting for the import UI.');}
async function fixture(){
 const deck=createDeck();deck.name='Synthetic import';const page=deck.slides[0];page.name='Independent objects';
 const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const context=canvas.getContext('2d');context.fillStyle='#ef65a8';context.fillRect(0,0,60,80);context.fillStyle='#583785';context.fillRect(60,0,60,80);
 deck.assets=[{id:'image',name:'panel.png',mime:'image/png',dataUrl:canvas.toDataURL('image/png'),width:120,height:80}];
 page.items=[{id:'text',name:'Editable label',type:'text',text:'Synthetic title',fontSize:24,fontFamily:'Arial',color:'#212121',x:40,y:30,width:400,height:60},
 {id:'picture',name:'Independent picture',type:'image',assetId:'image',x:80,y:150,width:240,height:160,crop:{x:.25,y:0,width:.5,height:1}},
 {id:'shape',name:'Editable rectangle',type:'rect',x:400,y:150,width:200,height:100,fill:'#aaddff',stroke:'#112233',strokeWidth:2}];
 const second=addSlide(deck);second.items=[{id:'second',type:'text',text:'Second page',x:50,y:50,width:350,height:50,fontSize:24}];
 return new File([await exportPPTX(deck)],'synthetic.pptx',{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
}

run.onclick=async()=>{
 run.disabled=true;results.replaceChildren();window.pptxImportChecks={finished:false,checks:[]};document.querySelector('iframe')?.remove();
 try{
  if(!['18766','18767','18768','18770'].includes(location.port)||!['127.0.0.1','localhost'].includes(location.hostname))throw new Error('Use a separate local test port.');
  const frame=document.createElement('iframe');frame.title='PPTX import test editor';frame.src='../index.html';document.body.append(frame);await new Promise(resolve=>frame.onload=resolve);
  const win=frame.contentWindow,doc=frame.contentDocument;await wait(()=>!doc.querySelector('#import-pptx').disabled);
  win.confirm=()=>true;doc.querySelector('#new-project').click();
  const input=doc.querySelector('input[accept=".pptx"]');
  const upload=file=>{const transfer=new win.DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new win.Event('change',{bubbles:true}));};
  upload(await fixture());await wait(()=>!doc.querySelector('#pptx-import-submit').disabled);
  check('Both slide choices appear before insertion',doc.querySelector('#pptx-import-page').options.length===2&&doc.querySelectorAll('.slide-card').length===1);
  check('Converted preview contains separate picture and text',doc.querySelector('#pptx-import-status').textContent.includes('1 image · 1 editable text'));
  const select=doc.querySelector('#pptx-import-page');select.value='2';select.dispatchEvent(new win.Event('change'));await wait(()=>!doc.querySelector('#pptx-import-submit').disabled);
  check('Choosing page 2 updates the preview',doc.querySelector('#pptx-import-status').textContent.startsWith('0 images'));
  select.value='1';select.dispatchEvent(new win.Event('change'));await wait(()=>!doc.querySelector('#pptx-import-submit').disabled);doc.querySelector('#pptx-import-submit').click();
  check('Selected page inserts after the current slide',doc.querySelectorAll('.slide-card').length===2&&doc.querySelector('#slide-position').textContent==='Slide 2 of 2');
  const label=[...doc.querySelectorAll('.layer-select')].find(el=>el.textContent.includes('Editable label'));label.click();
  const text=doc.querySelector('#text-content');check('Imported text opens in the text inspector',text?.value==='Synthetic title');text.value='Edited after importing';text.dispatchEvent(new win.Event('input',{bubbles:true}));text.dispatchEvent(new win.Event('blur'));
  let saved,savedFile=new Blob([]);win.showSaveFilePicker=async()=>({getFile:async()=>savedFile,name:'imported.figure.json',createWritable:async()=>{let pending;return {write:async blob=>{pending=blob;},close:async()=>{savedFile=pending;saved=JSON.parse(await pending.text());}};}});
  doc.querySelector('#save-project').click();await wait(()=>saved&&!doc.querySelector('#save-project').disabled);
  const inserted=saved.slides[1];check('Save preserves independently edited text',inserted.items.some(i=>i.type==='text'&&i.text==='Edited after importing'));
  check('Original image and restorable crop survive Save',inserted.items.some(i=>i.type==='image'&&i.crop?.x===.25&&i.crop?.width===.5)&&saved.assets[0].width===120);
  doc.querySelector('#undo').click();doc.querySelector('#undo').click();check('One Undo after text undo removes the whole imported slide',doc.querySelectorAll('.slide-card').length===1);
  doc.querySelector('#redo').click();check('Redo restores the page and separate objects',doc.querySelectorAll('.slide-card').length===2&&doc.querySelectorAll('.layer-select').length===inserted.items.length);
  win.showOpenFilePicker=async()=>[{name:'imported.figure.json',getFile:async()=>new File([JSON.stringify(saved)],'imported.figure.json',{type:'application/json'})}];
  doc.querySelector('#open-project').click();await wait(()=>!doc.querySelector('#open-project').disabled);
  check('Reopening keeps editable text and image objects',doc.querySelector('#stage').textContent.includes('Edited after importing')&&doc.querySelectorAll('.layer-select').length===inserted.items.length);
  upload(await fixture());await wait(()=>doc.querySelector('#pptx-import-dialog').open);doc.querySelector('#pptx-import-cancel').click();await new Promise(resolve=>setTimeout(resolve,300));
  check('Cancel adds no slide',!doc.querySelector('#pptx-import-dialog').open&&doc.querySelectorAll('.slide-card').length===2);
  upload(new File(['bad archive'],'bad.pptx'));await wait(()=>doc.querySelector('#pptx-import-status').textContent.includes('not a readable PPTX'));
  check('Invalid file leaves the project intact and cannot insert',doc.querySelector('#pptx-import-submit').disabled&&doc.querySelectorAll('.slide-card').length===2);doc.querySelector('#pptx-import-cancel').click();
 }catch(error){const li=document.createElement('li');li.dataset.pass='false';li.textContent=error.stack||error.message;results.append(li);window.pptxImportChecks.error=error.message;}
 finally{window.pptxImportChecks.finished=true;run.disabled=false;document.title=window.pptxImportChecks.error?'FAIL — PPTX import':'PASS — PPTX import';}
};
