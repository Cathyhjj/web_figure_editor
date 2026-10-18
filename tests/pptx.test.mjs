import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { createProject } from '../core.js';
import { createDeck, addSlide, validateDeck } from '../deck.js';
import { exportPPTX, pptxLayout } from '../pptx.js';

// Synthetic 1 x 1 red images, with no external resources or project data.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const JPEG = '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD4vooor+Uz/fw//9k=';
const EMU = 9525;
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function crc32(bytes) {
  // Independent table-driven check of the ZIP writer's checksums.
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    return n >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function unzip(blob) {
  assert.equal(blob.type, MIME);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'ZIP end-of-directory record');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'single-disk ZIP');
  assert.equal(bytes.readUInt16LE(end + 6), 0);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  const centralSize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  const centralEnd = cursor + centralSize;
  assert.equal(centralEnd, end);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'ZIP central entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    assert.equal(flags & 1, 0, 'entry is not encrypted');
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCRC = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    assert.ok(!entries.has(name), `unique ZIP part ${name}`);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, `local header for ${name}`);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    const localNameSize = bytes.readUInt16LE(local + 26);
    const localExtraSize = bytes.readUInt16LE(local + 28);
    assert.equal(bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8'), name);
    const start = local + 30 + localNameSize + localExtraSize;
    const compressed = bytes.subarray(start, start + compressedSize);
    assert.ok([0, 8].includes(method), `standard compression for ${name}`);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(data.length, uncompressedSize, `uncompressed size for ${name}`);
    assert.equal(crc32(data), expectedCRC, `CRC32 for ${name}`);
    entries.set(name, data);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(cursor, centralEnd);
  return entries;
}

const xml = (parts, path) => {
  assert.ok(parts.has(path), `package has ${path}`);
  return parts.get(path).toString('utf8');
};
const attrs = source => Object.fromEntries([...source.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const tags = (source, tag) => [...source.matchAll(new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, 'g'))].map(m => attrs(m[1]));
const objects = source => [...source.matchAll(/<p:(sp|pic|cxnSp)(?=[\s>])[\s\S]*?<\/p:\1>/g)].map(m => m[0]);
const named = (source, name) => {
  const result = objects(source).find(block => tags(block, 'p:cNvPr')[0]?.name === name);
  assert.ok(result, `editable object named ${name}`);
  return result;
};
function transform(source) {
  const off = tags(source, 'a:off')[0];
  const ext = tags(source, 'a:ext')[0];
  assert.ok(off && ext, 'object has position and dimensions');
  return { x: Number(off.x), y: Number(off.y), width: Number(ext.cx), height: Number(ext.cy) };
}
const item = (id, type, extra = {}) => ({ id, name: id, type, x: 20, y: 30, width: 120, height: 80, ...extra });
const asset = (id = 'png', mime = 'image/png', payload = PNG) => ({ id, name: `${id}.${mime === 'image/png' ? 'png' : 'jpg'}`, mime, dataUrl: `data:${mime};base64,${payload}`, width: 1, height: 1 });
function fixture() {
  const deck = createDeck();
  deck.id = 'pptx-fixture';
  deck.name = 'Research <figure> & "slides"';
  deck.slides[0].name = 'First & original';
  deck.assets = [asset(), asset('jpeg', 'image/jpeg', JPEG), asset('unused')];
  deck.slides[0].items = [
    item('caption', 'text', { text: 'A & B <sample>\n第二行\n', fontSize: 24, fontFamily: 'Arial', fontWeight: '700', fontStyle: 'italic', align: 'center', color: '#12345680', opacity: 0.5, rotation: -30 }),
    item('rectangle', 'rect', { x: -10, y: 40, width: 240, height: 50, fill: '#0f08', stroke: '#abc', strokeWidth: 2, opacity: 0.5, rotation: 45 }),
    item('line', 'line', { x: 0, y: 640, width: 960, height: 0, stroke: 'blue', strokeWidth: 1 }),
    item('picture', 'image', { assetId: 'png', x: 300, y: 50, opacity: 0.4, rotation: 90 }),
    item('hidden-caption', 'text', { text: 'HIDDEN_MARKER', hidden: true }),
    item('hidden-image', 'image', { assetId: 'unused', hidden: true }),
  ];
  const second = addSlide(deck);
  second.name = 'Second slide';
  second.items = [item('picture-again', 'image', { assetId: 'png' }), item('jpeg-picture', 'image', { assetId: 'jpeg' })];
  return deck;
}

test('PPTX is a valid ZIP package with resolved relationships, content types and slide order', async () => {
  const parts = await unzip(await exportPPTX(fixture()));
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) assert.ok(parts.has(required), required);
  for (const [path, bytes] of parts) {
    if (!path.endsWith('.rels')) continue;
    const base = path === '_rels/.rels' ? '' : posix.dirname(posix.dirname(path));
    const seen = new Set();
    for (const rel of tags(bytes.toString('utf8'), 'Relationship')) {
      assert.ok(rel.Id && !seen.has(rel.Id), `unique relationship ID in ${path}`);
      seen.add(rel.Id);
      assert.notEqual(rel.TargetMode, 'External', 'PPTX contains no remote or file links');
      assert.ok(!/^[a-z]+:/i.test(rel.Target), 'relationship uses a package-relative target');
      const target = rel.Target.startsWith('/') ? rel.Target.slice(1) : posix.normalize(posix.join(base, rel.Target));
      assert.ok(parts.has(target), `${path} resolves ${rel.Target}`);
    }
  }
  const types = xml(parts, '[Content_Types].xml');
  const defaults = new Map(tags(types, 'Default').map(t => [t.Extension, t.ContentType]));
  const overrides = new Map(tags(types, 'Override').map(t => [t.PartName, t.ContentType]));
  for (const path of parts.keys()) if (path !== '[Content_Types].xml') assert.ok(overrides.get(`/${path}`) || defaults.get(path.split('.').at(-1)), `declared content type for ${path}`);
  const presentation = xml(parts, 'ppt/presentation.xml');
  assert.deepEqual(tags(presentation, 'p:sldSz')[0], { cx: String(960 * EMU), cy: String(640 * EMU), type: 'custom' });
  const relationships = new Map(tags(xml(parts, 'ppt/_rels/presentation.xml.rels'), 'Relationship').map(r => [r.Id, r.Target]));
  assert.deepEqual(tags(presentation, 'p:sldId').map(s => relationships.get(s['r:id'])), ['slides/slide1.xml', 'slides/slide2.xml']);
  assert.equal(tags(xml(parts, 'ppt/slides/slide1.xml'), 'p:cSld')[0].name, 'First &amp; original');
  assert.equal(tags(xml(parts, 'ppt/slides/slide2.xml'), 'p:cSld')[0].name, 'Second slide');
});

