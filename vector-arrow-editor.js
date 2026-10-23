import { formatSection } from './format-inspector.js';
import { rebuildArrow, fadeArrow } from './vector-arrow.js';

export function arrowEditorMarkup(item) {
  const a=item.editableArrow;if(!a)return '';
  const scale=Math.sqrt(item.width/a.viewWidth*item.height/a.viewHeight);
  const select=(label,key,options)=>`<label class="field"><span>${label}</span><select data-arrow-property="${key}">${options.map(([value,title])=>`<option value="${value}" ${a[key]===value?'selected':''}>${title}</option>`).join('')}</select></label>`;
  const number=(label,key,value,min,max)=>`<label class="field"><span>${label}</span><input type="number" data-arrow-property="${key}" value="${Math.round(value*10)/10}" min="${min}" max="${max}" step="0.5"></label>`;
  return formatSection('arrow-path','Arrow',
    `<div class="field-row">${select('Path','kind',[['curve','Curve'],['polyline','Polyline']])}${select('Arrowheads','heads',[['end','End'],['both','Both ends']])}</div>`+
    select('Tip style','headStyle',[['stealth','Notched'],['triangle','Triangle']])+
    `<div class="field-row">${number('Shaft width / px','shaftWidth',a.shaftWidth*scale,.5,500)}${number('Tail width / %','tailWidth',a.tailWidth*100,0,100)}</div>`+
    `<div class="field-row">${number('Head width / px','headWidth',a.headWidth*scale,1,1000)}${number('Head length / px','headLength',a.headLength*scale,1,1000)}</div>`+
    '<div class="image-crop-actions"><button class="button" data-arrow-action="fade">Fade tail</button><button class="button" data-arrow-action="solid">Solid color</button></div>'+
    '<p class="hint">Drag orange points to reshape. Click + to add a point; Alt/Option-click a point to remove it. Use Fill to change the arrow color or gradient. Stretching also stretches the arrowhead.</p>',true);
}

export function bindArrowEditor(item,box,{change}) {
  if(!item.editableArrow)return;
  box.querySelectorAll('[data-arrow-property]').forEach(input=>{
    input.disabled=item.locked;
    input.onchange=()=>{
      if(item.locked||input.value==='')return;
      let value=input.type==='number'?Number(input.value):input.value;
      if(input.type==='number') {
        if(!Number.isFinite(value))return;
        value=Math.max(Number(input.min),Math.min(Number(input.max),value));
        value=input.dataset.arrowProperty==='tailWidth'?value/100:value/Math.sqrt(item.width/item.editableArrow.viewWidth*item.height/item.editableArrow.viewHeight);
      }
      change(()=>{item.editableArrow[input.dataset.arrowProperty]=value;rebuildArrow(item);});
    };
  });
  box.querySelectorAll('[data-arrow-action]').forEach(button=>{
    button.disabled=item.locked;
    button.onclick=()=>{if(!item.locked)change(()=>{if(button.dataset.arrowAction==='fade')fadeArrow(item);else delete item.fillGradient;});};
  });
}

export function arrowMidpoints(a) {
  return a.points.slice(0,-1).map((p,i)=>{
    const q=a.points[i+1],before=a.points[Math.max(0,i-1)],after=a.points[Math.min(a.points.length-1,i+2)];
    return a.kind==='polyline'?{x:(p.x+q.x)/2,y:(p.y+q.y)/2}
      :{x:(p.x+q.x)/2+(p.x-before.x+q.x-after.x)/16,y:(p.y+q.y)/2+(p.y-before.y+q.y-after.y)/16};
  });
}

export function appendArrowHandles(group,item,zoom,svg) {
  const a=item.editableArrow;if(!a)return;
  if(a.points.length<32)arrowMidpoints(a).forEach((p,i)=>{
    const handle=svg('g',{'data-arrow-insert':i,transform:`translate(${p.x*item.width} ${p.y*item.height})`,style:'cursor:copy'});
    handle.append(svg('circle',{r:6/zoom,fill:'#fff',stroke:'#b86712','stroke-width':1/zoom}));
    handle.append(svg('path',{d:`M${-3/zoom} 0H${3/zoom}M0 ${-3/zoom}V${3/zoom}`,stroke:'#b86712','stroke-width':1/zoom,'pointer-events':'none'}));
    handle.append(svg('title',{},'Add arrow point'));group.append(handle);
  });
  a.points.forEach((p,i)=>{
    const handle=svg('circle',{cx:p.x*item.width,cy:p.y*item.height,r:5/zoom,fill:'#fff3d9',stroke:'#b86712','stroke-width':1.6/zoom,
      'data-arrow-point':i,'aria-label':`Arrow point ${i+1}`,style:'cursor:crosshair'});
    handle.append(svg('title',{},`Drag point ${i+1} · Alt/Option-click to remove`));group.append(handle);
  });
}
