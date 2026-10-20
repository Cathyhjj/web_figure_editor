import { isMediaItem, posterSource } from './video.js';
import { createChartFrame } from './html-chart.js';
import { uid, projectToSVG, exportPNG, downloadBlob } from './core.js';
import { createDeck, validateDeck, cloneDeck, currentSlide, slideProject, deckSourceManifest, addSlide } from './deck.js';
import { pickProjectFile, readProjectFile, writeProjectFile } from './project-files.js';
import { importFiles, pickImages, importFolderFiles, pickFolder, importDroppedFiles, linkAsset, refreshAsset, replaceAsset } from './assets.js?v=locate-1';
import { buildAssetTree } from './asset-tree.js';
import { locateAsset } from './locate.js';
import { generateHTMLReport } from './report.js';
import { exportPPTX, pptxLayout } from './pptx.js';
import { initPPTXImport } from './pptx-import.js';
import { exportPDF } from './pdf.js';
import { initWindows } from './windows.js';
import { imageShadowSVG } from './shadow.js';
import { shadowEditorMarkup, bindShadowEditor } from './shadow-editor.js';
import { imageCrop, isCropped, cropImage } from './crop.js';
import { createCropEditor } from './crop-editor.js';
import { resizeItem } from './resize.js';
import { selectionRect, enclosedItemIds } from './selection.js';
import { initFontTools, fontValue } from './font-tools.js';

import { CLIPBOARD_MIME, createSelection, encodeSelection, decodeSelection, pasteSelection, SLIDE_CLIPBOARD_MIME, SLIDES_CLIPBOARD_MIME, createSlidesClipboard, encodeSlides, decodeSlides, pasteSlides } from './clipboard.js';
import { selectionToPNG } from './clipboard-image.js';

