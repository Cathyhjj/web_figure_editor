/** Static SVG documents stay vector. Render only as image URLs, never as page markup. */
const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'title', 'desc', 'style', 'image', 'switch',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'filter',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG',
  'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);
export const SVG_NS = 'http://www.w3.org/2000/svg';

function checkCss(css) {
  const value = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // No CSS escapes, imports, font downloads, or dynamic image functions.
  if (/[\\@]/.test(value) || /(?:expression|image-set|cross-fade|paint|image|src)\s*\(/i.test(value)) {
    throw new Error('The SVG contains unsupported dynamic styles or external resources. Export it as a self-contained static image.');
  }
  const withoutLocalUrls = value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, '');
  if (/url\s*\(/i.test(withoutLocalUrls)) throw new Error('The SVG references external resources. Embed its images and fonts, or export a PNG.');
}

function svgLength(value) {
  const match = String(value || '').trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(px|pt|pc|in|cm|mm|q)?$/i);
  if (!match) return null;
  const factor = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  return Number(match[1]) * (factor[(match[2] || 'px').toLowerCase()]);
}

const fail = message => { throw new Error(`Invalid SVG: ${message}`); };
const escapeXML = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const XLINK = 'http://www.w3.org/1999/xlink';

/** This pure validator also runs on project/clipboard JSON, without trusting import history. */
export function validateSVGDocument(input) {
  let count=0, size=0;
  const visit=(node,depth=0)=>{
    if (++count>100000 || depth>128) fail('document is too complex.');
    if(typeof node==='string') {
      size+=node.length;
      if(size>25*1024*1024)fail('document exceeds 25 MB.');
      if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(node))fail('invalid XML characters.');
      return node;
    }
    if(!node || typeof node!=='object' || !SVG_TAGS.has(node.tag) || !node.attrs || typeof node.attrs!=='object' || Array.isArray(node.attrs) || !Array.isArray(node.children))fail('unsupported MIME or missing static SVG document.');
    const attrs={};
    for(const [key,value] of Object.entries(node.attrs)) {
      if(typeof value!=='string' || !/^(?:[A-Za-z_][\w.-]*|xlink:href|xml:space|xmlns:xlink)$/.test(key) || /^on/i.test(key) || key==='src')fail('unsupported attribute.');
      visit(value,depth+1);
      if(key==='xmlns' && value!==SVG_NS || key==='xmlns:xlink' && value!==XLINK)fail('unsupported namespace.');
      if(key==='href' || key==='xlink:href') {
        if(!/^#[\w:.-]+$/.test(value) && !(['image','feImage'].includes(node.tag) && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value)))fail('external or active image reference.');
      }
      checkCss(value);
      Object.defineProperty(attrs,key,{value,enumerable:true,writable:true,configurable:true});
    }
    const children=node.children.map(child=>visit(child,depth+1));
    if(node.tag==='style') {
      if(children.some(c=>typeof c!=='string'))fail('invalid stylesheet.');
      checkCss(children.join(''));
    }
    return {tag:node.tag,attrs,children};
  };
  const result=visit(input);
  if(result.tag!=='svg')fail('root must be SVG.');
  result.attrs.xmlns=SVG_NS;result.attrs['xmlns:xlink']=XLINK;
  svgDimensions(result);
  return result;
}

export function svgDimensions(root) {
  const vb=(root.attrs.viewBox||'').trim().split(/[\s,]+/).map(Number);
  const valid=vb.length===4 && vb.every(Number.isFinite) && vb[2]>0 && vb[3]>0;
  let width=svgLength(root.attrs.width),height=svgLength(root.attrs.height);
  if(valid) {
    if(!width&&!height)[width,height]=vb.slice(2);
    else if(!width)width=height*vb[2]/vb[3];
    else if(!height)height=width*vb[3]/vb[2];
  }
  width ||= 300;height ||= 150;
  if(!Number.isFinite(width+height)||width<1||height<1||width>100000||height>100000)fail('invalid dimensions.');
  return {width,height,viewBox:valid?vb:[0,0,width,height]};
}

export function parseSVG(source) {
  if(typeof source!=='string'||source.length>25*1024*1024)fail('source exceeds 25 MB.');
  if(/<!ENTITY\b|<!DOCTYPE[^>]*\[|<\?xml-stylesheet\b/i.test(source))fail('entities or external stylesheets are unsupported.');
  const doc=new DOMParser().parseFromString(source.replace(/<!DOCTYPE[^>]*>/gi,''),'image/svg+xml');
  if(doc.getElementsByTagName('parsererror').length)fail('invalid XML.');
  const read=(el,depth=0)=>{
    if(depth>128)fail('document is too deeply nested.');
    if(el.nodeType===3||el.nodeType===4)return el.nodeValue;
    if(el.nodeType!==1)return null;
    if(el.localName==='metadata'||el.namespaceURI&&el.namespaceURI!==SVG_NS)return null;
    const attrs={};
    for(const a of el.attributes) {
      if(a.name.startsWith('xmlns:')&&a.value!==XLINK)continue;
      if(a.namespaceURI && !['http://www.w3.org/2000/xmlns/','http://www.w3.org/XML/1998/namespace',XLINK].includes(a.namespaceURI))continue;
      attrs[a.namespaceURI===XLINK?'xlink:'+a.localName:a.name]=a.value;
    }
    return {tag:el.localName,attrs,children:[...el.childNodes].map(c=>read(c,depth+1)).filter(c=>c!==null)};
  };
  const root=validateSVGDocument(read(doc.documentElement));
  const {width,height,viewBox}=svgDimensions(root);
  root.attrs.width=String(width);root.attrs.height=String(height);
  if(!root.attrs.viewBox)root.attrs.viewBox=viewBox.join(' ');
  return {document:root,width,height};
}

export function serializeSVG(document) {
  const write=node=>typeof node==='string'?escapeXML(node):`<${node.tag}${Object.entries(node.attrs).map(([k,v])=>` ${k}="${escapeXML(v)}"`).join('')}>${node.children.map(write).join('')}</${node.tag}>`;
  return write(validateSVGDocument(document));
}
export function svgDataURL(document) {
  const bytes=new TextEncoder().encode(serializeSVG(document)),parts=[];
  for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return 'data:image/svg+xml;base64,'+btoa(parts.join(''));
}
export function svgNodes(document) {
  const result=[];
  const visit=(node,path=[])=>{
    if(typeof node==='string')return;
    result.push({node,path});node.children.forEach((child,index)=>visit(child,[...path,index]));
  };
  visit(document);return result;
}

/** Root transform preserves child-selector relationships, definitions and references. */
export function mirrorSVG(document,flipX,flipY) {
  const root=validateSVGDocument(document),[x,y,w,h]=svgDimensions(root).viewBox;
  root.attrs['transform-origin']='0 0';
  root.attrs.transform=`translate(${flipX?2*x+w:0} ${flipY?2*y+h:0}) scale(${flipX?-1:1} ${flipY?-1:1}) ${root.attrs.transform||''}`.trim();
  return root;
}
