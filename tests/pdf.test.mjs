import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createProject } from '../core.js';
import { exportPDF } from '../pdf.js';
import { shadowBounds } from '../shadow.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const fixture = (width = 2, height = 2) => ({
  ...createProject(), id: 'pdf-fixture',
  canvas: { width, height, background: 'transparent' },
});
const item = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, width: 20, height: 10, ...extra });
function imageFixture(extra = {}) {
  const project = fixture(200, 100);
  project.assets = [{ id: 'source', name: 'source.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG}`, width: 2, height: 2 }];
  project.items = [item('image', 'image', { assetId: 'source', ...extra })];
  return project;
}

async function withBrowser(options, run) {
  const descriptors = new Map(['document', 'Image', 'CompressionStream', 'fetch', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const state = { canvases: [], blobs: [], revoked: [], draws: [], reads: [], sources: [], requests: [] };
  globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' };
  globalThis.document = {
    fonts: { ready: options.fontsReady ?? Promise.resolve() },
    createElement(type) {
      assert.equal(type, 'canvas');
      if (options.createError) throw options.createError;
      const canvas = {
        width: 0, height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          if (options.noContext) return null;
          return {
            drawImage(image, ...args) {
              state.draws.push(args);
              if (options.drawError) throw options.drawError;
            },
            getImageData(...args) {
              state.reads.push(args);
              if (options.readError) throw options.readError;
              const data = typeof options.rgba === 'function' ? options.rgba(canvas.width, canvas.height) : options.rgba ?? new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
              assert.equal(data.length, canvas.width * canvas.height * 4);
              return { data };
            },
          };
        },
      };
      state.canvases.push(canvas);
      return canvas;
    },
  };
  globalThis.Image = class {
    naturalWidth = options.naturalWidth ?? 2;
    naturalHeight = options.naturalHeight ?? 2;
    set src(value) {
      assert.match(value, /^(?:blob:pdf-test-|data:image\/)/);
      state.sources.push(value);
      queueMicrotask(() => options.imageError ? this.onerror() : this.onload());
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    state.requests.push({ url, ...init });
    if (options.fetchError) throw options.fetchError;
    const metadata = { app: 'figure-editor-local', version: 1, pdfTextOutlines: true, token: 'test-token' };
    const body = url === '/api/local' ? options.metadata ?? metadata : options.outlineResponse ?? {
      outlines: JSON.parse(init.body).items.map(entry => ({ id: entry.id, lines: entry.text.split('\n').map((_, index) => ({ width: index ? 2 : 4, path: '0 0 m 3 0 l 3 2 l 0 2 l h' })) })),
    };
    return new Response(JSON.stringify(body), { status: options.responseStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  if ('compression' in options) globalThis.CompressionStream = options.compression;
  URL.createObjectURL = blob => { state.blobs.push(blob); return `blob:pdf-test-${state.blobs.length}`; };
  URL.revokeObjectURL = value => state.revoked.push(value);
  try { return await run(state); }
  finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

function assertReleased(state) {
  assert.deepEqual(state.revoked, state.blobs.map((_, index) => `blob:pdf-test-${index + 1}`));
  for (const canvas of state.canvases) {
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  }
}

// Read the binary file through its cross-reference table, independently of the
// writer. Lengths and offsets are byte offsets, including binary image data.
async function parsePDF(blob) {
  assert.equal(blob.type, 'application/pdf');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 9).toString('ascii'), '%PDF-1.4\n');
  const end = bytes.toString('latin1').match(/startxref\n(\d+)\n%%EOF\n$/);
  assert.ok(end, 'PDF has a final cross-reference pointer');
  const xrefOffset = Number(end[1]);
  const xref = bytes.subarray(xrefOffset).toString('ascii');
  const header = xref.match(/^xref\n0 (\d+)\n/);
  assert.ok(header, 'startxref points exactly to the table');
  const count = Number(header[1]);
  const lines = xref.slice(header[0].length).split('\n');
  assert.equal(lines[0], '0000000000 65535 f ');
  assert.match(xref, new RegExp(`trailer\\n<< /Size ${count} /Root \\d+ 0 R >>`));
  const offsets = lines.slice(1, count).map(line => {
    assert.match(line, /^\d{10} 00000 n $/);
    return Number(line.slice(0, 10));
  });
  const objects = new Map();
  for (let index = 0; index < offsets.length; index++) {
    const id = index + 1;
    const object = bytes.subarray(offsets[index], offsets[index + 1] ?? xrefOffset);
    const prefix = `${id} 0 obj\n`;
    assert.equal(object.subarray(0, prefix.length).toString('ascii'), prefix);
    assert.equal(object.subarray(-8).toString('ascii'), '\nendobj\n');
    const body = object.subarray(prefix.length, -8);
    const streamAt = body.indexOf('\nstream\n');
    const dictionary = body.subarray(0, streamAt < 0 ? body.length : streamAt).toString('ascii');
    const entry = { dictionary };
    if (streamAt >= 0) {
      const length = dictionary.match(/\/Length (\d+)\b/);
      assert.ok(length, `stream ${id} declares its byte length`);
      const start = streamAt + '\nstream\n'.length;
      entry.stream = body.subarray(start, start + Number(length[1]));
      assert.equal(entry.stream.length, Number(length[1]));
      assert.match(body.subarray(start + entry.stream.length).toString('ascii'), /^\n?endstream$/);
      entry.decoded = dictionary.includes('/FlateDecode') ? inflateSync(entry.stream) : entry.stream;
    }
    objects.set(id, entry);
  }
  for (const entry of objects.values()) {
    for (const reference of entry.dictionary.matchAll(/\b(\d+) 0 R\b/g)) assert.ok(objects.has(Number(reference[1])), 'all object references resolve');
  }
  assert.equal([...objects.values()].filter(object => /\/Type \/Catalog\b/.test(object.dictionary)).length, 1);
  assert.equal([...objects.values()].filter(object => /\/Type \/Pages\b/.test(object.dictionary) && /\/Count 1\b/.test(object.dictionary)).length, 1);
  return objects;
}

const page = objects => [...objects.values()].find(object => /\/Type \/Page\b/.test(object.dictionary));
const images = objects => [...objects.values()].filter(object => /\/Subtype \/Image\b/.test(object.dictionary));
const graphics = objects => [...objects.values()].filter(object => object.decoded && !/\/Subtype \/Image\b/.test(object.dictionary)).map(object => object.decoded.toString('ascii')).join('\n');
const dictionaries = objects => [...objects.values()].map(object => object.dictionary).join('\n');
const vectorOnly = { createError: new Error('Vector export must not allocate a drawing canvas') };

test('PDF keeps rectangles and lines as native paths with transforms and no drawing canvas', async () => {
  await withBrowser(vectorOnly, async state => {
    const project = fixture(200, 100);
    project.items = [
      item('rect', 'rect', { x: 10, y: 20, width: 20, height: 10, rotation: 90, fill: '#ff0000', stroke: 'blue', strokeWidth: 2 }),
      item('line', 'line', { x: 3, y: 4, width: 30, height: 0, stroke: '#00ff00', strokeWidth: 3 }),
      item('hidden', 'rect', { width: 777, height: 333, fill: '#abcdef', hidden: true }),
      item('hidden-label', 'text', { text: 'Hidden Unicode 中文', hidden: true }),
    ];
    const objects = await parsePDF(await exportPDF(project, 300));
    const content = graphics(objects);
    assert.equal(images(objects).length, 0);
    assert.match(page(objects).dictionary, /\/MediaBox \[0 0 150 75\]/);
    assert.match(content, /0?\.75 0 0 -0?\.75 0 75 cm/);
    assert.match(content, /0 0 20 10 re/);
    assert.match(content, /1 0 0 rg/);
    assert.match(content, /0 0 1 RG/);
    assert.match(content, /0 1 0 RG/);
    assert.match(content, /2 w/);
    assert.match(content, /3 w/);
    assert.match(content, /0 0 m\s+30 0 l\s+S/);
    assert.match(content, /0 1 -1 0 [\d. -]+ cm/, '90-degree rotation stays a PDF transform');
    assert.doesNotMatch(content, /777|333/);
    assert.equal(state.canvases.length, 0);
    assert.equal(state.requests.length, 0);
  });
});

test('PDF preserves color alpha and applies object opacity as a transparency group', async () => {
  await withBrowser(vectorOnly, async () => {
    const project = fixture(30, 20);
    project.items = [item('alpha', 'rect', { fill: '#f008', stroke: '#0000ff80', opacity: 0.5 })];
    const objects = await parsePDF(await exportPDF(project));
    const dicts = dictionaries(objects);
    assert.equal(images(objects).length, 0);
    assert.match(dicts, /\/Type \/ExtGState/);
    assert.match(dicts, /\/ca 0\.533333/);
    assert.match(dicts, /\/CA 0\.501961/);
    assert.match(dicts, /\/ca 0\.5\b/);
    assert.match(dicts, /\/Subtype \/Form/);
    assert.match(dicts, /\/S \/Transparency/);
  });
});

test('PDF outlines Unicode text through the authenticated font endpoint without rasterization', async () => {
  await withBrowser(vectorOnly, async state => {
    const project = fixture(100, 50);
    const text = 'μ(E) · 中文 α → β & <sample>\nSecond';
    project.items = [item('label', 'text', { x: 10, y: 8, width: 20, height: 30, text, fontSize: 10, fontFamily: 'Arial', fontWeight: 'bold', fontStyle: 'italic', align: 'center' })];
    const objects = await parsePDF(await exportPDF(project));
    assert.equal(images(objects).length, 0);
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[0].url, '/api/local');
    assert.equal(state.requests[1].url, '/api/pdf-text');
    assert.equal(state.requests[1].method, 'POST');
    assert.ok(JSON.stringify(state.requests[1].headers).includes('test-token'), 'the local token authenticates the font request');
    assert.deepEqual(JSON.parse(state.requests[1].body), { items: [{ id: 'label', text, fontFamily: 'Arial', fontSize: 10, fontWeight: 'bold', fontStyle: 'italic' }] });
    const content = graphics(objects);
    assert.equal(content.match(/0 0 m 3 0 l 3 2 l 0 2 l h/g)?.length, 2, 'each line retains its vector glyph path');
    assert.match(content, /1 0 0 -1 8 10 cm/, 'first line is centered with a font-size baseline');
    assert.match(content, /1 0 0 -1 9 22 cm/, 'second line is centered with 1.2 line spacing');
    assert.equal(state.canvases.length, 0);
    assert.equal(state.sources.length, 0);
  });
});

test('PDF fails clearly if font outlines are unavailable instead of rasterizing text', async () => {
  const project = fixture();
  project.items = [item('label', 'text', { text: 'Unicode μ' })];
  for (const options of [
    { metadata: { app: 'figure-editor-local', version: 1, pdfTextOutlines: false, token: 'test-token' } },
    { metadata: { app: 'other-app', version: 1, pdfTextOutlines: true, token: 'test-token' } },
    { metadata: { app: 'figure-editor-local', version: 1, pdfTextOutlines: true } },
    { responseStatus: 500 },
    { fetchError: new Error('font endpoint unreachable') },
    { outlineResponse: { outlines: [] } },
    { outlineResponse: { outlines: [{ id: 'label', lines: [{ width: 4, path: '0 0 m NaN 1 l h' }] }] } },
    { outlineResponse: { outlines: [{ id: 'label', lines: [{ width: 4, path: '0 0 m 1 1 l /Unexpected Do' }] }] } },
  ]) {
    await withBrowser({ ...vectorOnly, ...options }, async state => {
      await assert.rejects(exportPDF(project), /font|outline|vector|local|PDF/i);
      assert.equal(state.canvases.length, 0);
      assert.equal(state.sources.length, 0);
    });
  }
});

test('PDF embeds original image pixels losslessly with late transparency and valid binary streams', async () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 12, 34, 56, 0]);
  await withBrowser({ rgba }, async state => {
    const objects = await parsePDF(await exportPDF(imageFixture(), 600));
    const rgb = images(objects).find(object => /\/DeviceRGB/.test(object.dictionary));
    assert.ok(rgb);
    assert.match(rgb.dictionary, /\/Width 2 \/Height 2 \//);
    assert.match(rgb.dictionary, /\/Filter \/FlateDecode/);
    assert.deepEqual([...rgb.decoded], [255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56]);
    const maskId = rgb.dictionary.match(/\/SMask (\d+) 0 R/);
    assert.ok(maskId);
    const mask = objects.get(Number(maskId[1]));
    assert.match(mask.dictionary, /\/ColorSpace \/DeviceGray/);
    assert.deepEqual([...mask.decoded], [255, 255, 128, 0]);
    assert.deepEqual(state.reads, [[0, 0, 2, 2]], 'source image decoding does not upsample to export DPI');
    assert.equal(state.requests.length, 0);
    assertReleased(state);
  });
});

test('PDF crops an image with a vector clip while preserving original source pixels', async () => {
  await withBrowser({}, async state => {
    const objects = await parsePDF(await exportPDF(imageFixture({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }), 96));
    const content = graphics(objects);
    assert.match(content, /0 0 20 10 re\s+W\s+n/);
    assert.match(content, /40 0 0 -10 -10 10 cm/, 'crop scales/translates the intact source behind the visible frame');
    assert.equal(images(objects).length, 1);
    assert.doesNotMatch(images(objects)[0].dictionary, /SMask/);
    assert.match(images(objects)[0].dictionary, /\/Width 2 \/Height 2\b/);
    assertReleased(state);
  });
});

test('PDF rasterizes only the shadow object bounds at the requested DPI', async () => {
  await withBrowser({}, async state => {
    const project = imageFixture({ x: 50, y: 30, width: 4, height: 2, rotation: 90, shadow: { enabled: true, blur: 0, distance: 0 } });
    project.canvas.width = 16000;
    project.canvas.height = 16000;
    project.items.push(item('native-rect', 'rect', { width: 777, height: 333, fill: '#ff0000' }));
    const bounds = shadowBounds(project.items[0]);
    for (const dpi of [96, 192]) {
      const objects = await parsePDF(await exportPDF(project, dpi));
      const width = Math.round(bounds.width * dpi / 96), height = Math.round(bounds.height * dpi / 96);
      assert.match(images(objects).find(object => /\/DeviceRGB/.test(object.dictionary)).dictionary, new RegExp(`/Width ${width} /Height ${height}\\b`));
      assert.deepEqual(state.reads.at(-1), [0, 0, width, height]);
      assert.match(graphics(objects), /0 0 777 333 re/, 'other objects remain native PDF paths');
      const svg = await state.blobs.at(-1).text();
      assert.match(svg, /feGaussianBlur/);
      assert.doesNotMatch(svg, /native-rect/, 'the raster patch excludes unrelated objects');
      assert.match(page(objects).dictionary, /\/MediaBox \[0 0 12000 12000\]/);
    }
    assertReleased(state);
  });
});

test('PDF exports large vector pages at any DPI without whole-page raster limits', async () => {
  await withBrowser(vectorOnly, async state => {
    for (const dpi of [1, 96, 300, 600, 2400]) {
      const project = fixture(16000, 16000);
      project.items = [item('rect', 'rect', { fill: '#123456' })];
      const objects = await parsePDF(await exportPDF(project, dpi));
      assert.match(page(objects).dictionary, /\/MediaBox \[0 0 12000 12000\]/);
      assert.equal(images(objects).length, 0);
    }
    assert.equal(state.canvases.length, 0);
  });
});

test('PDF can export native shapes without browser drawing APIs and retains fractional page dimensions', async () => {
  const project = fixture(2.5, 3);
  project.items = [item('rectangle', 'rect', { width: 1, height: 1 })];
  const objects = await parsePDF(await exportPDF(project, 96));
  assert.match(page(objects).dictionary, /\/MediaBox \[0 0 1\.875 2\.25\]/);
  assert.equal(images(objects).length, 0);
});

test('PDF image streams have a lossless fallback without CompressionStream', async () => {
  await withBrowser({ compression: undefined, naturalWidth: 1, naturalHeight: 1, rgba: new Uint8ClampedArray([0, 10, 255, 127]) }, async state => {
    const objects = await parsePDF(await exportPDF(imageFixture(), 96));
    const rgb = images(objects).find(object => /\/DeviceRGB/.test(object.dictionary));
    const gray = images(objects).find(object => /\/DeviceGray/.test(object.dictionary));
    assert.doesNotMatch(rgb.dictionary, /\/Filter/);
    assert.doesNotMatch(gray.dictionary, /\/Filter/);
    assert.deepEqual([...rgb.stream], [0, 10, 255]);
    assert.deepEqual([...gray.stream], [127]);
    assertReleased(state);
  });
});

test('PDF validates inputs and rejects excessive raster patches before allocation', async () => {
  await withBrowser({}, async state => {
    for (const dpi of [0, -1, NaN, Infinity, 2401, '300']) await assert.rejects(exportPDF(fixture(), dpi), /DPI/i);
    await assert.rejects(exportPDF({ ...fixture(), version: 2 }), /Invalid figure project/);
    const project = imageFixture({ width: 16000, height: 16000, shadow: { enabled: true, blur: 0 } });
    await assert.rejects(exportPDF(project, 300), /megapixel|pixels per side|size|large|width|height/i);
    assert.equal(state.blobs.length, 0);
    assert.equal(state.canvases.length, 0);
    assert.equal(state.requests.length, 0);
  });
});

test('PDF releases source-image and shadow rendering resources after failures', async () => {
  for (const extra of [{}, { shadow: { enabled: true, blur: 0 } }]) {
    for (const [options, message] of [
      [{ imageError: true }, /render|image|decode/i],
      [{ noContext: true }, /canvas/i],
      [{ drawError: new Error('draw failed') }, /draw failed/],
      [{ readError: new Error('pixel read failed') }, /pixel read failed/],
      [{ compression: class { constructor() { throw new Error('compression failed'); } } }, /compression failed/],
      [{ createError: new Error('canvas creation failed') }, /canvas creation failed/],
    ]) {
      await withBrowser(options, async state => {
        await assert.rejects(exportPDF(imageFixture(extra), 96), message);
        assertReleased(state);
      });
    }
  }
});
