/** Picture shadows use PowerPoint-style points; item geometry uses 96 CSS px/in. */
import { imageCrop } from './crop.js';
import { softEdgeSVG } from './soft-edge.js';
import { shapeBounds as vectorBounds } from './shape.js';
import { isShapeItem, shapeBounds as presetBounds, shapeSVG as presetSVG } from './shapes.js';

export const DEFAULT_SHADOW = Object.freeze({ enabled: false, color: '#000000', transparency: 60, size: 100, blur: 5, angle: 0, distance: 0 });
export const SHADOW_PRESETS = Object.freeze([
  { id: 'none', label: 'No shadow', values: { ...DEFAULT_SHADOW } },
  { id: 'soft', label: 'Soft centered', values: { ...DEFAULT_SHADOW, enabled: true } },
  { id: 'bottom-right', label: 'Offset bottom right', values: { ...DEFAULT_SHADOW, enabled: true, angle: 45, distance: 5 } },
  { id: 'bottom', label: 'Offset below', values: { ...DEFAULT_SHADOW, enabled: true, angle: 90, distance: 6, blur: 8 } },
  { id: 'hard', label: 'Hard bottom right', values: { ...DEFAULT_SHADOW, enabled: true, transparency: 45, blur: 0, angle: 45, distance: 4 } },
].map(preset => Object.freeze({ ...preset, values: Object.freeze(preset.values) })));

