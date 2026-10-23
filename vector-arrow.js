// Filled arrow outlines use ordinary shape paths in every renderer/exporter.
// Editing coordinates live in a fixed reference box, so stretching an arrow
// and then editing a point does not unexpectedly change its other proportions.
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const mix = (a,b,t) => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
export const ARROW_DRAWING_TOOLS = ['drawCurveArrow','drawPolylineArrow'];
export const ARROW_PRESETS = [
  {id:'arcVectorArrow',name:'Arc arrow',width:220,height:120},
  {id:'sweepVectorArrow',name:'Sweeping arrow',width:220,height:140},
  {id:'fadedVectorArrow',name:'Fading curved arrow',width:220,height:140},
  {id:'polylineVectorArrow',name:'Polyline arrow',width:220,height:120},
  {id:'drawCurveArrow',name:'Draw curved arrow'},
  {id:'drawPolylineArrow',name:'Draw polyline arrow'},
];

export function validateEditableArrow(a) {
  const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(!a || !['curve','polyline'].includes(a.kind) || !['triangle','stealth'].includes(a.headStyle) || !['end','both'].includes(a.heads)
    || !finite(a.viewWidth,1,100000) || !finite(a.viewHeight,1,100000)
    || !finite(a.shaftWidth,.1,10000) || !finite(a.headWidth,.1,10000) || !finite(a.headLength,.1,10000) || !finite(a.tailWidth,0,1)
    || !Array.isArray(a.points) || a.points.length<2 || a.points.length>32
    || a.points.some(p=>!p || !finite(p.x,-10,10) || !finite(p.y,-10,10))) throw new Error('Invalid editable arrow geometry.');
  return {kind:a.kind,viewWidth:a.viewWidth,viewHeight:a.viewHeight,shaftWidth:a.shaftWidth,headWidth:a.headWidth,headLength:a.headLength,
    tailWidth:a.tailWidth,headStyle:a.headStyle,heads:a.heads,points:a.points.map(p=>({x:p.x,y:p.y}))};
}

function centerline(a) {
  const nodes=a.points.map(p=>({x:p.x*a.viewWidth,y:p.y*a.viewHeight})).filter((p,i,all)=>!i||distance(p,all[i-1])>1e-6);
  if(nodes.length<2)return [nodes[0],{x:nodes[0].x+.01,y:nodes[0].y}];
  if(a.kind==='polyline')return nodes;
  const result=[nodes[0]];
  for(let i=0;i<nodes.length-1;i++) {
    const p0=nodes[Math.max(0,i-1)],p1=nodes[i],p2=nodes[i+1],p3=nodes[Math.min(nodes.length-1,i+2)];
    for(let j=1;j<=20;j++) {
      const t=j/20,u=1-t;
      result.push({x:u*u*u*p1.x+3*u*u*t*(p1.x+(p2.x-p0.x)/6)+3*u*t*t*(p2.x-(p3.x-p1.x)/6)+t*t*t*p2.x,
        y:u*u*u*p1.y+3*u*u*t*(p1.y+(p2.y-p0.y)/6)+3*u*t*t*(p2.y-(p3.y-p1.y)/6)+t*t*t*p2.y});
    }
  }
  return result;
}

function outline(a) {
  const line=centerline(a),lengths=[0];
  for(let i=1;i<line.length;i++)lengths.push(lengths[i-1]+distance(line[i-1],line[i]));
  const total=lengths.at(-1),headLength=Math.min(a.headLength,total*(a.heads==='both'?.3:.45));
  const headWidth=Math.max(a.shaftWidth,Math.min(a.headWidth,total*.8));
  const at=s=>{
    const i=Math.max(1,lengths.findIndex(l=>l>=s));
    return mix(line[i-1],line[i],(s-lengths[i-1])/Math.max(1e-9,lengths[i]-lengths[i-1]));
  };
  const notch=a.headStyle==='stealth'?.68:1;
  const begin=a.heads==='both'?headLength*notch:0,end=total-headLength*notch;
  const shaft=[{p:at(begin),s:begin},...line.map((p,i)=>({p,s:lengths[i]})).filter(v=>v.s>begin&&v.s<end),{p:at(end),s:end}];
  const unit=(p,q)=>{const d=distance(p,q)||1;return {x:(q.x-p.x)/d,y:(q.y-p.y)/d};};
  const side=(sign)=>shaft.map(({p,s},i)=>{
    const before=unit(shaft[Math.max(0,i-1)].p,p),after=unit(p,shaft[Math.min(shaft.length-1,i+1)].p);
    const incoming=i?before:after,outgoing=i===shaft.length-1?before:after;
    const sum={x:incoming.x+outgoing.x,y:incoming.y+outgoing.y},d=Math.hypot(sum.x,sum.y);
    const tangent=d>1e-6?{x:sum.x/d,y:sum.y/d}:outgoing;
    const radius=a.shaftWidth/2*(a.heads==='both'?1:a.tailWidth+(1-a.tailWidth)*s/Math.max(end,1e-9));
    const offset=Math.min(radius/Math.max(.01,tangent.x*outgoing.x+tangent.y*outgoing.y),radius*2.5);
    return {x:p.x-sign*tangent.y*offset,y:p.y+sign*tangent.x*offset};
  });
  const head=(start=false)=>{
    const tip=start?line[0]:line.at(-1),base=at(start?headLength:total-headLength),direction=unit(base,tip);
    return [{x:base.x-direction.y*headWidth/2,y:base.y+direction.x*headWidth/2},tip,
      {x:base.x+direction.y*headWidth/2,y:base.y-direction.x*headWidth/2}];
  };
  return [...side(1),...head(),...side(-1).reverse(),...(a.heads==='both'?head(true):[])];
}