test('text and shapes remain separate editable objects with stacking, styling and alpha', async () => {
  const parts = await unzip(await exportPPTX(fixture()));
  const slide = xml(parts, 'ppt/slides/slide1.xml');
  const names = objects(slide).map(block => tags(block, 'p:cNvPr')[0].name);
  assert.deepEqual(names.filter(name => ['caption', 'rectangle', 'line', 'picture'].includes(name)), ['caption', 'rectangle', 'line', 'picture']);
  assert.equal(slide.includes('HIDDEN_MARKER'), false);
  assert.equal(slide.includes('hidden-caption'), false);
  assert.equal(slide.includes('hidden-image'), false);
  const text = named(slide, 'caption');
  assert.match(text, /<p:cNvSpPr\b[^>]*txBox="1"/);
  assert.match(text, /<a:t(?:\s[^>]*)?>A &amp; B &lt;sample&gt;<\/a:t>/);
  assert.match(text, /<a:t(?:\s[^>]*)?>第二行<\/a:t>/);
  assert.equal(tags(text, 'a:p').length, 3, 'explicit and trailing line breaks survive');
  assert.ok(tags(text, 'a:pPr').every(p => p.algn === 'ctr'));
  assert.ok(tags(text, 'a:rPr').some(r => r.sz === '1800' && r.b === '1' && r.i === '1'), '24px becomes 18pt with bold/italic');
  assert.ok(tags(text, 'a:latin').some(r => r.typeface === 'Arial'));
  assert.ok(tags(text, 'a:srgbClr').some(c => c.val.toUpperCase() === '123456'));
  assert.ok(tags(text, 'a:alpha').some(a => Number(a.val) === Math.round(0.5 * 128 / 255 * 100000)));
  assert.equal(((Number(tags(text, 'a:xfrm')[0].rot) / 60000) % 360 + 360) % 360, 330);
  assert.deepEqual(transform(text), { x: 20 * EMU, y: 30 * EMU, width: 120 * EMU, height: 80 * EMU });
  const rect = named(slide, 'rectangle');
  assert.equal(tags(rect, 'a:prstGeom')[0].prst, 'rect');
  assert.deepEqual(transform(rect), { x: -10 * EMU, y: 40 * EMU, width: 240 * EMU, height: 50 * EMU });
  assert.equal(Number(tags(rect, 'a:xfrm')[0].rot), 45 * 60000);
  assert.ok(tags(rect, 'a:srgbClr').some(c => c.val.toUpperCase() === '00FF00'));
  assert.ok(tags(rect, 'a:srgbClr').some(c => c.val.toUpperCase() === 'AABBCC'));
  assert.ok(tags(rect, 'a:alpha').some(a => Number(a.val) === Math.round(0.5 * 136 / 255 * 100000)));
  assert.equal(Number(tags(rect, 'a:ln')[0].w), 2 * EMU);
  const line = named(slide, 'line');
  assert.equal(tags(line, 'a:prstGeom')[0].prst, 'line');
  assert.deepEqual(transform(line), { x: 0, y: 640 * EMU, width: 960 * EMU, height: 0 });
});

