/** Bounded, portable vector geometry. Coordinates are relative to the object's size. */
const MODES = ['norm', 'none', 'darkenLess', 'darken', 'lightenLess', 'lighten'];
const COLORS = { black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000', blue:'#0000ff', gray:'#808080', grey:'#808080', none:'#00000000', transparent:'#00000000' };
const invalid = () => { throw new Error('Invalid figure shape geometry.'); };
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
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
  return {paths};
}
export function cloneShape(item) {
  return item.type === 'shape' ? {paths:item.paths.map(p=>({...p,commands:p.commands.map(c=>[...c])}))} : {};
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
export function shapeBounds(item) {
  let l=0,t=0,r=item.width,b=item.height;
  for (const path of item.paths) for (const c of path.commands) for (let j=1;j<c.length;j+=2) {
    const x=c[j]*item.width,y=c[j+1]*item.height;
    l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
  }
  const pad=item.stroke==='none'||(item.strokeOpacity??1)===0 ? 0 : item.strokeWidth*2; // Include the bounded miter join.
  return {x:l-pad,y:t-pad,width:r-l+2*pad,height:b-t+2*pad};
}
const n = v => Number(v.toFixed(6));
/** Paints only; object opacity belongs to the enclosing group. */
export function shapeSVG(item) {
  let result = '';
  for (const path of item.paths) {
    const fill = shadeColor(item.fill,path.fillMode);
    const d=path.commands.map(c=>c[0]+c.slice(1).map((v,j)=>n(v*(j%2 ? item.height : item.width))).join(' ')).join(' ');
    const dash=item.strokeDash==='dash' ? `${4*item.strokeWidth} ${3*item.strokeWidth}` : item.strokeDash==='dot' ? `${item.strokeWidth} ${2*item.strokeWidth}` : 'none';
    result+=`<path d="${d}" fill="${fill}" fill-opacity="${n(item.fillOpacity??1)}" stroke="${path.stroke ? item.stroke : 'none'}" stroke-opacity="${n(item.strokeOpacity??1)}" stroke-width="${item.strokeWidth}" stroke-dasharray="${dash}" stroke-linejoin="miter" stroke-miterlimit="4"/>`;
  }
  return result;
}
