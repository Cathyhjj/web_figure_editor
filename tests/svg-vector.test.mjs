import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSVGDocument, svgDataURL, serializeSVG, mirrorSVG, svgNodes } from '../svg-vector.js';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createDeck, cloneDeck, validateDeck } from '../deck.js';

const node=(tag,attrs={},children=[])=>({tag,attrs,children});
const fixture=()=>node('svg',{width:'120',height:'80',viewBox:'0 0 120 80'},[
  node('defs',{},[
    node('linearGradient',{id:'gradient'},[node('stop',{offset:'0','stop-color':'red'}),node('stop',{offset:'1','stop-color':'blue'})]),
    node('filter',{id:'shadow'},[node('feDropShadow',{dx:'3',dy:'4',stdDeviation:'2','flood-opacity':'.4'})]),
  ]),node('path',{d:'M10 10H100V60H10Z',fill:'url(#gradient)',filter:'url(#shadow)'}),node('text',{x:'10',y:'70'},['可编辑 & editable']),
]);
const asset=()=>{const svgDocument=validateSVGDocument(fixture());return {id:'vector',name:'test.svg',mime:'image/svg+xml',width:120,height:80,svgDocument,dataUrl:svgDataURL(svgDocument)};};
const project=()=>({...createProject(),assets:[asset()],items:[{id:'item',type:'image',assetId:'vector',x:0,y:0,width:120,height:80}]});

test('SVG gradients, filters, paths and Unicode text survive project save and vector export',()=>{
  const p=validateProject(JSON.parse(serializeProject(project())));
  assert.equal(p.assets[0].mime,'image/svg+xml');
  assert.deepEqual(p.assets[0].svgDocument,validateSVGDocument(fixture()));
  assert.match(projectToSVG(p),/href="data:image\/svg\+xml;base64,/);
  assert.match(serializeSVG(p.assets[0].svgDocument),/feDropShadow/);
  assert.match(serializeSVG(p.assets[0].svgDocument),/可编辑 &amp; editable/);
});
test('persisted vectors cannot substitute unvalidated bytes or execute dynamic content',()=>{
  const p=project();p.assets[0].dataUrl='data:image/svg+xml;base64,'+btoa('<svg onload="alert(1)"/>');
  assert.throws(()=>validateProject(p),/do not match/);
  for(const bad of [node('script',{},['alert(1)']),node('foreignObject'),node('path',{onload:'alert(1)'}),node('image',{href:'https://example.com/a.png'}),node('use',{'xlink:href':'data:image/svg+xml;base64,PHN2Zy8+'}),node('style',{},['@import "https://example.com"']),node('rect',{style:'fill:url(https://example.com)'}),node('path',{'xmlns':'http://www.w3.org/1999/xhtml'}),node('path',{'xml:base':'https://example.com'})]) {
    assert.throws(()=>validateSVGDocument(node('svg',{},[bad])));
  }
});
test('bounded document validation rejects deep or oversized documents',()=>{
  let deep=node('path');for(let i=0;i<130;i++)deep=node('g',{},[deep]);
  assert.throws(()=>validateSVGDocument(node('svg',{},[deep])),/complex/);
  assert.throws(()=>validateSVGDocument(node('svg',{width:'99999999',height:'1'})),/dimensions/);
});
test('reflections keep definitions and original document untouched',()=>{
  const original=validateSVGDocument(fixture()),before=JSON.stringify(original),mirrored=mirrorSVG(original,true,false);
  assert.equal(mirrored.attrs.transform,'translate(120 0) scale(-1 1)');
  assert.equal(JSON.stringify(original),before);
  assert.equal(svgNodes(mirrored).filter(({node})=>node.tag==='stop').length,2);
});
test('portable deck snapshots retain independently replaced SVG documents',()=>{
  const deck=createDeck();deck.assets=[asset()];deck.slides[0].items=project().items;
  const old=cloneDeck(validateDeck(deck));
  const next=validateSVGDocument(deck.assets[0].svgDocument);svgNodes(next).find(({node})=>node.tag==='stop').node.attrs['stop-color']='green';
  deck.assets[0]={...deck.assets[0],svgDocument:next,dataUrl:svgDataURL(next)};
  assert.notEqual(deck.assets[0].dataUrl,old.assets[0].dataUrl);
  assert.equal(validateDeck(JSON.parse(JSON.stringify(old))).assets[0].dataUrl,old.assets[0].dataUrl);
});
