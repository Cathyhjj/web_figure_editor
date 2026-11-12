import { validateSVGDocument, svgNodes, svgDataURL, svgDimensions, parseSVG } from './svg-vector.js';

const fields={
  svg:['viewBox'],g:['transform','opacity','fill','stroke','filter'],
  path:['d'],rect:['x','y','width','height','rx','ry'],circle:['cx','cy','r'],ellipse:['cx','cy','rx','ry'],
  line:['x1','y1','x2','y2'],polyline:['points'],polygon:['points'],
  text:['x','y','font-size','font-family','text-anchor'],tspan:['x','y','dx','dy','font-size','font-family'],
  linearGradient:['x1','y1','x2','y2','gradientTransform','gradientUnits','spreadMethod'],
  radialGradient:['cx','cy','r','fx','fy','fr','gradientTransform','gradientUnits','spreadMethod'],
  stop:['offset','stop-color','stop-opacity'],filter:['x','y','width','height','filterUnits','primitiveUnits'],
  feDropShadow:['dx','dy','stdDeviation','flood-color','flood-opacity'],feGaussianBlur:['stdDeviation'],
  feOffset:['dx','dy'],feFlood:['flood-color','flood-opacity'],feColorMatrix:['type','values'],
  feComposite:['operator','k1','k2','k3','k4'],feBlend:['mode'],use:['x','y','width','height','transform'],
};
const drawable=new Set(['path','rect','circle','ellipse','line','polyline','polygon','text','tspan','use']);
const paints=new Set(['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','stop-color','stop-opacity','flood-color','flood-opacity','font-size','font-family','text-anchor','filter']);
export function documentForAsset(asset) {
  if(asset.mime==='image/svg+xml')return validateSVGDocument(asset.svgDocument);
  if(asset?.originalMime!=='image/svg+xml'||!asset.originalDataUrl)throw new Error('This object has no editable SVG.');
  // Old originals were stored as inert provenance: sanitize again before promotion.
  const bytes=Uint8Array.from(atob(asset.originalDataUrl.split(',')[1]),c=>c.charCodeAt(0));
  return parseSVG(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).document;
}
export function styleValue(node,key) {
  const declarations=(node.attrs.style||'').split(';').map(v=>v.split(/:(.*)/s));
  return declarations.find(([k])=>k.trim()===key)?.[1]?.trim().replace(/\s*!important\s*$/i,'')??node.attrs[key]??'';
}
export function setValue(node,key,value) {
  if(paints.has(key)) {
    const declarations=(node.attrs.style||'').split(';').filter(v=>v.trim()&&v.split(':')[0].trim()!==key);
    if(value.trim())declarations.push(`${key}:${value} !important`);
    if(declarations.length)node.attrs.style=declarations.join(';');else delete node.attrs.style;
  }
  if(value.trim())node.attrs[key]=value;else delete node.attrs[key];
}

export function editableFields(node) {
  return [...new Set([...(fields[node.tag]||[]),...(drawable.has(node.tag)?['transform','fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','filter']:[])])];
}
export function fieldValue(node, key) { return paints.has(key) ? styleValue(node, key) : (node.attrs[key] || ''); }

/** Bounded metadata only: never return embedded images, raw markup, or file handles. */
export function inspectSVGAsset(asset, { offset = 0, limit = 50 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('SVG inspection requires offset >= 0 and limit between 1 and 100.');
  const rows = svgNodes(documentForAsset(asset));
  return {
    assetId: asset.id, totalNodes: rows.length, offset,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    nodes: rows.slice(offset, offset + limit).map(({ node, path }) => {
      const editableAttributes = editableFields(node), truncatedAttributes = [];
      const attributes = Object.fromEntries(editableAttributes.map(key => {
        const value = fieldValue(node, key);
        if (value.length > 2000) truncatedAttributes.push(key);
        return [key, value.slice(0, 2000)];
      }));
      const textSegments = ['text', 'tspan', 'textPath'].includes(node.tag)
        ? node.children.flatMap((child, index) => typeof child === 'string' ? [{ index, text: child.slice(0, 2000), truncated: child.length > 2000 }] : []) : [];
      return { path, tag: node.tag, elementId: (node.attrs.id || '').slice(0, 300), editableAttributes, attributes,
        truncatedAttributes, textSegments: textSegments.slice(0, 20), textSegmentCount: textSegments.length };
    }),
    notes: ['Paths index the original children array, including text nodes. Shared gradients and filters affect all elements using them inside this SVG.',
      'Values are limited to 2000 characters; at most 20 direct text segments per node are shown. Text converted to paths cannot be edited as text.'],
  };
}

/** Topology-preserving patch; changes create a derived asset with no live source link. */
export function patchSVGAsset(asset, patches, newId) {
  if (!Array.isArray(patches) || !patches.length || patches.length > 200) throw new Error('Supply 1–200 SVG patches.');
  let document = documentForAsset(asset);
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['path', 'attributes', 'textIndex', 'text'].includes(key))) throw new Error('Unsupported SVG patch fields.');
    if (!Array.isArray(patch.path) || patch.path.length > 128 || !patch.path.every(index => Number.isInteger(index) && index >= 0))
      throw new Error('SVG path must contain nonnegative child indices.');
    let node = document;
    for (const index of patch.path) node = node?.children?.[index];
    if (!node || typeof node === 'string') throw new Error('SVG path does not identify an element. Inspect the SVG again.');
    let edits = 0;
    if (patch.attributes !== undefined) {
      if (!patch.attributes || typeof patch.attributes !== 'object' || Array.isArray(patch.attributes)) throw new Error('SVG attributes must be an object.');
      const allowed = editableFields(node);
      for (const [key, value] of Object.entries(patch.attributes)) {
        if (!allowed.includes(key) || typeof value !== 'string' || value.length > 20000) throw new Error(`Unsupported SVG attribute or value: ${key}.`);
        // Attribute patches are individual CSS values, never CSS declaration lists.
        if (/[;{}]|\/\*|\*\//.test(value)) throw new Error('SVG attribute values must not contain CSS declarations or comments.');
        setValue(node, key, value); edits++;
      }
    }
    if ('text' in patch || 'textIndex' in patch) {
      if (!['text', 'tspan', 'textPath'].includes(node.tag) || !Number.isInteger(patch.textIndex) || patch.textIndex < 0
          || typeof node.children[patch.textIndex] !== 'string' || typeof patch.text !== 'string' || patch.text.length > 20000)
        throw new Error('Text patches require a text element, direct textIndex and text of at most 20000 characters.');
      node.children[patch.textIndex] = patch.text; edits++;
    }
    if (!edits) throw new Error('Supply SVG attributes or a direct text segment to edit.');
  }
  document = validateSVGDocument(document);
  const dataUrl = svgDataURL(document), { width, height } = svgDimensions(document);
  return { id: newId, name: asset.name.replace(/\.svg$/i, '').slice(0, 980) + ' (edited).svg',
    mime: 'image/svg+xml', svgDocument: document, dataUrl, width, height,
    size: atob(dataUrl.split(',')[1]).length, sourceKind: 'copy', lastModified: Date.now(),
    originalMime: 'image/svg+xml', originalDataUrl: asset.originalMime === 'image/svg+xml' ? asset.originalDataUrl : asset.dataUrl };
}
