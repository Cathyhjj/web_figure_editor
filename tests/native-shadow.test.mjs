import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject,validateProject,projectToSVG} from '../core.js';
import {shadowBounds,DEFAULT_SHADOW,objectShadowSVG} from '../shadow.js';
import {validateDeck,cloneDeck} from '../deck.js';

const shadow={...DEFAULT_SHADOW,enabled:true,size:102,alignment:'ctr',rotateWithShape:false};
const line={id:'line',type:'line',x:40,y:40,width:120,height:0,rotation:90,stroke:'#cc2266',strokeWidth:4,shadow};
test('native zero-height line retains vector geometry and unclipped editable shadow',()=>{
  const p=validateProject({...createProject(),items:[line]});
  assert.deepEqual(p.items[0].shadow,shadow);
  const svg=projectToSVG(p),bounds=shadowBounds(p.items[0]);
  assert.match(svg,/<feGaussianBlur/);assert.match(svg,/<(?:path|line) /);assert.doesNotMatch(svg,/<image /);
  assert.ok(bounds.y< -13 && bounds.height>26);
  const deck=validateDeck(p),copy=cloneDeck(deck);copy.slides[0].items[0].shadow.blur=20;
  assert.equal(deck.slides[0].items[0].shadow.blur,5);
});
test('fixed world-angle shadow offsets counter-rotate with the object',()=>{
  const item={...line,shadow:{...shadow,angle:0,distance:3,size:100}};
  const s=objectShadowSVG(item,'<line x2="120"/>','native-test');
  assert.match(s,/translate\(0 -4\)/);
});
test('shadow copies namespace their gradient and mask IDs',()=>{
  const s=objectShadowSVG(line,'<defs><linearGradient id="paint"/></defs><path fill="url(#paint)"/>','native-test');
  assert.match(s,/id="native-test-paint"/);assert.match(s,/url\(#native-test-paint\)/);
  assert.equal((s.match(/id="paint"/g)||[]).length,1);
});
test('invalid native shadow metadata is rejected for shapes and text too',()=>{
  for(const value of [{alignment:'script'},{rotateWithShape:'no'},{blur:-1}])assert.throws(()=>validateProject({...createProject(),items:[{...line,shadow:{...shadow,...value}}]}));
});
