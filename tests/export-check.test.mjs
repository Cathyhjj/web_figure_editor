import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExport } from '../export-check.js';

const canvas = { width: 960, height: 640 };
function deck(assets, items, secondItems = []) {
  return { activeSlideId: 'first', assets, slides: [
    { id: 'first', name: 'Figure 1', canvas, items },
    { id: 'second', name: 'Figure 2', canvas: { width: 480, height: 640 }, items: secondItems },
  ] };
}
const raster = { id: 'plot', mime: 'image/png', width: 1200, height: 600, sourceKind: 'linked' };
const panel = (id, extra = {}) => ({ id, name: id, type: 'image', assetId: 'plot', x: 20, y: 40,
  width: 200, height: 100, opacity: 1, rotation: 0, ...extra });

test('effective DPI uses crop pixels and fitted content at the requested physical size', () => {
  const crop = { x: .25, y: 0, width: .5, height: 1 };
  const project = deck([raster], [panel('stretched', { crop }), panel('letterboxed', { crop, imageFit: 'contain' })]);
  const unchanged = structuredClone(project);
  const result = checkExport(project, { format: 'png', finalWidthMm: 254 });
  assert.deepEqual(result.slides[0].rasters.map(({ dpiX, dpiY, effectiveDpi }) => [dpiX, dpiY, effectiveDpi]), [[288,576,288],[576,576,576]]);
  assert.deepEqual(result.findings.map(f => [f.code,f.slideId,f.itemId]), [['low_raster_dpi','first','stretched']]);
  assert.equal(result.findings[0].minRasterDpi, 300);
  assert.equal(result.findings[0].sourceWidthPx, 600);
  const smaller = checkExport(project, { format: 'svg', finalWidthMm: 127 });
  assert.equal(smaller.slides[0].rasters[0].effectiveDpi, 576);
  assert.equal(smaller.findings.length, 0);
  assert.deepEqual(project, unchanged);
});

test('the threshold compares unrounded DPI and includes only native or explicitly selected pages', () => {
  const item = panel('nearly300', { width: 960, height: 96, x: 0, y: 0 });
  const project = deck([{ ...raster, width: 2999 }], [item], [panel('unused-on-first')]);
  for (const format of ['png','svg','pdf']) {
    const report = checkExport(project, { format });
    assert.deepEqual(report.slides.map(s => s.slideId), ['first']);
    assert.equal(report.slides[0].finalWidthMm, 254);
    assert.equal(Math.round(report.findings[0].effectiveDpi), 300);
    assert.equal(report.findings[0].code, 'low_raster_dpi');
  }
  for (const format of ['pptx','html']) {
    assert.deepEqual(checkExport(project, { format }).slides.map(s => s.finalWidthMm), format === 'pptx' ? [254,254] : [254,127]);
    assert.deepEqual(checkExport(project, { format, slideId: 'second' }).slides.map(s => s.slideId), ['second']);
  }
  assert.deepEqual(checkExport(project, { format: 'pdf', slideId: 'second' }).slides.map(s => s.slideId), ['second']);
  project.assets[0].width = 3000;
  assert.equal(checkExport(project, { format: 'png' }).findings.length, 0);
});

test('PowerPoint mixed-size slides use the common print page, centered canvas, and native slide limits', () => {
  // At 85 mm wide the 2:1 output page is 42.5 mm high. The square second
  // canvas occupies 42.5×42.5 mm and the 12px image spans half its 24px width.
  const project = deck([{ ...raster, width: 200, height: 100 }], [],
    [panel('panel', { x: -1, y: 3, width: 12, height: 6 })]);
  project.slides[0].canvas = { width: 48, height: 24 };
  project.slides[1].canvas = { width: 24, height: 24 };
  const report = checkExport(project, { format: 'pptx', slideId: 'second', finalWidthMm: 85 });
  const slide = report.slides[0];
  assert.deepEqual([slide.finalWidthMm, slide.finalHeightMm], [85, 42.5]);
  assert.deepEqual(slide.pptxCanvasMm, { x: 21.25, y: 0, width: 42.5, height: 42.5 });
  assert.equal(slide.rasters[0].placedWidthMm, 21.25);
  assert.ok(Math.abs(slide.rasters[0].dpiX - 200 / (21.25 / 25.4)) < 1e-8);
  assert.deepEqual(report.findings.map(f => f.code), ['outside_canvas', 'low_raster_dpi']);
  assert.deepEqual(report.findings[0].sides, ['left']);
  const native = checkExport(project, { format: 'pptx', slideId: 'second' }).slides[0];
  assert.deepEqual([native.finalWidthMm,native.finalHeightMm], [50.8,25.4]);
  assert.equal(native.rasters[0].effectiveDpi, 400);
});

