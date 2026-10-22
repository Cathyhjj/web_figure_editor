import { mirrorSVG, svgDataURL, serializeSVG, SVG_NS } from './svg-vector.js';
/** Local PPTX conversion and explicit, previewed single-slide insertion. */
import { uid, validateProject, projectToSVG } from './core.js';
import { validateDeck } from './deck.js';
import { importFiles } from './assets.js?v=locate-1';
import { shadowBounds } from './shadow.js';

const launchHint = 'PPTX import needs the local Figure Editor server. Restart with start.command (or npm start), then reload this page.';
const MAX_BYTES = 100 * 1024 * 1024;
const styleKeys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color'];
const sameStyle = (a, b) => styleKeys.every(k => a[k] === b[k]) && a.baseline === b.baseline && JSON.stringify(a.shadow) === JSON.stringify(b.shadow);
function textStyle(run) { return { ...Object.fromEntries(styleKeys.map(key => [key, run[key]])), ...(run.shadow ? {shadow:{...run.shadow}} : {}) }; }

function canvasMeasure() {
  const context = document.createElement('canvas').getContext('2d');
  return (text, run) => {
    context.font = `${run.fontStyle} ${run.fontWeight} ${run.fontSize}px ${JSON.stringify(run.fontFamily)}, Arial, sans-serif`;
    const metrics = context.measureText(text);
    return { width: metrics.width, ascent: metrics.fontBoundingBoxAscent || run.fontSize * .9,
      descent: metrics.fontBoundingBoxDescent || run.fontSize * .2 };
  };
}

function positionText(block, item, x, y) {
  const angle = block.rotation * Math.PI / 180, cs = Math.cos(angle), sn = Math.sin(angle);
  const cx = x + item.width / 2 - block.width / 2, cy = y + item.height / 2 - block.height / 2;
  return { ...item, id: uid(), type: 'text', name: block.name, rotation: block.rotation,
    ...(block.shadow && !item.shadow ? {shadow:{...block.shadow}} : {}),
    opacity: block.opacity, locked: false, hidden: false,
    x: block.x + block.width / 2 + cx * cs - cy * sn - item.width / 2,
    y: block.y + block.height / 2 + cx * sn + cy * cs - item.height / 2 };
}

