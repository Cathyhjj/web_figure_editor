import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeck, validateDeck, slideProject, deckSourceManifest } from '../deck.js';
import { projectToSVG } from '../core.js';
import { isMP4, posterProject } from '../video.js';
import { createSelection, encodeSelection, decodeSelection, pasteSelection, createSlidesClipboard, pasteSlides } from '../clipboard.js';
import { selectionImageProject } from '../clipboard-image.js';
import { generateHTMLReport } from '../report.js';
import { resizeItem } from '../resize.js';
import { exportPPTX } from '../pptx.js';
import { replaceAsset, importFiles, MAX_FILE_BYTES } from '../assets.js';

const mp4 = readFileSync(new URL('./fixtures/video.mp4', import.meta.url));
const png = readFileSync(new URL('./fixtures/video-poster.png', import.meta.url));
const poster = `data:image/png;base64,${png.toString('base64')}`;
const source = `data:video/mp4;base64,${mp4.toString('base64')}`;
function fixture() {
  const deck = createDeck();
  deck.assets = [{ id: 'video-asset', name: 'video.mp4', mime: 'video/mp4', dataUrl: source, width: 320, height: 180, posterDataUrl: poster, posterWidth: 320, posterHeight: 180, duration: 6 }];
  deck.slides[0].items = [{ id: 'video-item', type: 'video', assetId: 'video-asset', name: 'MP4', x: 20, y: 30, width: 320, height: 180 }];
  return validateDeck(deck);
}
async function parts(blob) {
  const data = Buffer.from(await blob.arrayBuffer()), entries = new Map();
  for (let at = 0; data.readUInt32LE(at) === 0x04034b50;) {
    assert.equal(data.readUInt16LE(at + 8), 0);
    const size = data.readUInt32LE(at + 18), n = data.readUInt16LE(at + 26), extra = data.readUInt16LE(at + 28), start = at + 30 + n + extra;
    entries.set(data.subarray(at + 30, at + 30 + n).toString(), data.subarray(start, start + size));
    at = start + size;
  }
  return entries;
}

test('MP4 container detection rejects spoofed, truncated, and wrong-brand files', () => {
  assert.equal(isMP4(mp4), true);
  assert.equal(isMP4(png), false);
  assert.equal(isMP4(mp4.subarray(0, 15)), false);
  const fake = Buffer.alloc(24); fake.writeUInt32BE(24); fake.write('ftyp', 4); fake.write('heic', 8);
  assert.equal(isMP4(fake), false);
  fake.write('isom', 16); assert.equal(isMP4(fake), true);
  fake.writeUInt32BE(999999); assert.equal(isMP4(fake), false);
});

test('video original, poster and duration survive save/open and source manifest', () => {
  const saved = validateDeck(JSON.parse(JSON.stringify(fixture())));
  assert.equal(saved.assets[0].dataUrl, source);
  assert.equal(saved.assets[0].posterDataUrl, poster);
  assert.equal(saved.assets[0].duration, 6);
  assert.equal(saved.slides[0].items[0].type, 'video');
  assert.equal(deckSourceManifest(saved).sources[0].usedBy[0].itemId, 'video-item');
});

test('untrusted projects reject missing posters, corrupt MP4 bytes and media kind mismatch', () => {
  for (const edit of [a => { delete a.posterDataUrl; }, a => { a.posterDataUrl = 'https://example.test/a.png'; }, a => { a.duration = Infinity; }, a => { a.dataUrl = `data:video/mp4;base64,${png.toString('base64')}`; }]) {
    const deck = fixture(); edit(deck.assets[0]); assert.throws(() => validateDeck(deck));
  }
  const deck = fixture(); deck.slides[0].items[0].type = 'image'; assert.throws(() => validateDeck(deck), /incompatible/);
});

test('video selection and slide clipboard retain media and remap collisions', () => {
  const deck = fixture(), selection = createSelection(slideProject(deck), new Set(['video-item']));
  const copied = decodeSelection(encodeSelection(selection));
  const destination = createDeck(); pasteSelection(destination, copied);
  assert.equal(destination.assets[0].dataUrl, source);
  assert.equal(destination.slides[0].items[0].assetId, destination.assets[0].id);
  pasteSlides(destination, createSlidesClipboard(deck));
  assert.equal(destination.slides.length, 2);
  assert.equal(destination.slides[1].items[0].type, 'video');
  assert.equal(destination.assets.length, 1);
  assert.equal(selectionImageProject(copied).assets[0].dataUrl, source);
});