test('PDF retains plain text as outlines and rasterizes text effects and gradient shapes', () => {
  const label = { id: 'label', name: 'label', type: 'text', text: 'A', color: '#000000', x: 200, y: 200,
    width: 80, height: 40, fontSize: 20, rotation: 0 };
  const gradient = { angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
  const project = deck([], [label, { ...label, id: 'soft', softEdge: 1 },
    { ...label, type: 'rect', id: 'gradient', fill: '#fff', fillGradient: gradient, strokeWidth: 0 }]);
  assert.deepEqual(checkExport(project, { format: 'pdf' }).slides[0].vectors.map(v => [v.itemId, v.output]),
    [['label','vector'],['soft','rasterized'],['gradient','rasterized']]);
});

test('vectors have no source-DPI findings; flattened SVGs, chart snapshots and video posters use the stored bitmap', () => {
  const svg = { id: 'svg', mime: 'image/svg+xml', width: 10, height: 10 };
  const oldSVG = { ...raster, id: 'flat', width: 40, originalMime: 'image/svg+xml' };
  const chart = { id: 'chart', mime: 'text/html', width: 800, height: 600, posterWidth: 50, posterHeight: 40, hasSnapshot: true };
  const video = { ...chart, id: 'movie', mime: 'video/mp4' };
  const project = deck([svg, oldSVG, chart, video], [
    panel('vector', { assetId: svg.id }), panel('flat', { assetId: oldSVG.id }),
    panel('chart', { type: 'html', assetId: chart.id }), panel('movie', { type: 'video', assetId: video.id }),
  ]);
  for (const [format, output] of [['png','rasterized'],['pdf','rasterized'],['pptx','vector_with_png_fallback'],['html','vector'],['svg','vector']]) {
    const report = checkExport(project, { format });
    assert.deepEqual(report.slides[0].vectors, [{ itemId: 'vector', itemName: 'vector', assetId: 'svg', output }]);
    assert.deepEqual(report.findings.map(f => [f.itemId, f.sourceType]), [['flat','flattened_svg'],['chart','html_snapshot'],['movie','video_poster']]);
    assert.equal(report.slides[0].rasters[1].dpiX, 24);
  }
});

test('all formats report missing snapshots on the inspected slide, skipping hidden and transparent objects', () => {
  const project = deck([{ id: 'chart', mime: 'text/html', hasSnapshot: false }],
    [panel('h', { type: 'html', assetId: 'chart', hidden: true }), panel('t', { type: 'html', assetId: 'chart', opacity: 0 })],
    [panel('missing', { type: 'html', assetId: 'chart' })]);
  for (const format of ['png','svg','pdf','pptx','html']) {
    assert.equal(checkExport(project, { format, slideId: 'first' }).findings.length, 0);
    const { findings, slides } = checkExport(project, { format, slideId: 'second' });
    assert.deepEqual(findings, [{ code: 'missing_html_snapshot', slideId: 'second', slideName: 'Figure 2',
      itemId: 'missing', itemName: 'missing', assetId: 'chart' }]);
    assert.deepEqual(slides[0].rasters, []);
  }
});

test('rotated painted bounds include borders and exclude empty contain margins and transparent objects', () => {
  const square = { ...raster, width: 600, height: 600 };
  const project = deck([square], [
    panel('padding', { x: -30, imageFit: 'contain' }),
    panel('border', { x: -30, imageFit: 'contain', stroke: '#123456', strokeWidth: 2 }),
    panel('rotated', { x: 100, y: 20, rotation: 90 }),
    panel('touch', { x: 100, y: 50, rotation: 90 }),
    { ...panel('clear'), type: 'rect', x: -999, fill: 'transparent', strokeWidth: 0 },
  ]);
  const result = checkExport(project, { format: 'svg', minRasterDpi: 1 });
  assert.deepEqual(result.findings.map(f => [f.code,f.itemId,f.sides]),
    [['outside_canvas','border',['left']],['outside_canvas','rotated',['top']]]);
});

test('invalid options and unknown slides fail explicitly', () => {
  const project = deck([], []);
  for (const opts of [{}, { format: 'jpg' }, { format: 'png', finalWidthMm: 0 }, { format: 'svg', minRasterDpi: NaN },
    { format: 'svg', slideId: 'nonexistent' }, { format: 'pptx', slideId: null }, { format: 'pdf', other: true },
    { format: 'svg', finalWidthMm: Number.MIN_VALUE }]) assert.throws(() => checkExport(project, opts));
});
