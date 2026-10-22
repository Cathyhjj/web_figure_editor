import { createDeck, validateDeck } from '../deck.js';
const checks = [], results = document.getElementById('results');
function check(name, pass) { checks.push({name,pass:!!pass}); const row=document.createElement('li');row.dataset.pass=String(!!pass);row.textContent=`${pass?'PASS':'FAIL'} — ${name}`;results.append(row); }
async function loadEditor() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under Asset selection integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?asset-selection-checks=${Date.now()}`;
  document.getElementById('editor-host').replaceChildren(iframe);
  await loaded;
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) throw new Error('The editor app module was not found.');
    const script = doc.createElement('script');
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('asset-selection-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('asset-selection-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => { clearTimeout(timeout); win.removeEventListener('asset-selection-editor-ready', ready); win.removeEventListener('asset-selection-editor-failed', failed); script.remove(); };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('asset-selection-editor-ready', ready, { once: true });
    win.addEventListener('asset-selection-editor-failed', failed, { once: true });
    doc.body.append(script);
  });
  return iframe;
}


document.getElementById('run').onclick=async()=>{
 checks.length=0;results.replaceChildren();window.assetSelectionChecks={finished:false};
 const restore=[];
 try{
  if(!['18766','18768'].includes(location.port)||!['localhost','127.0.0.1'].includes(location.hostname))throw new Error('Use isolated localhost port 18766 or 18768.');
  const iframe=await loadEditor(),win=iframe.contentWindow,doc=iframe.contentDocument,get=id=>doc.getElementById(id);
  const picker=Object.getOwnPropertyDescriptor(win,'showSaveFilePicker');
  Object.defineProperty(win,'showSaveFilePicker',{configurable:true,value:undefined});restore.push(()=>{if(picker)Object.defineProperty(win,'showSaveFilePicker',picker);else delete win.showSaveFilePicker;});
  const oldConfirm=win.confirm;win.confirm=()=>true;restore.push(()=>win.confirm=oldConfirm);
  const oldCreate=win.URL.createObjectURL,oldClick=win.HTMLAnchorElement.prototype.click,urls=new Map(),downloads=[];
  win.URL.createObjectURL=blob=>{const url=oldCreate.call(win.URL,blob);urls.set(url,blob);return url;};
  win.HTMLAnchorElement.prototype.click=function(){if(this.download)downloads.push(urls.get(this.href));else oldClick.call(this);};
  restore.push(()=>{win.URL.createObjectURL=oldCreate;win.HTMLAnchorElement.prototype.click=oldClick;for(const url of urls.keys())win.URL.revokeObjectURL(url);});
  const save=async()=>{const index=downloads.length;await get('save-project').onclick();return JSON.parse(await downloads[index].text());};
  const open=async deck=>{const transfer=new win.DataTransfer();transfer.items.add(new win.File([JSON.stringify(deck)],'asset-selection.figure.json',{type:'application/json'}));get('project-input').files=transfer.files;await get('project-input').onchange({target:get('project-input')});};
  const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3;canvas.getContext('2d').fillRect(0,0,4,3);
  const deck=createDeck();deck.name='Asset selection fixture';
  deck.assets=['used','remote','unused','hidden'].map(id=>({id,name:id+'.png',mime:'image/png',width:4,height:3,dataUrl:canvas.toDataURL(),sourceKind:'copy'}));
  const picture=(id,assetId,extra={})=>({id,assetId,type:'image',name:id,x:20,y:20,width:80,height:60,...extra});
  deck.slides=[{id:'one',name:'One',canvas:{width:400,height:300,background:'white'},items:[picture('lower','used'),picture('upper','used',{x:130}),picture('hidden-top','used',{hidden:true}),picture('hidden-only','hidden',{hidden:true,locked:true})]},{id:'two',name:'Two',canvas:{width:400,height:300,background:'white'},items:[picture('remote-object','remote')]}];deck.activeSlideId='one';
  const fixture=validateDeck(deck);await open(fixture);
  const card=id=>doc.querySelector(`[data-asset="${id}"]`),selected=()=>[...get('layer-list').querySelectorAll('.selected')].map(node=>node.dataset.layer),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const click=async(id,selector='.asset-preview')=>{const node=card(id);await node.onclick({target:node.querySelector(selector)});};
  await click('used');check('Preview selects the topmost visible copy without inserting or making history',equal(selected(),['upper'])&&equal(await save(),fixture)&&get('undo').disabled);
  doc.querySelector('[data-layer="lower"] .layer-select').click();await click('used','.asset-name');check('Card body preserves an already selected copy',equal(selected(),['lower'])&&equal(await save(),fixture));
  await click('unused');check('Unused asset gives a Place hint and preserves the project and selection',get('status').textContent.includes('Click Place')&&equal(selected(),['lower'])&&equal(await save(),fixture));
  await click('hidden');check('A hidden locked instance remains selectable through its asset card',equal(selected(),['hidden-only'])&&get('status').textContent.includes('hidden')&&get('status').textContent.includes('locked')&&equal(await save(),fixture));
  await click('remote');const remote=await save();check('Asset used only on another slide switches to that existing instance',remote.activeSlideId==='two'&&equal(remote.slides,fixture.slides)&&equal(remote.assets,fixture.assets)&&equal(selected(),['remote-object'])&&get('undo').disabled);
  await click('remote','[data-action="place"]');const placed=await save();check('Explicit Place adds exactly one independent instance with shared original bytes',placed.slides[1].items.length===2&&placed.assets.length===fixture.assets.length&&placed.slides[1].items[1].assetId==='remote'&&placed.slides[1].items[1].id!=='remote-object');
  get('undo').click();check('One Undo removes only the explicitly placed copy',equal(await save(),remote));
  const target=card('remote').querySelector('.asset-preview'),r=get('workspace').getBoundingClientRect(),p={clientX:r.x+30,clientY:r.y+30};
  target.dispatchEvent(new win.PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:87,clientX:0,clientY:0}));doc.dispatchEvent(new win.PointerEvent('pointermove',{bubbles:true,pointerId:87,...p}));doc.dispatchEvent(new win.PointerEvent('pointerup',{bubbles:true,pointerId:87,...p}));
  check('Dragging a library preview does not insert another instance',equal(await save(),remote));
  await get('workspace').ondrop({preventDefault(){},...p,dataTransfer:{getData:type=>type==='application/x-figure-asset'?'remote':''}});
  const dropStatus=get('status').textContent;
  check('Legacy internal asset drop payload also cannot insert',equal(await save(),remote)&&dropStatus.includes('Click Place'));
 }catch(error){check(error.stack||error.message,false);}finally{restore.reverse().forEach(fn=>fn());window.assetSelectionChecks={finished:true,passed:checks.length>0&&checks.every(check=>check.pass),checks:[...checks]};document.title=(window.assetSelectionChecks.passed?'PASS':'FAIL')+' — Asset selection checks';}
};
