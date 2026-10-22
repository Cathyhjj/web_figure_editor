import { createProject, projectToSVG, exportPNG } from '../core.js';
import { createDeck } from '../deck.js';
import { exportPPTX } from '../pptx.js';
import { exportPDF } from '../pdf.js';
import { preparePPTXSlide } from '../pptx-import.js';

const check=(name,ok)=>{const li=document.createElement('li');li.dataset.pass=!!ok;li.textContent=`${ok?'PASS':'FAIL'} — ${name}`;document.querySelector('#results').append(li);if(!ok)throw Error(name);};
const wait=async fn=>{const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw Error('Timed out waiting for UI');await new Promise(r=>setTimeout(r,40));}};
const b64=async blob=>{let s='';const b=new Uint8Array(await blob.arrayBuffer());for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s);};
const projectFor=deck=>({format:'figure-editor',version:1,id:deck.id,name:deck.name,...deck.slides[0],assets:deck.assets});
async function pixels(project){const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(projectToSVG(project));await img.decode();const canvas=document.createElement('canvas');canvas.width=500;canvas.height=300;canvas.getContext('2d').drawImage(img,0,0);return canvas.getContext('2d').getImageData(0,0,500,300).data;}
const at=(data,x,y)=>data.slice((y*500+x)*4,(y*500+x)*4+4);
const red=p=>p[0]>180&&p[2]<70&&p[3]>200;
const blue=p=>p[2]>180&&p[0]<70&&p[3]>200;
const item=(id,type,x,y,width,height,angle=0)=>({id,name:id,type,x,y,width,height,fill:'none',stroke:'none',strokeWidth:6,strokeGradient:{angle,stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff'}]}});

document.querySelector('#run').onclick=async()=>{
 const button=document.querySelector('#run');button.disabled=true;document.querySelector('#results').replaceChildren();document.querySelector('iframe')?.remove();
 try {
  if(!['18768','18769'].includes(location.port))throw Error('Use isolated test port 18768 or 18769');
  const source=createDeck();source.slides[0].canvas={width:500,height:300,background:'transparent'};
  source.slides[0].items=[item('Horizontal','line',40,40,240,0),item('Vertical','line',350,30,0,180,90),item('Border','rect',40,110,240,100),item('Arrow','arrow',40,250,240,0)];
  source.slides[0].items[3].strokeGradient.stops.forEach(stop=>{stop.color='#ff000080';});
  const local=await (await fetch('/api/local')).json();
  const convert=async deck=>{
    const response=await fetch('/api/pptx-import',{method:'POST',headers:{'Content-Type':'application/json','X-Figure-Token':local.token},body:JSON.stringify({name:'synthetic-gradient.pptx',data:await b64(await exportPPTX(deck)),slide:1})});
    const converted=await response.json();if(!response.ok)throw Error(converted.error);return (await preparePPTXSlide(converted)).deck;
  };
  const deck=await convert(source);
  check('Native PPTX import retains all four independent gradient objects',deck.slides[0].items.filter(i=>i.strokeGradient).length===4&&deck.assets.length===0);
  let p=projectFor(deck),data=await pixels({...p,canvas:{...p.canvas,background:'transparent'},items:p.items.filter(i=>i.strokeGradient)});
  check('Horizontal line visibly transitions red to blue',red(at(data,50,40))&&blue(at(data,270,40)));
  check('Vertical zero-width line visibly transitions red to blue',red(at(data,350,40))&&blue(at(data,350,200)));
  check('Unfilled rectangle retains its gradient border',red(at(data,50,110))&&blue(at(data,270,110))&&at(data,150,150)[3]===0);
  const alpha=[];for(let y=238;y<262;y++)for(let x=45;x<280;x++)alpha.push(at(data,x,y)[3]);
  check('Semitransparent arrow shaft and head overlaps paint alpha once',Math.max(...alpha)<=130&&at(data,100,250)[3]>=126);
  const dashed={...p,items:[{...p.items.find(i=>i.name==='Arrow'),strokeDash:'dash'}]};
  const dashedData=await pixels(dashed);check('Dashed gradient arrows retain solid arrowheads',at(dashedData,278,250)[3]>0);
  const frame=document.createElement('iframe');frame.src='../index.html';frame.title='Gradient editing test';document.body.append(frame);await new Promise(r=>frame.onload=r);
  const win=frame.contentWindow,doc=frame.contentDocument;await wait(()=>doc.querySelector('#open-project')&&!doc.querySelector('#open-project').disabled);win.confirm=()=>true;
  const open=async value=>{win.showOpenFilePicker=async()=>[{name:'gradient.figure.json',getFile:async()=>new File([JSON.stringify(value)],'gradient.figure.json',{type:'application/json'})}];doc.querySelector('#open-project').click();await wait(()=>!doc.querySelector('#open-project').disabled&&[...doc.querySelectorAll('.layer-select')].some(el=>el.textContent.includes('Horizontal')));};
  await open(deck);
  const choose=name=>{[...doc.querySelectorAll('.layer-select')].find(el=>el.textContent.trim().endsWith(name)).click();const line=doc.querySelector('[data-format-section="line"]');if(line)line.open=true;};
  const editor='[data-gradient-editor="strokeGradient"]';
  const chooseStop=index=>doc.querySelector(`${editor} [data-gradient-stop="${index}"]`).click();
  const paint=value=>doc.querySelector(`[data-shape-paint="stroke"][value="${value}"]`).click();
  choose('Horizontal');
  check('Border inspector exposes gradient mode, angle and editable stops',doc.querySelector('[data-shape-paint="stroke"]:checked').value==='gradient'&&doc.querySelector(`${editor} [data-gradient-field="angle"]`)&&doc.querySelectorAll(`${editor} [data-gradient-stop]`).length===2&&doc.querySelectorAll(`${editor} [data-gradient-field="color"]`).length===1);
  const update=(field,value)=>{const input=doc.querySelector(field);input.value=value;input.dispatchEvent(new win.Event('change',{bubbles:true}));};
  chooseStop(0);update(`${editor} [data-gradient-field="color"]`,'#00ff00');
  const originalID=deck.slides[0].items.find(i=>i.name==='Horizontal').id;
  const stopColor=id=>doc.querySelector(`#stage [data-item="${id}"] stop`).getAttribute('stop-color');
  check('Changing a border gradient stop updates the actual canvas',stopColor(originalID).startsWith('#00ff00'));
  doc.querySelector('#duplicate').click();choose('Horizontal copy');chooseStop(0);update(`${editor} [data-gradient-field="color"]`,'#ff8800');
  check('Editing a duplicate leaves the original gradient unchanged',stopColor(originalID).startsWith('#00ff00'));
  doc.querySelector('#undo').click();check('Undo restores the duplicate gradient independently',[...doc.querySelectorAll('#stage linearGradient stop:first-child')].filter(el=>el.getAttribute('stop-color').startsWith('#00ff00')).length===2);
  choose('Border');paint('none');
  check('No Border removes the gradient paint server',!doc.querySelector(`#stage [data-item="${deck.slides[0].items.find(i=>i.name==='Border').id}"] linearGradient`));
  doc.querySelector('#undo').click();choose('Border');paint('solid');
  check('Solid Border clears the former gradient',!doc.querySelector(editor));doc.querySelector('#undo').click();
  let saved;win.showSaveFilePicker=async()=>({name:'gradient.figure.json',createWritable:async()=>({write:async blob=>{saved=JSON.parse(await blob.text());},close:async()=>{}})});
  doc.querySelector('#save-project-as').click();await wait(()=>saved);
  check('Saved project retains each native gradient and independent stops',saved.slides[0].items.filter(i=>i.strokeGradient).length===5);
  await open(saved);choose('Horizontal');chooseStop(0);check('Reopening restores the edited gradient',doc.querySelector(`${editor} [data-gradient-field="color"]`).value==='#00ff00');
  p=projectFor(saved);const png=await exportPNG(p,144);check('PNG export renders gradient strokes',png.size>1000);
  const pdf=await exportPDF(p,144);check('PDF export renders all gradient strokes',pdf.size>1000);
  for(const extra of [{strokeWidth:0},{strokeOpacity:0},{strokeWidth:.5}]){const tiny={...p,items:[{...p.items.find(i=>i.name==='Horizontal'),...extra}]};check(`PDF supports gradient line ${JSON.stringify(extra)}`,(await exportPDF(tiny,144)).size>300);}
  const roundtrip=await convert(saved);check('Edited PPTX roundtrip preserves all five native gradients',roundtrip.slides[0].items.filter(i=>i.strokeGradient).length===5&&roundtrip.slides[0].items.find(i=>i.name==='Horizontal').strokeGradient.stops[0].color.startsWith('#00ff00'));
  document.querySelector('#preview').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(projectToSVG(projectFor(roundtrip)));
  document.title='PASS — Gradient stroke checks';
 }catch(error){const li=document.createElement('li');li.dataset.pass=false;li.textContent=error.stack||error.message;document.querySelector('#results').append(li);document.title='FAIL — Gradient stroke checks';}
 finally{button.disabled=false;}
};