/** Resolve wrapping before insertion; SVG, PNG and PPT exports then share explicit lines. */
export function layoutTextBlock(block, measure = canvasMeasure()) {
  const paragraphs = [];
  let height = 0;
  const spacingValue = (setting, size, fallback = 0) => !setting ? fallback
    : setting.kind === 'spcPct' ? size * setting.value / 100000 : setting.value / 100 * 96 / 72 * block.scaleY;
  for (const paragraph of block.paragraphs) {
    const width = Math.max(1, block.width - block.insets.left - block.insets.right - paragraph.marginLeft - paragraph.marginRight);
    const lines = [];
    let line = [], used = 0, firstLine = true;
    const flush = () => { lines.push({ fragments: line, width: used, indent: firstLine ? paragraph.indent : 0 }); line = []; used = 0; firstLine = false; };
    const add = (text, run) => {
      const measured = measure(text, run);
      const previous = line.at(-1);
      if (previous && sameStyle(previous.run, run)) {
        used -= previous.width; previous.text += text; previous.width = measure(previous.text, run).width; used += previous.width;
      } else { line.push({ text, run, ...measured }); used += measured.width; }
    };
    for (const run of paragraph.runs) {
      for (let token of run.text.split(/(\n|[^\S\n]+)/u).filter(Boolean)) {
        if (token === '\n') { flush(); continue; }
        let available = Math.max(1, width - (firstLine ? paragraph.indent : 0));
        if (block.wrap && used && used + measure(token, run).width > available && token.trim()) {
          flush(); available = width;
        }
        // Break long words/CJK without discarding any source characters.
        if (block.wrap && token.trim() && measure(token, run).width > available) {
          for (const character of token) {
            if (used && used + measure(character, run).width > Math.max(1, width - (firstLine ? paragraph.indent : 0))) flush();
            add(character, run);
          }
        } else add(token, run);
      }
    }
    if (line.length || !lines.length || paragraph.runs.at(-1)?.text.endsWith('\n')) flush();
    const size = Math.max(...paragraph.runs.map(run => run.fontSize));
    height += spacingValue(paragraph.spacing.spcBef, size);
    const top = height;
    for (const line of lines) {
      line.ascent = Math.max(...(line.fragments.length ? line.fragments : [{ run: paragraph.runs[0], ...measure('M', paragraph.runs[0]) }]).map(f => f.ascent + Math.max(0, f.run.baseline * size)));
      line.size = line.fragments.length ? Math.max(...line.fragments.map(f => f.run.fontSize)) : size;
      line.step = Math.max(1, spacingValue(paragraph.spacing.lnSpc, line.size, line.size * 1.2));
      line.top = height; height += line.step;
    }
    paragraphs.push({ paragraph, width, lines, top });
    height += spacingValue(paragraph.spacing.spcAft, size);
  }
  const innerHeight = block.height - block.insets.top - block.insets.bottom;
  const offset = block.insets.top + (block.anchor === 'ctr' ? Math.max(0, (innerHeight-height)/2) : block.anchor === 'b' ? Math.max(0, innerHeight-height) : 0);
  const items = [];
  for (const { paragraph, width, lines } of paragraphs) {
    const style = paragraph.runs[0];
    const simple = paragraph.runs.every(run => sameStyle(run, style) && !run.baseline)
      && !paragraph.indent && lines.every(line => Math.abs(line.step - style.fontSize * 1.2) < .001);
    const x = block.insets.left + paragraph.marginLeft;
    if (simple) {
      const item = { ...textStyle(style), text: lines.map(l => l.fragments.map(f => f.text).join('')).join('\n'),
        width, height: Math.max(.01, lines.length * style.fontSize * 1.2), align: paragraph.align };
      items.push(positionText(block, item, x, offset+lines[0].top+lines[0].ascent-style.fontSize));
    } else for (const line of lines) {
      let cursor = x + line.indent + (paragraph.align === 'center' ? (width-line.indent-line.width)/2 : paragraph.align === 'right' ? width-line.indent-line.width : 0);
      for (const fragment of line.fragments) {
        const item = { ...textStyle(fragment.run), text: fragment.text, width: Math.max(.01, fragment.width), height: fragment.run.fontSize*1.2, align: 'left' };
        items.push(positionText(block, item, cursor, offset+line.top+line.ascent-fragment.run.fontSize-fragment.run.baseline*line.size));
        cursor += fragment.width;
      }
    }
  }
  return items;
}

function imageFile(media) {
  const encoded = media.dataUrl.split(',')[1], bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  return new File([bytes], media.name, { type: media.mime });
}

async function mirroredAsset(asset, flipX, flipY) {
  if (asset.mime === 'image/svg+xml') {
    const svgDocument = mirrorSVG(asset.svgDocument, flipX, flipY);
    return { ...asset, id: uid(), svgDocument, dataUrl: svgDataURL(svgDocument), relativePath: asset.relativePath + ' (mirrored)' };
  }
  // Raster sources remain embedded images inside the reflected SVG wrapper.
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}" viewBox="0 0 ${asset.width} ${asset.height}"><image width="${asset.width}" height="${asset.height}" transform="translate(${flipX?asset.width:0} ${flipY?asset.height:0}) scale(${flipX?-1:1} ${flipY?-1:1})" href="${asset.dataUrl}"/></svg>`;
  const result = await importFiles([new File([xml], 'mirrored-'+asset.name+'.svg', { type: 'image/svg+xml' })]);
  if (!result.assets.length) throw new Error(result.errors[0]?.message || 'Could not preserve image reflection.');
  return { ...result.assets[0], relativePath: asset.relativePath + ' (mirrored)' };
}

