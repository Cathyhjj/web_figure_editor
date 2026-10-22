import { createDeck, validateDeck } from '../deck.js';
import { exportPNG, projectToSVG } from '../core.js';
import { selectionToPNG } from '../clipboard-image.js';
import { SHAPE_CATEGORIES, DRAWING_TOOLS, createCatalogShape } from '../shape-catalog.js';

const checks = [];
function check(name, passed) {
  checks.push(Boolean(passed));
  const row = document.createElement('li');
  row.dataset.pass = String(Boolean(passed));
  row.textContent = `${passed ? 'PASS' : 'FAIL'} — ${name}`;
  document.querySelector('#results').append(row);
}
async function pixels(blob) {
  const image = await createImageBitmap(blob), canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
  return { at: (x, y) => [...ctx.getImageData(x, y, 1, 1).data], width: canvas.width, height: canvas.height };
}
document.querySelector('#run').onclick = async () => {
  checks.length = 0; document.querySelector('#results').replaceChildren();
  document.querySelector('#run').disabled = true;
  try {
    const iframe = document.createElement('iframe');
    const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = reject; });
    iframe.src = '../index.html';
    document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
    const win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    const app = [...doc.querySelectorAll('script[type=module][src]')].find(script => script.src.includes('/app.js'));
    await new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      win.addEventListener('shape-ready', resolve, { once: true });
      win.addEventListener('shape-error', reject, { once: true });
      script.type = 'module'; script.textContent = `import(${JSON.stringify(app.src)}).then(()=>window.dispatchEvent(new Event('shape-ready')),()=>window.dispatchEvent(new Event('shape-error')));`;
      doc.body.append(script);
    });
    const empty = createDeck(); empty.name = 'Shape check fixture';
    const data = new DataTransfer(); data.items.add(new File([JSON.stringify(empty)], 'shape-checks.figure.json', { type: 'application/json' }));
    win.confirm = () => true;
    get('project-input').files = data.files;
    await get('project-input').onchange({ target: get('project-input') });
    const set = (selector, value) => {
      const node = doc.querySelector(selector); node.value = value;
      node.dispatchEvent(new win.Event('input', { bubbles: true }));
      node.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    const selected = () => get('stage').querySelector('.figure-item.selected');
    const selectLatest = () => get('layer-list').querySelector('.layer-select').click();
    const legacy=['rect','roundRect','circle','ellipse','line','arrow','doubleArrow'].map(key=>doc.querySelector(`[data-shape-choice="${key}"]`));
    for (const [index, button] of legacy.entries()) {
      get('shapes-toggle').click(); button.click();
      check(`Insert ${button.textContent.trim()} and select it`, get('stage').querySelectorAll('.figure-item').length === index + 1 && Boolean(selected()));
      set('[data-property=x]', 40 + (index % 4) * 210);
      set('[data-property=y]', 50 + Math.floor(index / 4) * 220);
    }
    check('Horizontal arrow starts with zero height', doc.querySelector('[data-property=height]').value === '0');
    set('[data-transparency=strokeOpacity][type=number]', '35');
    set('[data-property=strokeDash]', 'dash');
    check('Arrow transparency and solid heads remain separate from dashed shaft', selected().querySelector('g[opacity="0.65"]') && selected().querySelector('line[stroke-dasharray]') && selected().querySelectorAll('path').length === 2);
    get('undo').click(); selectLatest();
    check('Undo restores the previous arrow line style', doc.querySelector('[data-property=strokeDash]').value === 'solid');
    get('redo').click(); selectLatest();
    check('Redo restores dashed style', doc.querySelector('[data-property=strokeDash]').value === 'dash');
    get('shapes-toggle').click(); get('add-rect').click();
    set('[data-property=x]', '460'); set('[data-property=y]', '270');
    set('[data-shape-color=fill]', '#ee7755');
    set('[data-transparency=fillOpacity][type=number]', '80');
    check('Fill at 80% transparency leaves border opaque', selected().querySelector('rect[fill-opacity="0.2"][stroke-opacity="1"]') !== null);
    check('Transparency number synchronizes its slider', doc.querySelector('[data-transparency=fillOpacity][type=range]').value === '80');
    set('[data-transparency=strokeOpacity][type=range]', '25');
    check('Transparency slider synchronizes its number', doc.querySelector('[data-transparency=strokeOpacity][type=number]').value === '25');
    set('[data-shape-paint=fill]', 'none');
    check('No fill keeps the border and disables fill controls', selected().querySelector('rect[fill="none"]') && doc.querySelector('[data-shape-color=fill]').disabled);
    set('[data-shape-paint=fill]', 'solid');
    check('Restoring fill preserves color and transparency', selected().querySelector('rect[fill="#ee7755"][fill-opacity="0.2"]') !== null);
    set('[data-shape-paint=stroke]', 'none');
    check('No border retains the fill', selected().querySelector('rect[stroke="none"][fill="#ee7755"]') !== null);
    get('undo').click(); selectLatest();
    check('Undo restores the border', selected().querySelector('rect[stroke="#252735"]') !== null);
    get('duplicate').click();
    check('Duplicated shape retains independent transparency', selected().querySelector('rect[fill-opacity="0.2"][stroke-opacity="0.75"]') !== null);
    get('object-locked').click();
    check('Locked shape cannot change paint or transparency', [...get('inspector').querySelectorAll('[data-transparency],[data-shape-color],[data-shape-paint]')].every(node => node.disabled));
    get('object-locked').click();
    const rasterProject = { format:'figure-editor', version:1, id:'pixels', name:'Pixels', canvas:{width:100,height:100,background:'transparent'}, assets:[], items:[{id:'box',type:'rect',x:20,y:20,width:60,height:60,fill:'#ff0000',stroke:'#0000ff',strokeWidth:4,fillOpacity:.2,strokeOpacity:1}] };
    const raster = await pixels(await exportPNG(rasterProject, 96));
    check('PNG pixels have a 20% alpha fill and fully opaque blue border', Math.abs(raster.at(50,50)[3]-51)<=1 && raster.at(20,50)[2]===255 && raster.at(20,50)[3]===255);
    const arrow = {...rasterProject,items:[{id:'arrow',type:'doubleArrow',x:20,y:20,width:80,height:0,stroke:'#000000',strokeWidth:12,strokeOpacity:.5}]};
    const copied = await pixels(await selectionToPNG(arrow, { dpi:96 }));
    check('Copied arrow includes head height rather than clipping to the shaft', copied.height > 12 && copied.width > copied.height);
    check('SVG retains editable vector geometry', !projectToSVG(rasterProject).includes('<image'));
    const extra=SHAPE_CATEGORIES.flatMap(group=>group.shapes).filter(entry=>!DRAWING_TOOLS.includes(entry.id)&&entry.id!=='textBox'&&!legacy.some(button=>button.dataset.shapeChoice===entry.id));
    for(const entry of extra){
      get('shapes-toggle').click();doc.querySelector(`[data-shape-choice="${entry.id}"]`).click();
      check(`Insert ${entry.name} as editable geometry`,Boolean(selected()?.querySelector('path')));
    }
    get('shapes-toggle').click();doc.querySelector('[data-shape-choice="heart"]').click();
    set('[data-shape-color=fill]','#ee7755');set('[data-transparency=fillOpacity][type=number]','80');
    set('[data-transparency=strokeOpacity][type=number]','25');set('[data-property=strokeDash]','dash');
    check('New preset has independent paint alpha and dashed outline',Boolean(selected().querySelector('path[fill-opacity="0.2"][stroke-opacity="0.75"][stroke-dasharray="8 6"]')));
    set('[data-shape-paint=stroke]','none');
    check('New preset supports No border',Boolean(selected().querySelector('path[stroke="none"]')));
    get('undo').click();selectLatest();
    check('Undo restores new preset outline',Boolean(selected().querySelector('path[stroke="#252735"]')));
    get('duplicate').click();get('object-locked').click();
    check('New preset duplicate locks all paint controls', [...get('inspector').querySelectorAll('[data-transparency],[data-shape-color],[data-shape-paint],[data-property],[data-shape]')].every(node=>node.disabled));
    get('object-locked').click();
    for(const key of ['donut','frame','noSmoking']){
      const shape={id:key,x:10,y:10,...createCatalogShape(key),width:80,height:80,fill:'#ff0000',stroke:'none'};
      const image=await pixels(await exportPNG({...rasterProject,items:[shape]},96));
      const hole=key==='noSmoking'?image.at(65,35):image.at(50,50);
      check(`${key} retains transparent holes in rendered PNG`,hole[3]===0);
    }
    get('shapes-toggle').click();const search=doc.querySelector('.shape-search');search.value='triangle';search.dispatchEvent(new win.Event('input'));
    check('Gallery search finds both triangles',doc.querySelectorAll('.shape-category:not([hidden]) button:not([hidden])').length===2);
    check('Matching search hides the empty-results message',get('shapes-menu').querySelector('p.hint').hidden);
    search.value='no such shape';search.dispatchEvent(new win.Event('input'));
    check('Empty search results show a helpful message',!get('shapes-menu').querySelector('p.hint').hidden&&doc.querySelectorAll('.shape-category:not([hidden])').length===0);
    get('shapes-menu').hidePopover();
    const expectedCount=get('stage').querySelectorAll('.figure-item').length;
    // Wait for the actual persisted draft, then reopen the editor through a fresh document.
    await new Promise(resolve => setTimeout(resolve, 900));
    const reloaded = new Promise(resolve => iframe.onload = resolve);
    iframe.src = '../index.html?shapes-reopen=1'; await reloaded;
    const deadline = performance.now() + 5000;
    while (!iframe.contentDocument.querySelector('#stage .figure-item') && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    check('Reload restores all synthetic shapes with saved paint styles', iframe.contentDocument.querySelectorAll('#stage .figure-item').length === expectedCount && iframe.contentDocument.querySelector('#stage path[fill-opacity="0.2"][stroke-opacity="0.75"]'));
  } catch (error) {
    check(error.stack || error.message, false);
  }
  document.querySelector('#summary').textContent = `${checks.filter(Boolean).length}/${checks.length} passed`;
  document.querySelector('#run').disabled = false;
};
