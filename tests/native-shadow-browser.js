import {createProject,projectToSVG} from '../core.js';
import {validateDeck,slideProject} from '../deck.js';
import {exportPPTX} from '../pptx.js';
import {exportPDF} from '../pdf.js';
import {preparePPTXSlide} from '../pptx-import.js';
import {DEFAULT_SHADOW} from '../shadow.js';
const check=(name,ok)=>{const li=document.createElement('li');li.dataset.pass=!!ok;li.textContent=`${ok?'PASS':'FAIL'} — ${name}`;document.querySelector('#results').append(li);if(!ok)throw Error(name);};
const b64=async blob=>{let s='';const b=new Uint8Array(await blob.arrayBuffer());for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s);};
const shadow={...DEFAULT_SHADOW,enabled:true,color:'#0000ff',transparency:0,blur:0,distance:15,angle:0,rotateWithShape:false,alignment:'ctr'};
async function pixels(project){const img=new Image();img.src=URL.createObjectURL(new Blob([projectToSVG(project)],{type:'image/svg+xml'}));await img.decode();document.querySelector('#preview').append(img);const c=document.createElement('canvas');c.width=500;c.height=300;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,500,300);return ctx.getImageData(0,0,500,300).data;}
const at=(data,x,y)=>data.slice((y*500+x)*4,(y*500+x)*4+4);
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').disabled=true;document.querySelector('#results').replaceChildren();document.querySelector('#preview').replaceChildren();
 try{
  const p={...createProject(),canvas:{width:500,height:300,background:'transparent'},items:[
   {id:'rectangle',type:'rect',name:'Rotated shadow',x:100,y:100,width:100,height:20,rotation:90,fill:'#ff0000',stroke:'none',strokeWidth:0,shadow},
   {id:'line',type:'line',name:'Gradient line',x:30,y:220,width:220,height:0,stroke:'none',strokeWidth:5,strokeGradient:{angle:0,stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#00ff00'}]},shadow:{...shadow,blur:4,angle:90,distance:6}},
   {id:'text',type:'text',name:'Overflow text',text:'Long caption',fontFamily:'Arial',fontSize:24,x:280,y:70,width:10,height:20,color:'#ff0000',shadow:{...shadow,angle:90,distance:5}}
  ]};
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  p.assets=[{id:'photo',name:'pixel.png',mime:'image/png',width:1,height:1,dataUrl:'data:image/png;base64,'+png}];
  p.items.push({id:'photo',name:'Gradient picture border',type:'image',assetId:'photo',x:300,y:180,width:100,height:70,stroke:'none',strokeWidth:8,strokeGradient:{angle:0,stops:[{offset:0,color:'#00ff00'},{offset:1,color:'#0000ff'}]},shadow});
  const data=await pixels(p);
  check('Picture gradient borders remain visible outside the bitmap',at(data,310,177)[1]>200&&at(data,390,177)[2]>200);
  check('World-fixed shadow stays to the right of a rotated shape',at(data,170,100)[2]>240&&at(data,150,100)[0]>240);
  check('Text and shadow remain visible beyond the text frame',Array.from({length:35},(_,j)=>at(data,380,70+j)).some(pixel=>pixel[0]>100)&&Array.from({length:35},(_,j)=>at(data,380,70+j)).some(pixel=>pixel[2]>100));
  const api=await(await fetch('/api/local')).json();
  const response=await fetch('/api/pptx-import',{method:'POST',headers:{'Content-Type':'application/json','X-Figure-Token':api.token},body:JSON.stringify({name:'native-shadow-roundtrip.pptx',data:await b64(await exportPPTX(validateDeck(p))),slide:1})});
  const converted=await response.json();if(!response.ok)throw Error(converted.error);
  const prepared=await preparePPTXSlide(converted),items=prepared.deck.slides[0].items;
  check('PPTX roundtrip keeps native rectangle, line and text shadows',items.filter(i=>i.shadow?.enabled).length===4&&prepared.deck.assets.length===1);
  check('PPTX roundtrip preserves line gradient and world-fixed direction',items.find(i=>i.type==='line').strokeGradient.stops.length===2&&items.find(i=>i.name==='Rotated shadow').shadow.rotateWithShape===false);
  check('Picture border survives native PPTX export and reimport',items.find(i=>i.type==='image').strokeGradient?.stops.length===2);
  const pdf=await exportPDF(p,150);check('Native shadow PDF exports successfully',pdf.size>1000&&(await pdf.text()).startsWith('%PDF'));
  const download=document.createElement('a');download.href='data:application/pdf;base64,'+await b64(pdf);download.download='native-shadow-proof.pdf';download.textContent='Download PDF proof';document.querySelector('#preview').append(download);
  const leaf={id:'leaf',name:'Asymmetric leaf',type:'rect',x:10,y:20,width:30,height:40,fill:'#ff0000',stroke:'none',strokeWidth:0,rotation:0,opacity:1,shadow:{...shadow,blur:2,distance:3}};
  const group={id:'group',name:'Nested shadow group',type:'shadowGroup',x:40,y:40,width:100,height:100,rotation:0,opacity:1,_flipX:true,items:[leaf],shadow:{...shadow,blur:4,distance:0}};
  const nested={...group,_flipX:false,name:'Outer group',items:[{...group,x:0,y:0}]};
  const grouped=await preparePPTXSlide({name:'Groups',canvas:p.canvas,items:[nested],media:[],warnings:[]});
  const asset=grouped.deck.assets[0];check('Nested shadow groups remain validated editable SVG',asset.mime==='image/svg+xml'&&!!asset.svgDocument);
  const svg=decodeURIComponent(escape(atob(asset.dataUrl.split(',')[1])));check('Nested SVG children are expanded, with vector paths and filters',!svg.includes('data:image/svg+xml')&&svg.includes('<filter')&&svg.includes('<rect'));
  const groupedPixels=await pixels(slideProject(grouped.deck,grouped.deck.slides[0].id));
  check('Group reflection keeps its asymmetric red child on the right',at(groupedPixels,115,80)[0]>240&&at(groupedPixels,55,80)[0]<100);
  document.title='PASS — Native shadows';
 }catch(error){checkError(error);document.title='FAIL — Native shadows';}
 finally{document.querySelector('#run').disabled=false;}
};
function checkError(error){const li=document.createElement('li');li.dataset.pass=false;li.textContent=error.stack||String(error);document.querySelector('#results').append(li);}