export function arrowPaths(a) {
  return [{commands:[...outline(a).map((p,i)=>[i?'L':'M',p.x/a.viewWidth,p.y/a.viewHeight]),['Z']],fillMode:'norm',stroke:true}];
}

// Refit the box around the outline while retaining every point's world position,
// including on rotated or non-uniformly stretched arrows.
export function rebuildArrow(item) {
  const a=item.editableArrow,polygon=outline(a);
  const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y),left=Math.min(...xs),top=Math.min(...ys);
  const width=Math.max(1,Math.max(...xs)-left),height=Math.max(1,Math.max(...ys)-top);
  const sx=item.width/a.viewWidth,sy=item.height/a.viewHeight;
  const dx=(left+width/2)*sx-item.width/2,dy=(top+height/2)*sy-item.height/2;
  const angle=(item.rotation??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  item.x+=(item.width-width*sx)/2+c*dx-s*dy;
  item.y+=(item.height-height*sy)/2+s*dx+c*dy;
  a.points=a.points.map(p=>({x:(p.x*a.viewWidth-left)/width,y:(p.y*a.viewHeight-top)/height}));
  a.viewWidth=width;a.viewHeight=height;item.width=width*sx;item.height=height*sy;
  item.paths=arrowPaths(a);
  return item;
}

export function createVectorArrow(kind,points,{fade=false}={}) {
  if(!['curve','polyline'].includes(kind))throw new Error('Unknown arrow drawing tool.');
  points=points.filter((p,i)=>!i||distance(p,points[i-1])>.01);
  if(points.length<2)return null;
  if(points.length>32||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error('Arrows support 2–32 points.');
  const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
  const width=Math.max(1,Math.max(...points.map(p=>p.x))-x),height=Math.max(1,Math.max(...points.map(p=>p.y))-y);
  const item={type:'shape',name:kind==='curve'?'Curved vector arrow':'Polyline vector arrow',x,y,width,height,rotation:0,
    fill:'#596675',stroke:'none',strokeWidth:0,fillOpacity:1,strokeOpacity:1,strokeDash:'solid',
    editableArrow:{kind,viewWidth:width,viewHeight:height,points:points.map(p=>({x:(p.x-x)/width,y:(p.y-y)/height})),
      shaftWidth:6,headWidth:23,headLength:25,tailWidth:kind==='curve'?.15:1,headStyle:'stealth',heads:'end'}};
  rebuildArrow(item);
  if(fade)fadeArrow(item);
  return item;
}

export function fadeArrow(item) {
  const a=item.editableArrow,start=a.points[0],end=a.points.at(-1);
  const angle=Math.atan2((end.y-start.y)*item.height,(end.x-start.x)*item.width)*180/Math.PI;
  const color=/^#[\da-f]{6}$/i.test(item.fill)?item.fill:'#596675';
  item.fillGradient={angle,stops:[{offset:0,color:color+'00'},{offset:.35,color:color+'88'},{offset:1,color}]};
}

export function createArrowPreset(key) {
  const points=key==='arcVectorArrow'?[{x:10,y:110},{x:45,y:35},{x:130,y:15},{x:210,y:100}]
    :key==='polylineVectorArrow'?[{x:0,y:0},{x:80,y:0},{x:80,y:95},{x:220,y:95}]
    :[{x:210,y:10},{x:95,y:12},{x:40,y:75},{x:60,y:160}];
  const item=createVectorArrow(key==='polylineVectorArrow'?'polyline':'curve',points,{fade:key==='fadedVectorArrow'});
  item.name=ARROW_PRESETS.find(p=>p.id===key).name;
  item.x=80;item.y=80;
  return item;
}

export function arrowLocalPoint(item,world) {
  const angle=-(item.rotation??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const x=world.x-item.x-item.width/2,y=world.y-item.y-item.height/2;
  return {x:(c*x-s*y+item.width/2)/item.width,y:(s*x+c*y+item.height/2)/item.height};
}

export function moveArrowPoint(item,index,world) {
  const p=arrowLocalPoint(item,world);
  item.editableArrow.points[index]={x:clamp(p.x,-9,9),y:clamp(p.y,-9,9)};
  return rebuildArrow(item);
}
