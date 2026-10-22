/** Embedded Office clipboard packages and the opt-in local macOS clipboard bridge. */
import { localAPI, preparePPTXSlide } from './pptx-import.js';

export const POWERPOINT_MIME = 'ppt/slides';
const MAX_BASE64 = 4*Math.ceil(100*1024*1024/3);
export function decodePowerPointClipboard(text) {
  if (!text) return null;
  if (typeof text !== 'string' || text.length > MAX_BASE64+65536) throw new Error('The copied PowerPoint slide exceeds 100 MB.');
  let value;
  try { value=JSON.parse(text); } catch { throw new Error('The PowerPoint clipboard package is invalid. Copy the slide again.'); }
  if (!value || typeof value !== 'object' || value.isDataCompressed !== false) throw new Error('This PowerPoint clipboard format is unsupported. Use Import PPTX instead.');
  // packageSize is expressed in MiB by Office. Bound the actual encoded bytes.
  const data=value.data;
  if (typeof data !== 'string' || !data.length || data.length>MAX_BASE64 || data.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('The embedded PowerPoint slide data is invalid or exceeds 100 MB.');
  return {data};
}
export async function clipboardImageDigest(file) {
  if (!file || file.type !== 'image/png' || file.size > 40*1024*1024 || !globalThis.crypto?.subtle) return null;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export function initPowerPointPaste({captureTarget,targetIsCurrent,insert,status}) {
  const button=document.getElementById('paste-powerpoint');
  const notes=document.createElement('button');notes.id='pptx-paste-notes';notes.className='button quiet';notes.textContent='Paste notes';notes.hidden=true;button.after(notes);
  const dialog=document.createElement('dialog');dialog.id='pptx-paste-dialog';
  dialog.innerHTML='<div class="dialog-header"><h2>Paste PowerPoint slide</h2></div><div class="dialog-body"><p role="status" aria-live="polite">Preparing editable objects…</p><ul hidden></ul></div><div class="dialog-actions"><button class="button">Cancel</button></div>';
  document.body.append(dialog);
  const info=dialog.querySelector('p'),list=dialog.querySelector('ul'),cancel=dialog.querySelector('button');
  let sequence=0,controller,showingNotes=false;
  const close=()=>{sequence++;controller?.abort();dialog.close();};
  cancel.onclick=close;
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  dialog.addEventListener('keydown',e=>e.stopPropagation());
  for(const type of ['copy','cut','paste'])dialog.addEventListener(type,e=>e.stopPropagation());
  notes.onclick=()=>{showingNotes=true;info.textContent='PowerPoint conversion notes';list.hidden=false;cancel.textContent='Close';dialog.showModal();};
  function progress(){showingNotes=false;list.hidden=true;info.textContent='Preparing editable text, images and shapes…';cancel.textContent='Cancel';if(!dialog.open)dialog.showModal();}
  async function paste({officeText,previewFile}={}) {
    const optional=!!previewFile,payload=officeText ? decodePowerPointClipboard(officeText) : null;
    const target=captureTarget(),current=++sequence;controller?.abort();controller=new AbortController();
    const signal=controller.signal;
    const unavailable=()=>current===sequence&&targetIsCurrent(target)?false:true;
    if(!optional)progress();
    try {
      let local;
      try { local=await localAPI(); } catch(error) { if(optional)return unavailable();throw error; }
      if(current!==sequence)return true;
      if(local.pptxPaste!==true) { if(optional)return unavailable();throw new Error('Restart the local Figure Editor to enable PowerPoint paste.'); }
      if(!payload&&local.pptxClipboard!==true) { if(optional)return unavailable();throw new Error('Direct clipboard reading needs the macOS local server and Apple command line tools. Use Import PPTX instead.'); }
      if(optional&&local.pptxClipboardReady!==true)return unavailable();
      const digest=optional ? await clipboardImageDigest(previewFile) : null;
      if(optional&&!digest)return unavailable();
      if(current!==sequence)return true;
      let response;
      try { response=await fetch(payload ? '/api/pptx-paste' : '/api/pptx-clipboard',{
        method:'POST',mode:'same-origin',redirect:'error',cache:'no-store',signal,
        headers:{'Content-Type':'application/json','X-Figure-Token':local.token},
        body:JSON.stringify(payload || (optional ? {previewSha256:digest} : {})),
      }); } catch(error) { if(optional&&error.name!=='AbortError')return unavailable();throw error; }
      const converted=await response.json();
      if(current!==sequence)return true;
      if(!response.ok) {
        if(optional&&converted.nativeUnavailable===true)return unavailable();
        throw new Error(converted.error||'Could not convert this PowerPoint slide.');
      }
      if(converted.available===false) {
        if(optional)return unavailable();
        throw new Error('Copy one slide thumbnail in PowerPoint, then click Paste PowerPoint again.');
      }
      if(!targetIsCurrent(target))throw new Error('Paste cancelled because the destination changed. Copy or paste the slide again.');
      progress();
      const result=await preparePPTXSlide(converted,signal);
      if(current!==sequence)return true;
      if(!targetIsCurrent(target))throw new Error('Paste cancelled because the destination changed. Paste again.');
      insert(result.deck,result.warnings);
      list.replaceChildren(...result.warnings.map(message=>{const li=document.createElement('li');li.textContent=message;return li;}));
      notes.hidden=!result.warnings.length;
      const items=result.deck.slides[0].items;
      const images=items.filter(i=>i.type==='image').length,texts=items.filter(i=>i.type==='text').length,shapes=items.length-images-texts;
      status(`Pasted a new slide: ${texts} text objects, ${images} images, ${shapes} shapes. Use Undo to remove the slide.${result.warnings.length?' See Paste notes for conversion details.':''}`);
      return true;
    } catch(error) {
      if(current!==sequence||error.name==='AbortError')return true;
      throw error;
    } finally {
      if(current===sequence&&!showingNotes)dialog.close();
    }
  }
  button.onclick=()=>paste().catch(error=>status(error.message,true));
  return {paste,cancel:close};
}
