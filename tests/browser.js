import { importFiles } from '../assets.js';
import { createProject, exportPNG, projectToSVG } from '../core.js';

const checks = [];
function assert(name, ok) {
  checks.push({ name, pass: !!ok });
  const li = document.createElement('li');
  li.textContent = `${ok ? 'PASS' : 'FAIL'} — ${name}`;
  document.querySelector('#results').append(li);
}

async function checkGeneratedPNG() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 3;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      pixels.data.set(x < 2 ? [216, 45, 70, 255] : [32, 97, 186, 255], (y * canvas.width + x) * 4);
    }
  }
  context.putImageData(pixels, 0, 0);
  const fixture = await new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Could not encode the generated PNG fixture.')),
    'image/png',
  ));
  const raster = await importFiles([new File([fixture], 'generated-fixture.png', { type: 'image/png' })]);
  assert('Real PNG decode preserves generated dimensions 4×3', raster.errors.length === 0 && raster.assets[0]?.width === 4 && raster.assets[0]?.height === 3);
  if (!raster.assets[0]) throw new Error('Generated PNG did not import.');
  const decoded = new Image();
  decoded.src = raster.assets[0].dataUrl;
  await decoded.decode();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(decoded, 0, 0);
  const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
  assert('Imported PNG preserves every generated RGBA pixel', actual.every((value, index) => value === pixels.data[index]));
}

document.querySelector('#run').onclick = async () => {
  document.querySelector('#results').replaceChildren();
  checks.length = 0;
  try {
    await checkGeneratedPNG();
    const safe = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="navy"/><text x="10" y="30" fill="white">Demo</text></svg>';
    const vector = await importFiles([new File([safe], 'safe.svg', { type: 'image/svg+xml' })]);
    assert('Safe SVG rasterizes at 3× and retains original SVG', vector.assets[0]?.width === 300 && vector.assets[0]?.height === 150 && vector.assets[0]?.originalMime === 'image/svg+xml');
    for (const [name, markup] of [
      ['script', '<script>alert(1)</script>'],
      ['external image', '<image href="https://example.com/never-fetch.png"/>'],
      ['foreignObject', '<foreignObject><div>no</div></foreignObject>'],
    ]) {
      const result = await importFiles([new File([`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`], `${name}.svg`)]);
      assert(`Rejects unsafe SVG ${name}`, result.assets.length === 0 && result.errors.length === 1);
    }
    const project = createProject();
    project.canvas = { width: 100, height: 50, background: '#ffffff' };
    project.assets = vector.assets;
    project.items = [{ id: 'test-image', type: 'image', assetId: vector.assets[0].id, x: 0, y: 0, width: 100, height: 50 }];
    const blob = await exportPNG(project, 300);
    const bitmap = await createImageBitmap(blob);
    assert('Actual PNG rendering creates 313×156 export', bitmap.width === 313 && bitmap.height === 156);
    bitmap.close();
    const svg = projectToSVG(project);
    assert('SVG export embeds raster preview without active original SVG', svg.includes('data:image/png;base64,') && !svg.includes('data:image/svg+xml;base64,'));
  } catch (error) {
    assert(error.stack || error.message, false);
  }
  document.title = checks.every(check => check.pass) ? 'PASS — Figure Editor browser checks' : 'FAIL — Figure Editor browser checks';
};
