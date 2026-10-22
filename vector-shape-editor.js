import { shadeColor } from './shape.js';
const rgb = c => shadeColor(c).slice(0,7);
const alpha = c => {const hex=shadeColor(c);return hex.length===9 ? Math.round(parseInt(hex.slice(7),16)/255*100) : 100;};
const withAlpha = (c,a) => rgb(c)+Math.round(Math.max(0,Math.min(100,a))/100*255).toString(16).padStart(2,'0');
export function vectorShapeEditor(item) {
  let border='';
  if(item.strokeGradient)border=gradientControls(item.strokeGradient,'strokeGradient','Border gradient');
  if(item.type!=='shape'||item.paths.every(path=>path.fillMode==='none'))return border;
  const g=item.fillGradient,mode=g?'gradient':item.fill==='none'?'none':'solid';
  let html=`<label class="field"><span>Fill</span><select data-shape="mode">${['none','solid','gradient'].map(m=>`<option value="${m}" ${mode===m?'selected':''}>${m[0].toUpperCase()+m.slice(1)}</option>`).join('')}</select></label>`;
  if(g) {
    html+=`<label class="field"><span>Gradient angle / °</span><input data-shape="angle" type="number" min="-360" max="360" value="${g.angle}"></label>`;
    g.stops.forEach((s,i)=>{html+=`<div class="field-row"><label class="field"><span>Stop ${i+1}</span><input data-shape="stopColor" data-stop="${i}" type="color" value="${rgb(s.color)}"></label><label class="field"><span>Opacity / %</span><input data-shape="stopOpacity" data-stop="${i}" type="number" min="0" max="100" value="${alpha(s.color)}"></label><label class="field"><span>Position / %</span><input data-shape="stopOffset" data-stop="${i}" type="number" min="0" max="100" value="${s.offset*100}"></label></div>`;});
  }
  return html+border;
}
function gradientControls(g,key,title) {
  return `<fieldset class="shape-paint"><legend>${title}</legend><label class="field"><span>${title} angle / °</span><input data-gradient="${key}" data-gradient-field="angle" aria-label="${title} angle" type="number" min="-360" max="360" value="${g.angle}"></label>`+
    g.stops.map((stop,index)=>`<div class="field-row"><label class="field"><span>Stop ${index+1}</span><input data-gradient="${key}" data-gradient-field="color" data-stop="${index}" aria-label="${title} stop ${index+1} color" type="color" value="${rgb(stop.color)}"></label><label class="field"><span>Opacity / %</span><input data-gradient="${key}" data-gradient-field="opacity" data-stop="${index}" aria-label="${title} stop ${index+1} opacity" type="number" min="0" max="100" value="${alpha(stop.color)}"></label><label class="field"><span>Position / %</span><input data-gradient="${key}" data-gradient-field="offset" data-stop="${index}" aria-label="${title} stop ${index+1} position" type="number" min="0" max="100" value="${stop.offset*100}"></label></div>`).join('')+'</fieldset>';
}
export function bindVectorShapeEditor(item,box,change) {
  box.querySelectorAll('[data-gradient]').forEach(input=>{
    input.disabled=item.locked;
    input.onchange=()=>{
      if(item.locked||input.type==='number'&&(input.value===''||!Number.isFinite(Number(input.value))))return;
      change(()=>{
        const g=item[input.dataset.gradient],key=input.dataset.gradientField,value=input.type==='number'?Number(input.value):input.value;
        if(key==='angle'){g.angle=((value%360)+360)%360;return;}
        const stop=g.stops[Number(input.dataset.stop)];
        if(key==='color')stop.color=withAlpha(value,alpha(stop.color));
        else if(key==='opacity')stop.color=withAlpha(stop.color,value);
        else {stop.offset=Math.max(0,Math.min(1,value/100));g.stops.sort((a,b)=>a.offset-b.offset);}
      });
    };
  });
  box.querySelectorAll('[data-shape]').forEach(input=>{
    input.disabled=item.locked;
    input.onchange=()=>{
      if(input.type==='number'&&(input.value===''||!Number.isFinite(Number(input.value))))return;
      const key=input.dataset.shape,value=input.type==='number'?Number(input.value):input.value;
      change(()=>{
        if(key==='mode'){
          delete item.fillGradient;
          item.fill=value==='none'?'none':'#4472c4';
          if(value==='gradient')item.fillGradient={angle:90,stops:[{offset:0,color:'#4472c4'},{offset:1,color:'#ffffff'}]};
        }else if(key==='fill')item.fill=withAlpha(value,alpha(item.fill));
        else if(key==='opacity')item.fill=withAlpha(item.fill,value);
        else if(key==='angle')item.fillGradient.angle=((value%360)+360)%360;
        else {
          const stop=item.fillGradient.stops[Number(input.dataset.stop)];
          if(key==='stopColor')stop.color=withAlpha(value,alpha(stop.color));
          else if(key==='stopOpacity')stop.color=withAlpha(stop.color,value);
          else {stop.offset=Math.max(0,Math.min(1,value/100));item.fillGradient.stops.sort((a,b)=>a.offset-b.offset);}
        }
      });
    };
  });
}
