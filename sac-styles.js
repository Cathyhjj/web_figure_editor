import { createProject, projectToSVG, uid } from './core.js';
import { SAC_PALETTE as P, SAC_TEXT_STYLE, sacShapeStyle } from './sac-theme.js';
import { SAC_MOTIFS } from './sac-motifs.js';

import { SAC_POSTER_STYLES, posterLayers, posterPreviewAssets } from './sac-poster.js';

export const SAC_STYLES = Object.freeze([
  ...SAC_POSTER_STYLES,
  { id:'section-panel', name:'Section panel', category:'Frames & headings', width:340, height:230 },
  { id:'title-band', name:'Blue title band', category:'Frames & headings', width:400, height:80 },
  { id:'panel-outline', name:'Fine panel frame', category:'Frames & headings', width:280, height:250 },
  { id:'lavender-capsule', name:'Lavender rounded card', category:'Frames & headings', width:260, height:100 },
  { id:'blush-card', name:'Blush card', category:'Frames & headings', width:260, height:90 },
  { id:'subtle-divider', name:'Soft blue divider', category:'Lines & connectors', width:320, height:2 },
  { id:'luminous-divider', name:'Fading divider', category:'Lines & connectors', width:320, height:3 },
  ...['peach','coral','magenta','purple'].map(color => ({ id:`connector-${color}`, name:`${color[0].toUpperCase()+color.slice(1)} dot connector`, category:'Lines & connectors', width:180, height:95, color })),
  { id:'fading-block-arrow', name:'Fading blue arrow', category:'Lines & connectors', width:150, height:70 },
  { id:'fading-u-turn-arrow', name:'Fading U-turn arrow', category:'Lines & connectors', width:280, height:75 },
  { id:'pastel-highlight', name:'Pastel highlight', category:'Soft accents', width:280, height:150 },
  { id:'purple-orb', name:'Purple glass orb', category:'Soft accents', width:120, height:120 },
  { id:'blue-node', name:'Blue glass node', category:'Soft accents', width:80, height:80 },
  { id:'feathered-paper', name:'Feathered paper strip', category:'Soft accents', width:320, height:24 },
].map(Object.freeze));

const box = (x,y,width,height,extra={}) => ({type:'rect',x,y,width,height,...sacShapeStyle(),...extra});
const text = (x,y,width,height,value,size,color) => ({type:'text',x,y,width,height,...SAC_TEXT_STYLE,text:value,fontSize:size,fontWeight:700,color});

// Rotation-aware group bounds keep source layers and endpoint dots together.
function bounds(items) {
  const points=items.flatMap(i=>{
    const a=(i.rotation||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),cx=i.x+i.width/2,cy=i.y+i.height/2;
    return [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]].map(([x,y])=>({x:cx+c*x*i.width-s*y*i.height,y:cy+s*x*i.width+c*y*i.height}));
  });
  const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
  return {x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y};
}
function scaleItems(items,scale,x=0,y=0) {
  for(const i of items) {
    i.x=i.x*scale+x;i.y=i.y*scale+y;i.width*=scale;i.height*=scale;
    for(const key of ['fontSize','strokeWidth','softEdge'])if(i[key]!==undefined)i[key]*=scale;
    if(i.shadow)for(const key of ['blur','distance'])i.shadow[key]*=scale;
  }
  return items;
}
function sourceItems(entry) {
  if(entry.id==='section-panel')return [
    box(0,0,340,230,{fill:'none'}),
    text(14,10,312,28,'SECTION TITLE',20,P.blue),
    box(14,46,312,1.2,{fill:P.divider,stroke:'none',strokeWidth:0}),
  ];
  if(entry.id==='title-band')return [
    box(0,0,400,80,{fill:P.navy,stroke:'none',strokeWidth:0}),
    box(0,68,400,12,{fill:P.blue,stroke:'none',strokeWidth:0}),
    text(20,14,360,40,'YOUR TITLE',28,P.paper),
  ];
  const items=entry.parts ? posterLayers(entry.parts) : structuredClone(SAC_MOTIFS[entry.color?'ecosystem-connector':entry.id]);
  if(entry.id==='luminous-divider') {
    // The original divider sat on navy. Fade to transparent for any canvas.
    Object.assign(items[0],{width:320,height:2,rotation:0});
    items[0].fillGradient={angle:0,stops:[{offset:0,color:P.blue+'00'},{offset:.2,color:P.divider},{offset:.8,color:P.divider},{offset:1,color:P.blue+'00'}]};
  }
  const b=bounds(items),scale=Math.min(entry.width/b.width,entry.height/b.height);
  scaleItems(items,scale,-b.x*scale,-b.y*scale);
  if(entry.id==='panel-outline')items[0].strokeWidth=2;
  if(entry.color) {
    items[0].stroke=P[entry.color]+'db';items[0].strokeWidth=2.7;
    const dot=items[1],cx=dot.x+dot.width/2,cy=dot.y+dot.height/2;
    Object.assign(dot,{x:cx-4,y:cy-4,width:8,height:8,fill:P[entry.color]});
  }
  return items;
}