test('static SVG/report/PDF view uses only poster pixels without changing original', () => {
  const deck = fixture(), before = JSON.stringify(deck), view = slideProject(deck);
  const svg = projectToSVG(view), html = generateHTMLReport(deck);
  assert.ok(svg.includes(poster)); assert.ok(html.includes(poster));
  assert.ok(!svg.includes(source)); assert.ok(!html.includes(source));
  const staticView = posterProject(view);
  assert.equal(staticView.items[0].type, 'image'); assert.equal(staticView.assets[0].mime, 'image/png');
  assert.equal(staticView.assets[0].dataUrl, poster);
  assert.equal(JSON.stringify(deck), before);
});

test('videos keep their aspect ratio during corner resize', () => {
  const item = fixture().slides[0].items[0];
  const resized = resizeItem(item, 'se', 80, 100);
  assert.equal(resized.width / resized.height, 320 / 180);
});

test('PPTX embeds unchanged MP4 once with posters, internal relationships and playback timing for each placement', async () => {
  const deck = fixture();
  deck.slides[0].items.push({ ...deck.slides[0].items[0], id: 'second-video', x: 400, rotation: 12 });
  deck.slides.push({ ...deck.slides[0], id: 'second-slide', items: [{ ...deck.slides[0].items[0], id: 'third-video' }] });
  const before = JSON.stringify(deck), files = await parts(await exportPPTX(deck));
  const videos = [...files.keys()].filter(name => name.endsWith('.mp4'));
  assert.equal(videos.length, 1); assert.deepEqual(files.get(videos[0]), mp4);
  assert.deepEqual(files.get('ppt/media/poster1.png'), png);
  assert.match(files.get('[Content_Types].xml').toString(), /Extension="mp4" ContentType="video\/mp4"/);
  for (const [slide, count] of [[1, 2], [2, 1]]) {
    const xml = files.get(`ppt/slides/slide${slide}.xml`).toString();
    const rels = files.get(`ppt/slides/_rels/slide${slide}.xml.rels`).toString();
    assert.match(rels, /relationships\/video" Target="..\/media\/video1.mp4"/);
    assert.match(rels, /office\/2007\/relationships\/media" Target="..\/media\/video1.mp4"/);
    assert.doesNotMatch(rels, /TargetMode="External"/);
    assert.equal((xml.match(/action="ppaction:\/\/media"/g) || []).length, count);
    assert.equal((xml.match(/<p14:media /g) || []).length, count);
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"[^>]*><a:hlinkClick/g)].map(m => m[1]);
    const targets = [...xml.matchAll(/<p:spTgt spid="(\d+)"/g)].map(m => m[1]);
    assert.deepEqual(targets, ids); assert.equal(new Set(ids).size, count);
    const timingIds = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m => m[1]);
    assert.equal(new Set(timingIds).size, count + 1);
    assert.match(xml, /delay="indefinite"/);
  }
  assert.equal(JSON.stringify(deck), before);
});

test('hidden and unused videos do not leak into PPTX media or playback nodes', async () => {
  const deck = fixture(); deck.slides[0].items[0].hidden = true;
  const files = await parts(await exportPPTX(deck));
  assert.equal([...files.keys()].filter(name => name.startsWith('ppt/media/')).length, 0);
  assert.doesNotMatch(files.get('ppt/slides/slide1.xml').toString(), /p:timing|videoFile|p14:media/);
});

test('video names with line breaks and replacement metacharacters remain literal XML data', async () => {
  const deck = fixture();
  deck.assets[0].name = "clip $& $` $' $$\nsecond line.mp4";
  deck.slides[0].items[0].name = "name $& $` $' $$\nsecond line";
  const files = await parts(await exportPPTX(deck));
  const xml = files.get('ppt/slides/slide1.xml').toString();
  assert.equal((xml.match(/<p:nvPicPr>/g) || []).length, 1);
  assert.match(xml, /<a:videoFile /);
  assert.match(xml, /<p14:media /);
  assert.ok(xml.includes("name $&amp; $` $&apos; $$\nsecond line"));
  assert.ok(xml.includes("clip $&amp; $` $&apos; $$\nsecond line.mp4"));
});

test('MP4 import rejects oversize and fake files before decoding', async () => {
  const huge = { name: 'huge.mp4', size: MAX_FILE_BYTES + 1, arrayBuffer() { throw new Error('must not read'); } };
  assert.match((await importFiles([huge])).errors[0].message, /25 MB/);
  const fake = Object.assign(new Blob(['not video'], { type: 'video/mp4' }), { name: 'spoof.mp4' });
  assert.match((await importFiles([fake])).errors[0].message, /actual file contents/);
});
