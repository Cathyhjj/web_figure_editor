import { uid, projectToSVG, exportPNG, downloadBlob } from './core.js';
import { createDeck, validateDeck, cloneDeck, currentSlide, slideProject, serializeDeck, deckSourceManifest, addSlide, duplicateSlide, deleteSlide } from './deck.js';
import { importFiles, pickImages, importFolderFiles, pickFolder, importDroppedFiles, linkAsset, refreshAsset, replaceAsset } from './assets.js';
import { buildAssetTree } from './asset-tree.js';
import { generateHTMLReport } from './report.js';
import { exportPPTX, pptxLayout } from './pptx.js';
import { initWindows } from './windows.js';

const $ = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
let project = createDeck(), selected = new Set(), zoom = .75, undoStack = [], redoStack = [];
let gesture = null, dirty = false, relinkId = null, draftTimer, draftDb, pendingText = null, lastPointerItem = null, lastTap = null;
const collapsedAssetFolders = new Set();
let libraryImports = 0;
let libraryImportNotice = { hidden: true, text: '', error: false };
const clone = cloneDeck;
const slide = () => currentSlide(project);
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chosen = () => slide().items.filter(i=>selected.has(i.id));
const byId = id => slide().items.find(i=>i.id===id);
const assetById = id => project.assets.find(a=>a.id===id);
function status(message, error=false) { $('status').textContent=message; $('status').classList.toggle('error',error); }
function snapshot(){return clone(project);}
function record(before){undoStack.push(before); if(undoStack.length>50)undoStack.shift();redoStack=[];changed();}
function change(action){flushText();const before=snapshot();try{action();validateDeck(project);record(before);render();return true;}catch(error){project=before;render();status(error.message,true);return false;}}
function changed(){dirty=true;clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,650);}
function base(type, x=80,y=80,width=160,height=80){return {id:uid(),type,name:type==='text'?'Text':type==='rect'?'Rectangle':type==='line'?'Line':'Image',x,y,width,height,rotation:0,opacity:1,locked:false,hidden:false};}
function svg(tag, attrs={}, text){const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
function appendItemContent(g,item){
  if(item.type==='image'){const a=assetById(item.assetId);if(a)g.append(svg('image',{href:a.dataUrl,width:item.width,height:item.height,preserveAspectRatio:'none'}));}
  else if(item.type==='text'){
   const text=svg('text',{x:item.align==='center'?item.width/2:item.align==='right'?item.width:0,y:item.fontSize,fill:item.color,'font-family':item.fontFamily+', Arial, sans-serif','font-size':item.fontSize,'font-weight':item.fontWeight,'font-style':item.fontStyle,'text-anchor':item.align==='center'?'middle':item.align==='right'?'end':'start','xml:space':'preserve'});
   String(item.text).split('\n').forEach((line,j)=>text.append(svg('tspan',{x:item.align==='center'?item.width/2:item.align==='right'?item.width:0,dy:j?item.fontSize*1.2:0},line||' ')));g.append(text);
  }else if(item.type==='rect')g.append(svg('rect',{width:item.width,height:item.height,fill:item.fill,stroke:item.stroke,'stroke-width':item.strokeWidth}));
  else if(item.type==='line')g.append(svg('line',{x1:0,y1:0,x2:item.width,y2:item.height,stroke:item.stroke,'stroke-width':item.strokeWidth}));
}
function renderSlides(){
 const list=$('slide-list'),existing=new Map([...list.children].map(card=>[card.dataset.slide,card]));
 project.slides.forEach((page,index)=>{
  const card=existing.get(page.id)||document.createElement('button');existing.delete(page.id);card.type='button';card.className='slide-card';card.dataset.slide=page.id;
  card.setAttribute('aria-current',String(page.id===project.activeSlideId));
  card.setAttribute('aria-label',`Slide ${index+1}: ${page.name}`);card.title=page.name;
  const preview=svg('svg',{class:'slide-preview',viewBox:`0 0 ${page.canvas.width} ${page.canvas.height}`,'aria-hidden':'true'});
  preview.append(svg('rect',{width:page.canvas.width,height:page.canvas.height,fill:page.canvas.background}));
  for(const item of page.items){
   if(item.hidden)continue;
   const g=svg('g',{transform:`translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width/2} ${item.height/2})`,opacity:item.opacity});
   appendItemContent(g,item);preview.append(g);
  }
  const caption=document.createElement('span');caption.className='slide-caption';
  caption.innerHTML=`<span>${index+1}</span><span>${escapeHTML(page.name)}</span>`;card.replaceChildren(preview,caption);
  card.onclick=()=>selectSlide(page.id);if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);
 });
 for(const card of existing.values())card.remove();
 $('slide-name').value=slide().name;
 $('slide-position').textContent=`Slide ${project.slides.indexOf(slide())+1} of ${project.slides.length}`;
 $('delete-slide').disabled=project.slides.length===1;
 $('new-slide').disabled=$('duplicate-slide').disabled=project.slides.length>=100;
}
function selectSlide(id){
 if(id===project.activeSlideId)return;
 flushText();project.activeSlideId=id;selected.clear();lastTap=null;lastPointerItem=null;
 render();fit();saveDraft();status(`Editing ${slide().name}. Assets are shared across slides.`);
}
function editSlides(action,message){
 const applied=change(()=>{action(project);selected.clear();lastTap=null;lastPointerItem=null;});
 if(applied){fit();$('slide-list').querySelector('[aria-current="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});status(message);}
}
$('new-slide').onclick=()=>editSlides(addSlide,'New blank slide added. Place an asset or add text to begin.');
$('duplicate-slide').onclick=()=>editSlides(duplicateSlide,'Slide duplicated. Objects can be edited independently.');
$('delete-slide').onclick=()=>editSlides(deleteSlide,'Slide deleted. Use Undo to restore it.');
$('slide-name').oninput=e=>{if(!pendingText)pendingText=snapshot();slide().name=e.target.value.trim().slice(0,120)||'Untitled slide';changed();};
$('slide-name').onblur=()=>{flushText();renderToolbar();};
function renderStage(){
 const stage=$('stage');stage.replaceChildren();stage.setAttribute('viewBox',`0 0 ${slide().canvas.width} ${slide().canvas.height}`);
 stage.style.width=`${slide().canvas.width*zoom}px`;stage.style.height=`${slide().canvas.height*zoom}px`;
 $('stage-wrap').style.width=`${slide().canvas.width*zoom}px`;$('stage-wrap').style.height=`${slide().canvas.height*zoom}px`;
 stage.style.background=slide().canvas.background;
 for(const item of slide().items){
  if(item.hidden)continue;
  const g=svg('g',{'data-item':item.id,transform:`translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width/2} ${item.height/2})`,opacity:item.opacity, class:`figure-item ${selected.has(item.id)?'selected':''}`});
  appendItemContent(g,item);
  // Transparent geometry makes whitespace in a text box and thin lines selectable.
  g.append(svg('rect',{width:item.width,height:item.height,fill:'transparent','pointer-events':'all',class:'item-hit'}));
  if(selected.has(item.id)){
   g.append(svg('rect',{width:item.width,height:item.height,fill:'none',stroke:item.locked?'#777':'#9c357c','stroke-width':1.4/zoom,'stroke-dasharray':item.locked?`${4/zoom} ${3/zoom}`:'none','pointer-events':'none'}));
   if(selected.size===1&&!item.locked)g.append(svg('rect',{x:item.width-5/zoom,y:item.height-5/zoom,width:10/zoom,height:10/zoom,fill:'#fff',stroke:'#9c357c','stroke-width':1.5/zoom,'data-resize':item.id,class:'resize-handle'}));
  }
  stage.append(g);
 }
 $('empty-state').hidden=slide().items.length>0;
 $('zoom-value').textContent=`${Math.round(zoom*100)}%`;
 $('selection-count').textContent=selected.size?`${selected.size} selected`:`${slide().items.length} object${slide().items.length === 1 ? "" : "s"}`;
}
function renderAssets(){
 const list=$('asset-list'),scrollTop=$('assets-panel').scrollTop;
 // Read the current state directly so even an immediate rerender preserves a toggle.
 for(const folder of list.querySelectorAll('.asset-folder')){
  if(folder.open)collapsedAssetFolders.delete(folder.dataset.path);else collapsedAssetFolders.add(folder.dataset.path);
 }
 list.replaceChildren();
 if(!project.assets.length){const p=document.createElement('p');p.className='hint';p.textContent='Drop images or folders here to preview them. Folder structure is kept. Files are processed locally.';list.append(p);}
 function assetCard(a){
  const card=document.createElement('div');card.className='asset-card';card.dataset.asset=a.id;card.draggable=false;
  card.innerHTML=`<button class="asset-preview" data-action="place" title="Add to canvas" aria-label="Place ${escapeHTML(a.name)} on canvas"><img draggable="false" loading="lazy" decoding="async" class="asset-thumb" alt="${escapeHTML(a.name)}" src="${a.dataUrl}"></button><div class="asset-name" title="${escapeHTML(a.relativePath||a.name)}">${escapeHTML(a.name)}</div><div class="asset-meta">${a.width} × ${a.height} · ${a.sourceKind==='linked'?(a.linkPersistence==='session'?'Session link + copy':'Local link + copy'):'Portable copy'}${a.originalMime==='image/svg+xml'?' · Rasterized SVG':''}</div><div class="asset-actions"><button data-action="place">Place</button><button data-action="relink">Link</button>${a.sourceKind==='linked'?'<button data-action="refresh">Refresh</button>':''}</div>`;
  let suppressClick=false;
  card.onpointerdown=e=>{
   if(e.button!==0||e.target.closest('.asset-actions'))return;
   const start={x:e.clientX,y:e.clientY};let moved=false;
   const move=ev=>{if(Math.hypot(ev.clientX-start.x,ev.clientY-start.y)>5){moved=true;document.body.style.cursor='copy';}};
   const end=ev=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.body.style.cursor='';if(!moved)return;suppressClick=true;const r=$('workspace').getBoundingClientRect();if(ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom){const p=point(ev);placeAsset(a,{x:Math.max(0,p.x),y:Math.max(0,p.y)});}setTimeout(()=>suppressClick=false,0);};
   document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});
  };
  card.onclick=async e=>{if(suppressClick)return;const action=e.target.closest('[data-action]')?.dataset.action;if(action==='place')placeAsset(a);if(action==='relink')await relink(a);if(action==='refresh')await refresh(a);};return card;
 }
 function appendFolderContents(node,container){
  for(const folder of node.folders){
   const details=document.createElement('details');details.className='asset-folder';details.dataset.path=folder.path;details.open=!collapsedAssetFolders.has(folder.path);
   const summary=document.createElement('summary');summary.title=folder.path;
   summary.innerHTML=`<span class="folder-chevron" aria-hidden="true">›</span><svg aria-hidden="true"><use href="#i-folder"/></svg><span class="folder-name">${escapeHTML(folder.name)}</span><span class="folder-count" aria-label="${folder.count} images">${folder.count}</span>`;
   const contents=document.createElement('div');contents.className='asset-folder-content';appendFolderContents(folder,contents);
   details.append(summary,contents);container.append(details);
  }
  for(const asset of node.assets)container.append(assetCard(asset));
 }
 appendFolderContents(buildAssetTree(project.assets),list);
 $('assets-panel').scrollTop=scrollTop;
}
function renderLayers(){
 const list=$('layer-list');list.replaceChildren();
 if(!slide().items.length){const p=document.createElement('p');p.className='hint';p.textContent='No objects on this slide yet.';list.append(p);}
 for(const i of [...slide().items].reverse()){
  const row=document.createElement('div');row.className=`layer-row ${selected.has(i.id)?'selected':''}`;row.dataset.layer=i.id;
  row.innerHTML=`<button class="layer-select" title="Select object">${i.type==='image'?'▧':i.type==='text'?'T':i.type==='rect'?'□':'╱'} <span>${escapeHTML(i.name)}</span></button><button data-action="hide" title="${i.hidden?'Show':'Hide'}">${i.hidden?'○':'●'}</button><button data-action="lock" title="${i.locked?'Unlock':'Lock'}">${i.locked?'▣':'◇'}</button>`;
  row.onclick=e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(action)change(()=>{if(action==='hide')i.hidden=!i.hidden;else i.locked=!i.locked;});else{flushText();if(e.shiftKey){selected.has(i.id)?selected.delete(i.id):selected.add(i.id);}else selected=new Set([i.id]);render();}};list.append(row);
 }
}
function field(label,key,value,type='number',extra=''){return `<label class="field"><span>${label}</span><input data-property="${key}" type="${type}" value="${escapeHTML(value)}" ${extra}></label>`;}
function renderInspector(){
 const items=chosen(), box=$('inspector');
 if(items.length!==1){box.innerHTML=`<div class="section-heading">${items.length?'Multiple objects':'Object properties'}</div><p class="hint">${items.length?'Use the alignment tools to arrange selected objects. Shift + click to add or remove objects.':'Select an image, text, or shape to edit. Double-click text to edit its content.'}</p>`;return;}
 const i=items[0];
 box.innerHTML=`<div class="section-heading">${i.type==='image'?'Image':i.type==='text'?'Text':'Shape'} properties${i.locked?' · Locked':''}</div>${field('Name','name',i.name,'text')}<div class="field-row">${field('X / px','x',round(i.x),'number','step="1"')}${field('Y / px','y',round(i.y),'number','step="1"')}</div><div class="field-row">${field('Width / px','width',round(i.width),'number','min="1" step="1"')}${field('Height / px','height',round(i.height),'number','min="1" step="1"')}</div><div class="field-row">${field('Rotation / °','rotation',round(i.rotation))}${field('Opacity','opacity',i.opacity,'number','min="0" max="1" step="0.1"')}</div>`;
 if(i.type==='text')box.innerHTML+=`<label class="field"><span>Text content</span><textarea id="text-content" rows="4">${escapeHTML(i.text)}</textarea></label><label class="field"><span>Font</span><select data-property="fontFamily">${[...new Set([i.fontFamily,'Arial','Helvetica','Avenir','Times New Roman','Georgia','Courier New','sans-serif','serif'])].map(f=>`<option ${i.fontFamily===f?'selected':''}>${escapeHTML(f)}</option>`).join('')}</select></label><div class="field-row">${field('Size / px','fontSize',i.fontSize,'number','min="1" max="500"')}${field('Color','color',i.color,'color')}</div><div class="field-row"><label class="field"><span>Weight</span><select data-property="fontWeight"><option value="400" ${String(i.fontWeight)==='400'?'selected':''}>Regular</option><option value="700" ${String(i.fontWeight)==='700'?'selected':''}>Bold</option></select></label><label class="field"><span>Style</span><select data-property="fontStyle"><option value="normal" ${i.fontStyle==='normal'?'selected':''}>Normal</option><option value="italic" ${i.fontStyle==='italic'?'selected':''}>Italic</option></select></label></div><label class="field"><span>Text alignment</span><select data-property="align">${[['left','Left'],['center','Center'],['right','Right']].map(([v,t])=>`<option value="${v}" ${i.align===v?'selected':''}>${t}</option>`).join('')}</select></label><p class="hint">Uses fonts installed on this computer. SVG does not embed fonts. Press Enter for a new line.</p>`;
 if(i.type==='image'){const a=assetById(i.assetId);const effectiveDPI=a?Math.round(Math.min(a.width/i.width,a.height/i.height)*96):0;box.innerHTML+=`<p class="hint">Source: ${escapeHTML(a?.name)}<br>Original size: ${a?.width} × ${a?.height} px<br>Effective resolution: ${effectiveDPI} DPI<br>Drag a corner to keep proportions. Hold Shift to resize freely. Changing width also updates height.</p>`;}
 if(i.type==='rect'||i.type==='line')box.innerHTML+=`<div class="field-row">${i.type==='rect'?field('Fill','fill',i.fill,'color'):''}${field('Stroke','stroke',i.stroke,'color')}</div>${field('Stroke width / px','strokeWidth',i.strokeWidth,'number','min="0" max="100" step="0.5"')}`;
 box.innerHTML+=`<label class="field inline"><input id="object-locked" type="checkbox" ${i.locked?'checked':''}> Lock object</label>`;
 box.querySelectorAll('[data-property]').forEach(input=>{
  input.disabled=i.locked;
  const apply=()=>{
   const key=input.dataset.property;
   if(input.type==='number'&&input.value==='')return;
   let val=input.type==='number'?Number(input.value):input.value;
   if(typeof val==='number'&&!Number.isFinite(val))return;
   if(['width','height'].includes(key))val=Math.max(1,Math.min(20000,val));
   if(['x','y'].includes(key))val=Math.max(-100000,Math.min(100000,val));
   if(key==='rotation')val=Math.max(-36000,Math.min(36000,val));
   if(key==='fontSize')val=Math.max(1,Math.min(500,val));if(key==='opacity')val=Math.max(0,Math.min(1,val));if(key==='strokeWidth')val=Math.max(0,Math.min(100,val));
   if(key==='name')val=val.slice(0,1000);
   if(i[key]===val)return;
   if(!pendingText)pendingText=snapshot();
   if(i.type==='image'&&(key==='width'||key==='height')){const ratio=i.width/i.height;if(key==='width')i.height=val/ratio;else i.width=val*ratio;const other=box.querySelector(`[data-property="${key==='width'?'height':'width'}"]`);if(other)other.value=round(key==='width'?i.height:i.width);}
   i[key]=val;changed();renderStage();
  };
  input.oninput=apply;
  input.onchange=()=>{apply();flushText();renderLayers();renderToolbar();};
  input.onblur=()=>{flushText();renderLayers();renderToolbar();};
 });
 $('object-locked').onchange=e=>change(()=>i.locked=e.target.checked);
 const text=$('text-content');if(text){text.disabled=i.locked;text.oninput=()=>{if(!pendingText)pendingText=snapshot();i.text=text.value.slice(0,20000);i.height=Math.max(i.fontSize*1.2*i.text.split('\n').length,i.height);changed();renderStage();};text.onblur=()=>{flushText();renderLayers();renderToolbar();};}
}
function flushText(){if(pendingText){const before=pendingText;pendingText=null;record(before);renderSlides();}}
const round=n=>Math.round(n*10)/10;
function renderToolbar(){
 $('undo').disabled=!undoStack.length;$('redo').disabled=!redoStack.length;
 for(const id of ['duplicate','delete-item','bring-forward','send-backward'])$(id).disabled=!selected.size;
 for(const id of ['align-left','align-center','align-top','align-middle'])$(id).disabled=!chosen().some(i=>!i.locked);
 $('distribute-x').disabled=chosen().filter(i=>!i.locked).length<3;
}
function render(){
 selected=new Set([...selected].filter(id=>byId(id)));renderStage();renderSlides();renderAssets();renderLayers();renderInspector();renderToolbar();
 $('project-name').value=project.name;$('canvas-width').value=slide().canvas.width;$('canvas-height').value=slide().canvas.height;$('canvas-background').value=slide().canvas.background;
}
function point(event){const r=$('stage').getBoundingClientRect();return{x:(event.clientX-r.left)/zoom,y:(event.clientY-r.top)/zoom};}
function placeAsset(a,position){change(()=>{const maxW=slide().canvas.width*.43,maxH=slide().canvas.height*.65,scale=Math.min(1,maxW/a.width,maxH/a.height);const offset=slide().items.length%6*18;const i={...base('image',position?.x??60+offset,position?.y??60+offset,a.width*scale,a.height*scale),assetId:a.id,name:a.name};slide().items.push(i);selected=new Set([i.id]);});status(`Added ${a.name} to the canvas.`);}
const importTarget=()=>({project,slideId:project.activeSlideId});
async function importResult(result,position,target,{libraryOnly=false}={}){
 if(!result)return;
 const page=target?.project===project?project.slides.find(s=>s.id===target.slideId):null;
 if(target?.project!==project||(!libraryOnly&&!page)){status('Import cancelled because the target project or slide changed. Please import again.',true);return;}
 const errors=result.errors.map(e=>`${e.name}: ${e.message}`).join('; ');
 const skipped=result.skipped?` Skipped ${result.skipped} unsupported file${result.skipped===1?'':'s'}.`:'';
 if(result.assets.length){
  const applied=change(()=>{for(const [j,a] of result.assets.entries()){
   project.assets.push(a);if(libraryOnly)continue;
   const scale=Math.min(1,page.canvas.width*.43/a.width,page.canvas.height*.65/a.height);
   const i={...base('image',(position?.x??60)+j*22,(position?.y??60)+j*22,a.width*scale,a.height*scale),assetId:a.id,name:a.name};
   page.items.push(i);if(page.id===project.activeSlideId)selected=new Set([i.id]);
  }});
  if(!applied)return;
  status(`Imported ${result.assets.length} asset${result.assets.length===1?'':'s'} into ${libraryOnly?'Assets':page.name}.${libraryOnly?' Choose a preview or Place to add it to the canvas.':' Portable copies are included.'}${skipped}${errors?' '+errors:''}`,!!errors);
 }else if(errors)status(errors+skipped,true);
 else if('skipped' in result)status('No supported images found. Choose a folder containing PNG, JPG, WebP, or SVG images.'+skipped);
}
async function importToLibrary(pending,target){
 libraryImports++;renderLibraryImportNotice();
 try{
  const result=await pending;
  if(result===null||(!result.assets.length&&!result.errors.length&&!('skipped' in result))){
   if(result===null)$('folder-input').click();
   return;
  }
  await importResult(result,undefined,target,{libraryOnly:true});
  libraryImportNotice={hidden:false,text:$('status').textContent,error:$('status').classList.contains('error')};
 }
 catch(error){status(error.message,true);libraryImportNotice={hidden:false,text:error.message,error:true};}
 finally{libraryImports--;renderLibraryImportNotice();}
}
function renderLibraryImportNotice(){
 const notice=$('asset-import-status'),busy=libraryImports>0;
 $('assets-panel').setAttribute('aria-busy',String(busy));
 notice.hidden=!busy&&libraryImportNotice.hidden;
 notice.textContent=busy?'Reading images and subfolders…':libraryImportNotice.text;
 notice.classList.toggle('error',!busy&&libraryImportNotice.error);
}
async function relink(a){try{const updated=await linkAsset(a);if(updated)change(()=>{project.assets=project.assets.map(x=>x.id===a.id?updated:x);});else{relinkId=a.id;$('relink-input').click();}status(updated?'Local file linked and embedded copy updated.':'Select the local file to link.');}catch(e){if(e.name!=='AbortError')status(e.message,true);}}
async function refresh(a){try{const updated=await refreshAsset(a);change(()=>{project.assets=project.assets.map(x=>x.id===a.id?updated:x);});status('Embedded copy updated from the authorized local file.');}catch(e){status(e.message,true);}}
$('add-images').onclick=async()=>{const target=importTarget();try{const result=await pickImages();if(result===null)$('file-input').click();else await importResult(result,undefined,target);}catch(e){status(e.message,true);}};
$('file-input').onchange=async e=>{const target=importTarget();await importResult(await importFiles([...e.target.files]),undefined,target);e.target.value='';};
$('add-folders').onclick=async()=>{
 const target=importTarget();
 await importToLibrary(pickFolder(),target);
};
$('folder-input').onchange=async e=>{const files=[...e.target.files];e.target.value='';if(files.length)await importToLibrary(importFolderFiles(files),importTarget());};
$('relink-input').onchange=async e=>{try{const a=assetById(relinkId);if(a&&e.target.files[0]){const updated=await replaceAsset(a,e.target.files[0]);change(()=>{project.assets=project.assets.map(x=>x.id===a.id?updated:x);});status('Asset copy updated. This browser does not retain a local file link.');}}catch(err){status(err.message,true);}e.target.value='';};
$('workspace').ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';$('workspace').classList.add('drag-over');};
$('workspace').ondragleave=e=>{if(!$('workspace').contains(e.relatedTarget))$('workspace').classList.remove('drag-over');};
$('workspace').ondrop=async e=>{
 e.preventDefault();$('workspace').classList.remove('drag-over');const target=importTarget(),p=point(e);p.x=Math.max(0,p.x);p.y=Math.max(0,p.y);
 const assetId=e.dataTransfer.getData('application/x-figure-asset');if(assetId){const a=assetById(assetId);if(a)placeAsset(a,p);return;}
 try{await importResult(await importDroppedFiles(e.dataTransfer),p,target);}catch(error){status(error.message,true);}
};
const libraryDropZone=document.querySelector('.library-panel');
libraryDropZone.ondragover=e=>{if(![...e.dataTransfer.types].includes('Files'))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='copy';libraryDropZone.classList.add('drag-over');};
libraryDropZone.ondragleave=e=>{if(!libraryDropZone.contains(e.relatedTarget))libraryDropZone.classList.remove('drag-over');};
libraryDropZone.ondrop=async e=>{e.preventDefault();e.stopPropagation();libraryDropZone.classList.remove('drag-over');await importToLibrary(importDroppedFiles(e.dataTransfer),importTarget());};
$('stage').onpointerdown=e=>{
 if(e.button!==0)return;flushText();const id=e.target.closest('[data-item]')?.dataset.item;lastPointerItem=id;
 if(!id){selected.clear();render();return;}
 const i=byId(id);if(e.shiftKey&&!e.target.dataset.resize){selected.has(id)?selected.delete(id):selected.add(id);render();return;}
 if(!selected.has(id))selected=new Set([id]);renderInspector();renderLayers();renderToolbar();renderStage();
 if(i.locked)return;
 const start=point(e),items=chosen().filter(i=>!i.locked),before=snapshot();const edit=i.type==='text'&&lastTap?.id===id&&e.timeStamp-lastTap.time<500&&Math.abs(start.x-lastTap.x)+Math.abs(start.y-lastTap.y)<5;lastTap={id,time:e.timeStamp,...start};gesture={mode:e.target.dataset.resize?'resize':'move',id,start,items:items.map(i=>({...i})),before,moved:false,edit};
 $('stage').setPointerCapture(e.pointerId);e.preventDefault();
};
$('stage').onpointermove=e=>{
 if(!gesture)return;const p=point(e),dx=p.x-gesture.start.x,dy=p.y-gesture.start.y;if(Math.abs(dx)+Math.abs(dy)<.2)return;gesture.moved=true;
 if(gesture.mode==='move'){for(const orig of gesture.items){const i=byId(orig.id);i.x=orig.x+dx;i.y=orig.y+dy;}}
 else{const orig=gesture.items.find(i=>i.id===gesture.id),i=byId(orig.id),angle=orig.rotation*Math.PI/180;let w=Math.max(4,orig.width+dx*Math.cos(angle)+dy*Math.sin(angle)),h=Math.max(4,orig.height-dx*Math.sin(angle)+dy*Math.cos(angle));if(orig.type==='image'&&!e.shiftKey)h=w*orig.height/orig.width;
 // Keep the rotated top-left corner fixed while resizing around the center.
 const dw=w-orig.width,dh=h-orig.height;i.x=orig.x+(dw*Math.cos(angle)-dh*Math.sin(angle)-dw)/2;i.y=orig.y+(dw*Math.sin(angle)+dh*Math.cos(angle)-dh)/2;i.width=w;i.height=h;
 }renderStage();
};
function endGesture(){if(!gesture)return;const edit=gesture.edit&&!gesture.moved;if(gesture.moved)record(gesture.before);gesture=null;render();if(edit){$('text-content')?.focus();$('text-content')?.select();}}
$('stage').onpointerup=endGesture;$('stage').onpointercancel=endGesture;
$('stage').ondblclick=e=>{const i=byId(e.target.closest('[data-item]')?.dataset.item||lastPointerItem);if(i?.type==='text'&&!i.locked){selected=new Set([i.id]);render();$('text-content')?.focus();$('text-content')?.select();}};
$('add-text').onclick=()=>{change(()=>{const i={...base('text',60,50,260,44),name:'Text',text:'Double-click to edit',fontFamily:'Arial',fontSize:28,fontWeight:400,fontStyle:'normal',color:'#20212b',align:'left'};slide().items.push(i);selected=new Set([i.id]);});$('text-content').focus();$('text-content').select();};
$('add-rect').onclick=()=>change(()=>{const i={...base('rect',80,80,160,100),fill:'#ffffff',stroke:'#252735',strokeWidth:2};slide().items.push(i);selected=new Set([i.id]);});
$('add-line').onclick=()=>change(()=>{const i={...base('line',80,80,160,1),stroke:'#252735',strokeWidth:2};slide().items.push(i);selected=new Set([i.id]);});
$('undo').onclick=()=>{flushText();if(!undoStack.length)return;redoStack.push(snapshot());project=undoStack.pop();selected.clear();changed();render();fit();status('Undone');};
$('redo').onclick=()=>{flushText();if(!redoStack.length)return;undoStack.push(snapshot());project=redoStack.pop();selected.clear();changed();render();fit();status('Redone');};
$('duplicate').onclick=()=>{if(!selected.size)return;change(()=>{const copies=chosen().filter(i=>!i.locked).map(i=>({...i,id:uid(),name:i.name+' copy',x:i.x+20,y:i.y+20}));slide().items.push(...copies);selected=new Set(copies.map(i=>i.id));});};
$('delete-item').onclick=()=>{if(!selected.size)return;change(()=>{slide().items=slide().items.filter(i=>!selected.has(i.id)||i.locked);selected=new Set(chosen().map(i=>i.id));});};
function reorder(direction){if(!selected.size)return;change(()=>{if(direction>0){for(let j=slide().items.length-2;j>=0;j--)if(selected.has(slide().items[j].id)&&!slide().items[j].locked&&!selected.has(slide().items[j+1].id))[slide().items[j],slide().items[j+1]]=[slide().items[j+1],slide().items[j]];}else{for(let j=1;j<slide().items.length;j++)if(selected.has(slide().items[j].id)&&!slide().items[j].locked&&!selected.has(slide().items[j-1].id))[slide().items[j],slide().items[j-1]]=[slide().items[j-1],slide().items[j]];}});}
$('bring-forward').onclick=()=>reorder(1);$('send-backward').onclick=()=>reorder(-1);
function align(mode){const items=chosen().filter(i=>!i.locked);if(!items.length)return;change(()=>{const minX=Math.min(...items.map(i=>i.x)),maxX=Math.max(...items.map(i=>i.x+i.width)),minY=Math.min(...items.map(i=>i.y)),maxY=Math.max(...items.map(i=>i.y+i.height));for(const i of items){if(mode==='left')i.x=items.length===1?0:minX;if(mode==='center')i.x=((items.length===1?slide().canvas.width:minX+maxX)-i.width)/2;if(mode==='top')i.y=items.length===1?0:minY;if(mode==='middle')i.y=((items.length===1?slide().canvas.height:minY+maxY)-i.height)/2;}});}
for(const mode of ['left','center','top','middle'])$('align-'+mode).onclick=()=>align(mode);
$('distribute-x').onclick=()=>{const items=chosen().filter(i=>!i.locked).sort((a,b)=>a.x-b.x);if(items.length<3)return;change(()=>{const start=items[0].x,end=items.at(-1).x+items.at(-1).width,total=items.reduce((s,i)=>s+i.width,0),gap=(end-start-total)/(items.length-1);let x=start;for(const i of items){i.x=x;x+=i.width+gap;}});};
$('project-name').oninput=e=>{if(!pendingText)pendingText=snapshot();project.name=e.target.value.trim().slice(0,120)||'Untitled figure';changed();};$('project-name').onblur=()=>{flushText();renderToolbar();};
$('canvas-preset').onchange=e=>{const presets={single:[321,242],double:[680,454],square:[454,454]};if(presets[e.target.value])[$('canvas-width').value,$('canvas-height').value]=presets[e.target.value];};
$('apply-canvas').onclick=()=>{const w=Number($('canvas-width').value),h=Number($('canvas-height').value);if(!Number.isFinite(w)||!Number.isFinite(h)||w<64||h<64||w>8000||h>8000){status('Canvas dimensions must be between 64 and 8,000 px.',true);return;}change(()=>slide().canvas={width:Math.round(w),height:Math.round(h),background:$('canvas-background').value});fit();};
function setZoom(z){zoom=Math.max(.1,Math.min(3,z));renderStage();}
function fit(){const r=$('workspace').getBoundingClientRect();setZoom(Math.min((r.width-100)/slide().canvas.width,(r.height-100)/slide().canvas.height,1));}
$('zoom-in').onclick=()=>setZoom(zoom*1.2);$('zoom-out').onclick=()=>setZoom(zoom/1.2);$('zoom-fit').onclick=fit;
const filename=()=>project.name.replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,80)||'figure';
$('save-project').onclick=()=>{try{flushText();const file=new Blob([serializeDeck(project)],{type:'application/json'});if(file.size>240*1024*1024)throw new Error('Project exceeds the 240 MB file limit. Split it into smaller projects before saving.');downloadBlob(file,filename()+'.figure.json');dirty=false;status(`Project saved with ${project.slides.length} slide${project.slides.length===1?'':'s'} and embedded asset copies.`);}catch(e){status(e.message,true);}};
function replaceProject(p){project=validateDeck(p);selected.clear();undoStack=[];redoStack=[];pendingText=null;dirty=false;collapsedAssetFolders.clear();$('asset-list').replaceChildren();libraryImportNotice={hidden:true,text:'',error:false};renderLibraryImportNotice();render();fit();saveDraft();}
$('new-project').onclick=()=>{if(dirty&&!confirm('Creating a new project will replace the current local draft. Save your project first to keep a copy. Continue?'))return;replaceProject(createDeck());status('New project created with one blank slide.');};
$('open-project').onclick=()=>$('project-input').click();
$('project-input').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>240*1024*1024)throw new Error('Project exceeds 240 MB. Split it into smaller projects.');const p=validateDeck(JSON.parse(await file.text()));if(dirty&&!confirm('Opening a project will replace the current local draft. Continue?'))return;replaceProject(p);status('Editable project opened. Use Link on an asset to reconnect its local file.');}catch(err){status('Could not open project: '+err.message,true);}finally{e.target.value='';}};
$('source-manifest').onclick=()=>downloadBlob(new Blob([JSON.stringify(deckSourceManifest(project),null,2)],{type:'application/json'}),filename()+'.sources.json');
let exporting=false;
function exportInfo(){
 if(exporting)return;
 const format=$('export-format').value,report=format==='html',ppt=format==='pptx',png=format==='png',dpi=Number($('export-dpi').value);
 $('export-title').textContent=ppt?'Export as PPT':report?'Export HTML report':'Export current slide';
 $('export-slide-name').textContent=report||ppt?`All ${project.slides.length} slide${project.slides.length===1?'':'s'} · ${project.name}`:`Slide ${project.slides.indexOf(slide())+1} of ${project.slides.length}: ${slide().name}`;
 $('export-dpi').disabled=!png;
 $('export-submit').disabled=false;
 if(ppt){
  try{
   const layout=pptxLayout(project);
   $('export-info').textContent=`PowerPoint (.pptx) · ${Number(layout.widthInches.toFixed(2))} × ${Number(layout.heightInches.toFixed(2))} in. All slides, with editable text, shapes, and separate images. ${layout.mixedSizes?'Different canvas sizes are fitted proportionally and centered on the first slide’s page size. ':''}${layout.scale!==1?'The first canvas is scaled to fit PowerPoint’s size limits. ':''}Fonts are not embedded.`;
  }catch(e){$('export-info').textContent=e.message;$('export-submit').disabled=true;}
  return;
 }
 $('export-info').textContent=report?'One self-contained HTML file with all slides and a contents list. Open it offline in a browser or print it. Text and shapes remain vector; images are embedded. The report is read-only, and fonts are not embedded.':png?`${Math.round(slide().canvas.width*dpi/96)} × ${Math.round(slide().canvas.height*dpi/96)} px · ${dpi} DPI. All content is rasterized with transparency preserved. Higher DPI does not add detail to source images.`:'SVG keeps editor text and shapes as vectors. Images, including imported SVGs, are embedded rasters. Fonts are not embedded; recipients need the same fonts installed.';
}
$('export-open').onclick=()=>{flushText();exportInfo();$('export-dialog').showModal();};
$('export-format').onchange=exportInfo;$('export-dpi').onchange=exportInfo;$('export-cancel').onclick=()=>$('export-dialog').close();
$('export-dialog').addEventListener('cancel',e=>{if(exporting)e.preventDefault();});
$('export-submit').onclick=async()=>{
 if(exporting)return;
 exporting=true;
 const button=$('export-submit');button.disabled=true;button.textContent='Exporting…';
 $('export-format').disabled=$('export-dpi').disabled=$('export-cancel').disabled=true;
 try{
  flushText();const format=$('export-format').value;let blob,exportName;
  if(format==='pptx'){
   exportName=filename()+'.pptx';blob=await exportPPTX(project);
  }else if(format==='html'){
   blob=new Blob([generateHTMLReport(project)],{type:'text/html;charset=utf-8'});exportName=filename()+'-report.html';
  }else{
   const p=slideProject(project);exportName=(project.slides.length>1?`${filename()}-slide-${project.slides.indexOf(slide())+1}`:filename())+'.'+format;
   const usedAssets=new Set(p.items.filter(i=>i.type==='image').map(i=>i.assetId));p.assets=p.assets.filter(a=>usedAssets.has(a.id));
   blob=format==='png'?await exportPNG(p,Number($('export-dpi').value)):new Blob([projectToSVG(p)],{type:'image/svg+xml'});
  }
  if(blob.size>240*1024*1024)throw new Error('Export exceeds 240 MB. Use fewer slides or smaller source images.');
  downloadBlob(blob,exportName);$('export-dialog').close();
  status(format==='pptx'?`PowerPoint exported with all ${project.slides.length} slides. Text, shapes, and images can be edited in PowerPoint.`:format==='html'?`HTML report exported with all ${project.slides.length} slides. Open the file offline; save your project to keep editing.`:`Current slide exported as ${format.toUpperCase()}. Save project to keep all slides editable.`);
 }catch(e){$('export-info').textContent='Export failed: '+e.message;status('Export failed: '+e.message,true);}finally{exporting=false;button.disabled=false;button.textContent='Export file';$('export-format').disabled=$('export-cancel').disabled=false;$('export-dpi').disabled=$('export-format').value!=='png';}
};
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented)return;
 const input=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable,mod=e.metaKey||e.ctrlKey;
 if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();$('save-project').click();return;}
 if(input||$('export-dialog').open)return;
 if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'redo':'undo').click();}
 else if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();$('redo').click();}
 else if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();$('duplicate').click();}
 else if(mod&&e.key.toLowerCase()==='a'){e.preventDefault();selected=new Set(slide().items.filter(i=>!i.hidden).map(i=>i.id));render();}
 else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();$('delete-item').click();}
 else if(e.key==='Escape'){selected.clear();render();}
 else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&selected.size){e.preventDefault();const n=e.shiftKey?10:1;change(()=>{for(const i of chosen().filter(i=>!i.locked)){if(e.key==='ArrowLeft')i.x-=n;if(e.key==='ArrowRight')i.x+=n;if(e.key==='ArrowUp')i.y-=n;if(e.key==='ArrowDown')i.y+=n;}});}
});
async function openDraftDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('figure-editor-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});}
async function saveDraft(){try{draftDb??=await openDraftDB();const tx=draftDb.transaction('drafts','readwrite');tx.objectStore('drafts').put(clone(project),'current');await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});}catch(e){status('Could not save the local draft. Use Save project to download a backup. '+e.message,true);}}
async function loadDraft(){try{draftDb=await openDraftDB();const req=draftDb.transaction('drafts').objectStore('drafts').get('current');const p=await new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});if(p){project=validateDeck(p);dirty=true;render();fit();status('Local draft restored. Save your project regularly to keep a backup.');}}catch{status('Local drafts are unavailable. Use Save project to keep a backup.');}}
$('demo-project').onclick=async()=>{
 if(dirty&&!confirm('The example will replace the current local draft. Continue?'))return;
 try{const {makeDemo}=await import('./demo.js');replaceProject(await makeDemo());status('Example loaded. Images, text, and shapes can be edited independently.');}catch(e){status(e.message,true);}
};
render();initWindows({onLayoutChange:fit});requestAnimationFrame(fit);await loadDraft();
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
