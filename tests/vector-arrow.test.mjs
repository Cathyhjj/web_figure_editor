import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorArrow, createArrowPreset, rebuildArrow, moveArrowPoint, arrowPaths } from '../vector-arrow.js';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createSelection, encodeSelection, decodeSelection } from '../clipboard.js';
import { createDeck, cloneDeck } from '../deck.js';
import { exportPDF } from '../pdf.js';
const arrow=()=>({id:'arrow',opacity:1,...createArrowPreset('sweepVectorArrow')});
const world=(item,p)=>{
  const angle=item.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),x=(p.x-.5)*item.width,y=(p.y-.5)*item.height;
  return {x:item.x+item.width/2+c*x-s*y,y:item.y+item.height/2+s*x+c*y};
};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} ≠ ${b}`);

test('editable arrows persist through projects, clipboard and independent copies',()=>{
  const item=arrow(),project=validateProject({...createProject(),items:[item]});
  assert.deepEqual(validateProject(JSON.parse(serializeProject(project))),project);
  const selected=decodeSelection(encodeSelection(createSelection(project,new Set(['arrow']))));
  assert.deepEqual(selected.items[0].editableArrow,project.items[0].editableArrow);
  const deck=createDeck();deck.slides[0].items=[item];const copy=cloneDeck(deck);
  copy.slides[0].items[0].editableArrow.points[0].x=.99;
  assert.notEqual(item.editableArrow.points[0].x,.99);
});

test('metadata is bounded and authoritative for saved arrow paths',()=>{
  for(const mutate of [a=>a.points.push(...Array(33).fill({x:0,y:0})),a=>a.points[0].x=Infinity,a=>a.headLength=-1,a=>a.viewWidth=0,a=>a.kind='invalid',a=>a.tailWidth=2]){
    const item=arrow();mutate(item.editableArrow);
    assert.throws(()=>validateProject({...createProject(),items:[item]}),/arrow/);
  }
  const item=arrow();item.paths[0].commands[0][1]=42;
  const restored=validateProject({...createProject(),items:[item]}).items[0];
  assert.deepEqual(restored.paths,arrowPaths(restored.editableArrow));
  const huge=arrow();Object.assign(huge.editableArrow,{viewWidth:1,viewHeight:1,shaftWidth:10000});
  assert.throws(()=>validateProject({...createProject(),items:[huge]}),/geometry/);
});

test('straight, vertical, reversed, repeated and sharp multi-point paths have bounded filled outlines',()=>{
  const sets=[[{x:0,y:0},{x:150,y:0}],[{x:0,y:0},{x:0,y:150}],[{x:100,y:100},{x:0,y:0}],
    [{x:0,y:0},{x:80,y:0},{x:80,y:100},{x:200,y:100}],
    [{x:0,y:0},{x:80,y:0},{x:0,y:2},{x:160,y:5}],
    Array.from({length:32},(_,i)=>({x:i*10,y:Math.sin(i)*60}))];
  for(const kind of ['curve','polyline'])for(const points of sets)for(const heads of ['end','both']){
    const item={id:'a',...createVectorArrow(kind,[points[0],...points])};
    item.editableArrow.heads=heads;rebuildArrow(item);
    const result=validateProject({...createProject(),items:[item]}).items[0];
    assert.ok(result.paths[0].commands.length<2048);
    assert.equal(result.paths[0].commands.at(-1)[0],'Z');
    assert.doesNotMatch(projectToSVG({...createProject(),items:[item]}),/NaN|Infinity/);
    for(const [op,...v] of result.paths[0].commands)for(const n of v)assert.ok(n>=-1e-8&&n<=1+1e-8);
  }
  assert.equal(createVectorArrow('curve',[{x:0,y:0},{x:0,y:0}]),null);
});

test('point dragging keeps other nodes fixed after rotation and nonuniform resizing',()=>{
  const item=arrow();item.width*=1.7;item.height*=.6;item.rotation=37;
  const before=structuredClone(item),original=item.editableArrow.points.map(p=>world(item,p));
  rebuildArrow(item);
  for(const key of ['x','y','width','height'])near(item[key],before[key]);
  const target={x:original[1].x-40,y:original[1].y+50};
  moveArrowPoint(item,1,target);
  item.editableArrow.points.forEach((p,i)=>{
    const actual=world(item,p),expected=i===1?target:original[i];near(actual.x,expected.x);near(actual.y,expected.y);
  });
});

test('solid arrows remain vector in SVG and PDF with a single filled silhouette',async()=>{
  const project=validateProject({...createProject(),items:[arrow()]});
  assert.doesNotMatch(projectToSVG(project),/<image/);
  assert.equal(project.items[0].paths.length,1);
  const pdf=await(await exportPDF(project)).text();
  assert.doesNotMatch(pdf,/\/Subtype \/Image/);
  assert.match(pdf,/ l\n/);
});
