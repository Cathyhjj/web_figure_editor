import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, uid, validateProject, serializeProject, projectToSVG, exportPNG, sourceManifest } from '../core.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = () => ({ id: 'asset-1', name: 'sample.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 1, height: 1, size: 68, lastModified: 123, sourceKind: 'copy' });
const imageItem = () => ({ id: 'image-1', type: 'image', assetId: 'asset-1', x: 0, y: 0, width: 100, height: 100 });
const textItem = () => ({ id: 'text-1', type: 'text', x: 12, y: 8, width: 120, height: 80, text: 'A & B\n<sample>', fontSize: 20 });
const fixture = () => ({ ...createProject(), id: 'project-1', assets: [asset()], items: [imageItem(), textItem()] });

test('creates independent projects and round-trips canonical editable content', () => {
  const p = fixture();
  const validated = validateProject(p);
  assert.notEqual(uid(), uid());
  assert.deepEqual(createProject().canvas, { width: 960, height: 640, background: '#ffffff' });
  assert.deepEqual(JSON.parse(serializeProject(p)), validated);
  validated.items[0].x = 3;
  assert.equal(p.items[0].x, 0);
  assert.equal(validated.items[1].fontFamily, 'Arial');
  assert.equal(validated.items[1].opacity, 1);
});

test('rejects invalid versions, non-finite geometry, duplicates, and missing assets', () => {
  for (const mutate of [
    p => p.version = 2,
    p => p.canvas.width = Infinity,
    p => p.items[0].x = NaN,
    p => p.items[0].width = -1,
    p => p.items[0].opacity = 1.1,
    p => p.items[0].hidden = 'false',
    p => p.items.push({ ...p.items[0] }),
    p => p.assets.push({ ...p.assets[0] }),
    p => p.items[0].assetId = 'missing',
    p => p.items[0].id = 'id" onclick="oops',
  ]) {
    const p = fixture(); mutate(p);
    assert.throws(() => validateProject(p), /Invalid figure project/);
  }
});

test('rejects external image URLs, active image MIME, forged MIME and invalid base64', () => {
  for (const dataUrl of ['https://example.org/image.png', 'file:///private/image.png', 'data:image/png;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,@@@=', 'data:image/png;base64,a===']) {
    const p = fixture(); p.assets[0].dataUrl = dataUrl;
    assert.throws(() => validateProject(p), /Invalid figure project/);
  }
  const p = fixture(); p.assets[0].mime = 'image/svg+xml';
  p.assets[0].dataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  assert.throws(() => validateProject(p), /unsupported MIME/);
});

test('discards unknown fields and blocks paint-server URLs', () => {
  const p = fixture();
  p.items[1].onclick = 'alert(1)';
  p.assets[0].fileHandle = { private: true };
  p.unknown = 'unused';
  const safe = validateProject(p);
  assert.equal(safe.unknown, undefined);
  assert.equal(safe.assets[0].fileHandle, undefined);
  assert.equal(safe.items[1].onclick, undefined);
  p.items[1].color = 'url(https://example.org/x)';
  assert.throws(() => projectToSVG(p), /hex color/);
});