/** Expand only already-validated SVG assets; never allow arbitrary nested SVG URLs. */
function groupSVG(project) {
  const doc=new DOMParser().parseFromString(projectToSVG(project),'image/svg+xml');
  const known=new Map(project.assets.filter(a=>a.mime==='image/svg+xml').map(a=>[a.dataUrl,a]));
  for(const image of [...doc.querySelectorAll('image')]){
    const asset=known.get(image.getAttribute('href'));if(!asset)continue;
    const prefix='nested-'+uid()+'-';
    const root=new DOMParser().parseFromString(serializeSVG(asset.svgDocument),'image/svg+xml').documentElement;
    const ids=new Map([...root.querySelectorAll('[id]')].map(node=>[node.id,prefix+node.id]));
    if(root.id)ids.set(root.id,prefix+root.id);
    for(const node of [root,...root.querySelectorAll('*')]){
      for(const attr of [...node.attributes]){
        let value=attr.value;
        if(attr.name==='id')value=ids.get(value)||value;
        else {
          value=value.replace(/url\(\s*(['"]?)#([\w:.-]+)\1\s*\)/g,(_,quote,id)=>`url(#${ids.get(id)||id})`);
          if((attr.localName==='href')&&value.startsWith('#'))value='#'+(ids.get(value.slice(1))||value.slice(1));
        }
        node.setAttributeNS(attr.namespaceURI,attr.name,value);
      }
      if(node.localName==='style')for(const [id,replacement] of ids)node.textContent=node.textContent.replaceAll('#'+id,'#'+replacement);
    }
    for(const key of ['x','y','width','height','preserveAspectRatio'])if(image.hasAttribute(key))root.setAttribute(key,image.getAttribute(key));
    const wrapper=doc.createElementNS(SVG_NS,'g');
    for(const attr of image.attributes)if(!['href','x','y','width','height','preserveAspectRatio'].includes(attr.localName))wrapper.setAttribute(attr.name,attr.value);
    wrapper.append(doc.importNode(root,true));image.replaceWith(wrapper);
  }
  return new XMLSerializer().serializeToString(doc);
}

export async function preparePPTXSlide(converted, signal) {
  const assets = [], ids = new Map(), warnings = [...converted.warnings];
  let bytes = 0, pixels = 0, embeddedBytes = 0;
  function accountAsset(asset) {
    pixels += asset.width*asset.height;
    embeddedBytes += (asset.dataUrl.length + (asset.originalDataUrl?.length || 0))*3/4;
    if (pixels > 64_000_000 || embeddedBytes > 100*1024*1024) throw new Error('The converted slide exceeds 64 million decoded image pixels or 100 MB of embedded images.');
  }
  const mediaById = new Map(converted.media.map(media => [media.id, media]));
  const fallbackIDs = new Set(converted.media.map(media => media.fallbackId).filter(Boolean));
  const directIDs = new Set(converted.items.filter(item => item.type === 'image').map(item => item.assetId));
  for (const media of converted.media) {
    if (fallbackIDs.has(media.id) && !directIDs.has(media.id)) continue;
    signal?.throwIfAborted();
    const file = imageFile(media); bytes += file.size;
    if (bytes > 100*1024*1024) throw new Error('The selected slide contains more than 100 MB of images.');
    let result = await importFiles([file]);
    if (result.errors.length && media.fallbackId && mediaById.has(media.fallbackId)) {
      const fallbackFile = imageFile(mediaById.get(media.fallbackId)); bytes += fallbackFile.size;
      if (bytes > 100*1024*1024) throw new Error('The selected slide contains more than 100 MB of images.');
      warnings.push(`${media.name}: SVG could not be imported; its preview image is used. ${result.errors[0].message}`);
      result = await importFiles([fallbackFile]);
    }
    signal?.throwIfAborted();
    if (result.errors.length || !result.assets.length) {
      warnings.push(`${media.name}: Image omitted. ${result.errors[0]?.message || 'Unsupported image.'}`); continue;
    }
    const asset = { ...result.assets[0], relativePath: media.relativePath, sourceOrigin: 'file' };
    accountAsset(asset);
    assets.push(asset); ids.set(media.id, asset);
  }
  await document.fonts.ready;
  signal?.throwIfAborted();
  const measure = canvasMeasure(), items = [], mirrored = new Map();
  for (const source of converted.items) {
    signal?.throwIfAborted();
    const { _flipX, _flipY, ...item } = source;
    if (item.type === 'shadowGroup') {
      const prepared = await preparePPTXSlide({ ...converted, name:item.name, items:item.items, warnings:[] }, signal);
      warnings.push(...prepared.warnings);
      const children = prepared.deck.slides[0].items;
      let left=0, top=0, right=item.width, bottom=item.height;
      for(const child of children){
        const b=shadowBounds(child), r=child.rotation*Math.PI/180, cs=Math.cos(r), sn=Math.sin(r), cx=child.width/2, cy=child.height/2;
        for(const x of [b.x,b.x+b.width])for(const y of [b.y,b.y+b.height]){
          const px=child.x+cx+(x-cx)*cs-(y-cy)*sn, py=child.y+cy+(x-cx)*sn+(y-cy)*cs;
          left=Math.min(left,px);top=Math.min(top,py);right=Math.max(right,px);bottom=Math.max(bottom,py);
        }
      }
      const width=right-left,height=bottom-top;
      const local={format:'figure-editor',version:1,id:uid(),name:item.name,canvas:{width,height,background:'transparent'},assets:prepared.deck.assets,
        items:children.map(child=>({...child,x:child.x-left,y:child.y-top}))};
      const result=await importFiles([new File([groupSVG(local)],item.name+'.svg',{type:'image/svg+xml'})]);
      if(result.errors.length||!result.assets.length)throw new Error('Could not preserve group shadow: '+result.errors.map(e=>e.message).join('; '));
      const asset=(_flipX||_flipY)?await mirroredAsset(result.assets[0],_flipX,_flipY):result.assets[0];accountAsset(asset);assets.push(asset);
      const r=item.rotation*Math.PI/180,dx=(left+right-item.width)/2*(_flipX?-1:1),dy=(top+bottom-item.height)/2*(_flipY?-1:1);
      items.push({id:uid(),type:'image',name:item.name,assetId:asset.id,width,height,
        x:item.x+item.width/2+dx*Math.cos(r)-dy*Math.sin(r)-width/2,
        y:item.y+item.height/2+dx*Math.sin(r)+dy*Math.cos(r)-height/2,
        rotation:item.rotation,opacity:item.opacity,locked:false,hidden:false,shadow:item.shadow});
    }
    else if (item.type === 'textBlock') items.push(...layoutTextBlock(item, measure));
    else if (item.type === 'image') {
      let asset = ids.get(item.assetId);
      if (!asset) continue;
      if (_flipX || _flipY) {
        const key = `${asset.id}:${_flipX}:${_flipY}`;
        if (!mirrored.has(key)) {
          const copy = await mirroredAsset(asset, _flipX, _flipY); accountAsset(copy); assets.push(copy); mirrored.set(key, copy);
          signal?.throwIfAborted();
        }
        asset = mirrored.get(key);
        if (item.crop) item.crop = { ...item.crop, x: _flipX ? 1-item.crop.x-item.crop.width : item.crop.x, y: _flipY ? 1-item.crop.y-item.crop.height : item.crop.y };
      }
      items.push({ ...item, id: uid(), assetId: asset.id });
    } else items.push({ ...item, id: uid() });
    if (items.length > 2000) throw new Error('The converted slide exceeds 2,000 editable objects.');
  }
  const used = new Set(items.filter(i => i.type==='image').map(i => i.assetId));
  const project = validateProject({ format: 'figure-editor', version: 1, id: uid(), name: converted.name,
    canvas: converted.canvas, assets: assets.filter(a => used.has(a.id)), items });
  const deck = validateDeck(project); deck.slides[0].name = converted.name;
  return { deck, preview: projectToSVG(project), warnings };
}

export async function localAPI() {
  if (location.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(location.hostname)) throw new Error(launchHint);
  let local;
  try {
    const response = await fetch('/api/local', { mode:'same-origin', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    local = await response.json();
  } catch { throw new Error(launchHint); }
  if (local?.app !== 'figure-editor-local' || local.pptxImport !== true || typeof local.token !== 'string') throw new Error(launchHint);
  return local;
}

export function initPPTXImport({ captureTarget, targetIsCurrent, insert }) {
  const button=document.getElementById('import-pptx');
  const input=document.createElement('input'); input.type='file'; input.accept='.pptx'; input.hidden=true; document.body.append(input);
  const dialog=document.createElement('dialog'); dialog.id='pptx-import-dialog'; dialog.setAttribute('aria-labelledby','pptx-import-title');
  dialog.innerHTML='<div class="dialog-header"><span class="eyebrow">POWERPOINT IMPORT</span><h2 id="pptx-import-title">Import a PowerPoint slide</h2><p id="pptx-import-file"></p></div><div class="dialog-body"><label class="field"><span>Choose a slide</span><select id="pptx-import-page" disabled></select></label><p id="pptx-import-status" role="status" aria-live="polite">Reading presentation…</p><img id="pptx-import-preview" alt="Preview of the converted slide" hidden><p class="hint">Preview shows the converted layout. Pictures and text remain separate. Mixed text styles may become separate text objects.</p><details id="pptx-import-notes" hidden><summary>Import notes</summary><ul></ul></details></div><div class="dialog-actions"><button id="pptx-import-cancel" class="button">Cancel</button><button id="pptx-import-submit" class="button primary" disabled>Insert as new slide</button></div>';
  document.body.append(dialog);
  const get=id=>dialog.querySelector('#pptx-import-'+id), select=get('page'), submit=get('submit'), info=get('status'), preview=get('preview');
  let generation=0, pageGeneration=0, controller, ready=null, target, fileData, token, previewURL;
  function clearPreview() { ready=null; submit.disabled=true; preview.hidden=true; preview.removeAttribute('src'); if(previewURL)URL.revokeObjectURL(previewURL); previewURL=null; get('notes').hidden=true; }
  dialog.addEventListener('close',()=>{generation++;pageGeneration++;controller?.abort();clearPreview();fileData=null;button.disabled=false;});
  dialog.addEventListener('keydown',e=>e.stopPropagation());
  for(const type of ['copy','cut','paste'])dialog.addEventListener(type,e=>e.stopPropagation());
  get('cancel').onclick=()=>dialog.close();
  button.onclick=()=>input.click();
  async function request(slide, signal) {
    let response;
    try { response=await fetch('/api/pptx-import',{method:'POST',mode:'same-origin',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json','X-Figure-Token':token},body:JSON.stringify({...fileData,...(slide?{slide}:{})}),signal}); }
    catch(error){if(error.name==='AbortError')throw error;throw new Error('PPTX import could not reach the local server. Check the terminal and try again.');}
    const result=await response.json(); if(!response.ok)throw new Error(result.error||'Could not read this PPTX.'); return result;
  }
  async function loadPage() {
    const current=generation, page=++pageGeneration; controller?.abort(); controller=new AbortController(); clearPreview(); info.textContent='Preparing editable slide preview…';
    try {
      const converted=await request(Number(select.value),controller.signal);
      if(current!==generation||page!==pageGeneration)return;
      const result=await preparePPTXSlide(converted,controller.signal);
      if(current!==generation||page!==pageGeneration)return;
      ready=result;previewURL=URL.createObjectURL(new Blob([result.preview],{type:'image/svg+xml'}));preview.src=previewURL;preview.hidden=false;
      const items=result.deck.slides[0].items, images=items.filter(i=>i.type==='image').length, texts=items.filter(i=>i.type==='text').length;
      info.textContent=`${images} image${images===1?'':'s'} · ${texts} editable text object${texts===1?'':'s'} · ${items.length} objects total`;
      const notes=get('notes'); notes.querySelector('ul').replaceChildren(...result.warnings.map(message=>{const li=document.createElement('li');li.textContent=message;return li;}));notes.hidden=!result.warnings.length;notes.open=result.warnings.some(w=>/omitted|not retained|approximat/i.test(w));
      submit.disabled=false;
    } catch(error) { if(current===generation&&page===pageGeneration&&error.name!=='AbortError')info.textContent=error.message; }
  }
  select.onchange=loadPage;
  input.onchange=async()=>{
    const file=input.files[0];input.value='';if(!file)return;
    const current=++generation;target=captureTarget();button.disabled=true;select.replaceChildren();select.disabled=true;clearPreview();get('file').textContent=file.name;info.textContent='Reading presentation…';dialog.showModal();
    try {
      if(!/\.pptx$/i.test(file.name)||!file.size||file.size>MAX_BYTES)throw new Error('Choose a nonempty .pptx file of 100 MB or less.');
      const local=await localAPI();if(current!==generation)return;token=local.token;
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Could not read the PPTX file.'));reader.readAsDataURL(file);});
      if(current!==generation)return;fileData={name:file.name,data};controller=new AbortController();
      const result=await request(null,controller.signal);if(current!==generation)return;
      for(const slide of result.slides){const option=document.createElement('option');option.value=slide.number;option.textContent=`${slide.number}. ${slide.title}`;select.append(option);}
      select.disabled=false;await loadPage();
    }catch(error){if(current===generation&&error.name!=='AbortError')info.textContent=error.message;}
  };
  submit.onclick=()=>{
    if(!ready)return;
    if(!targetIsCurrent(target)){info.textContent='The destination project or slide changed. Cancel and import again.';submit.disabled=true;return;}
    try { if(insert(ready.deck,ready.warnings)!==false)dialog.close(); }
    catch(error) { info.textContent=error.message; }
  };
}
