import { exportPNG } from '../core.js';
const fixtures = './fixtures/powerpoint-radial/';
async function pixels(url) {
  const image=new Image();image.src=url;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const context=canvas.getContext('2d');context.drawImage(image,0,0);
  return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};
}
document.querySelector('#run').onclick=async()=>{
  const button=document.querySelector('#run'),list=document.querySelector('#results'),summary=document.querySelector('#summary');
  button.disabled=true;list.replaceChildren();const results=[];
  try {
    const manifest=await (await fetch(fixtures+'cases.json')).json();
    for(const test of manifest.cases) {
      const blob=await exportPNG(test.project,96),url=URL.createObjectURL(blob);
      let actual;try{actual=await pixels(url);}finally{URL.revokeObjectURL(url);}
      const expected=await pixels(fixtures+test.reference),{width,height}=expected;
      if(actual.width!==width || actual.height!==height)throw Error('Reference dimensions changed');
      const a=actual.data,b=expected.data,mask=new Uint8Array(width*height);
      for(let i=0;i<mask.length;i++)mask[i]=[0,1,2].some(c=>a[i*4+c]<245||b[i*4+c]<245)?1:0;
      let total=0,count=0;const histogram=new Uint32Array(256);
      // Ignore the two-pixel antialias boundary, retaining interior gradients.
      for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
        if(![-2,0,2].every(dy=>[-2,0,2].every(dx=>mask[(y+dy)*width+x+dx])))continue;
        for(let c=0;c<3;c++){const i=(y*width+x)*4+c,d=Math.abs(a[i]-b[i]);total+=d;count++;histogram[d]++;}
      }
      const mean=total/count;let cumulative=0,p99=0;
      while(p99<255 && (cumulative+=histogram[p99])<count*.99)p99++;
      const pass=count>100 && mean<=test.meanErrorLimit;
      const result={name:test.project.name,pass,mean,p99,samples:count};results.push(result);
      const li=document.createElement('li');li.dataset.pass=String(pass);li.textContent=`${pass?'PASS':'FAIL'} ${result.name}: mean ${mean.toFixed(3)}/255, 99th percentile ${p99}/255`;list.append(li);
      summary.textContent=`Checked ${results.length}/${manifest.cases.length}`;
    }
    window.__powerpointRadialResults=results;
    summary.textContent=`${results.filter(r=>r.pass).length}/${results.length} passed`;
  }catch(error){summary.textContent='ERROR: '+error.message;throw error;}finally{button.disabled=false;}
};