test('pictures preserve original embedded PNG/JPEG bytes and reuse assets across slides', async () => {
  const parts = await unzip(await exportPPTX(fixture()));
  const media = [...parts.keys()].filter(path => path.startsWith('ppt/media/'));
  assert.equal(media.length, 2, 'only two visible asset IDs are embedded');
  const png = media.find(path => path.endsWith('.png'));
  const jpeg = media.find(path => /\.jpe?g$/.test(path));
  assert.ok(png && jpeg);
  assert.deepEqual(parts.get(png), Buffer.from(PNG, 'base64'));
  assert.deepEqual(parts.get(jpeg), Buffer.from(JPEG, 'base64'));
  function pictureTarget(slideNumber, name) {
    const picture = named(xml(parts, `ppt/slides/slide${slideNumber}.xml`), name);
    assert.ok(picture.startsWith('<p:pic'));
    const relId = tags(picture, 'a:blip')[0]['r:embed'];
    const rel = tags(xml(parts, `ppt/slides/_rels/slide${slideNumber}.xml.rels`), 'Relationship').find(r => r.Id === relId);
    assert.ok(rel.Type.endsWith('/image'));
    return { picture, target: posix.normalize(posix.join('ppt/slides', rel.Target)) };
  }
  const first = pictureTarget(1, 'picture');
  assert.equal(first.target, png);
  assert.equal(pictureTarget(2, 'picture-again').target, png);
  assert.equal(pictureTarget(2, 'jpeg-picture').target, jpeg);
  assert.equal(Number(tags(first.picture, 'a:xfrm')[0].rot), 90 * 60000);
  assert.equal(Number(tags(first.picture, 'a:alphaModFix')[0].amt), 40000);
});

test('different canvas sizes fit proportionally into the first page and scale geometry and type', async () => {
  const deck = createDeck();
  const second = addSlide(deck);
  second.canvas = { width: 1920, height: 1920, background: '#f00' };
  second.items = [item('scaled', 'text', { x: 96, y: 192, width: 600, height: 120, text: 'Scaled', fontSize: 36 }), item('scaled-stroke', 'rect', { strokeWidth: 3 })];
  const layout = pptxLayout(deck);
  assert.equal(layout.mixedSizes, true);
  assert.equal(layout.widthInches, 10);
  assert.equal(layout.heightInches, 640 / 96);
  const parts = await unzip(await exportPPTX(deck));
  const secondXML = xml(parts, 'ppt/slides/slide2.xml');
  const text = named(secondXML, 'scaled');
  assert.deepEqual(transform(text), { x: (160 + 32) * EMU, y: 64 * EMU, width: 200 * EMU, height: 40 * EMU });
  assert.ok(tags(text, 'a:rPr').some(r => r.sz === '900'), '36px font scales by one third then converts to points');
  assert.equal(Number(tags(named(secondXML, 'scaled-stroke'), 'a:ln')[0].w), EMU);
  assert.ok(tags(secondXML, 'a:srgbClr').some(c => c.val.toUpperCase() === 'FF0000'));
});

