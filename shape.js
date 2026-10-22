/** Bounded, portable vector geometry. Coordinates are relative to the object's size. */
const MODES = ['norm', 'none', 'darkenLess', 'darken', 'lightenLess', 'lighten'];
const COLORS = { black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000', blue:'#0000ff', gray:'#808080', grey:'#808080', none:'#00000000', transparent:'#00000000' };
const invalid = () => { throw new Error('Invalid figure shape geometry or gradient.'); };
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const colorOK = c => typeof c === 'string' && (/^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(c) || Object.hasOwn(COLORS,c.toLowerCase()));
export function validateShape(item) {
  if (!Array.isArray(item.paths) || !item.paths.length || item.paths.length > 32) invalid();
  let count = 0;
  const paths = item.paths.map(path => {
    if (!path || !MODES.includes(path.fillMode) || typeof path.stroke !== 'boolean' || !Array.isArray(path.commands) || !path.commands.length || path.commands[0]?.[0] !== 'M') invalid();
    const commands = path.commands.map(command => {
      if (++count > 2048 || !Array.isArray(command) || !Object.hasOwn({M:3,L:3,C:7,Z:1},command[0]) || command.length !== ({M:3,L:3,C:7,Z:1})[command[0]] || !command.slice(1).every(n => finite(n,-100,100))) invalid();
      return [...command];
    });
    return { commands, fillMode:path.fillMode, stroke:path.stroke };
  });
  return {paths,...(item.fillGradient !== undefined ? {fillGradient:validateGradient(item.fillGradient)} : {})};
}
export function validateGradient(g) {
  if (!g || !finite(g.angle,-36000,36000) || !Array.isArray(g.stops) || g.stops.length < 2 || g.stops.length > 16) invalid();
  if (g.type !== undefined && !['linear','radial'].includes(g.type)) invalid();
  if (g.center !== undefined && (!g.center || !finite(g.center.x,0,1) || !finite(g.center.y,0,1))) invalid();
  if (g.rotateWithShape !== undefined && typeof g.rotateWithShape !== 'boolean') invalid();
  let previous=-1;
  const stops=g.stops.map(s=>{
    if(!s || !finite(s.offset,0,1) || s.offset<previous || !colorOK(s.color))invalid();
    if(s.brightness !== undefined && !finite(s.brightness,-100,100))invalid();
    previous=s.offset;return {offset:s.offset,color:s.color,...(s.brightness !== undefined ? {brightness:s.brightness} : {})};
  });
  // Keep legacy gradients byte-for-byte compatible; defaults are interpreted by paint code.
  return {angle:g.angle,stops,...(g.type !== undefined ? {type:g.type} : {}),
    ...(g.center !== undefined ? {center:{x:g.center.x,y:g.center.y}} : {}),
    ...(g.rotateWithShape !== undefined ? {rotateWithShape:g.rotateWithShape} : {})};
}
export function cloneShape(item) {
  return {
    ...(item.type==='shape' ? {paths:item.paths.map(p=>({...p,commands:p.commands.map(c=>[...c])}))} : {}),
    ...Object.fromEntries(['fillGradient','strokeGradient'].filter(key=>item[key]).map(key=>[key,{...item[key],...(item[key].center ? {center:{...item[key].center}} : {}),stops:item[key].stops.map(s=>({...s}))}])),
  };
}

export function shadeColor(value, mode='norm') {
  let c = COLORS[value.toLowerCase()] || value;
  if (c.length === 4 || c.length === 5) c = '#'+[...c.slice(1)].map(v=>v+v).join('');
  if (mode === 'none') return 'none';
  const factor = {darkenLess:.8,darken:.6,lightenLess:.2,lighten:.4}[mode];
  if (factor === undefined) return c;
  const channels = [1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
  return '#'+channels.map(v=>Math.round(mode.startsWith('darken') ? v*factor : v+(255-v)*factor).toString(16).padStart(2,'0')).join('')+c.slice(7);
}
/** PowerPoint brightness adjusts HSL luminance, leaving hue, saturation and alpha intact. */
export function gradientStopColor(stop) {
  const c=shadeColor(stop.color),amount=(stop.brightness??0)/100;
  if (!amount) return c;
  const rgb=[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255);
  const hi=Math.max(...rgb),lo=Math.min(...rgb),l=(hi+lo)/2,chroma=hi-lo;
  const lightness=amount>0 ? l+(1-l)*amount : l*(1+amount);
  const saturation=chroma===0 ? 0 : chroma/(1-Math.abs(2*l-1));
  const nextChroma=(1-Math.abs(2*lightness-1))*saturation;
  return '#'+rgb.map(v=>Math.round(Math.max(0,Math.min(1,chroma===0 ? lightness : lightness+(v-l)*nextChroma/chroma))*255).toString(16).padStart(2,'0')).join('')+c.slice(7);
}
export function shapeBounds(item) {
  let l=0,t=0,r=item.width,b=item.height;
  for (const path of item.paths) for (const c of path.commands) for (let j=1;j<c.length;j+=2) {
    const x=c[j]*item.width,y=c[j+1]*item.height;
    l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  const pad=(!item.strokeGradient&&item.stroke==='none')||(item.strokeOpacity??1)===0 ? 0 : item.strokeWidth*2; // Include the bounded miter join.
  return {x:l-pad,y:t-pad,width:r-l+2*pad,height:b-t+2*pad};
}
const n = v => Number(v.toFixed(6));
/** User-space paint servers also work on horizontal and vertical zero-area lines. */
export function gradientSVG(item,g,id,mode='norm',stroke=false) {
  id=String(id).replace(/[^a-zA-Z0-9_-]/g,'-');
  const w=Math.max(item.width,stroke?item.strokeWidth:0,.01),h=Math.max(item.height,stroke?item.strokeWidth:0,.01);
  const stops=g.stops.map(s=>`<stop offset="${n(s.offset)}" stop-color="${shadeColor(gradientStopColor(s),mode)}"/>`).join('');
  // PDF raster patches keep geometry local, but must retain the original slide orientation.
  const rotation=g.rotateWithShape===false ? -(item.gradientRotation??item.rotation??0) : 0;
  const rotate=rotation ? `rotate(${n(rotation)} ${n(item.width/2)} ${n(item.height/2)})` : '';
  if (g.type==='radial') {
    // DrawingML circle gradients use a circumscribing circle; fillToRect is
    // relative to its square bounds, rather than stretching a circle to an ellipse.
    const center=g.center??{x:.5,y:.5},radius=Math.hypot(w,h)/2,cx=item.width/2,cy=item.height/2;
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" fx="${n(cx+radius*(2*center.x-1))}" fy="${n(cy+radius*(2*center.y-1))}"${rotate ? ` gradientTransform="${rotate}"` : ''}>${stops}</radialGradient>`;
  }
  const a=g.angle*Math.PI/180,dx=Math.cos(a),dy=Math.sin(a),norm=Math.max(Math.abs(dx),Math.abs(dy));
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(item.width/2-dx/norm*w/2)}" y1="${n(item.height/2-dy/norm*h/2)}" x2="${n(item.width/2+dx/norm*w/2)}" y2="${n(item.height/2+dy/norm*h/2)}"${rotate ? ` gradientTransform="${rotate}"` : ''}>${stops}</linearGradient>`;
}
export function shapeSVG(item, id) {
  // IDs come from project IDs, but also constrain callers to inert identifiers.
  id = String(id).replace(/[^a-zA-Z0-9_-]/g,'-');
  let definitions='', result='',stroke=item.stroke;
  if(item.strokeGradient) {
    const name=`${id}-stroke-gradient`;definitions+=gradientSVG(item,item.strokeGradient,name,'norm',true);stroke=`url(#${name})`;
  }
  for (const [index,path] of item.paths.entries()) {
    let fill = shadeColor(item.fill,path.fillMode);
    if (item.fillGradient && path.fillMode !== 'none') {
      const name=`${id}-gradient-${index}`;
      definitions+=gradientSVG(item,item.fillGradient,name,path.fillMode);
      fill=`url(#${name})`;
    }
    const d=path.commands.map(c=>c[0]+c.slice(1).map((v,j)=>n(v*(j%2 ? item.height : item.width))).join(' ')).join(' ');
    const dash=item.strokeDash==='dash' ? `${4*item.strokeWidth} ${3*item.strokeWidth}` : item.strokeDash==='dot' ? `${item.strokeWidth} ${2*item.strokeWidth}` : 'none';
    result+=`<path d="${d}" fill="${fill}" fill-opacity="${n(item.fillOpacity??1)}" stroke="${path.stroke ? stroke : 'none'}" stroke-opacity="${n(item.strokeOpacity??1)}" stroke-width="${item.strokeWidth}" stroke-dasharray="${dash}" stroke-linejoin="miter" stroke-miterlimit="4"/>`;
  }
  return (definitions ? `<defs>${definitions}</defs>` : '')+result;
}
