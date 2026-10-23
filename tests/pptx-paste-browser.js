import { createDeck } from '../deck.js';
import { exportPPTX } from '../pptx.js';
import { createSlidesClipboard,encodeSlides,SLIDES_CLIPBOARD_MIME } from '../clipboard.js';
const results=document.querySelector('#results');
function check(name,pass){const li=document.createElement('li');li.textContent=`${pass?'PASS':'FAIL'} — ${name}`;li.dataset.pass=String(!!pass);results.append(li);if(!pass)throw new Error(name);}
async function wait(fn){const end=Date.now()+25000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timed out');}
const delay=()=>new Promise(r=>setTimeout(r,120));
document.querySelector('#run').onclick=async()=>{
 results.replaceChildren();document.querySelector('iframe')?.remove();window.pptxPasteChecks={finished:false};
 try{
  if(!['18767','18768','18769'].includes(location.port))throw new Error('Use an isolated test port.');
  const deck=createDeck(),page=deck.slides[0];page.name='Paste fixture';
  const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;const ctx=canvas.getContext('2d');ctx.fillStyle='#ed7335';ctx.fillRect(0,0,40,20);
  deck.assets=[{id:'picture',name:'panel.png',mime:'image/png',dataUrl:canvas.toDataURL(),width:40,height:20}];
  page.items=[
   {id:'txt',name:'Editable title',type:'text',text:'PowerPoint title',x:40,y:30,width:350,height:50,fontSize:24},
   {id:'pic',name:'Editable picture',type:'image',assetId:'picture',x:50,y:130,width:200,height:100},
   {id:'vector',name:'Gradient arrow',type:'shape',x:350,y:130,width:200,height:150,rotation:20,fill:'#4472c4',stroke:'#113366',strokeWidth:2,
    paths:[{commands:[['M',.25,0],['L',.75,0],['L',.75,.5],['L',1,.5],['L',.5,1],['L',0,.5],['L',.25,.5],['Z']],fillMode:'norm',stroke:true}],
    fillGradient:{angle:90,stops:[{offset:0,color:'#4472c480'},{offset:.5,color:'#2233cc'},{offset:1,color:'#aabbff'}]}},
  ];
  const pptx=await exportPPTX(deck),base64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(pptx);});
  const office=JSON.stringify({isDataCompressed:false,data:base64});
  const frame=document.createElement('iframe');frame.src='../index.html';frame.title='Paste test editor';document.body.append(frame);await new Promise(r=>frame.onload=r);
  const win=frame.contentWindow,doc=frame.contentDocument;await wait(()=>!doc.querySelector('#paste-powerpoint').disabled);win.confirm=()=>true;doc.querySelector('#new-project').click();
  const send=(values,files=[])=>{doc.querySelector('#workspace').focus();const data=new win.DataTransfer();for(const [key,value]of Object.entries(values))data.setData(key,value);for(const file of files)data.items.add(file);doc.querySelector('#workspace').dispatchEvent(new win.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));};
  send({'ppt/slides':office});await wait(()=>doc.querySelectorAll('.slide-card').length===2);
  check('Office package inserts a new slide with separate text, picture and shape',doc.querySelectorAll('.layer-select').length===4&&doc.querySelector('#status').textContent.includes('2 shapes'));
  const layer=name=>[...doc.querySelectorAll('.layer-select')].find(el=>el.textContent.includes(name));
  layer('Gradient arrow').click();
  const gradientEditor='[data-gradient-editor="fillGradient"]';
  check('Imported arrow is vector with editable gradient stops',doc.querySelectorAll(`${gradientEditor} [data-gradient-stop]`).length===3&&doc.querySelectorAll(`${gradientEditor} [data-gradient-field="color"]`).length===1&&doc.querySelector('#stage path[fill^="url"]').getAttribute('d').includes('L'));
  doc.querySelector(`${gradientEditor} [data-gradient-stop="0"]`).click();
  const color=doc.querySelector(`${gradientEditor} [data-gradient-field="color"]`);color.value='#ff0000';color.dispatchEvent(new win.Event('change'));
  layer('Editable title').click();const text=doc.querySelector('#text-content');text.value='Edited paste title';text.dispatchEvent(new win.Event('input'));text.dispatchEvent(new win.Event('blur'));
  layer('Editable picture').click();const width=doc.querySelector('[data-property="width"]');width.value='250';width.dispatchEvent(new win.Event('change'));
  let saved,savedFile=new Blob([]);
  win.showSaveFilePicker=async()=>({getFile:async()=>savedFile,name:'pasted.figure.json',createWritable:async()=>{let pending;return {write:async blob=>{pending=blob;},close:async()=>{savedFile=pending;saved=JSON.parse(await pending.text());}};}});
  doc.querySelector('#save-project').click();await wait(()=>saved&&!doc.querySelector('#save-project').disabled);
  const inserted=saved.slides[1];
  check('Save keeps edited text, image dimensions and gradient alpha independently',inserted.items.some(i=>i.type==='text'&&i.text==='Edited paste title')&&inserted.items.some(i=>i.type==='image'&&i.width===250)&&inserted.items.some(i=>i.type==='shape'&&i.fillGradient.stops[0].color==='#ff000080'));
  for(let i=0;i<4;i++)doc.querySelector('#undo').click();
  check('Undo edits then removes the complete pasted slide',doc.querySelectorAll('.slide-card').length===1);
  doc.querySelector('#redo').click();check('Redo restores all object types',doc.querySelectorAll('.layer-select').length===4);
  win.showOpenFilePicker=async()=>[{getFile:async()=>new File([JSON.stringify(saved)],'pasted.figure.json')}];doc.querySelector('#open-project').click();await wait(()=>!doc.querySelector('#open-project').disabled);
  layer('Gradient arrow').click();doc.querySelector(`${gradientEditor} [data-gradient-stop="0"]`).click();check('Reopening retains editable gradient geometry',doc.querySelector(`${gradientEditor} [data-gradient-field="color"]`).value==='#ff0000');
  const before=doc.querySelectorAll('.slide-card').length;
  send({[SLIDES_CLIPBOARD_MIME]:encodeSlides(createSlidesClipboard(deck,[page.id])),'ppt/slides':'bad'});
  check('Figure Editor slide clipboard takes precedence over Office data',doc.querySelectorAll('.slide-card').length===before+1);
  send({'ppt/slides':'bad'});await wait(()=>doc.querySelector('#status').textContent.includes('invalid'));
  check('Malformed Office data adds nothing',doc.querySelectorAll('.slide-card').length===before+1);
  const fetch=win.fetch.bind(win);let release;
  win.fetch=async(url,options)=>{if(url==='/api/pptx-paste')await new Promise(r=>release=r);return fetch(url,options);};
  send({'ppt/slides':office});await wait(()=>release);doc.querySelector('#pptx-paste-dialog button').click();release();await delay();
  check('Cancel prevents a late slide insertion',doc.querySelectorAll('.slide-card').length===before+1&&!doc.querySelector('#pptx-paste-dialog').open);
  win.fetch=async(url,options)=>{
   if(url==='/api/local'){const response=await fetch(url,options),value=await response.json();return new Response(JSON.stringify({...value,pptxClipboard:true,pptxClipboardReady:true}));}
   if(url==='/api/pptx-clipboard')return new Response(JSON.stringify({error:'Helper unavailable',nativeUnavailable:true}),{status:422});
   return fetch(url,options);
  };
  const image=await new Promise(r=>canvas.toBlob(blob=>r(new File([blob],'ordinary.png',{type:'image/png'}))));
  send({},[image]);await wait(()=>doc.querySelectorAll('.layer-select').length===4);
  check('Ordinary PNG still pastes when native helper fails',doc.querySelectorAll('.slide-card').length===before+1);
  win.fetch=fetch;
  check('Conversion notes are available after insertion',!doc.querySelector('#pptx-paste-notes').hidden);
 }catch(error){checkError(error);}
 finally{window.pptxPasteChecks.finished=true;document.title=window.pptxPasteChecks.error?'FAIL — PowerPoint paste':'PASS — PowerPoint paste';}
};
function checkError(error){window.pptxPasteChecks.error=error.message;const li=document.createElement('li');li.dataset.pass='false';li.textContent=error.stack;results.append(li);}