test('mixed-aspect canvas margins cover overflowing content while preserving editable source geometry', async () => {
  const deck = createDeck();
  const square = addSlide(deck);
  square.canvas = { width: 640, height: 640, background: '#fff' };
  square.items = [item('wide-overflow', 'rect', { x: -80, y: 20, width: 800, height: 100, rotation: 20, fill: 'red' })];
  const wide = addSlide(deck);
  wide.canvas = { width: 1920, height: 640, background: '#fff' };
  wide.items = [item('tall-overflow', 'rect', { x: 20, y: -160, width: 100, height: 960, fill: 'blue' })];
  const proportional = addSlide(deck);
  proportional.canvas = { width: 1920, height: 1280, background: '#fff' };
  const before = JSON.stringify(deck);
  const parts = await unzip(await exportPPTX(deck));
  assert.equal(JSON.stringify(deck), before, 'source items and canvases are not clipped or mutated');
  const squareXML = xml(parts, 'ppt/slides/slide2.xml');
  const wideXML = xml(parts, 'ppt/slides/slide3.xml');
  const squareObject = named(squareXML, 'wide-overflow');
  assert.equal(tags(squareObject, 'a:prstGeom')[0].prst, 'rect');
  assert.equal(Number(tags(squareObject, 'a:xfrm')[0].rot), 20 * 60000);
  assert.deepEqual(transform(squareObject), { x: 80 * EMU, y: 20 * EMU, width: 800 * EMU, height: 100 * EMU });
  assert.deepEqual(transform(named(wideXML, 'tall-overflow')), { x: 10 * EMU, y: 80 * EMU, width: 50 * EMU, height: 480 * EMU });
  for (const [source, objectName, expected] of [
    [squareXML, 'wide-overflow', { left: { x: 0, y: 0, width: 160, height: 640 }, right: { x: 800, y: 0, width: 160, height: 640 } }],
    [wideXML, 'tall-overflow', { top: { x: 0, y: 0, width: 960, height: 160 }, bottom: { x: 0, y: 480, width: 960, height: 160 } }],
  ]) {
    const objectNames = objects(source).map(block => tags(block, 'p:cNvPr')[0].name);
    const maskNames = Object.keys(expected).map(side => `Canvas margin — ${side}`);
    assert.deepEqual(objectNames.slice(-2), maskNames, 'margins are above all source objects');
    for (const [side, dimensions] of Object.entries(expected)) {
      const maskName = `Canvas margin — ${side}`;
      assert.ok(objectNames.indexOf(maskName) > objectNames.indexOf(objectName));
      const mask = named(source, maskName);
      assert.equal(tags(mask, 'a:prstGeom')[0].prst, 'rect');
      assert.deepEqual(transform(mask), Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, value * EMU])));
      assert.ok(tags(mask, 'a:srgbClr').some(c => c.val.toUpperCase() === 'FFFFFF'));
      assert.equal(tags(mask, 'a:alpha').length, 0, 'white margin is opaque');
      assert.match(mask, /<a:ln><a:noFill\/><\/a:ln>/, 'margin has no visible outline');
    }
    const ids = tags(source, 'p:cNvPr').map(value => value.id);
    assert.equal(new Set(ids).size, ids.length, 'masks have unique editable-object identities');
  }
  for (const number of [1, 4]) assert.equal(xml(parts, `ppt/slides/slide${number}.xml`).includes('Canvas margin —'), false, 'same-aspect canvases need no margin masks');
});

test('PPTX accepts legacy single figures and does not mutate either format', async () => {
  for (const input of [fixture(), { ...createProject(), items: [item('legacy-text', 'text', { text: 'Legacy figure' })] }]) {
    const before = JSON.stringify(input);
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(input);
    const parts = await unzip(await exportPPTX(input));
    assert.equal(JSON.stringify(input), before);
    assert.equal([...parts.keys()].filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length, input.slides?.length ?? 1);
  }
});

test('XML-special text, names and illegal controls are safely encoded', async () => {
  const deck = createDeck();
  deck.name = 'A <title> & "quoted"';
  deck.slides[0].name = 'Slide <1> & "one"';
  deck.slides[0].items = [item('escaped', 'text', { name: 'Name <&>"', text: '<p:sp> & "quoted"\u0000\u000b', fontFamily: 'Font " & <tag>' })];
  const parts = await unzip(await exportPPTX(deck));
  const slide = xml(parts, 'ppt/slides/slide1.xml');
  assert.match(slide, /&lt;p:sp&gt; &amp;/);
  assert.match(slide, /Name &lt;&amp;&gt;&quot;/);
  assert.match(slide, /Font &quot; &amp; &lt;tag&gt;/);
  assert.match(slide, /Slide &lt;1&gt; &amp; &quot;one&quot;/);
  for (const [name, data] of parts) if (name.endsWith('.xml') || name.endsWith('.rels')) assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(data.toString('utf8')), false, `legal XML characters in ${name}`);
});

