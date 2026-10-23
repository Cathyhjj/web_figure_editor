// Generate the native comparison input without changing any saved project.
// Open the output in Microsoft PowerPoint, then export every slide as PNG at 800x600.
import { readFile, writeFile } from 'node:fs/promises';
import { exportPPTX } from '../pptx.js';
const {cases}=JSON.parse(await readFile(new URL('../tests/fixtures/powerpoint-radial/cases.json',import.meta.url),'utf8'));
const deck={format:'figure-editor',version:2,id:'native-radial-reference',name:'Native radial reference',assets:[],activeSlideId:cases[0].project.id,
  slides:cases.map(({project:p})=>({id:p.id,name:p.name,canvas:p.canvas,items:p.items}))};
const output=process.argv[2];
if(!output)throw Error('Usage: node scripts/create-radial-reference.mjs /tmp/radial-reference.pptx');
await writeFile(output,Buffer.from(await(await exportPPTX(deck)).arrayBuffer()));
console.log(`Wrote ${cases.length} slides to ${output}`);
