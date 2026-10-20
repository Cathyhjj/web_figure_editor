import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createDeck, validateDeck, cloneDeck } from '../deck.js';
import { createSelection, encodeSelection, decodeSelection } from '../clipboard.js';
import { selectionImageProject } from '../clipboard-image.js';
import { exportPDF } from '../pdf.js';
import { exportPPTX } from '../pptx.js';
import { SHAPE_TYPES, arrowHeads, shapeBounds, shapeColor } from '../shapes.js';
import { resizeItem } from '../resize.js';

const item = (type, extra = {}) => ({ id: type, name: type, type, x: 40, y: 40, width: 120, height: type.includes('rrow') || type === 'line' ? 0 : 80, fill: '#ff0000', stroke: '#004488', strokeWidth: 4, fillOpacity: .2, strokeOpacity: .65, strokeDash: 'dash', ...extra });
const fixture = () => ({ ...createProject(), items: SHAPE_TYPES.map(type => item(type)) });

test('all shape styles survive save, deck cloning and editable selection clipboard', () => {
  const project = validateProject(fixture());
  assert.deepEqual(JSON.parse(serializeProject(project)), project);
  const deck = createDeck();
  deck.slides[0].items = project.items;
  assert.deepEqual(cloneDeck(validateDeck(deck)).slides[0].items, project.items);
  const selected = createSelection(project, new Set(project.items.map(i => i.id)));
  const restored = decodeSelection(encodeSelection(selected));
  assert.deepEqual(restored.items, selected.items);
  assert.equal(restored.items[0].fillOpacity, .2);
  assert.equal(restored.items[0].strokeOpacity, .65);
});

test('legacy shapes retain opaque solid defaults and invalid style data is rejected', () => {
  const old = { ...createProject(), items: [{ id: 'old', type: 'rect', x: 0, y: 0, width: 20, height: 30 }] };
  const canonical = validateProject(old).items[0];
  assert.equal(canonical.fillOpacity, 1);
  assert.equal(canonical.strokeOpacity, 1);
  assert.equal(canonical.strokeDash, 'solid');
  for (const style of [{ fillOpacity: -1 }, { strokeOpacity: 2 }, { strokeOpacity: NaN }, { strokeDash: 'url(evil)' }, { cornerRadius: 2 }]) {
    assert.throws(() => validateProject({ ...old, items: [item('roundRect', style)] }), /Invalid figure project/);
  }
  assert.throws(() => projectToSVG({ ...old, items: [item('ellipse', { stroke: '"><script>' })] }), /hex color/);
});

test('SVG uses vectors with independent paints and keeps dashed arrowheads solid', () => {
  const svg = projectToSVG(fixture());
  assert.match(svg, /<ellipse[^>]+fill-opacity="0.2"[^>]+stroke-opacity="0.65"/);
  assert.match(svg, /rx="13.333333"/);
  assert.match(svg, /stroke-dasharray="16 12"/);
  const arrow = svg.slice(svg.indexOf('<g id="doubleArrow"'));
  assert.equal((arrow.match(/<path /g) || []).length, 2);
  assert.equal((arrow.match(/stroke-dasharray=/g) || []).length, 1);
  assert.equal(svg.includes('<image'), false);
});

test('copy bounds enclose wide arrowheads at all rotations, including short and vertical arrows', () => {
  for (const extra of [{}, { rotation: 45 }, { width: 0, height: 100 }, { width: 2, height: 0 }, { width: 0, height: 0 }]) {
    const arrow = validateProject({ ...createProject(), items: [item('doubleArrow', { strokeWidth: 20, ...extra })] }).items[0];
    const copied = selectionImageProject({ ...createProject(), items: [arrow] });
    const translated = copied.items[0], radians = translated.rotation * Math.PI / 180;
    const box = shapeBounds(arrow);
    for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
      const cx = translated.width / 2, cy = translated.height / 2;
      const px = translated.x + cx + (x - cx) * Math.cos(radians) - (y - cy) * Math.sin(radians);
      const py = translated.y + cy + (x - cx) * Math.sin(radians) + (y - cy) * Math.cos(radians);
      assert.ok(px >= -1e-7 && px <= copied.canvas.width + 1e-7);
      assert.ok(py >= -1e-7 && py <= copied.canvas.height + 1e-7);
    }
    assert.ok(arrowHeads(arrow).flat(2).every(Number.isFinite));
  }
});

test('Shift keeps circles proportional; horizontal and vertical lines can stay flat during resize', () => {
  const circle = item('ellipse', { width: 100, height: 100 });
  assert.deepEqual(resizeItem(circle, 'se', 50, 20, { free: true }), { x: 40, y: 40, width: 150, height: 150 });
  assert.equal(resizeItem(item('arrow'), 'se', 20, 0).height, 0);
  assert.equal(resizeItem(item('arrow', { width: 0, height: 100 }), 'se', 0, 20).width, 0);
});

test('PDF preserves curves, stroke patterns and independent alpha without raster images', async () => {
  const pdf = await (await exportPDF(fixture())).text();
  assert.match(pdf, / c\n/);
  assert.match(pdf, /\[16 12\] 0 d/);
  assert.match(pdf, /\/ca 0.2 \/CA 0.65/);
  assert.match(pdf, /\/S \/Transparency/);
  assert.equal(pdf.includes('/Subtype /Image'), false);
});

test('PPTX round-trip retains editable shape types, open arrows, dashes and separate paint alpha', async () => {
  const project = fixture();
  project.items.forEach((shape, index) => { shape.x += index * 40; shape.rotation = index * 15; });
  const blob = await exportPPTX(project);
  const script = `import sys,json,base64\nfrom pptx_import import import_pptx\nprint(json.dumps(import_pptx({'name':'shapes.pptx','data':base64.b64encode(sys.stdin.buffer.read()).decode(),'slide':1})))`;
  const imported = JSON.parse(execFileSync('python3', ['-c', script], { input: Buffer.from(await blob.arrayBuffer()), cwd: new URL('..', import.meta.url), maxBuffer: 2 * 1024 * 1024 }));
  const shapes = imported.items.filter(shape => shape.name !== 'Slide background');
  assert.deepEqual(shapes.map(shape => shape.type), SHAPE_TYPES);
  assert.equal(imported.media.length, 0);
  assert.ok(imported.warnings.every(warning => warning.startsWith('Fonts must be installed')), imported.warnings.join('\n'));
  for (const shape of shapes) {
    assert.equal(shape.strokeDash, 'dash');
    assert.ok(Math.abs(shapeColor(shape.stroke).alpha - .65) < .005);
    if (!['line', 'arrow', 'doubleArrow'].includes(shape.type)) assert.ok(Math.abs(shapeColor(shape.fill).alpha - .2) < .005);
  }
});