test('invalid or external assets fail validation before creating an export', async () => {
  for (const mutate of [
    deck => deck.assets[0].dataUrl = 'https://example.invalid/private-image.png',
    deck => deck.slides[0].items[3].assetId = 'missing',
    deck => deck.slides[0].items[0].fontSize = NaN,
    deck => deck.slides = [],
  ]) {
    const deck = fixture();
    mutate(deck);
    await assert.rejects(exportPPTX(deck), /Invalid figure/);
  }
});

test('page-size limits scale uniformly and impossible aspect ratios fail clearly', async () => {
  const deck = createDeck();
  deck.slides[0].canvas = { width: 16000, height: 8000, background: 'transparent' };
  const layout = pptxLayout(deck);
  assert.equal(layout.widthInches, 56);
  assert.equal(layout.heightInches, 28);
  const parts = await unzip(await exportPPTX(deck));
  const size = tags(xml(parts, 'ppt/presentation.xml'), 'p:sldSz')[0];
  assert.equal(Number(size.cx), 56 * 914400);
  assert.equal(Number(size.cy), 28 * 914400);
  deck.slides[0].canvas = { width: 1, height: 16000, background: '#fff' };
  assert.throws(() => pptxLayout(deck), /size|ratio|PowerPoint/i);
  await assert.rejects(exportPPTX(deck), /size|ratio|PowerPoint/i);
});