const $ = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
let project = createDeck(), selected = new Set(), zoom = .75, undoStack = [], redoStack = [];
let selectedSlideIds = new Set([project.activeSlideId]), slideSelectionAnchor = project.activeSlideId;
const slideSelectionSnapshots = new WeakMap();
let gesture = null, dirty = false, relinkId = null, draftTimer, draftDb, pendingText = null, lastPointerItem = null, lastTap = null;
let projectFileHandle = null, projectFileName = '', projectFilePersistent = true;
// Keep file actions unavailable until the initial draft has finished restoring.
let projectEpoch = 0, editRevision = 0, fileOperation = true, draftWrites = Promise.resolve();
const AUTOSAVE_DELAY = 1500;
let autosaveEnabled = true, autosaveTimer, autosaveWriting = false, autosaveError = null;
let draftRevision = -1, draftError = null, lastFileSave = null;
try { autosaveEnabled = localStorage.getItem('figure-editor-autosave') !== 'off'; } catch { /* Keep the default when preferences are unavailable. */ }
const collapsedAssetFolders = new Set();
let selectedAssetIds = new Set();
let locatingAsset = false;
let lastPaste = null;
let clipboardWriteId = 0;
let readingSlideClipboard = false;
let libraryImports = 0;
let activeHTMLChart = null;
let libraryImportNotice = { hidden: true, text: '', error: false };
const clone = cloneDeck;
const slide = () => currentSlide(project);
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chosen = () => slide().items.filter(i=>selected.has(i.id));
const byId = id => slide().items.find(i=>i.id===id);
const assetById = id => project.assets.find(a=>a.id===id);
const fontTools = initFontTools({ getItems: chosen, change });
function status(message, error=false) { $('status').textContent=message; $('status').classList.toggle('error',error); }
function snapshot(){const copy=clone(project);slideSelectionSnapshots.set(copy,{ids:[...selectedSlideIds],anchor:slideSelectionAnchor});return copy;}
function resetSlideSelection(){selectedSlideIds=new Set([project.activeSlideId]);slideSelectionAnchor=project.activeSlideId;}
function restoreSlideSelection(saved){const state=slideSelectionSnapshots.get(saved);if(state){selectedSlideIds=new Set(state.ids);slideSelectionAnchor=state.anchor;}else resetSlideSelection();}
function record(before){undoStack.push(before); if(undoStack.length>50)undoStack.shift();redoStack=[];changed();}
function change(action){flushText();const before=snapshot();try{action();validateDeck(project);record(before);render();return true;}catch(error){project=before;restoreSlideSelection(before);render();status(error.message,true);return false;}}
function changed(){dirty=true;editRevision++;clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,650);scheduleAutosave();renderAutosave();}
function base(type, x=80,y=80,width=160,height=80){return {id:uid(),type,name:type==='text'?'Text':type==='rect'?'Rectangle':type==='line'?'Line':'Image',x,y,width,height,rotation:0,opacity:1,locked:false,hidden:false};}
const cropEditor=createCropEditor((id,crop)=>{
 const item=byId(id);if(!item||item.locked)return false;
 if(!change(()=>{const updated=cropImage(item,crop);delete item.crop;Object.assign(item,updated);}))return false;
 status(isCropped(item)?'Image cropped. The original is kept; use Restore original to show it again.':'Full image restored.');return true;
});
function svg(tag, attrs={}, text){const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
function closeHTMLChart(){
 if(activeHTMLChart){activeHTMLChart.viewer.dispose();activeHTMLChart=null;}
 $('html-chart-overlay').hidden=true;$('html-chart-controls').hidden=true;
}
function syncHTMLChart(){
 if(!activeHTMLChart)return;
 const state=activeHTMLChart,item=byId(state.itemId),asset=assetById(state.assetId);
 if(state.project!==project||state.slideId!==project.activeSlideId||!item||item.hidden||!selected.has(item.id)||selected.size!==1||asset?.dataUrl!==state.source){closeHTMLChart();return;}
 const host=$('html-chart-overlay'),frame=state.viewer.frame;
 Object.assign(host.style,{left:`${item.x*zoom}px`,top:`${item.y*zoom}px`,width:`${item.width*zoom}px`,height:`${item.height*zoom}px`,transform:`rotate(${item.rotation}deg)`,opacity:item.opacity});
 Object.assign(frame.style,{width:`${asset.width}px`,height:`${asset.height}px`,transform:`scale(${item.width*zoom/asset.width},${item.height*zoom/asset.height})`});
}
async function saveHTMLSnapshot(state=activeHTMLChart,{automatic=false}={}){
 if(!state||state.capturing)return;
 state.capturing=true;$('html-chart-snapshot').disabled=true;
 try{
  const captured=await state.viewer.capture();
  if(activeHTMLChart!==state||state.project!==project||assetById(state.assetId)?.dataUrl!==state.source)return;
  // Decode as well as checking PNG signature/dimensions before accepting child data.
  const image=new Image();image.src=captured.posterDataUrl;await image.decode();
  if(activeHTMLChart!==state||state.project!==project||assetById(state.assetId)?.dataUrl!==state.source)return;
  if(automatic){Object.assign(assetById(state.assetId),captured);changed();render();}
  else if(!change(()=>Object.assign(assetById(state.assetId),captured)))return;
  status('Chart snapshot saved for static exports and every placement of this asset. The HTML original remains interactive.');
 }catch(error){
  if(activeHTMLChart===state)status(automatic?'Chart is open. Use Save snapshot when it has finished drawing. '+error.message:error.message,!automatic);
 }finally{
  state.capturing=false;if(activeHTMLChart===state)$('html-chart-snapshot').disabled=false;
 }
}
function openHTMLChart(item){
 const asset=item&&assetById(item.assetId);if(item?.type!=='html'||!asset||item.hidden)return;
 if(activeHTMLChart?.itemId===item.id){syncHTMLChart();return;}
 closeHTMLChart();flushText();selected=new Set([item.id]);render();
 const state={itemId:item.id,assetId:asset.id,source:asset.dataUrl,project,slideId:project.activeSlideId,capturing:false};
 try{state.viewer=createChartFrame(asset,{
  onEscape:()=>{if(activeHTMLChart===state){closeHTMLChart();$('workspace').focus({preventScroll:true});status('Back to layout. Double-click the chart to interact again.');}},
  onWarning:message=>{if(activeHTMLChart===state)status(message,true);},
 });}catch(error){status('Could not open HTML chart. Choose a valid UTF-8 HTML file. '+error.message,true);return;}
 activeHTMLChart=state;
 $('html-chart-overlay').replaceChildren(state.viewer.frame);$('html-chart-overlay').hidden=false;
 $('html-chart-controls').hidden=false;$('html-chart-snapshot').disabled=false;syncHTMLChart();
 status('Chart interaction: hover or use its zoom controls. Done / Escape returns to layout. Save snapshot updates static exports.');
 state.viewer.ready.then(ready=>{
  if(!ready||activeHTMLChart!==state){if(activeHTMLChart===state)status('Chart loading timed out. Check that scripts and data are embedded or available.',true);return;}
  if(!asset.hasSnapshot)setTimeout(()=>{if(activeHTMLChart===state)saveHTMLSnapshot(state,{automatic:true});},500);
 });
}
$('html-chart-done').onclick=()=>{closeHTMLChart();$('workspace').focus({preventScroll:true});status('Back to layout. The chart HTML is kept in the project; interactive view changes are temporary.');};
$('html-chart-snapshot').onclick=()=>saveHTMLSnapshot();
$('html-chart-controls').onpointerdown=e=>e.stopPropagation();
function appendItemContent(g,item,context='stage'){
  if(item.type==='image'){
   const a=assetById(item.assetId);
   if(a)g.innerHTML=imageShadowSVG(item,a,`shadow-${context}-${item.id}`);
  }
  if(item.type==='image'){const a=assetById(item.assetId);if(a){const c=imageCrop(item),parent=item.crop?svg('svg',{width:item.width,height:item.height,viewBox:`${c.x} ${c.y} ${c.width} ${c.height}`,preserveAspectRatio:'none',overflow:'hidden'}):g;parent.append(svg('image',{href:a.dataUrl,width:item.crop?1:item.width,height:item.crop?1:item.height,preserveAspectRatio:'none'}));if(parent!==g)g.append(parent);}}
  else if(item.type==='html'){const a=assetById(item.assetId);if(a)g.append(svg('image',{href:a.posterDataUrl,width:item.width,height:item.height,preserveAspectRatio:'none'}));}
  else if(item.type==='video'){const a=assetById(item.assetId);if(a){g.append(svg('image',{href:a.posterDataUrl,width:item.width,height:item.height,preserveAspectRatio:'none'}));const r=Math.min(item.width,item.height)*.09;g.append(svg('circle',{cx:item.width/2,cy:item.height/2,r,fill:'#111827b3'}));g.append(svg('path',{d:`M ${item.width/2-r*.3} ${item.height/2-r*.5} L ${item.width/2+r*.55} ${item.height/2} L ${item.width/2-r*.3} ${item.height/2+r*.5} Z`,fill:'#fff'}));}}
  else if(item.type==='text'){
   const text=svg('text',{x:item.align==='center'?item.width/2:item.align==='right'?item.width:0,y:item.fontSize,fill:item.color,'font-family':item.fontFamily+', Arial, sans-serif','font-size':item.fontSize,'font-weight':item.fontWeight,'font-style':item.fontStyle,'text-anchor':item.align==='center'?'middle':item.align==='right'?'end':'start','xml:space':'preserve'});
   String(item.text).split('\n').forEach((line,j)=>text.append(svg('tspan',{x:item.align==='center'?item.width/2:item.align==='right'?item.width:0,dy:j?item.fontSize*1.2:0},line||' ')));g.append(text);
  }else if(item.type==='rect')g.append(svg('rect',{width:item.width,height:item.height,fill:item.fill,stroke:item.stroke,'stroke-width':item.strokeWidth}));
  else if(item.type==='line')g.append(svg('line',{x1:0,y1:0,x2:item.width,y2:item.height,stroke:item.stroke,'stroke-width':item.strokeWidth}));
}
function previewVideo(asset){
 if(!asset||asset.mime!=='video/mp4')return;
 const player=$('video-player');
 $('video-title').textContent=asset.name;player.poster=asset.posterDataUrl;player.src=asset.dataUrl;
 $('video-dialog').showModal();player.play().catch(()=>{});
}
$('video-close').onclick=()=>$('video-dialog').close();
$('video-dialog').addEventListener('close',()=>{const player=$('video-player');player.pause();player.removeAttribute('src');player.removeAttribute('poster');player.load();});
function renderSlides(){
 const validIds=new Set(project.slides.map(page=>page.id));
 selectedSlideIds=new Set([...selectedSlideIds].filter(id=>validIds.has(id)));
 if(!selectedSlideIds.has(project.activeSlideId))resetSlideSelection();
 if(!validIds.has(slideSelectionAnchor))slideSelectionAnchor=project.activeSlideId;
 const list=$('slide-list'),existing=new Map([...list.children].map(card=>[card.dataset.slide,card]));
 project.slides.forEach((page,index)=>{
  const card=existing.get(page.id)||document.createElement('button');existing.delete(page.id);card.type='button';card.className='slide-card';card.dataset.slide=page.id;
  card.setAttribute('aria-current',String(page.id===project.activeSlideId));
  card.setAttribute('aria-pressed',String(selectedSlideIds.has(page.id)));
  card.setAttribute('aria-label',`Slide ${index+1}: ${page.name}`);card.title=page.name;
  const preview=svg('svg',{class:'slide-preview',viewBox:`0 0 ${page.canvas.width} ${page.canvas.height}`,'aria-hidden':'true'});
  preview.append(svg('rect',{width:page.canvas.width,height:page.canvas.height,fill:page.canvas.background}));
  for(const item of page.items){
   if(item.hidden)continue;
   const g=svg('g',{transform:`translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width/2} ${item.height/2})`,opacity:item.opacity});
   appendItemContent(g,item,`preview-${page.id}`);preview.append(g);
  }
  const caption=document.createElement('span');caption.className='slide-caption';
  caption.innerHTML=`<span>${index+1}</span><span>${escapeHTML(page.name)}</span>`;card.replaceChildren(preview,caption);
  card.onclick=e=>{selectSlideCard(page.id,e);card.focus({preventScroll:true});};if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);
 });
 for(const card of existing.values())card.remove();
 $('slide-name').value=slide().name;
 $('slide-position').textContent=`Slide ${project.slides.indexOf(slide())+1} of ${project.slides.length}`;
 $('slide-selection-count').textContent=`${selectedSlideIds.size} selected`;
 $('copy-slide').title=`Copy ${selectedSlideIds.size===1?'slide':selectedSlideIds.size+' slides'} (⌘ / Ctrl + C)`;
 $('duplicate-slide').title=`Duplicate ${selectedSlideIds.size===1?'slide':selectedSlideIds.size+' selected slides'}`;
 $('delete-slide').title=`Delete ${selectedSlideIds.size===1?'slide':selectedSlideIds.size+' selected slides'}`;
 $('delete-slide').disabled=selectedSlideIds.size===project.slides.length;
 $('new-slide').disabled=project.slides.length>=100;
 $('duplicate-slide').disabled=project.slides.length+selectedSlideIds.size>100;
 $('paste-slide').disabled=readingSlideClipboard||project.slides.length>=100;
}
function selectSlide(id,{ids=new Set([id]),anchor=id}={}){
 flushText();project.activeSlideId=id;selectedSlideIds=ids;slideSelectionAnchor=anchor;editRevision++;selected.clear();lastTap=null;lastPointerItem=null;
 render();fit();saveDraft();status(`Editing ${slide().name}. Assets are shared across slides.`);
}
function selectSlideCard(id,event={}){
 const additive=event.metaKey||event.ctrlKey;
 let ids=new Set([id]),active=id,anchor=id;
 if(event.shiftKey){
  const start=project.slides.findIndex(page=>page.id===slideSelectionAnchor),end=project.slides.findIndex(page=>page.id===id);
  ids=new Set(additive?selectedSlideIds:[]);
  for(const page of project.slides.slice(Math.min(start,end),Math.max(start,end)+1))ids.add(page.id);
  anchor=slideSelectionAnchor;
 }else if(additive){
  ids=new Set(selectedSlideIds);
  if(ids.has(id)&&ids.size>1){ids.delete(id);active=ids.has(project.activeSlideId)?project.activeSlideId:project.slides.findLast(page=>ids.has(page.id)).id;}
  else ids.add(id);
 }
 selectSlide(active,{ids,anchor});
 if(ids.size>1)status(`${ids.size} slides selected. Copy to paste them together in slide order.`);
}
function editSlides(action,message){
 const keepSlideFocus=slideClipboardTarget(document.activeElement);
 const applied=change(()=>{action(project);resetSlideSelection();selected.clear();lastTap=null;lastPointerItem=null;});
 if(applied){fit();if(keepSlideFocus)focusCurrentSlide();else $('slide-list').querySelector('[aria-current="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});status(message);}
}
$('new-slide').onclick=()=>editSlides(addSlide,'New blank slide added. Place an asset or add text to begin.');
$('duplicate-slide').onclick=()=>{
 if($('duplicate-slide').disabled)return;
 try{
  const payload=createSlidesClipboard(project,selectedSlideIds);
  for(const page of payload.slides)page.name=`${page.name.slice(0,295)} copy`;
  insertClipboardSlide(payload);
 }catch(error){status(error.message,true);}
};
$('delete-slide').onclick=()=>{
 if($('delete-slide').disabled)return;
 const ids=new Set(selectedSlideIds),count=ids.size;
 editSlides(deck=>{
  const index=deck.slides.findIndex(page=>page.id===deck.activeSlideId);
  const next=deck.slides.slice(index+1).find(page=>!ids.has(page.id))||deck.slides.slice(0,index).findLast(page=>!ids.has(page.id));
  if(!next)throw new Error('The last slide cannot be deleted.');
  deck.slides=deck.slides.filter(page=>!ids.has(page.id));deck.activeSlideId=next.id;
 },`${count===1?'Slide':count+' slides'} deleted. Use Undo to restore.`);
};
$('slide-name').oninput=e=>{if(!pendingText)pendingText=snapshot();slide().name=e.target.value.trim().slice(0,120)||'Untitled slide';changed();};
$('slide-name').onblur=()=>{flushText();renderToolbar();};
function renderStage(){
 syncHTMLChart();
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
   if(selected.size===1&&!item.locked){
    const handles=isMediaItem(item)?[
     ['w',0,item.height/2,'Stretch width',0],['e',item.width,item.height/2,'Stretch width',0],
     ['n',item.width/2,0,'Stretch height',90],['s',item.width/2,item.height,'Stretch height',90],
    ]:[];
    handles.push(['se',item.width,item.height,isMediaItem(item)?'Scale proportionally (Shift: resize freely)':'Resize',45]);
    for(const [direction,x,y,label,angle] of handles){
     const cursor=['ew-resize','nwse-resize','ns-resize','nesw-resize'][((Math.round((item.rotation+angle)/45)%4)+4)%4];
     const handle=svg('rect',{x:x-5/zoom,y:y-5/zoom,width:10/zoom,height:10/zoom,fill:'#fff',stroke:'#9c357c','stroke-width':1.5/zoom,'data-resize':item.id,'data-resize-handle':direction,'aria-label':label,class:'resize-handle',style:`cursor:${cursor}`});
     handle.append(svg('title',{},label));g.append(handle);
    }
   }
  }
  stage.append(g);
 }
 if(gesture?.mode==='select'&&gesture.moved){
  stage.append(svg('rect',{...selectionRect(gesture.start,gesture.current),class:'selection-marquee','pointer-events':'none','aria-hidden':'true'}));
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
 if(!project.assets.length){const p=document.createElement('p');p.className='hint';p.textContent='Drop images, HTML charts, MP4 videos, or folders here to preview them. Folder structure is kept. Files are processed locally.';list.append(p);}
 function assetCard(a){
  const card=document.createElement('div');card.className='asset-card';card.dataset.asset=a.id;card.draggable=false;
  card.innerHTML=`<button class="asset-preview" data-action="place" title="Add to canvas" aria-label="Place ${escapeHTML(a.name)} on canvas"><img draggable="false" loading="lazy" decoding="async" class="asset-thumb" alt="${escapeHTML(a.name)}" src="${posterSource(a)}"></button><div class="asset-name" title="${escapeHTML(a.relativePath||a.name)}">${escapeHTML(a.name)}</div><div class="asset-meta">${a.width} × ${a.height}${a.mime==='text/html'?' · Interactive HTML':''}${a.mime==='video/mp4'?` · MP4 · ${a.duration.toFixed(1)} s`:''} · ${a.sourceKind==='linked'?(a.linkPersistence==='session'?'Session link + copy':'Local link + copy'):'Portable copy'}${a.originalMime==='image/svg+xml'?' · Rasterized SVG':''}</div><div class="asset-actions"><button data-action="place">Place</button><button data-action="relink">Link</button>${a.sourceKind==='linked'?'<button data-action="refresh">Refresh</button>':''}</div>`;
  card.setAttribute('role','group');
  const selectionLabel=document.createElement('div');selectionLabel.className='asset-selection-label';selectionLabel.textContent='Selected on canvas';card.append(selectionLabel);
  const locateButton=document.createElement('button');locateButton.type='button';locateButton.dataset.action='locate';locateButton.textContent='Locate';locateButton.title='Show source image in Finder';locateButton.setAttribute('aria-label',`Show ${a.name} in Finder`);locateButton.disabled=locatingAsset;card.querySelector('.asset-actions').insertBefore(locateButton,card.querySelector('[data-action="refresh"]'));
  if(a.mime==='video/mp4'){const preview=document.createElement('button');preview.dataset.action='preview';preview.textContent='Preview';card.querySelector('.asset-actions').append(preview);}
  let suppressClick=false;
  card.onpointerdown=e=>{
   if(e.button!==0||e.target.closest('.asset-actions'))return;
   const start={x:e.clientX,y:e.clientY};let moved=false;
   const move=ev=>{if(Math.hypot(ev.clientX-start.x,ev.clientY-start.y)>5){moved=true;document.body.style.cursor='copy';}};
   const end=ev=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.body.style.cursor='';if(!moved)return;suppressClick=true;const r=$('workspace').getBoundingClientRect();if(ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom){const p=point(ev);placeAsset(a,{x:Math.max(0,p.x),y:Math.max(0,p.y)});}setTimeout(()=>suppressClick=false,0);};
   document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});
  };
  card.onclick=async e=>{if(suppressClick)return;const action=e.target.closest('[data-action]')?.dataset.action;if(action==='preview')previewVideo(a);if(action==='place')placeAsset(a);if(action==='relink')await relink(a);if(action==='refresh')await refresh(a);if(action==='locate')await locate(a);};return card;
 }
 function appendFolderContents(node,container){
  for(const folder of node.folders){
   const details=document.createElement('details');details.className='asset-folder';details.dataset.path=folder.path;details.open=!collapsedAssetFolders.has(folder.path);
   const summary=document.createElement('summary');summary.title=folder.path;
   summary.innerHTML=`<span class="folder-chevron" aria-hidden="true">›</span><svg aria-hidden="true"><use href="#i-folder"/></svg><span class="folder-name">${escapeHTML(folder.name)}</span><span class="folder-count" aria-label="${folder.count} assets">${folder.count}</span>`;
   const contents=document.createElement('div');contents.className='asset-folder-content';appendFolderContents(folder,contents);
   details.append(summary,contents);container.append(details);
  }
  for(const asset of node.assets)container.append(assetCard(asset));
 }
 appendFolderContents(buildAssetTree(project.assets),list);
 $('assets-panel').scrollTop=scrollTop;
 syncAssetSelection();
}
function syncAssetSelection(revealAssetId){
 const nextIds=new Set(chosen().filter(isMediaItem).map(i=>i.assetId));
 const revealId=revealAssetId??[...nextIds].find(id=>!selectedAssetIds.has(id));
 selectedAssetIds=nextIds;
 let target;
 for(const card of $('asset-list').querySelectorAll('.asset-card')){
  const active=nextIds.has(card.dataset.asset);
  card.classList.toggle('selected',active);
  card.setAttribute('aria-label',`${card.querySelector('.asset-name').textContent}${active?' · Selected on canvas':''}`);
  if(active&&card.dataset.asset===revealId)target=card;
 }
 if(!target)return;
 // Reveal the source without scrolling the canvas or rebuilding the library during a drag.
 for(let folder=target.closest('.asset-folder');folder;folder=folder.parentElement.closest('.asset-folder')){
  folder.open=true;collapsedAssetFolders.delete(folder.dataset.path);
 }
 const panel=$('assets-panel'),bounds=panel.getBoundingClientRect(),cardBounds=target.getBoundingClientRect();
 const top=bounds.top+panel.clientTop,bottom=top+panel.clientHeight;
 if(cardBounds.top<top||cardBounds.height>panel.clientHeight)panel.scrollTop+=cardBounds.top-top;
 else if(cardBounds.bottom>bottom)panel.scrollTop+=cardBounds.bottom-bottom;
}
function renderLayers(){
 const list=$('layer-list');list.replaceChildren();
 if(!slide().items.length){const p=document.createElement('p');p.className='hint';p.textContent='No objects on this slide yet.';list.append(p);}
 for(const i of [...slide().items].reverse()){
  const row=document.createElement('div');row.className=`layer-row ${selected.has(i.id)?'selected':''}`;row.dataset.layer=i.id;
  row.innerHTML=`<button class="layer-select" title="Select object">${i.type==='html'?'◇':i.type==='video'?'▶':i.type==='image'?'▧':i.type==='text'?'T':i.type==='rect'?'□':'╱'} <span>${escapeHTML(i.name)}</span></button><button data-action="hide" title="${i.hidden?'Show':'Hide'}">${i.hidden?'○':'●'}</button><button data-action="lock" title="${i.locked?'Unlock':'Lock'}">${i.locked?'▣':'◇'}</button>`;
  row.onclick=e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(action)change(()=>{if(action==='hide')i.hidden=!i.hidden;else i.locked=!i.locked;});else{flushText();if(e.shiftKey){selected.has(i.id)?selected.delete(i.id):selected.add(i.id);}else selected=new Set([i.id]);render();}};list.append(row);
 }
}
function field(label,key,value,type='number',extra=''){return `<label class="field"><span>${label}</span><input data-property="${key}" type="${type}" value="${escapeHTML(value)}" ${extra}></label>`;}
function renderInspector(){
 const items=chosen(), box=$('inspector');
 if(items.length!==1){box.innerHTML=`<div class="section-heading">${items.length?'Multiple objects':'Object properties'}</div><p class="hint">${items.length?'Drag any selected object to move them together. Shift + click or Shift + drag on blank space to adjust the selection.':'Drag on blank canvas space to select objects, or click an image, text, or shape. Double-click text to edit its content.'}</p>`;return;}
 const i=items[0];
 box.innerHTML=`<div class="section-heading">${i.type==='html'?'HTML chart':i.type==='video'?'Video':i.type==='image'?'Image':i.type==='text'?'Text':'Shape'} properties${i.locked?' · Locked':''}</div>${field('Name','name',i.name,'text')}<div class="field-row">${field('X / px','x',round(i.x),'number','step="1"')}${field('Y / px','y',round(i.y),'number','step="1"')}</div><div class="field-row">${field('Width / px','width',round(i.width),'number','min="1" step="1"')}${field('Height / px','height',round(i.height),'number','min="1" step="1"')}</div><div class="field-row">${field('Rotation / °','rotation',round(i.rotation))}${field('Opacity','opacity',i.opacity,'number','min="0" max="1" step="0.1"')}</div>`;
 if(i.type==='text')box.innerHTML+=`<label class="field"><span>Text content</span><textarea id="text-content" rows="4">${escapeHTML(i.text)}</textarea></label>${field('Font','fontFamily',i.fontFamily,'text','list="font-families" maxlength="200" autocomplete="off" spellcheck="false"')}<div class="field-row">${field('Size / px','fontSize',i.fontSize,'number','min="1" max="2000" step="any"')}${field('Color','color',i.color,'color')}</div><div class="field-row"><label class="field"><span>Weight</span><select data-property="fontWeight"><option value="400" ${String(i.fontWeight)==='400'?'selected':''}>Regular</option><option value="700" ${String(i.fontWeight)==='700'?'selected':''}>Bold</option></select></label><label class="field"><span>Style</span><select data-property="fontStyle"><option value="normal" ${i.fontStyle==='normal'?'selected':''}>Normal</option><option value="italic" ${i.fontStyle==='italic'?'selected':''}>Italic</option></select></label></div><label class="field"><span>Text alignment</span><select data-property="align">${[['left','Left'],['center','Center'],['right','Right']].map(([v,t])=>`<option value="${v}" ${i.align===v?'selected':''}>${t}</option>`).join('')}</select></label><p class="hint">Uses fonts installed on this computer. SVG does not embed fonts. Press Enter for a new line.</p>`;
 if(i.type==='image'){const a=assetById(i.assetId),c=imageCrop(i);const effectiveDPI=a?Math.round(Math.min(a.width*c.width/i.width,a.height*c.height/i.height)*96):0;box.innerHTML+=`<div class="image-crop-actions"><button id="crop-image" class="button" ${i.locked?'disabled':''}>${isCropped(i)?'Edit crop':'Crop'}</button><button id="restore-image" class="button" ${i.locked||!isCropped(i)?'disabled':''}>Restore original</button></div><p class="hint">Source: ${escapeHTML(a?.name)}<br>Original size: ${a?.width} × ${a?.height} px${isCropped(i)?`<br>Cropped area: ${Math.round(a.width*c.width)} × ${Math.round(a.height*c.height)} px`:''}<br>Effective resolution: ${effectiveDPI} DPI<br>Drag the bottom-right corner to keep proportions; hold Shift to resize freely. Drag side handles to stretch width or height. Width and height fields keep proportions.</p>`;}
 if(i.type==='video'){const a=assetById(i.assetId);box.innerHTML+=`<div class="image-crop-actions"><button id="preview-video" class="button">▶ Preview video</button></div><p class="hint">MP4 · ${a.width} × ${a.height} px · ${a.duration.toFixed(1)} s<br>Embedded in PowerPoint; click the video during Slide Show to play. H.264 video with AAC audio is recommended.<br>PNG, SVG, PDF, and HTML reports use the poster frame.</p>`;}
 if(i.type==='image')box.innerHTML+=shadowEditorMarkup(i);
 if(i.type==='rect'||i.type==='line')box.innerHTML+=`<div class="field-row">${i.type==='rect'?field('Fill','fill',i.fill,'color'):''}${field('Stroke','stroke',i.stroke,'color')}</div>${field('Stroke width / px','strokeWidth',i.strokeWidth,'number','min="0" max="100" step="0.5"')}`;
 box.innerHTML+=`<label class="field inline"><input id="object-locked" type="checkbox" ${i.locked?'checked':''}> Lock object</label>`;
 if(i.type==='image'){
  $('crop-image').onclick=()=>{flushText();cropEditor.show(i,assetById(i.assetId));};
  $('restore-image').onclick=()=>{if(i.locked||!isCropped(i))return;if(change(()=>{const restored=cropImage(i);delete i.crop;Object.assign(i,restored);}))status('Full image restored. Use Undo to return to the crop.');};
 }
 if(i.type==='video')$('preview-video').onclick=()=>previewVideo(assetById(i.assetId));
 if(i.type==='html'){
  const note=document.createElement('p');note.className='hint';note.textContent='Double-click to zoom and hover. Save snapshot updates all copies of this asset for PNG, SVG, PDF, PPTX and HTML reports. View changes are temporary; the original HTML is saved.';
  const button=document.createElement('button');button.id='interact-html';button.className='button';button.textContent='Interact with chart';button.onclick=()=>openHTMLChart(i);
  box.append(button,note);
 }
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
   if(key==='fontSize'||key==='fontFamily'){val=fontValue(key,val);if(val===null)return;}
   if(key==='opacity')val=Math.max(0,Math.min(1,val));if(key==='strokeWidth')val=Math.max(0,Math.min(100,val));
   if(key==='name')val=val.slice(0,1000);
   if(i[key]===val)return;
   if(!pendingText)pendingText=snapshot();
   if(isMediaItem(i)&&(key==='width'||key==='height')){const ratio=i.width/i.height;if(key==='width')i.height=val/ratio;else i.width=val*ratio;const other=box.querySelector(`[data-property="${key==='width'?'height':'width'}"]`);if(other)other.value=round(key==='width'?i.height:i.width);}
   i[key]=val;changed();renderStage();
  };
  input.oninput=()=>{if(input.dataset.property!=='fontFamily')apply();};
  input.onchange=()=>{apply();input.value=i[input.dataset.property];flushText();renderLayers();renderToolbar();};
  input.onblur=()=>{flushText();renderLayers();renderToolbar();};
 });
 bindShadowEditor(i,box,{
  begin:()=>{if(!pendingText)pendingText=snapshot();},
  preview:()=>{changed();renderStage();},
  commit:()=>{flushText();renderToolbar();},
  change,
 });
 $('object-locked').onchange=e=>change(()=>i.locked=e.target.checked);
 const text=$('text-content');if(text){text.disabled=i.locked;text.oninput=()=>{if(!pendingText)pendingText=snapshot();i.text=text.value.slice(0,20000);i.height=Math.max(i.fontSize*1.2*i.text.split('\n').length,i.height);changed();renderStage();};text.onblur=()=>{flushText();renderLayers();renderToolbar();};}
}
function flushText(){if(pendingText){const before=pendingText;pendingText=null;record(before);renderSlides();}}
const round=n=>Math.round(n*10)/10;
function renderToolbar(){
 renderFileActions();
 fontTools.render();
 $('undo').disabled=!undoStack.length;$('redo').disabled=!redoStack.length;
 for(const id of ['duplicate','delete-item','bring-forward','send-backward'])$(id).disabled=!selected.size;
 for(const id of ['align-left','align-center','align-top','align-middle'])$(id).disabled=!chosen().some(i=>!i.locked);
 $('distribute-x').disabled=chosen().filter(i=>!i.locked).length<3;
}
function render(){
 if(gesture?.mode==='select'&&!marqueeCurrent())finishMarquee(true,false);
 selected=new Set([...selected].filter(id=>byId(id)));renderStage();renderSlides();renderAssets();renderLayers();renderInspector();renderToolbar();
 $('project-name').value=project.name;$('canvas-width').value=slide().canvas.width;$('canvas-height').value=slide().canvas.height;$('canvas-background').value=slide().canvas.background;
}
function point(event){const p=new DOMPoint(event.clientX,event.clientY).matrixTransform($('stage').getScreenCTM().inverse());return{x:p.x,y:p.y};}
function placeAsset(a,position){change(()=>{const maxW=slide().canvas.width*.43,maxH=slide().canvas.height*.65,scale=Math.min(1,maxW/a.width,maxH/a.height);const offset=slide().items.length%6*18;const i={...base(a.mime==='text/html'?'html':a.mime==='video/mp4'?'video':'image',position?.x??60+offset,position?.y??60+offset,a.width*scale,a.height*scale),assetId:a.id,name:a.name};slide().items.push(i);selected=new Set([i.id]);});status(`Added ${a.name} to the canvas.`);if(a.mime==='text/html')openHTMLChart(chosen()[0]);}
const importTarget=()=>({project,slideId:project.activeSlideId});
initPPTXImport({
 captureTarget:importTarget,
 targetIsCurrent:target=>target.project===project&&target.slideId===project.activeSlideId&&(!fileOperation||autosaveWriting),
 insert:(deck,warnings)=>{
  const applied=change(()=>{const pages=pasteSlides(project,deck);selectedSlideIds=new Set(pages.map(page=>page.id));slideSelectionAnchor=pages[0].id;selected.clear();lastPaste=null;});
  if(applied){fit();focusCurrentSlide();status(`Imported ${slide().name}. Images and text are independently editable. Use Undo to remove this slide.${warnings.some(w=>/omitted|not retained/i.test(w))?' Some PowerPoint features were not retained; see the import preview notes.':''}`);}
  else throw new Error($('status').textContent);
  return applied;
 }
});
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
   const i={...base(a.mime==='text/html'?'html':a.mime==='video/mp4'?'video':'image',(position?.x??60)+j*22,(position?.y??60)+j*22,a.width*scale,a.height*scale),assetId:a.id,name:a.name};
   page.items.push(i);if(page.id===project.activeSlideId)selected=new Set([i.id]);
  }});
  if(!applied)return;
  status(`Imported ${result.assets.length} asset${result.assets.length===1?'':'s'} into ${libraryOnly?'Assets':page.name}.${libraryOnly?' Choose a preview or Place to add it to the canvas.':' Portable copies are included.'}${skipped}${errors?' '+errors:''}`,!!errors);
  if(!libraryOnly&&page.id===project.activeSlideId&&chosen()[0]?.type==='html')openHTMLChart(chosen()[0]);
 }else if(errors)status(errors+skipped,true);
 else if('skipped' in result)status('No supported media found. Choose a folder containing PNG, JPG, WebP, SVG, MP4, or HTML files.'+skipped);
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
 notice.textContent=busy?'Reading images, videos, and subfolders…':libraryImportNotice.text;
 notice.classList.toggle('error',!busy&&libraryImportNotice.error);
}
async function relink(a){try{const updated=await linkAsset(a);if(updated)change(()=>{project.assets=project.assets.map(x=>x.id===a.id?updated:x);});else{relinkId=a.id;$('relink-input').click();}status(updated?'Local file linked and embedded copy updated.':'Select the local file to link.');}catch(e){if(e.name!=='AbortError')status(e.message,true);}}
async function refresh(a){try{const updated=await refreshAsset(a);change(()=>{project.assets=project.assets.map(x=>x.id===a.id?updated:x);});status('Embedded copy updated from the authorized local file.');}catch(e){status(e.message,true);}}
async function locate(a){
 if(locatingAsset)return;
 locatingAsset=true;for(const button of document.querySelectorAll('[data-action="locate"]'))button.disabled=true;
 status(`Locating ${a.name}… Finding its source file.`);
 try{const result=await locateAsset(a);status(result==='cancelled'?'Locate cancelled.':`Asked Finder to show ${a.name}.`);}
 catch(error){status(error.message,true);}
 finally{locatingAsset=false;for(const button of document.querySelectorAll('[data-action="locate"]'))button.disabled=false;}
}
$('add-images').onclick=async()=>{const target=importTarget();try{const result=await pickImages();if(result===null)$('file-input').click();else await importResult(result,undefined,target);}catch(e){status(e.message,true);}};
$('add-html').onclick=()=>$('html-file-input').click();
$('html-file-input').onchange=async e=>{const target=importTarget();status('Importing HTML charts…');await importResult(await importFiles([...e.target.files]),undefined,target);e.target.value='';};
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
function marqueeCurrent(){return gesture.project===project&&gesture.slideId===project.activeSlideId&&gesture.revision===editRevision;}
function releaseGesture(){
 const ended=gesture;gesture=null;$('workspace').classList.remove('selecting');
 if($('stage').hasPointerCapture(ended.pointerId))$('stage').releasePointerCapture(ended.pointerId);
 return ended;
}
function finishMarquee(cancel=false,redraw=true){
 const current=marqueeCurrent(),ended=releaseGesture();
 if(cancel&&current)selected=new Set(ended.selection);
 if(redraw)render();
}
function updateMarquee(e){
 if(!marqueeCurrent()){finishMarquee(true);return;}
 if(!gesture.moved&&Math.hypot(e.clientX-gesture.clientX,e.clientY-gesture.clientY)<3)return;
 gesture.moved=true;gesture.current=point(e);$('workspace').classList.add('selecting');
 const ids=enclosedItemIds(slide().items,selectionRect(gesture.start,gesture.current));
 const next=new Set([...(gesture.additive?gesture.selection:[]),...ids]);
 const selectionChanged=selected.size!==next.size||[...next].some(id=>!selected.has(id));
 selected=next;renderStage();
 if(selectionChanged){renderLayers();renderInspector();renderToolbar();syncAssetSelection();}
}
$('workspace').onpointerdown=e=>{
 if(e.target.closest('#html-chart-overlay'))return;
 if(e.button!==0||gesture)return;$('workspace').focus({preventScroll:true});flushText();const id=e.target.closest('[data-item]')?.dataset.item;lastPointerItem=id;
 if(!id){
  const start=point(e);lastTap=null;
  gesture={mode:'select',pointerId:e.pointerId,start,current:start,clientX:e.clientX,clientY:e.clientY,selection:new Set(selected),additive:e.shiftKey,moved:false,project,slideId:project.activeSlideId,revision:editRevision};
  if(!e.shiftKey)selected.clear();render();$('stage').setPointerCapture(e.pointerId);e.preventDefault();return;
 }
 const i=byId(id);if(e.shiftKey&&!e.target.dataset.resize){selected.has(id)?selected.delete(id):selected.add(id);render();return;}
 if(!selected.has(id))selected=new Set([id]);renderInspector();renderLayers();renderToolbar();renderStage();syncAssetSelection(isMediaItem(i)?i.assetId:undefined);
 if(i.locked)return;
 const start=point(e),items=chosen().filter(i=>!i.locked),before=snapshot();const edit=i.type==='text'&&lastTap?.id===id&&e.timeStamp-lastTap.time<500&&Math.abs(start.x-lastTap.x)+Math.abs(start.y-lastTap.y)<5;lastTap={id,time:e.timeStamp,...start};gesture={mode:e.target.dataset.resize?'resize':'move',pointerId:e.pointerId,handle:e.target.dataset.resizeHandle||'se',id,start,items:items.map(i=>({...i})),before,moved:false,edit};
 $('stage').setPointerCapture(e.pointerId);e.preventDefault();
};
$('workspace').onpointermove=e=>{
 if(!gesture||e.pointerId!==gesture.pointerId)return;
 if(gesture.mode==='select'){updateMarquee(e);return;}
 const p=point(e),dx=p.x-gesture.start.x,dy=p.y-gesture.start.y;if(Math.abs(dx)+Math.abs(dy)<.2)return;gesture.moved=true;
 if(gesture.mode==='move'){for(const orig of gesture.items){const i=byId(orig.id);i.x=orig.x+dx;i.y=orig.y+dy;}}
 else{const orig=gesture.items.find(i=>i.id===gesture.id);
 Object.assign(byId(orig.id),resizeItem(orig,gesture.handle,dx,dy,{free:e.shiftKey}));
 }renderStage();
};
function endGesture(e){
 if(!gesture||e.pointerId!==gesture.pointerId)return;
 if(gesture.mode==='select'){
  if(e.type==='pointerup')updateMarquee(e);
  if(gesture)finishMarquee(e.type!=='pointerup');return;
 }
 const edit=gesture.edit&&!gesture.moved;if(gesture.moved)record(gesture.before);releaseGesture();render();if(edit){$('text-content')?.focus();$('text-content')?.select();}
}
$('workspace').onpointerup=endGesture;$('workspace').onpointercancel=endGesture;
$('stage').onlostpointercapture=e=>{if(gesture?.mode==='select'&&e.pointerId===gesture.pointerId)finishMarquee(true);};
window.addEventListener('blur',()=>{if(gesture?.mode==='select')finishMarquee(true);});
$('stage').ondblclick=e=>{const i=byId(e.target.closest('[data-item]')?.dataset.item||lastPointerItem);if(i?.type==='html'){openHTMLChart(i);return;}if(i?.type==='text'&&!i.locked){selected=new Set([i.id]);render();$('text-content')?.focus();$('text-content')?.select();}};
$('add-text').onclick=()=>{change(()=>{const i={...base('text',60,50,260,44),name:'Text',text:'Double-click to edit',fontFamily:'Arial',fontSize:28,fontWeight:400,fontStyle:'normal',color:'#20212b',align:'left'};slide().items.push(i);selected=new Set([i.id]);});$('text-content').focus();$('text-content').select();};
$('add-rect').onclick=()=>change(()=>{const i={...base('rect',80,80,160,100),fill:'#ffffff',stroke:'#252735',strokeWidth:2};slide().items.push(i);selected=new Set([i.id]);});
$('add-line').onclick=()=>change(()=>{const i={...base('line',80,80,160,1),stroke:'#252735',strokeWidth:2};slide().items.push(i);selected=new Set([i.id]);});
$('undo').onclick=()=>{const keepSlideFocus=slideClipboardTarget(document.activeElement);flushText();if(!undoStack.length)return;redoStack.push(snapshot());project=undoStack.pop();restoreSlideSelection(project);selected.clear();changed();render();fit();if(keepSlideFocus)focusCurrentSlide();status('Undone');};
$('redo').onclick=()=>{const keepSlideFocus=slideClipboardTarget(document.activeElement);flushText();if(!redoStack.length)return;undoStack.push(snapshot());project=redoStack.pop();restoreSlideSelection(project);selected.clear();changed();render();fit();if(keepSlideFocus)focusCurrentSlide();status('Redone');};
$('duplicate').onclick=()=>{if(!selected.size)return;change(()=>{const copies=chosen().filter(i=>!i.locked).map(i=>({...i,...(i.crop?{crop:{...i.crop}}:{}),id:uid(),name:i.name+' copy',x:i.x+20,y:i.y+20}));slide().items.push(...copies);selected=new Set(copies.map(i=>i.id));});};
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
function renderAutosave(){
 const indicator=$('autosave-status'),toggle=$('autosave-toggle');
 toggle.checked=autosaveEnabled;
 let state='local',label='Local draft',detail='Use Save once to choose a project file. Browser drafts stay in this browser and can be removed by clearing site data.';
 if(autosaveWriting){state='saving';label='Saving…';detail=`Saving to ${projectFileName}.`;}
 else if(dirty&&draftError){state='draft-error';label='Draft not saved';detail=draftError+' Use Save to keep a project file.';}
 else if(autosaveEnabled&&autosaveError){({state,label,detail}=autosaveError);}
 else if(!autosaveEnabled){state='off';label='AutoSave off';detail='File AutoSave is off. Local draft recovery remains on; use Save to update the file.';}
 else if(projectFileHandle&&!dirty){state='saved';label='Saved to file';detail=lastFileSave?`Saved to ${projectFileName} at ${lastFileSave.toLocaleTimeString()}.`:`File: ${projectFileName}. Changes will save automatically.`;}
 else if(dirty&&(projectFileHandle||draftRevision!==editRevision)){state='pending';label='Changes pending';detail=projectFileHandle?`Changes will save to ${projectFileName} after you pause editing.`:'Saving a local draft in this browser…';}
 else if(draftRevision===editRevision){label='Saved locally';}
 if(projectFileHandle&&!projectFilePersistent)detail+=' File access is remembered for this session only.';
 indicator.dataset.state=state;indicator.textContent=label;indicator.title=detail;
}
function scheduleAutosave(){
 clearTimeout(autosaveTimer);
 if(!autosaveEnabled||!dirty||!projectFileHandle||autosaveError)return;
 const epoch=projectEpoch;
 autosaveTimer=setTimeout(()=>{
  if(epoch!==projectEpoch)return;
  if(fileOperation||gesture){scheduleAutosave();return;}
  void saveProject(false,{automatic:true});
 },AUTOSAVE_DELAY);
}
$('autosave-toggle').onchange=e=>{
 autosaveEnabled=e.target.checked;
 try{localStorage.setItem('figure-editor-autosave',autosaveEnabled?'on':'off');}catch{ /* The setting still applies for this session. */ }
 if(autosaveEnabled)autosaveError=null;
 scheduleAutosave();renderAutosave();
};
function renderFileActions(){
 for(const id of ['save-project','save-project-as','open-project','new-project','demo-project','import-pptx'])$(id).disabled=fileOperation;
 const destination=projectFileHandle?`Save to ${projectFileName}`:typeof globalThis.showSaveFilePicker==='function'?'Choose where to save this project':'Download project copy (direct saving is unavailable in this browser)';
 $('save-project').title=destination+' (⌘ / Ctrl + S)'+(projectFilePersistent?'':' · File access is remembered for this session only');
 $('save-project').setAttribute('aria-busy',String(fileOperation));
 renderAutosave();
}
async function saveProject(saveAs=false,{automatic=false}={}){
 if(fileOperation)return;
 if(automatic&&(!autosaveEnabled||!dirty||!projectFileHandle||autosaveError))return;
 if(!automatic)flushText();
 clearTimeout(autosaveTimer);
 const savedProject=snapshot(),epoch=projectEpoch,revision=editRevision;
 fileOperation=true;autosaveWriting=automatic;renderFileActions();if(!automatic)status('Saving project…');
 try{
  const result=await writeProjectFile(savedProject,{handle:projectFileHandle,name:saveAs?filename()+'.figure.json':projectFileName||filename()+'.figure.json',saveAs,automatic});
  if(epoch!==projectEpoch)return;
  projectFileHandle=result.handle;projectFileName=result.name;
  // Drag geometry changes before its undo/revision entry is committed on pointerup.
  dirty=result.downloaded||revision!==editRevision||Boolean(gesture?.moved&&gesture.mode!=='select');
  autosaveError=null;if(!result.downloaded)lastFileSave=new Date();
  if(!automatic)status(result.downloaded?'Project download started. This browser cannot save back to the original file. Use Chrome or Edge for direct Save.':`Saved to ${projectFileName}.${!dirty?'':autosaveEnabled?' Newer changes will save automatically.':' Newer changes are still unsaved; use Save again.'}`);
  await saveDraft();
 }catch(error){
  if(epoch!==projectEpoch)return;
  if(automatic)autosaveError=error.name==='NotAllowedError'
   ?{state:'permission',label:'Click Save to allow',detail:'AutoSave needs write access. Click Save to grant permission. Local draft recovery remains on.'}
   :{state:'error',label:'AutoSave failed',detail:`Could not save to ${projectFileName}: ${error.message} Click Save to retry; local draft recovery remains on.`};
  else status(error.name==='AbortError'?'Save canceled. Your changes are still in the editor.':`Could not save project: ${error.message}`,error.name!=='AbortError');
 }finally{fileOperation=false;autosaveWriting=false;renderFileActions();scheduleAutosave();}
}
$('save-project').onclick=()=>saveProject();
$('save-project-as').onclick=()=>saveProject(true);
function replaceProject(p,{handle=null,name=''}={}){
 const next=validateDeck(p);
 clearTimeout(autosaveTimer);clearTimeout(draftTimer);
 project=next;projectEpoch++;editRevision=0;projectFileHandle=handle;projectFileName=name;projectFilePersistent=true;
 autosaveError=null;draftError=null;draftRevision=-1;lastFileSave=null;
 resetSlideSelection();
 selected.clear();undoStack=[];redoStack=[];pendingText=null;dirty=false;collapsedAssetFolders.clear();$('asset-list').replaceChildren();libraryImportNotice={hidden:true,text:'',error:false};renderLibraryImportNotice();render();fit();saveDraft();
}
$('new-project').onclick=()=>{if(fileOperation)return;if(dirty&&!confirm('Creating a new project will replace the current local draft. Save your project first to keep a copy. Continue?'))return;replaceProject(createDeck());status('New project created. Use Save to choose its file location.');};
$('open-project').onclick=async()=>{
 if(fileOperation)return;
 if(typeof globalThis.showOpenFilePicker!=='function'){$('project-input').click();return;}
 fileOperation=true;renderFileActions();
 try{
  const opened=await pickProjectFile();
  if(dirty&&!confirm('Opening a project will replace the current local draft. Continue?'))return;
  replaceProject(opened.project,opened);status(`Opened ${opened.name}. Save will update this file.`);
 }catch(error){
  if(error.name==='SecurityError'){$('project-input').click();}
  else if(error.name!=='AbortError')status('Could not open project: '+error.message,true);
 }finally{fileOperation=false;renderFileActions();}
};
$('project-input').onchange=async e=>{
 if(fileOperation){e.target.value='';return;}
 const file=e.target.files[0];if(!file)return;
 fileOperation=true;renderFileActions();
 try{
  const opened=await readProjectFile(file);
  if(dirty&&!confirm('Opening a project will replace the current local draft. Continue?'))return;
  replaceProject(opened,{name:file.name});status('Editable project opened. Save will ask for a location when supported; otherwise it downloads a copy.');
 }catch(error){status('Could not open project: '+error.message,true);}
 finally{e.target.value='';fileOperation=false;renderFileActions();}
};
$('source-manifest').onclick=()=>downloadBlob(new Blob([JSON.stringify(deckSourceManifest(project),null,2)],{type:'application/json'}),filename()+'.sources.json');
let exporting=false;
function exportInfo(){
 if(exporting)return;
 const format=$('export-format').value,report=format==='html',ppt=format==='pptx',png=format==='png',pdf=format==='pdf',dpi=Number($('export-dpi').value);
 $('export-title').textContent=ppt?'Export as PPT':report?'Export HTML report':'Export current slide';
 $('export-slide-name').textContent=report||ppt?`All ${project.slides.length} slide${project.slides.length===1?'':'s'} · ${project.name}`:`Slide ${project.slides.indexOf(slide())+1} of ${project.slides.length}: ${slide().name}`;
 $('export-dpi').disabled=!(png||pdf);
 $('export-dpi-label').textContent=pdf?'PDF shadow resolution':'PNG resolution';
 $('export-submit').disabled=false;
 if(ppt){
  try{
   const layout=pptxLayout(project);
   $('export-info').textContent=`PowerPoint (.pptx) · ${Number(layout.widthInches.toFixed(2))} × ${Number(layout.heightInches.toFixed(2))} in. All slides, with editable text, shapes, separate images, and embedded MP4 videos (click to play in Slide Show). ${layout.mixedSizes?'Different canvas sizes are fitted proportionally and centered on the first slide’s page size. ':''}${layout.scale!==1?'The first canvas is scaled to fit PowerPoint’s size limits. ':''}Fonts are not embedded.`;
  }catch(e){$('export-info').textContent=e.message;$('export-submit').disabled=true;}
  return;
 }
 $('export-info').textContent=report?'One self-contained HTML file with all slides and a contents list. Open it offline in a browser or print it. Text and shapes remain vector; images are embedded. The report is read-only, and fonts are not embedded.':pdf?`Single-page PDF · ${Number((slide().canvas.width*25.4/96).toFixed(2))} × ${Number((slide().canvas.height*25.4/96).toFixed(2))} mm. Text and shapes remain vector; text becomes outlines and is not searchable. Images remain raster. ${dpi} DPI applies only to images with shadows. Text outlines require the local macOS server.`:png?`${Math.round(slide().canvas.width*dpi/96)} × ${Math.round(slide().canvas.height*dpi/96)} px · ${dpi} DPI. All content is rasterized with transparency preserved. Higher DPI does not add detail to source images.`:'SVG keeps editor text and shapes as vectors. Images, including imported SVGs, are embedded rasters. Fonts are not embedded; recipients need the same fonts installed.';
 if(project.slides.some(page=>page.items.some(i=>i.type==='video'&&!i.hidden)))$('export-info').textContent+=' Videos appear as static poster frames in this format.';
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
   const usedAssets=new Set(p.items.filter(isMediaItem).map(i=>i.assetId));p.assets=p.assets.filter(a=>usedAssets.has(a.id));
   blob=format==='png'?await exportPNG(p,Number($('export-dpi').value)):format==='pdf'?await exportPDF(p,Number($('export-dpi').value)):new Blob([projectToSVG(p)],{type:'image/svg+xml'});
  }
  if(blob.size>240*1024*1024)throw new Error('Export exceeds 240 MB. Use fewer slides or smaller source images.');
  downloadBlob(blob,exportName);$('export-dialog').close();
  status(format==='pptx'?`PowerPoint exported with all ${project.slides.length} slides. Text, shapes, and images can be edited in PowerPoint. Embedded videos play when clicked in Slide Show.`:format==='html'?`HTML report exported with all ${project.slides.length} slides. Open the file offline; save your project to keep editing.`:`Current slide exported as ${format.toUpperCase()}. Save project to keep all slides editable.`);
 }catch(e){$('export-info').textContent='Export failed: '+e.message;status('Export failed: '+e.message,true);}finally{exporting=false;button.disabled=false;button.textContent='Export file';$('export-format').disabled=$('export-cancel').disabled=false;$('export-dpi').disabled=!['png','pdf'].includes($('export-format').value);}
};
const editingInput = target => /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName)||target?.isContentEditable;
const nativeClipboard = e => e.defaultPrevented||editingInput(e.target)||$('export-dialog').open||cropEditor.open||$('video-dialog').open;
function slideClipboardTarget(target){
 const focused=target===document||target===document.body?document.activeElement:target;
 return !!focused?.closest?.('#slides-panel');
}
function focusCurrentSlide(){
 const card=$('slide-list').querySelector('[aria-current="true"]');
 card?.focus({preventScroll:true});card?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function writeSlideToClipboard(e){
 if(nativeClipboard(e)||!e.clipboardData)return;
 ++clipboardWriteId;
 try{
  flushText();const payload=createSlidesClipboard(project,selectedSlideIds),text=encodeSlides(payload);
  e.preventDefault();e.clipboardData.setData('text/plain',text);
  try{e.clipboardData.setData(payload.slides.length===1?SLIDE_CLIPBOARD_MIME:SLIDES_CLIPBOARD_MIME,text);}catch{}
  lastPaste=null;status(copiedSlidesMessage(payload));
 }catch(error){e.preventDefault();status('Copy slide failed: '+error.message,true);}
}
function copiedSlidesMessage(payload){return payload.slides.length===1?`Slide copied: ${payload.slides[0].name}. Paste to insert it after the current slide.`:`${payload.slides.length} slides copied. Paste to insert them together after the current slide.`;}
function insertClipboardSlide(payload){
 const applied=change(()=>{const pages=pasteSlides(project,payload);selectedSlideIds=new Set(pages.map(page=>page.id));slideSelectionAnchor=pages[0].id;selected.clear();lastTap=null;lastPointerItem=null;});
 if(applied){lastPaste=null;fit();focusCurrentSlide();status(payload.slides.length===1?`Pasted slide: ${slide().name}. Use Undo to remove it.`:`Pasted ${payload.slides.length} slides in order. Use Undo to remove the whole group.`);}
 return applied;
}
$('copy-slide').onclick=async()=>{
 const writeId=++clipboardWriteId;
 try{
  flushText();const payload=createSlidesClipboard(project,selectedSlideIds),text=encodeSlides(payload);
  if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
  else if(navigator.clipboard?.write&&globalThis.ClipboardItem)await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'})})]);
  else{
   focusCurrentSlide();
   if(!document.execCommand('copy'))throw new Error('Select a slide and press Cmd/Ctrl+C.');
   return;
  }
  if(writeId===clipboardWriteId){lastPaste=null;status(copiedSlidesMessage(payload));}
 }catch(error){if(writeId===clipboardWriteId)status('Copy slide failed. Select a slide and press Cmd/Ctrl+C. '+error.message,true);}
};
$('paste-slide').onclick=async()=>{
 if(readingSlideClipboard)return;
 const target=importTarget();readingSlideClipboard=true;renderSlides();
 try{
  let text;
  if(navigator.clipboard?.readText)text=await navigator.clipboard.readText();
  else if(navigator.clipboard?.read){
   const items=await navigator.clipboard.read(),item=items.find(value=>value.types.includes('text/plain'));
   text=item?await (await item.getType('text/plain')).text():'';
  }else throw new Error('Select a slide and press Cmd/Ctrl+V to paste.');
  if(target.project!==project||target.slideId!==project.activeSlideId){status('Slide paste cancelled because the target project or slide changed. Paste again.',true);return;}
  const payload=decodeSlides(text);
  if(!payload)throw new Error('Copy a slide in Figure Editor first.');
  insertClipboardSlide(payload);
 }catch(error){status('Could not paste slide. Use Cmd/Ctrl+V if clipboard access is unavailable. '+error.message,true);}
 finally{readingSlideClipboard=false;renderSlides();}
};
async function clipboardHTML(png){
 const blob=await png;
 const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
 return new Blob([`<img src="${url}" alt="Figure Editor selection">`],{type:'text/html'});
}
// Native events support both keyboard shortcuts and the browser's Edit menu.
function writeSelectionToClipboard(e,cut=false){
 if(nativeClipboard(e)||!e.clipboardData||!selected.size)return;
 const writeId=++clipboardWriteId;
 const fail=error=>{
  if(writeId!==clipboardWriteId)return;
  status(`${cut?'Cut':'Copy'} failed. ${cut?'Original objects were kept. ':''}The browser could not write to the clipboard; try again or use Export. ${error.message}`,true);
 };
 try{
  flushText();
  const ids=cut?new Set(chosen().filter(item=>!item.locked).map(item=>item.id)):new Set(selected);
  if(cut&&!ids.size){e.preventDefault();status('Locked objects cannot be cut. Unlock them first.');return;}
  const sourceProject=project,sourceSlideId=project.activeSlideId;
  const selection=createSelection(slideProject(project),ids);
  if(!selection)return;
  const text=encodeSelection(selection);
  e.preventDefault();lastPaste=null;
  const complete=(legacy=false)=>{
   if(writeId!==clipboardWriteId)return;
   if(cut){
    // Async encoding may finish after a selection, slide, asset, or project edit.
    // Remove only the captured originals, and only if their copied content still matches.
    const source=project===sourceProject&&project.slides.find(page=>page.id===sourceSlideId);
    const current=source&&createSelection(slideProject(project,sourceSlideId),ids);
    if(!current||encodeSelection(current)!==text){
     status('Copied. Original objects were kept because the source changed during cut.');return;
    }
    if(!change(()=>{source.items=source.items.filter(item=>!ids.has(item.id));selected=new Set([...selected].filter(id=>!ids.has(id)));}))return;
   }
   status(legacy?`Objects ${cut?'cut':'copied'} for this editor. This browser cannot copy images to other apps; use Chrome or Edge, or Export.`:cut?'Cut. Paste into a slide or another app. Use Undo to restore the original objects.':'Copied. Paste into a slide to keep objects editable, or into another app as an image.');
  };
  if(selection.assets.some(asset=>asset.mime==='text/html'&&!asset.hasSnapshot)){
   e.clipboardData.setData(CLIPBOARD_MIME,text);e.clipboardData.setData('text/plain',text);complete();
   status(`Editable objects ${cut?'cut':'copied'}. Save a chart snapshot before copying an image to another app.`);
  }else if(navigator.clipboard?.write&&globalThis.ClipboardItem){
   // Use one writer: committing copy-event data while an async write is pending
   // changes Safari's pasteboard revision and rejects the async image write.
   // Keep the editable payload in the same ClipboardItem as the PNG instead.
   status(cut?'Cutting… Original objects stay until the clipboard is ready.':'Copying image and editable objects…');
   const png=selectionToPNG(selection),html=clipboardHTML(png);
   // Avoid unhandled rejections if the browser rejects ClipboardItem immediately.
   png.catch(()=>{});html.catch(()=>{});
   try{
    const pending=navigator.clipboard.write([new ClipboardItem({'image/png':png,'text/html':html,'text/plain':new Blob([text],{type:'text/plain'})})]);
    pending.then(()=>complete()).catch(fail);
   }catch(error){fail(error);}
  }else{
   // Legacy fallback is used only when there is no competing async writer.
   e.clipboardData.setData('text/plain',text);
   try{e.clipboardData.setData(CLIPBOARD_MIME,text);}catch{}
   complete(true);
  }
 }catch(error){fail(error);}
}
document.addEventListener('copy',e=>slideClipboardTarget(e.target)?writeSlideToClipboard(e):writeSelectionToClipboard(e));
document.addEventListener('cut',e=>{if(!slideClipboardTarget(e.target))writeSelectionToClipboard(e,true);});
document.addEventListener('paste',async e=>{
 if(nativeClipboard(e)||!e.clipboardData)return;
 const data=e.clipboardData;
 try{
  const slideText=data.getData(SLIDES_CLIPBOARD_MIME)||data.getData(SLIDE_CLIPBOARD_MIME),slidePayload=decodeSlides(slideText||data.getData('text/plain'));
  if(slideText&&!slidePayload)throw new Error('The Figure Editor slide clipboard data is invalid. Copy the slide again.');
  if(slidePayload){e.preventDefault();insertClipboardSlide(slidePayload);return;}
  const custom=data.getData(CLIPBOARD_MIME),text=custom||data.getData('text/plain');
  const selection=decodeSelection(text);
  if(custom&&!selection)throw new Error('The Figure Editor clipboard data is invalid. Copy the objects again.');
  if(selection){
   e.preventDefault();
   const count=lastPaste?.text===text&&lastPaste.project===project&&lastPaste.slideId===project.activeSlideId?lastPaste.count+1:1;
   const applied=change(()=>{selected=new Set(pasteSelection(project,selection,20*count));});
   if(applied){lastPaste={text,project,slideId:project.activeSlideId,count};$('workspace').focus({preventScroll:true});status(`Pasted ${selected.size} object${selected.size===1?'':'s'} into ${slide().name}.`);}
   return;
  }
  // Capture File objects synchronously: clipboard access ends with this event.
  const files=[...data.files];
  if(!files.length)for(const item of data.items||[]){if(item.kind==='file'){const file=item.getAsFile();if(file)files.push(file);}}
  const images=files.filter(file=>file.type.startsWith('image/')||/\.(png|jpe?g|webp|svg)$/i.test(file.name));
  if(!images.length)return;
  e.preventDefault();const target=importTarget();lastPaste=null;$('workspace').focus({preventScroll:true});
  status('Pasting clipboard images…');
  await importResult(await importFiles(images),undefined,target);
 }catch(error){e.preventDefault();status('Could not paste: '+error.message,true);}
});
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented)return;
 if(e.key==='Escape'&&activeHTMLChart){e.preventDefault();closeHTMLChart();$('workspace').focus({preventScroll:true});return;}
 if(cropEditor.open||$('video-dialog').open)return;
 if(gesture?.mode==='select'){if(e.key==='Escape')finishMarquee(true);e.preventDefault();return;}
 const input=editingInput(e.target),mod=e.metaKey||e.ctrlKey;
 if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();if(!e.repeat)$(e.shiftKey?'save-project-as':'save-project').click();return;}
 if(input||$('export-dialog').open)return;
 if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'redo':'undo').click();}
 else if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();$('redo').click();}
 else if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();$(slideClipboardTarget(e.target)?'duplicate-slide':'duplicate').click();}
 else if(mod&&e.key.toLowerCase()==='a'){
  e.preventDefault();
  if(slideClipboardTarget(e.target)){selectedSlideIds=new Set(project.slides.map(page=>page.id));selected.clear();render();focusCurrentSlide();status(`${selectedSlideIds.size} slides selected.`);}
  else{selected=new Set(slide().items.filter(i=>!i.hidden).map(i=>i.id));render();$('workspace').focus({preventScroll:true});}
 }
 else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();$(slideClipboardTarget(e.target)?'delete-slide':'delete-item').click();}
 else if(e.key==='Escape'){selected.clear();if(slideClipboardTarget(e.target))resetSlideSelection();render();}
 else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&selected.size){e.preventDefault();const n=e.shiftKey?10:1;change(()=>{for(const i of chosen().filter(i=>!i.locked)){if(e.key==='ArrowLeft')i.x-=n;if(e.key==='ArrowRight')i.x+=n;if(e.key==='ArrowUp')i.y-=n;if(e.key==='ArrowDown')i.y+=n;}});}
});
async function openDraftDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('figure-editor-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});}
function writeDraftRecord(savedProject,file){
 return new Promise((resolve,reject)=>{
  const tx=draftDb.transaction('drafts','readwrite'),store=tx.objectStore('drafts');
  tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Draft transaction aborted.'));
  try{store.put(savedProject,'current');store.put(file,'current-file');}
  catch(error){tx.abort();reject(error);}
 });
}
function saveDraft(){
 clearTimeout(draftTimer);
 // Capture together before awaiting storage; keep older autosaves ahead of newer ones.
 const savedProject=snapshot(),file={handle:projectFileHandle,name:projectFileName,dirty},epoch=projectEpoch,revision=editRevision;
 draftWrites=draftWrites.then(async()=>{
  draftDb??=await openDraftDB();
  try{
   await writeDraftRecord(savedProject,file);
   if(epoch===projectEpoch&&file.handle===projectFileHandle)projectFilePersistent=true;
  }catch(error){
   if(error.name!=='DataCloneError'||!file.handle)throw error;
   await writeDraftRecord(savedProject,{...file,handle:null});
   if(epoch===projectEpoch&&file.handle===projectFileHandle)projectFilePersistent=false;
  }
  if(epoch===projectEpoch){draftRevision=revision;draftError=null;}
  renderFileActions();
 }).catch(error=>{if(epoch===projectEpoch){draftError=error.message;renderAutosave();status('Could not save the local draft. Use Save to keep a project file. '+error.message,true);}});
 return draftWrites;
}
async function loadDraft(){
 const epoch=projectEpoch,revision=editRevision;
 try{
  draftDb=await openDraftDB();
  const store=draftDb.transaction('drafts').objectStore('drafts');
  const read=key=>new Promise((resolve,reject)=>{const req=store.get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  const [savedProject,file]=await Promise.all([read('current'),read('current-file')]);
  if(!savedProject||epoch!==projectEpoch||revision!==editRevision)return;
  project=validateDeck(savedProject);projectEpoch++;resetSlideSelection();
  projectFileHandle=file?.handle?.kind==='file'&&typeof file.handle.createWritable==='function'?file.handle:null;
  projectFileName=typeof file?.name==='string'?file.name:'';
  dirty=typeof file?.dirty==='boolean'?file.dirty:true;
  draftRevision=editRevision;
  render();fit();status(projectFileHandle?`Local draft restored. Save will update ${projectFileName}.`:'Local draft restored. Use Save to choose a project file location.');
 }catch{draftError='Local drafts are unavailable.';renderAutosave();status('Local drafts are unavailable. Use Save to keep a project file.');}
}
$('demo-project').onclick=async()=>{
 if(fileOperation)return;
 if(dirty&&!confirm('The example will replace the current local draft. Continue?'))return;
 const revision=editRevision;
 fileOperation=true;renderFileActions();
 try{const {makeDemo}=await import('./demo.js');const example=await makeDemo();if(revision!==editRevision&&dirty&&!confirm('Replace the current draft with the example?'))return;replaceProject(example);status('Example loaded. Use Save to choose its file location.');}catch(e){status(e.message,true);}
 finally{fileOperation=false;renderFileActions();}
};
render();initWindows({onLayoutChange:fit});requestAnimationFrame(fit);await loadDraft();fileOperation=false;renderFileActions();scheduleAutosave();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){if(dirty)void saveDraft();if(!fileOperation&&!gesture)void saveProject(false,{automatic:true});}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
