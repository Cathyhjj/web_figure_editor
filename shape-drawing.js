import { shapeSVG } from './shape.js';

const names = { curve: 'Curve', freeform: 'Freeform', scribble: 'Scribble' };
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

/** Turn a completed gesture into bounded, editable project geometry. */
export function createDrawingShape(tool, input, closed = false) {
  if (!names[tool]) throw new Error('Unknown drawing tool.');
  const points = input.filter((p,i) => !i || distance(p,input[i-1]) > .01);
  if (points.length < 2) return null;
  if (points.length > 1024 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid drawing points.');
  const commands = [['M',points[0].x,points[0].y]];
  if (tool === 'curve') {
    for (let i=0;i<points.length-1;i++) {
      const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
      commands.push(['C',b.x+(c.x-a.x)/6,b.y+(c.y-a.y)/6,c.x-(d.x-b.x)/6,c.y-(d.y-b.y)/6,c.x,c.y]);
    }
  } else for (const p of points.slice(1)) commands.push(['L',p.x,p.y]);
  closed = closed && points.length >= 3;
  if (closed) commands.push(['Z']);
  const xs=[],ys=[];
  for (const command of commands) for(let j=1;j<command.length;j+=2){xs.push(command[j]);ys.push(command[j+1]);}
  const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(1,Math.max(...xs)-x),height=Math.max(1,Math.max(...ys)-y);
  return { type:'shape',name:names[tool],x,y,width,height,
    paths:[{commands:commands.map(([op,...values])=>[op,...values.map((v,j)=>j%2?(v-y)/height:(v-x)/width)]),fillMode:closed?'norm':'none',stroke:true}],
    fill:closed?'#ffffff':'none',stroke:'#252735',strokeWidth:2,fillOpacity:1,strokeOpacity:1,strokeDash:'solid',
  };
}

export function initShapeDrawing({workspace,stage,point,context,insert,status,prepare}) {
  let state=null;
  const consume = event => {event.preventDefault();event.stopImmediatePropagation();};
  function release(){if(state?.pointerId!=null&&stage.hasPointerCapture(state.pointerId))stage.releasePointerCapture(state.pointerId);if(state)state.pointerId=null;}
  function cancel(){release();state=null;stage.querySelector('[data-drawing-preview]')?.remove();workspace.classList.remove('shape-drawing');}
  function current(){const now=context();if(state&&(now.project!==state.context.project||now.slideId!==state.context.slideId))cancel();return state;}
  function finish(closed=false){
    if(!current())return;
    const item=createDrawingShape(state.tool,state.points,closed);cancel();
    if(item)insert(item);else status('Drawing cancelled.');
  }
  function preview(){
    stage.querySelector('[data-drawing-preview]')?.remove();
    if(!state)return;
    const points=state.hover?[...state.points,state.hover]:state.points;
    const item=createDrawingShape(state.tool,points);
    if(!item)return;
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');
    group.dataset.drawingPreview='true';group.setAttribute('pointer-events','none');
    group.setAttribute('transform',`translate(${item.x} ${item.y})`);group.innerHTML=shapeSVG(item,'drawing-preview');stage.append(group);
  }
  function append(p){
    if(!state.points.length||distance(p,state.points.at(-1))>=1){
      if(state.points.length>=1000)state.points=state.points.filter((_,i)=>i%2===0);
      state.points.push(p);
    }
  }
  workspace.addEventListener('pointerdown',event=>{
    if(!current()||event.button!==0||!stage.contains(event.target))return;
    consume(event);workspace.focus({preventScroll:true});const p=point(event);
    if(state.tool==='freeform'&&state.points.length>=3&&distance(p,state.points[0])<8){finish(true);return;}
    append(p);state.hover=null;state.pointerId=event.pointerId;stage.setPointerCapture(event.pointerId);preview();
  },true);
  workspace.addEventListener('pointermove',event=>{
    if(!current())return;consume(event);
    const p=point(event);
    if(state.pointerId===event.pointerId&&state.tool!=='curve')append(p);
    state.hover=state.tool==='scribble'?null:p;preview();
  },true);
  workspace.addEventListener('pointerup',event=>{
    if(!current()||state.pointerId!==event.pointerId)return;consume(event);
    if(state.tool==='scribble'){append(point(event));finish();}
    else{release();state.hover=null;preview();}
  },true);
  workspace.addEventListener('pointercancel',event=>{if(current()){consume(event);cancel();status('Drawing cancelled.');}},true);
  workspace.addEventListener('dblclick',event=>{if(current()){consume(event);finish();}},true);
  workspace.addEventListener('contextmenu',event=>{if(current()){consume(event);finish();}},true);
  document.addEventListener('keydown',event=>{
    if(!current())return;
    if(event.key==='Escape'){consume(event);cancel();status('Drawing cancelled.');}
    else if(event.key==='Enter'){consume(event);finish();}
    else if(event.key==='Backspace'||event.key==='Delete'){consume(event);state.points.pop();preview();}
  },true);
  document.addEventListener('pointerdown',event=>{if(state&&!workspace.contains(event.target))cancel();},true);
  window.addEventListener('blur',()=>cancel());
  return {cancel,start(tool){
    if(!names[tool])return;cancel();prepare();
    state={tool,points:[],hover:null,pointerId:null,context:context()};workspace.classList.add('shape-drawing');workspace.focus({preventScroll:true});
    status(tool==='scribble'?'Scribble: drag on the canvas; release to finish. Escape cancels.':`${names[tool]}: click points; double-click or Enter to finish.${tool==='freeform'?' Click the first point to close and fill.':''} Escape cancels.`);
  }};
}