test('WebP conversion embeds PNG once, uses decoded dimensions and releases the canvas', async () => {
  // Decoding is mocked here; the browser suite exercises the actual image codec.
  const deck = createDeck();
  deck.assets = [asset('webp', 'image/webp', Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary').toString('base64'))];
  deck.slides[0].items = [item('webp-one', 'image', { assetId: 'webp' }), item('webp-two', 'image', { assetId: 'webp' })];
  const priorDocument = globalThis.document;
  const priorImage = globalThis.Image;
  const canvases = [];
  let decodes = 0;
  let nullBlob = false;
  let naturalWidth = 1;
  globalThis.Image = class {
    constructor() { decodes++; this.naturalWidth = naturalWidth; this.naturalHeight = 1; }
    set src(value) { assert.equal(value, deck.assets[0].dataUrl); queueMicrotask(() => this.onload()); }
  };
  globalThis.document = { createElement(type) {
    assert.equal(type, 'canvas');
    const canvas = {
      width: 0, height: 0,
      getContext(context) {
        assert.equal(context, '2d');
        return { drawImage(image, x, y) { assert.equal(image.naturalWidth, 1); assert.equal(x, 0); assert.equal(y, 0); } };
      },
      toBlob(callback, mime) {
        assert.equal(mime, 'image/png');
        assert.equal(this.width, 1);
        assert.equal(this.height, 1);
        callback(nullBlob ? null : new Blob([Buffer.from(PNG, 'base64')], { type: mime }));
      },
    };
    canvases.push(canvas);
    return canvas;
  } };
  try {
    const parts = await unzip(await exportPPTX(deck));
    const media = [...parts.keys()].filter(path => path.startsWith('ppt/media/'));
    assert.deepEqual(media, ['ppt/media/image1.png']);
    assert.deepEqual(parts.get(media[0]), Buffer.from(PNG, 'base64'));
    assert.equal(decodes, 1, 'one WebP conversion for repeated asset use');
    assert.equal(canvases.length, 1);
    assert.equal(canvases[0].width, 0);
    assert.equal(canvases[0].height, 0);
    nullBlob = true;
    await assert.rejects(exportPPTX(deck), /could not convert WebP/i);
    assert.equal(canvases[1].width, 0, 'canvas also released after encoding fails');
    assert.equal(canvases[1].height, 0);
    naturalWidth = 40000;
    await assert.rejects(exportPPTX(deck), /conversion limit/i);
    assert.equal(canvases.length, 2, 'oversized decoded image rejected before canvas allocation');
  } finally {
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorImage === undefined) delete globalThis.Image; else globalThis.Image = priorImage;
  }
});

test('newline-heavy legal text is rejected before XML expansion or image decoding', async () => {
  const deck = createDeck();
  const manyLines = '\n'.repeat(100000);
  deck.assets = [asset('webp', 'image/webp', Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary').toString('base64'))];
  deck.slides[0].items = [
    item('early-image', 'image', { assetId: 'webp' }),
    item('many-lines-one', 'text', { text: manyLines }),
    item('many-lines-two', 'text', { text: manyLines }),
  ];
  assert.doesNotThrow(() => validateDeck(deck), 'fixture is a legal project; export expansion needs its own limit');
  const before = JSON.stringify(deck);
  const originalSplit = String.prototype.split;
  const originalImage = globalThis.Image;
  const originalDocument = globalThis.document;
  let decoded = false;
  let expanded = false;
  // Fail safely if a regression tries to build hundreds of MB of paragraph XML.
  String.prototype.split = function (separator, ...args) {
    if (separator === '\n' && String(this) === manyLines) {
      expanded = true;
      throw new Error('Test stopped oversized paragraph expansion');
    }
    return originalSplit.call(this, separator, ...args);
  };
  globalThis.document = {};
  globalThis.Image = class { constructor() { decoded = true; throw new Error('Test stopped premature image decoding'); } };
  try {
    await assert.rejects(exportPPTX(deck), /too large to generate safely.*240 MB/i);
    assert.equal(decoded, false);
    assert.equal(expanded, false);
    assert.equal(JSON.stringify(deck), before);
  } finally {
    String.prototype.split = originalSplit;
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
  // Hidden text cannot inflate the output; ordinary multiline text still exports.
  for (const object of deck.slides[0].items) object.hidden = true;
  deck.slides[0].items.push(item('ordinary-text', 'text', { text: 'Line one\nLine two\n' }));
  const parts = await unzip(await exportPPTX(deck));
  const slide = xml(parts, 'ppt/slides/slide1.xml');
  assert.equal(tags(named(slide, 'ordinary-text'), 'a:p').length, 3);
  assert.equal(slide.includes('many-lines-one'), false);
  assert.equal(slide.includes('many-lines-two'), false);
  assert.equal([...parts.keys()].some(path => path.startsWith('ppt/media/')), false);
});

test('scaled text respects DrawingML font and paragraph-spacing limits without silent clamping', async () => {
  const tooLarge = createDeck();
  tooLarge.slides[0].canvas = { width: 16, height: 16, background: '#fff' };
  tooLarge.slides[0].items = [item('large-font', 'text', { text: 'Large', fontSize: 1000 })];
  await assert.rejects(exportPPTX(tooLarge), /4000 pt font limit/i);

  const spacing = createDeck();
  spacing.slides[0].items = [item('line-spacing', 'text', { text: 'One\nTwo', fontSize: 2000 })];
  await assert.rejects(exportPPTX(spacing), /1584 pt limit/i);
  spacing.slides[0].items[0].fontSize = 1760;
  const spacingParts = await unzip(await exportPPTX(spacing));
  const largeText = named(xml(spacingParts, 'ppt/slides/slide1.xml'), 'line-spacing');
  assert.ok(tags(largeText, 'a:rPr').some(r => r.sz === '132000'));
  assert.ok(tags(largeText, 'a:spcPts').some(r => r.val === '158400'), 'maximum valid spacing is retained');

  const small = createDeck();
  small.slides[0].canvas = { width: 96, height: 96, background: '#fff' };
  const second = addSlide(small);
  second.canvas = { width: 16000, height: 16000, background: '#fff' };
  second.items = [item('small-font', 'text', { text: 'Small', fontSize: 1 })];
  await assert.rejects(exportPPTX(small), /0\.01 pt scaled text/i);
  second.items[0].fontSize = 4;
  const smallParts = await unzip(await exportPPTX(small));
  const smallText = named(xml(smallParts, 'ppt/slides/slide2.xml'), 'small-font');
  assert.ok(tags(smallText, 'a:rPr').some(r => r.sz === '100'), 'nominal font stays within the schema range');
  assert.equal(tags(smallText, 'a:normAutofit')[0].fontScale, '1800', 'autofit retains the requested 0.018pt effective size');
});
