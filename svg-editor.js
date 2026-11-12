import { validateSVGDocument, svgNodes, svgDataURL, svgDimensions } from './svg-vector.js';
import { documentForAsset, editableFields, fieldValue, setValue } from './svg-edit.js';

const names={svg:'SVG artwork',g:'Group',defs:'Definitions',style:'Styles',path:'Path',rect:'Rectangle',circle:'Circle',ellipse:'Ellipse',line:'Line',text:'Text',tspan:'Text span',linearGradient:'Linear gradient',radialGradient:'Radial gradient',stop:'Gradient stop',filter:'Filter',feDropShadow:'Drop shadow',feGaussianBlur:'Blur',feOffset:'Shadow offset',feFlood:'Shadow color',feColorMatrix:'Color adjustment',feComposite:'Composite',feBlend:'Blend'};
const label={d:'Path geometry',stdDeviation:'Blur (standard deviation)',dx:'Horizontal offset',dy:'Vertical offset','stop-color':'Stop color','stop-opacity':'Stop opacity','flood-color':'Shadow color','flood-opacity':'Shadow opacity',gradientTransform:'Gradient transform',offset:'Stop position'};
const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
export function editableSVGAsset(asset) { return asset?.mime==='image/svg+xml'||asset?.originalMime==='image/svg+xml'; }

/** Edits stay in a draft tree; only Apply commits one independent asset via the caller. */
export function openSVGEditor(asset,onApply) {
  let draft=documentForAsset(asset),rows=svgNodes(draft),selected=0,closed=false;
  const dialog=el('dialog','svg-editor');dialog.id='svg-editor';
  const heading=el('div','dialog-header');heading.append(el('h2',null,'Edit SVG elements'));
  const body=el('div','svg-editor-body'),list=el('select','svg-element-list');list.id='svg-elements';list.size=16;list.setAttribute('aria-label','SVG element');
  const preview=el('img','svg-editor-preview');preview.alt='SVG preview';
  const properties=el('div','svg-element-properties'),notice=el('p','hint');notice.setAttribute('role','status');
  const note=el('p','hint','Choose a shape, text, gradient stop or shadow filter. Shared gradients and filters affect every element that uses them. Blank values inherit the original style.');
  const previewPane=el('div','svg-preview-pane');previewPane.append(preview,notice);
  body.append(list,previewPane,properties);
  const actions=el('div','dialog-actions'),cancel=el('button','button','Cancel'),apply=el('button','button primary','Apply');apply.id='svg-apply';cancel.id='svg-cancel';
  actions.append(cancel,apply);dialog.append(heading,note,body,actions);document.body.append(dialog);
  const close=()=>{closed=true;dialog.close();dialog.remove();};cancel.onclick=close;
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('keydown',event=>event.stopPropagation());
  for(const type of ['copy','cut','paste'])dialog.addEventListener(type,event=>event.stopPropagation());
  rows.forEach(({node,path},index)=>{const option=el('option',null,`${'  '.repeat(Math.min(path.length,8))}${names[node.tag]||node.tag}${node.attrs.id?' #'+node.attrs.id:''}`);option.dataset.svgTag=node.tag+(node.attrs.id?' #'+node.attrs.id:'');option.value=index;list.append(option);});
  const refresh=()=>{
    try {preview.src=svgDataURL(draft);notice.textContent='Vector preview · original gradients and filters retained';apply.disabled=false;}
    catch(error){notice.textContent=error.message;apply.disabled=true;}
  };
  function form() {
    properties.replaceChildren();const {node}=rows[selected];properties.append(el('h3',null,(names[node.tag]||node.tag)+(node.attrs.id?' #'+node.attrs.id:'')));
    const keys=editableFields(node);
    const field=(key,value,change)=>{
      const wrap=el('label','field');wrap.append(el('span',null,label[key]||key));
      const input=el(['d','points','Text'].includes(key)?'textarea':'input');if(input.tagName==='INPUT')input.type='text';
      input.value=value;input.dataset.svgField=key;input.setAttribute('aria-label',label[key]||key);input.placeholder='Inherited / default';
      input.oninput=()=>{change(input.value);refresh();};wrap.append(input);properties.append(wrap);
    };
    for(const key of keys)field(key,fieldValue(node,key),value=>setValue(node,key,value));
    if(['text','tspan','textPath'].includes(node.tag)) {
      node.children.forEach((child,index)=>{if(typeof child==='string')field('Text',child,value=>{node.children[index]=value;});});
    }
    if(!keys.length)properties.append(el('p','hint','This element is preserved. Choose its child element to edit its properties.'));
  }
  list.onchange=()=>{selected=Number(list.value);form();};list.value='0';form();refresh();
  apply.onclick=async()=>{
    apply.disabled=true;
    try {
      const svgDocument=validateSVGDocument(draft),{width,height}=svgDimensions(svgDocument),dataUrl=svgDataURL(svgDocument);
      // Confirm renderability before changing the real project.
      const image=new Image();image.src=dataUrl;await image.decode();
      if(closed)return;
      await onApply({svgDocument,dataUrl,mime:'image/svg+xml',width,height});close();
    }catch(error){notice.textContent=error.message;apply.disabled=false;}
  };
  dialog.showModal();list.focus();return dialog;
}
