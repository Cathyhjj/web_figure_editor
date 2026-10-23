/** M/L/C/Z commands shared with PDF and native PowerPoint custom arrow paths. */
export function shapePath(item) {
  const w = item.width, h = item.height, k = 0.5522847498307936;
  if (['line', 'arrow', 'doubleArrow'].includes(item.type)) {
    const commands = item.connector === 'elbow' ? [['M',0,0],['L',w/2,0],['L',w/2,h],['L',w,h]]
      : item.connector === 'curved' ? [['M',0,0],['C',w/4,0,w/2,h/4,w/2,h/2],['C',w/2,3*h/4,3*w/4,h,w,h]] : [['M', 0, 0], ['L', w, h]];
    return commands.map(([op,...values]) => [op,...values.map((v,i) => i%2 ? (item.connectorFlipY ? h-v : v) : (item.connectorFlipX ? w-v : v))]);
  }
  if (item.type === 'ellipse') {
    const x = w / 2, y = h / 2;
    return [['M', w, y], ['C', w, y + k * y, x + k * x, h, x, h],
      ['C', x - k * x, h, 0, y + k * y, 0, y],
      ['C', 0, y - k * y, x - k * x, 0, x, 0],
      ['C', x + k * x, 0, w, y - k * y, w, y], ['Z']];
  }
  const r = item.type === 'roundRect' ? Math.min(w, h) * (item.cornerRadius ?? 1 / 6) : 0;
  if (!r) return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
  const c = r * (1 - k);
  return [['M', r, 0], ['L', w - r, 0], ['C', w - c, 0, w, c, w, r],
    ['L', w, h - r], ['C', w, h - c, w - c, h, w - r, h],
    ['L', r, h], ['C', c, h, 0, h - c, 0, h - r],
    ['L', 0, r], ['C', 0, c, c, 0, r, 0], ['Z']];
}

/** Tight bounds of cubic paths, including extrema between endpoints, after rotation. */
export function gradientBounds(item, rotation = 0) {
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = item.width / 2, cy = item.height / 2;
  const point = (x, y) => [cx + (x-cx)*cos - (y-cy)*sin, cy + (x-cx)*sin + (y-cy)*cos];
  const paths = item.type === 'shape'
    ? item.paths.map(p => p.commands.map(([op,...v]) => [op,...v.map((x,i) => x*(i%2 ? item.height : item.width))]))
    : [shapePath(item)];
  let left=Infinity, top=Infinity, right=-Infinity, bottom=-Infinity;
  const include = ([x,y]) => { left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y); };
  for (const path of paths) {
    let start, current;
    for (const [op,...v] of path) {
      if (op === 'Z') { current=start;continue; }
      const points=[];
      for(let i=0;i<v.length;i+=2) points.push(point(v[i],v[i+1]));
      if(op==='C' && current) {
        const [p1,p2,p3]=points,p0=current;
        for(let axis=0;axis<2;axis++) {
          const a=-p0[axis]+3*p1[axis]-3*p2[axis]+p3[axis],b=2*(p0[axis]-2*p1[axis]+p2[axis]),c=p1[axis]-p0[axis];
          const discriminant=b*b-4*a*c;
          const roots=Math.abs(a)<1e-12 ? (Math.abs(b)<1e-12 ? [] : [-c/b]) : discriminant<0 ? [] : [(-b+Math.sqrt(discriminant))/(2*a),(-b-Math.sqrt(discriminant))/(2*a)];
          for(const t of roots) if(t>0 && t<1) include([0,1].map(j=>(1-t)**3*p0[j]+3*(1-t)**2*t*p1[j]+3*(1-t)*t*t*p2[j]+t**3*p3[j]));
        }
      }
      current=points.at(-1);include(current);
      if(op==='M')start=current;
    }
  }
  return {x:left,y:top,width:right-left,height:bottom-top};
}