test('SVG exports physical dimensions, escaped vector text, correct baselines and embedded raster', () => {
  const p = fixture();
  p.name = 'A <figure> & "quote"';
  p.items[1].fontFamily = 'A"/><script>alert(1)</script><text x="';
  p.items[1].align = 'center';
  p.items[1].rotation = 90;
  const svg = projectToSVG(p);
  assert.match(svg, /width="254mm" height="169\.333333mm" viewBox="0 0 960 640"/);
  assert.match(svg, /<title>A &lt;figure&gt; &amp; &quot;quote&quot;<\/title>/);
  assert.match(svg, /<tspan x="60" y="20">A &amp; B<\/tspan>/);
  assert.match(svg, /<tspan x="60" y="44">&lt;sample&gt;<\/tspan>/);
  assert.match(svg, /rotate\(90 60 40\)/);
  assert.match(svg, /href="data:image\/png;base64,/);
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /font-family="A&quot;\/&gt;&lt;script&gt;/);
});

test('SVG honors stack order, hidden objects, transparency, edge geometry and zero-height lines', () => {
  const p = fixture();
  p.items[0].hidden = true;
  p.canvas.background = 'transparent';
  p.items.push({ id: 'line-1', type: 'line', x: 0, y: 640, width: 960, height: 0, stroke: '#123456', strokeWidth: 1 });
  p.items.push({ id: 'rect-1', type: 'rect', x: 950, y: 630, width: 10, height: 10, opacity: 0.5, fill: 'none' });
  const svg = projectToSVG(p);
  assert.equal(svg.includes('<image '), false);
  assert.match(svg, /fill="transparent"/);
  assert.match(svg, /<line x1="0" y1="0" x2="960" y2="0"/);
  assert.match(svg, /translate\(950 630\)/);
  assert.match(svg, /opacity="0\.5"/);
  assert.ok(svg.indexOf('<g id="text-1"') < svg.indexOf('<g id="line-1"'));
  assert.ok(svg.indexOf('<g id="line-1"') < svg.indexOf('<g id="rect-1"'));
});

test('source manifest preserves provenance without binary data or pretending file handles persist', () => {
  const p = fixture();
  Object.assign(p.assets[0], { sourceKind: 'linked', relativePath: 'figures/sample.svg', fingerprint: 'sha256-test', originalMime: 'image/svg+xml', originalDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  const safe = validateProject(p);
  assert.equal(safe.assets[0].originalDataUrl, p.assets[0].originalDataUrl);
  const m = sourceManifest(p);
  assert.deepEqual(m.sources[0].usedBy, ['image-1']);
  assert.equal(m.sources[0].embeddedCopy, true);
  assert.equal(m.sources[0].sourceKind, 'linked');
  assert.equal(m.sources[0].renderedAs, 'raster');
  assert.equal(m.sources[0].originalEmbedded, true);
  assert.equal(m.sources[0].dataUrl, undefined);
  assert.equal(m.sources[0].originalDataUrl, undefined);
  assert.match(m.exportNotes.localSources, /not serialized/);
  assert.equal(projectToSVG(p).includes('data:image/svg+xml'), false);
});

test('PNG rejects excessive allocations and invalid DPI before touching browser APIs', async () => {
  const p = fixture();
  await assert.rejects(exportPNG(p, NaN), /export DPI/);
  await assert.rejects(exportPNG(p, 0), /export DPI/);
  p.canvas = { width: 16000, height: 16000, background: '#ffffff' };
  await assert.rejects(exportPNG(p, 300), /100 megapixels/);
});

test('portable projects and source manifests retain bounded link and rasterization metadata', () => {
  const p = fixture();
  Object.assign(p.assets[0], { sourceKind: 'linked', linkPersistence: 'session', rasterized: true, rasterizationScale: 3 });
  const reloaded = validateProject(JSON.parse(serializeProject(p)));
  const source = sourceManifest(reloaded).sources[0];
  for (const key of ['linkPersistence', 'rasterized', 'rasterizationScale']) {
    assert.equal(reloaded.assets[0][key], p.assets[0][key]);
    assert.equal(source[key], p.assets[0][key]);
  }
  for (const [key, value] of [['linkPersistence', 'permanent'], ['rasterized', 'true'], ['rasterizationScale', 0], ['rasterizationScale', Infinity], ['rasterizationScale', 17]]) {
    const invalid = fixture(); invalid.assets[0][key] = value;
    assert.throws(() => validateProject(invalid), new RegExp(`asset.${key}`));
  }
});

test('immutable local-link references survive save/reopen without claiming portable handles', () => {
  const beforeRelink = fixture();
  Object.assign(beforeRelink.assets[0], { sourceKind: 'linked', linkToken: 'e73f9a72-42bb-4442-a9b7-bfe18d2cf190' });
  const afterRelink = validateProject(beforeRelink);
  afterRelink.assets[0].linkToken = 'next-binding_2';
  const restored = validateProject(JSON.parse(serializeProject(beforeRelink)));
  assert.equal(restored.assets[0].linkToken, beforeRelink.assets[0].linkToken);
  assert.notEqual(restored.assets[0].linkToken, afterRelink.assets[0].linkToken);
  const source = sourceManifest(restored).sources[0];
  assert.equal(source.linkToken, beforeRelink.assets[0].linkToken);
  assert.match(source.linkTokenScope, /Browser-local.*not embedded/);
  assert.equal(validateProject(fixture()).assets[0].linkToken, undefined);
  for (const token of ['', 'x'.repeat(201), '../file', 'id:other', 'invalid token', '<script>']) {
    const p = fixture(); p.assets[0].linkToken = token;
    assert.throws(() => validateProject(p), /asset.linkToken/);
  }
});

test('PNG scales pixels to physical DPI, writes pHYs metadata with CRC, and cleans browser resources', async () => {
  const calls = [];
  const canvases = [];
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  globalThis.document = { fonts: { ready: Promise.resolve() }, createElement(type) {
    assert.equal(type, 'canvas');
    const c = { width: 0, height: 0, getContext() { return { drawImage(...args) { calls.push(args.slice(1)); } }; }, toBlob(callback, mime) { assert.equal(mime, 'image/png'); callback(new Blob([Buffer.from(PIXEL, 'base64')], { type: mime })); } };
    canvases.push(c); return c;
  } };
  globalThis.Image = class { set src(value) { assert.equal(value, 'blob:test'); queueMicrotask(() => this.onload()); } };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = value => calls.push(['revoke', value]);
  try {
    const png = await exportPNG(fixture(), 300);
    assert.deepEqual(calls[0], [0, 0, 3000, 2000]);
    assert.equal(png.type, 'image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    const index = bytes.indexOf('pHYs');
    assert.equal(index, 37);
    assert.equal(bytes.readUInt32BE(index - 4), 9);
    assert.equal(bytes.readUInt32BE(index + 4), 11811);
    assert.equal(bytes.readUInt32BE(index + 8), 11811);
    assert.equal(bytes[index + 12], 1);
    // A separate table-driven CRC implementation checks PNG chunk integrity.
    const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(index, index + 13)) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    assert.equal(bytes.readUInt32BE(index + 13), (crc ^ 0xffffffff) >>> 0);
    assert.deepEqual(calls.at(-1), ['revoke', 'blob:test']);
    assert.equal(canvases[0].width, 0);
    assert.equal(canvases[0].height, 0);
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