/** Keep old projects unchanged: callers only validate when shadow is present. */
export function validateShadow(value) {
  const fail = message => { throw new Error(`Invalid figure project: image.shadow ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object.');
  const result = {};
  const enabled = value.enabled === undefined ? DEFAULT_SHADOW.enabled : value.enabled;
  if (typeof enabled !== 'boolean') fail('enabled must be true or false.');
  result.enabled = enabled;
  const color = value.color === undefined ? DEFAULT_SHADOW.color : value.color;
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) fail('color must be a six-digit hex color.');
  result.color = color;
  for (const [key, maximum] of [['transparency', 100], ['size', 200], ['blur', 100], ['angle', 360], ['distance', 200]]) {
    const number = value[key] === undefined ? DEFAULT_SHADOW[key] : value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > maximum) fail(`${key} must be a finite number between 0 and ${maximum}.`);
    result[key] = number;
  }
  if (value.alignment !== undefined) {
    if (!['tl','t','tr','l','ctr','r','bl','b','br'].includes(value.alignment)) fail('alignment is invalid.');
    result.alignment = value.alignment;
  }
  if (value.rotateWithShape !== undefined) {
    if (typeof value.rotateWithShape !== 'boolean') fail('rotateWithShape must be boolean.');
    result.rotateWithShape = value.rotateWithShape;
  }
  return result;
}

const n = value => Number(value.toFixed(6)).toString();
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function objectBounds(item) {
  if(item.type==='image' && item.strokeWidth>0)return presetBounds({...item,type:'rect',stroke:item.stroke||'none'});
  if (item.type === 'shape') return vectorBounds(item);
  if (isShapeItem(item)) return presetBounds(item);
  if (item.type === 'text') {
    const size=item.fontSize||24, lines=String(item.text||'').split('\n');
    const context=typeof document!=='undefined'?document.createElement('canvas').getContext('2d'):null;
    if(context)context.font=`${item.fontStyle||'normal'} ${item.fontWeight||400} ${size}px ${JSON.stringify(item.fontFamily||'Arial')}, Arial, sans-serif`;
    let left=0,top=0,right=item.width,bottom=item.height;
    const anchor=item.align==='center'?.5:item.align==='right'?1:0;
    lines.forEach((line,index)=>{
      const m=context?.measureText(line),width=m?.width??line.length*size*1.5;
      const x=item.width*anchor-width*anchor,baseline=size*(1+index*1.2);
      left=Math.min(left,x-(m?.actualBoundingBoxLeft??size));right=Math.max(right,x+(m?.actualBoundingBoxRight??width+size));
      top=Math.min(top,baseline-(m?.actualBoundingBoxAscent??size*1.5));bottom=Math.max(bottom,baseline+(m?.actualBoundingBoxDescent??size*.5));
    });
    return {x:left,y:top,width:right-left,height:bottom-top};
  }
  return { x: 0, y: 0, width: item.width, height: item.height };
}

export function imageBorderSVG(item,id){
  if(!(item.strokeWidth>0)||!item.strokeGradient&&(!item.stroke||item.stroke==='none'))return '';
  return presetSVG({...item,type:'rect',fill:'none'},id);
}

function shadowGeometry(item, sourceBounds = objectBounds(item)) {
  if (item.shadow === undefined) return null;
  const shadow = validateShadow(item.shadow);
  if (!shadow.enabled || shadow.transparency === 100 || shadow.size === 0) return null;
  const width = item.width * shadow.size / 100, height = item.height * shadow.size / 100;
  const angle = (shadow.angle - (shadow.rotateWithShape === false ? (item.rotation || 0) : 0)) * Math.PI / 180, distance = shadow.distance * 96 / 72;
  const alignment = {tl:[0,0],t:[.5,0],tr:[1,0],l:[0,.5],ctr:[.5,.5],r:[1,.5],bl:[0,1],b:[.5,1],br:[1,1]}[shadow.alignment || 'ctr'];
  const x = (item.width - width) * alignment[0] + Math.cos(angle) * distance;
  const y = (item.height - height) * alignment[1] + Math.sin(angle) * distance;
  const sigma = shadow.blur * 96 / 72 / 2;
  // Four standard deviations retain the visible blur; one CSS pixel covers antialiasing.
  const pad = sigma > 0 ? sigma * 4 + 1 : 1;
  const scale = shadow.size / 100;
  return { shadow, x, y, width, height, sigma, bounds: { x: x + sourceBounds.x * scale - pad, y: y + sourceBounds.y * scale - pad, width: sourceBounds.width * scale + pad * 2, height: sourceBounds.height * scale + pad * 2 } };
}

/** Local union of the picture frame and shadow, before the item's rotation. */
export function shadowBounds(item, sourceBounds = objectBounds(item)) {
  const geometry = shadowGeometry(item, sourceBounds);
  if (!geometry) return sourceBounds;
  const box = geometry.bounds, x = Math.min(sourceBounds.x, box.x), y = Math.min(sourceBounds.y, box.y);
  return { x, y, width: Math.max(sourceBounds.x + sourceBounds.width, box.x + box.width) - x, height: Math.max(sourceBounds.y + sourceBounds.height, box.y + box.height) - y };
}

/** Compose one native object's alpha once, without converting its geometry to pixels. */
export function objectShadowSVG(item, content, filterId) {
  const geometry = shadowGeometry(item);
  if (!geometry) return content;
  if (!/^[A-Za-z][A-Za-z\d_-]*$/.test(filterId)) throw new Error('Shadow filter ID contains unsupported characters.');
  const { shadow, x, y, sigma, bounds } = geometry;
  const scale = shadow.size / 100;
  // A separate, transformed alpha copy supports PowerPoint shadow size as well as offset.
  const filter = `<defs><filter id="${filterId}" filterUnits="userSpaceOnUse" x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${n(sigma)}" result="shadow-blur"/><feFlood flood-color="${shadow.color}" flood-opacity="${n(1-shadow.transparency/100)}"/><feComposite in2="shadow-blur" operator="in"/></filter></defs>`;
  // Use a unique namespace for definitions in the shadow copy (gradients and arrow masks).
  const copy = content.replace(/\bid="([^"]+)"/g, (_, id) => `id="${filterId}-${id}"`).replace(/url\(#([^\)]+)\)/g, (_, id) => `url(#${filterId}-${id})`);
  return `${filter}<g filter="url(#${filterId})" pointer-events="none"><g transform="translate(${n(x)} ${n(y)}) scale(${n(scale)})">${copy}</g></g>${content}`;
}

/** Shadow-only SVG in item-local coordinates; place before the ordinary picture. */
export function imageShadowSVG(item, asset, filterId) {
  const geometry = shadowGeometry(item);
  if (!geometry) return '';
  if (typeof filterId !== 'string' || !/^[A-Za-z][A-Za-z\d_-]*$/.test(filterId)) throw new Error('Image shadow filter ID contains unsupported characters.');
  const { shadow, x, y, width, height, sigma, bounds } = geometry;
  const crop = imageCrop(item);
  let picture = item.crop
    ? `<svg x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}" preserveAspectRatio="none" overflow="hidden"><image width="1" height="1" preserveAspectRatio="none" href="${xml(asset.dataUrl)}"/></svg>`
    : `<image x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="none" href="${xml(asset.dataUrl)}"/>`;
  const border=imageBorderSVG(item,filterId+'-border');
  if(border)picture+=`<g transform="translate(${n(x)} ${n(y)}) scale(${n(shadow.size/100)})">${border}</g>`;
  const source = objectBounds(item), scale = shadow.size / 100;
  picture = softEdgeSVG({ ...item, softEdge: (item.softEdge || 0) * scale }, picture, filterId + '-soft-edge', { x: x + source.x * scale, y: y + source.y * scale, width: source.width * scale, height: source.height * scale });
  return `<defs><filter id="${filterId}" filterUnits="userSpaceOnUse" x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${n(sigma)}" result="shadow-blur"/><feFlood flood-color="${shadow.color}" flood-opacity="${n(1 - shadow.transparency / 100)}"/><feComposite in2="shadow-blur" operator="in"/></filter></defs><g filter="url(#${filterId})" pointer-events="none">${picture}</g>`;
}
