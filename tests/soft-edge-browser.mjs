// Start python3 server.py --port 18792; use a separate browser context and synthetic data.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output=await fs.mkdtemp(path.join(os.tmpdir(),'figure-soft-edge-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1550,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{window.showSaveFilePicker=undefined;window.showOpenFilePicker=undefined;});
let count=0;
function check(name,pass){if(!pass)throw new Error(name);count++;console.log('PASS',name);}
try{
  await page.goto('http://127.0.0.1:18792/');
  await page.waitForFunction(()=>!document.getElementById('open-project').disabled);
  const fixture=await page.evaluate(async()=>{
    const {createDeck}=await import('./deck.js');const deck=createDeck();deck.name='Soft edges verification';
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=160;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#2864dc';ctx.fillRect(20,20,160,120);
    ctx.fillStyle='#000000';ctx.fillRect(100,60,1,40);ctx.fillStyle='#ffffff';ctx.fillRect(101,60,1,40);
    deck.assets=[{id:'image-source',name:'transparent-detail.png',mime:'image/png',width:200,height:160,dataUrl:canvas.toDataURL()}];
    deck.slides[0].canvas={width:320,height:240,background:'transparent'};
    deck.slides[0].items=[{id:'picture',type:'image',name:'Feathered image',assetId:'image-source',x:40,y:40,width:200,height:160,rotation:0,opacity:1}];
    return deck;
  });
  async function open(deck){
    await page.locator('#project-input').setInputFiles({name:'soft-edge.figure.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(deck))});
    // Reopening the same project keeps its name; wait for the asynchronous import to finish.
    await page.waitForFunction(()=>document.getElementById('project-input').files.length===0&&!document.getElementById('open-project').disabled&&document.getElementById('project-name').value==='Soft edges verification');
    await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');
    await page.locator('#format-tab-effects').click();
  }
  async function saved(){const download=page.waitForEvent('download');await page.locator('#save-project').click();return JSON.parse(await fs.readFile(await (await download).path(),'utf8'));}
  await open(fixture);
  check('PPT-style presets and default-off size are exposed',await page.locator('#soft-edge-preset option').count()===8&&await page.locator('#soft-edge-size').inputValue()==='0');
  await page.locator('#soft-edge-preset').selectOption('10');
  check('Preset renders feathering in live canvas and slide thumbnail',await page.locator('#stage filter[id^="soft-edge-"]').count()===1&&await page.locator('.slide-preview filter[id^="soft-edge-"]').count()===1);
  const slider=page.locator('[data-soft-edge][type="range"]');
  await slider.evaluate(el=>{for(const value of ['15','20']){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}el.dispatchEvent(new Event('change',{bubbles:true}));});
  check('Slider synchronizes numeric size live',await page.locator('#soft-edge-size').inputValue()==='20');
  await page.locator('#undo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');check('One undo restores the slider gesture',await page.locator('#soft-edge-size').inputValue()==='10');
  await page.locator('#redo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');check('Redo restores soft edges',await page.locator('#soft-edge-size').inputValue()==='20');
  const snapshot=await saved();check('Saved project retains editable radius',snapshot.slides[0].items[0].softEdge===20);
  await open(snapshot);check('Reopen restores the soft edge control',await page.locator('#soft-edge-size').inputValue()==='20');
  await page.locator('#duplicate').click();await page.locator('#soft-edge-preset').selectOption('5');
  const duplicates=await saved();check('Duplicates have independent radii',duplicates.slides[0].items.map(i=>i.softEdge).join(',')==='20,5');
  await page.locator('#format-tab-size').click();await page.locator('#object-locked').check();await page.locator('#format-tab-effects').click();
  check('Locked object disables all feather controls',await page.locator('#soft-edge-preset').isDisabled()&&await page.locator('#soft-edge-size').isDisabled()&&await slider.isDisabled());
  await page.locator('#format-tab-size').click();await page.locator('#object-locked').uncheck();await page.locator('#format-tab-effects').click();
  await page.locator('#soft-edge-preset').selectOption('0');
  check('No soft edges removes the selected object filter',await page.locator('#stage .figure-item.selected filter').count()===0);
  await open(fixture);
  check('Older pictures default to all edges',await page.locator('#soft-edge-mode').inputValue()==='all'&&await page.locator('#soft-edge-angle').count()===0);
  await page.locator('#soft-edge-mode').selectOption('single');
  check('One edge starts with a visible width and a left-edge fade',await page.locator('#soft-edge-size').inputValue()==='10'&&await page.locator('#soft-edge-direction').inputValue()==='0');
  const strength=page.locator('#soft-edge-strength');
  const strengthSlider=page.getByRole('slider',{name:'Soft edges strength slider'});
  check('A newly enabled one-edge fade starts at the original 100% strength',await strength.inputValue()==='100'&&await strengthSlider.inputValue()==='100');
  await strengthSlider.evaluate(el=>{
    for(const value of ['70','40']){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}
    el.dispatchEvent(new Event('change',{bubbles:true}));
  });
  check('Strength and width are independent',await strength.inputValue()==='40'&&await page.locator('#soft-edge-size').inputValue()==='10');
  await page.locator('#undo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');
  check('One undo restores the entire strength gesture',await strength.inputValue()==='100');
  await strength.fill('50');await strength.press('Tab');
  check('Typing a strength updates its slider',await strengthSlider.inputValue()==='50');
  await page.locator('#soft-edge-mode').selectOption('all');
  check('All-edge mode hides the one-edge strength setting',await strength.count()===0);
  await page.locator('#soft-edge-mode').selectOption('single');
  check('Returning to one edge remembers its strength',await strength.inputValue()==='50');
  await strength.fill('225');await strength.press('Tab');
  check('Typing a boosted strength updates its slider',await strengthSlider.inputValue()==='225');
  await strengthSlider.focus();await strengthSlider.press('End');
  check('The strength slider reaches 300% without changing width',await strength.inputValue()==='300'&&await page.locator('#soft-edge-size').inputValue()==='10');
  await page.locator('#soft-edge-direction').selectOption({label:'Top'});
  check('Choosing Top sets the angle to 90 degrees',await page.locator('#soft-edge-angle').inputValue()==='90');
  const angleSlider=page.getByRole('slider',{name:'Soft edges angle slider'});
  await angleSlider.evaluate(el=>{
    for(const value of ['62','37']){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}
    el.dispatchEvent(new Event('change',{bubbles:true}));
  });
  check('Rotating the fade updates the number and direction',await page.locator('#soft-edge-angle').inputValue()==='37'&&await page.locator('#soft-edge-direction').inputValue()==='custom');
  await page.locator('#undo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');
  check('One undo restores the entire angle gesture',await page.locator('#soft-edge-angle').inputValue()==='90');
  await page.locator('#redo').click();await page.locator('#workspace').focus();await page.keyboard.press('Meta+a');
  const angled=await saved();
  await open(angled);
  check('Reopening preserves the angle, mode and active width',await page.locator('#soft-edge-angle').inputValue()==='37'&&await page.locator('#soft-edge-mode').inputValue()==='single'&&await page.locator('#soft-edge-size').inputValue()==='10');
  check('Saving and reopening preserves 300% strength',angled.slides[0].items[0].softEdgeStrength===300&&await strength.inputValue()==='300'&&await strengthSlider.inputValue()==='300');
  await page.locator('#format-tab-size').click();await page.locator('#object-locked').check();await page.locator('#format-tab-effects').click();
  check('Locking the picture disables direction and angle',await page.locator('#soft-edge-mode').isDisabled()&&await page.locator('#soft-edge-direction').isDisabled()&&await angleSlider.isDisabled());
  check('Locking also disables the strength slider and number',await strength.isDisabled()&&await strengthSlider.isDisabled());
  await open(fixture);
  await page.locator('#soft-edge-mode').selectOption('radial');
  const radius=page.locator('#soft-edge-radius');
  const radiusSlider=page.getByRole('slider',{name:'Soft edges radius slider'});
  check('Radial opens directly on an unfeathered picture with a visible default radius',
    await radius.inputValue()==='50'&&await page.locator('#stage radialGradient').count()>0&&await page.locator('#soft-edge-size,#soft-edge-preset').count()===0);
  check('Radial provides eight edge and corner positions',await page.locator('#soft-edge-direction option:enabled').count()===8);
  await page.locator('#soft-edge-direction').selectOption('315');
  check('The bottom-left radial center corresponds to 315 degrees',await page.locator('#soft-edge-angle').inputValue()==='315');
  await page.locator('#soft-edge-angle').fill('22');await page.locator('#soft-edge-angle').press('Tab');
  check('Radial accepts intermediate angles',await page.locator('#soft-edge-direction').inputValue()==='custom');
  await radius.fill('125');await radius.press('Tab');
  check('Typing a radial size updates its slider',await radiusSlider.inputValue()==='125');
  await radiusSlider.focus();await radiusSlider.press('End');
  check('The radial radius slider reaches 200%',await radius.inputValue()==='200');
  await strength.fill('275');await strength.press('Tab');
  const radialProject=await saved();await open(radialProject);
  check('Saving and reopening restores radial mode, radius, angle and boosted strength',
    await page.locator('#soft-edge-mode').inputValue()==='radial'&&await radius.inputValue()==='200'&&await page.locator('#soft-edge-angle').inputValue()==='22'&&await strength.inputValue()==='275');
  const shapeFixture=structuredClone(fixture);
  shapeFixture.slides[0].items=[{id:'shape',type:'rect',name:'Shape',x:30,y:30,width:80,height:60,fill:'#2864dc'}];
  await open(shapeFixture);
  check('Only pictures offer the one-edge mode',await page.locator('#soft-edge-mode').count()===0&&await page.locator('#soft-edge-size').inputValue()==='0');
  snapshot.slides[0].items[0].softEdge=10;
  await open(snapshot);
  await page.screenshot({path:path.join(output,'soft-edge-editor.png')});
  const raster=await page.evaluate(async fixture=>{
    const {slideProject}=await import('./deck.js');const {exportPNG,projectToSVG}=await import('./core.js');
    const {selectionToPNG}=await import('./clipboard-image.js');const {exportPDF}=await import('./pdf.js');
    const {exportPPTX}=await import('./pptx.js');const {preparePPTXSlide}=await import('./pptx-import.js');
    const {DEFAULT_SHADOW}=await import('./shadow.js');
    const p=slideProject(fixture);p.items[0].softEdge=10;
    const results=[];const check=(name,pass)=>results.push({name,pass:!!pass});
    async function pixels(blob){const bitmap=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const data=ctx.getImageData(0,0,c.width,c.height).data;return (x,y)=>[...data.slice((y*c.width+x)*4,(y*c.width+x)*4+4)];}
    const plain=structuredClone(p);plain.items[0].softEdge=0;
    const before=await pixels(await exportPNG(plain,96)),after=await pixels(await exportPNG(p,96));
    check('PNG feather follows transparent image content, leaving outside pixels clear',after(50,120)[3]===0&&after(60,120)[3]<80&&after(66,120)[3]>after(60,120)[3]&&after(66,120)[3]<255);
    check('PNG preserves opaque center and sharp one-pixel source detail',JSON.stringify(after(140,120))===JSON.stringify(before(140,120))&&JSON.stringify(after(141,120))===JSON.stringify(before(141,120))&&after(141,120)[0]>240&&after(140,120)[0]<10);
    const high=await pixels(await exportPNG(p,192));check('Higher DPI preserves physical feather width',Math.abs(high(132,240)[3]-after(66,120)[3])<25);
    const cropped=structuredClone(p);cropped.items[0].crop={x:.25,y:0,width:.5,height:1};
    const crop=await pixels(await exportPNG(cropped,96));check('Crop edges feather after cropping',crop(40,120)[3]<80&&crop(65,120)[3]>245);
    const faded=structuredClone(p);faded.items[0].opacity=.5;const fade=await pixels(await exportPNG(faded,96));
    check('Object transparency is applied once',Math.abs(fade(100,120)[3]-128)<2&&fade(66,120)[3]<after(66,120)[3]);
    const shapes={...p,assets:[],items:[{id:'rect',type:'rect',x:40,y:40,width:200,height:160,fill:'#2864dc80',stroke:'none',strokeWidth:0,softEdge:10}]};
    const shape=await pixels(await exportPNG(shapes,96));check('Semitransparent shape interior retains original alpha',Math.abs(shape(140,120)[3]-128)<2&&shape(40,120)[3]<50);
    const shadow=structuredClone(p);shadow.items[0].shadow={...DEFAULT_SHADOW,enabled:true,color:'#00cc44',transparency:0,distance:30,angle:0,blur:0};
    const combined=await pixels(await exportPNG(shadow,96));check('Feather and shadow compose without losing the shadow',combined(250,120)[3]>0&&combined(250,120)[1]>150);
    const copied=await pixels(await selectionToPNG(p));check('Copy as PNG retains feather rather than raw image bytes',copied(20,80)[3]<80&&copied(40,80)[3]>245);
    const svg=projectToSVG(p);check('SVG retains an editable embedded effect',svg.includes('soft-edge-mask')&&svg.includes('data:image/png;base64,'));
    const oneEdge=structuredClone(p);
    // Crop out the transparent margins, so each sample tests the image frame.
    Object.assign(oneEdge.items[0],{crop:{x:.1,y:.125,width:.8,height:.75},softEdge:30,softEdgeMode:'single'});
    const alphaByStrength=[];
    for(const strength of [0,50,100,200,300]){
      oneEdge.items[0].softEdgeStrength=strength;
      const sample=await pixels(await exportPNG(oneEdge,96));
      alphaByStrength.push([41,60,85].map(x=>sample(x,120)[3]));
    }
    const [off,half,full,double,triple]=alphaByStrength;
    check('At fixed width, 0%, 50% and 100% change only the strength of the fade',
      off.every(a=>a===255)&&full[0]<20&&full[1]>110&&full[1]<150&&full[2]===255&&
      half.every((a,i)=>Math.abs(a-(off[i]+full[i])/2)<3));
    const midpointOpacity=full[1]/255;
    check('At 200% and 300% the middle of the same fade is progressively more transparent',
      Math.abs(double[1]/255-midpointOpacity**2)<0.015&&Math.abs(triple[1]/255-midpointOpacity**3)<0.015);
    check('Pixels beyond the original fade width stay fully opaque at boosted strengths',
      double[2]===255&&triple[2]===255);
    const edgeSamples=[[41,120],[140,41],[238,120],[140,198]];
    for(const [index,angle] of [0,90,180,270].entries()){
      oneEdge.items[0].softEdgeAngle=angle;
      const sample=await pixels(await exportPNG(oneEdge,96));
      const alpha=edgeSamples.map(([x,y])=>sample(x,y)[3]);
      check(`At ${angle}° only the chosen side fades`,alpha[index]<35&&alpha.every((v,i)=>i===index||v>245));
    }
    oneEdge.items[0].softEdgeAngle=45;
    const diagonal=await pixels(await exportPNG(oneEdge,96));
    check('A diagonal angle fades the upper left and preserves the opposite corner',diagonal(42,42)[3]<60&&diagonal(237,197)[3]>245);
    // The cropped picture spans (40,40) to (240,200), so a 50% radius = 80 pixels.
    const radial=structuredClone(oneEdge),radialItem=radial.items[0];
    delete radialItem.softEdge;
    Object.assign(radialItem,{softEdgeMode:'radial',softEdgeAngle:0,softEdgeRadius:50,softEdgeStrength:100});
    const left=await pixels(await exportPNG(radial,96));
    const leftSamples=[[80,120],[64,152],[64,88]].map(([x,y])=>left(x,y)[3]);
    check('A radial fade from the left has circular contours in a non-square picture',
      left(41,120)[3]<12&&left(130,120)[3]===255&&leftSamples.every(alpha=>Math.abs(alpha-128)<6));
    radialItem.softEdgeAngle=315;
    const bottomLeft=await pixels(await exportPNG(radial,96));
    const cornerSamples=[[80,198],[41,159],[64,167]].map(([x,y])=>bottomLeft(x,y)[3]);
    check('A bottom-left radial fade is centered on the corner',
      bottomLeft(41,198)[3]<12&&bottomLeft(41,41)[3]===255&&cornerSamples.every(alpha=>Math.abs(alpha-128)<6));
    radialItem.softEdgeStrength=300;
    const boostedCorner=await pixels(await exportPNG(radial,96));
    check('In a 300% radial fade the circle midpoint follows the boosted opacity curve',
      Math.abs(boostedCorner(80,198)[3]-32)<6&&boostedCorner(140,198)[3]===255);
    const pdf=await exportPDF(p,96);check('PDF contains a transparency mask for the feathered bitmap',/\/SMask/.test(await pdf.text()));
    const directionalPDF=await exportPDF(oneEdge,96);
    check('Single-edge PDF includes a grayscale alpha mask',/\/SMask\s+\d+\s+0\s+R/.test(await directionalPDF.text()));
    const local=await (await fetch('/api/local')).json();
    async function roundTripPPTX(project) {
      const ppt=await exportPPTX(project);
      const encoded=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(ppt);});
      const response=await fetch('/api/pptx-import',{method:'POST',headers:{'Content-Type':'application/json','X-Figure-Token':local.token},body:JSON.stringify({name:'soft-edge.pptx',data:encoded,slide:1})});
      const converted=await response.json();if(!response.ok)throw new Error(JSON.stringify(converted));
      return preparePPTXSlide(converted);
    }
    const reopened=await roundTripPPTX(cropped);
    check('PPTX export and real import preserve editable soft edges and crop',reopened.deck.slides[0].items[0].softEdge===10&&reopened.deck.slides[0].items[0].crop.x===.25);
    const paired=structuredClone(oneEdge);
    paired.canvas.width=520;
    paired.items.push({...paired.items[0],id:'plain-copy',x:280,softEdge:0});
    const imported=slideProject((await roundTripPPTX(paired)).deck);
    // PowerPoint supplies a slide background. Isolate the pictures' own alpha.
    imported.canvas.background='transparent';
    const pptPixels=await pixels(await exportPNG(imported,96));
    const diagonalPoints=[[42,42],[52,52],[140,120],[237,197]];
    check('PowerPoint preserves the diagonal fade through export and import',
      diagonalPoints.every(([x,y])=>Math.abs(pptPixels(x,y)[3]-diagonal(x,y)[3])<8));
    check('A second placement of the same picture stays opaque after PowerPoint round trip',
      imported.items.length===2&&imported.items[0].assetId!==imported.items[1].assetId&&pptPixels(282,42)[3]>245);
    const data=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
    return {results,png:await data(await exportPNG(p,96)),pdf:await data(pdf),directionalPDF:await data(directionalPDF)};
  },fixture);
  for(const result of raster.results)check(result.name,result.pass);
  await fs.writeFile(path.join(output,'soft-edge.png'),Buffer.from(raster.png));await fs.writeFile(path.join(output,'soft-edge.pdf'),Buffer.from(raster.pdf));
  await fs.writeFile(path.join(output,'single-edge.pdf'),Buffer.from(raster.directionalPDF));
  check('Browser has no uncaught errors',errors.length===0);
  console.log(`${count} checks passed. Artifacts: ${output}`);
}finally{await browser.close();}