/** Fresh ordinary editable objects, centered and fitted to the current slide. */
export function createSACStyle(id,canvas={width:960,height:640}) {
  const entry=SAC_STYLES.find(e=>e.id===id);
  if(!entry)throw new Error('Choose a SAC style.');
  const items=sourceItems(entry),b=bounds(items);
  const scale=Math.min(1,canvas.width*.8/Math.max(1,b.width),canvas.height*.8/Math.max(1,b.height));
  scaleItems(items,scale,(canvas.width-b.width*scale)/2-b.x*scale,(canvas.height-b.height*scale)/2-b.y*scale);
  return items.map((item,index)=>({id:uid(),name:`SAC · ${entry.name}${items.length>1?` · ${index+1}`:''}`,rotation:0,opacity:1,hidden:false,locked:false,...item,
    ...(item.name ? {name:`SAC · ${entry.name} · ${item.name}`} : {}),
    ...(item.type==='text' ? {fontSize:Math.max(1,item.fontSize)} : {})}));
}

export function sacStylePreview(id) {
  const entry=SAC_STYLES.find(e=>e.id===id),project=createProject();
  project.canvas={width:entry.width+36,height:entry.height+36,background:id==='feathered-paper'?'#e7ebf1':'#ffffff'};
  project.items=createSACStyle(id,project.canvas);
  project.assets=posterPreviewAssets(project.items);
  return projectToSVG(project).replace(/<metadata>[\s\S]*?<\/metadata>/,'').replace('<svg ','<svg aria-hidden="true" ');
}

export function initSACStyles(menu,{insert}) {
  menu.replaceChildren();
  const heading=document.createElement('h2');heading.textContent='SAC styles';menu.append(heading);
  const hint=document.createElement('p');hint.className='sac-hint';hint.textContent='Choose a full layout, a row or an individual shape.';menu.append(hint);
  const search=document.createElement('input');search.type='search';search.placeholder='Search SAC styles';search.className='shape-search';search.setAttribute('aria-label','Search SAC styles');menu.append(search);
  const previews=new IntersectionObserver(entries=>{
    for(const {target,isIntersecting} of entries) {
      if(!isIntersecting)continue;
      target.insertAdjacentHTML('afterbegin',sacStylePreview(target.dataset.sacStyle));
      previews.unobserve(target);
    }
  },{root:menu,rootMargin:'120px'});
  for(const category of new Set(SAC_STYLES.map(e=>e.category))) {
    const section=document.createElement('section'),title=document.createElement('h3'),grid=document.createElement('div');
    section.className='sac-category';title.textContent=category;grid.className='sac-grid';section.append(title,grid);
    for(const entry of SAC_STYLES.filter(e=>e.category===category)) {
      const button=document.createElement('button'),label=document.createElement('span');button.type='button';button.dataset.sacStyle=entry.id;button.title=entry.name;button.setAttribute('aria-label',entry.name);
      label.textContent=entry.name;button.append(label);previews.observe(button);
      button.onclick=()=>{menu.hidePopover();insert(entry);};grid.append(button);
    }
    menu.append(section);
  }
  const empty=document.createElement('p');empty.className='sac-hint';empty.textContent='No matching SAC styles.';empty.hidden=true;menu.append(empty);
  search.oninput=()=>{
    let matches=0;const query=search.value.trim().toLowerCase();
    for(const section of menu.querySelectorAll('.sac-category')) {
      let visible=0;
      for(const button of section.querySelectorAll('button')){button.hidden=!button.title.toLowerCase().includes(query);if(!button.hidden)visible++;}
      section.hidden=!visible;matches+=visible;
    }
    empty.hidden=matches>0;
  };
  menu.addEventListener('toggle',event=>{if(event.newState==='open'){search.value='';search.oninput();}});
}
