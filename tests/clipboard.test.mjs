import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../core.js';
import { createDeck, validateDeck, currentSlide, slideProject, addSlide } from '../deck.js';
import { CLIPBOARD_MIME, createSelection, encodeSelection, decodeSelection, pasteSelection } from '../clipboard.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const image = () => ({ id: 'asset-a', name: 'original.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 1, height: 1, size: 68, lastModified: 42, sourceKind: 'linked', linkToken: 'binding-a', linkPersistence: 'browser', relativePath: 'sources/original.png', fingerprint: 'original-fingerprint' });
const text = (id = 'text-a') => ({ id, type: 'text', x: 20, y: 30, width: 120, height: 40, text: 'A & B\n第二行', fontSize: 20, rotation: 32, opacity: .4 });
const fixture = () => validateProject({ ...createProject(), id: 'project-a', assets: [image(), { ...image(), id: 'unused-a' }], items: [text(), { id: 'image-a', type: 'image', x: 100, y: 80, width: 120, height: 60, assetId: 'asset-a', rotation: -15, opacity: .8, locked: true, hidden: true }] });

test('selection snapshots keep source order, only referenced assets, and independent mutable records', () => {
  const view = fixture();
  const selection = createSelection(view, new Set(['image-a', 'text-a']));
  assert.deepEqual(selection.items.map(item => item.id), ['text-a', 'image-a']);
  assert.deepEqual(selection.assets.map(asset => asset.id), ['asset-a']);
  view.items[0].text = 'Changed';
  view.assets[0].dataUrl = 'Changed';
  view.canvas.width = 123;
  assert.equal(selection.items[0].text, 'A & B\n第二行');
  assert.equal(selection.assets[0].dataUrl, image().dataUrl);
  assert.equal(selection.canvas.width, 960);
  assert.equal(createSelection(view, new Set()), null);
  assert.equal(createSelection(view, new Set(['missing'])), null);
});

test('editable selections round-trip while ordinary clipboard text is left alone', () => {
  const selection = createSelection(fixture(), new Set(['text-a', 'image-a']));
  assert.equal(CLIPBOARD_MIME, 'application/x-figure-editor-selection');
  assert.deepEqual(decodeSelection(encodeSelection(selection)), selection);
  for (const ordinary of ['', 'ordinary text', JSON.stringify(selection), null, undefined]) assert.equal(decodeSelection(ordinary), null);
  assert.throws(() => decodeSelection('Figure Editor selection v1\n{bad'), /damaged/);
});

test('recognized oversized clipboard text is rejected before parsing', () => {
  const oversized = 'Figure Editor selection v1\n' + ' '.repeat(240 * 1024 * 1024);
  assert.throws(() => decodeSelection(oversized), /240 MB clipboard limit/);
});

test('pasted payloads reject hostile assets and invalid references, and discard unknown fields', () => {
  const marker = 'Figure Editor selection v1\n';
  for (const mutate of [
    p => p.assets[0].dataUrl = 'https://example.org/panel.png',
    p => p.assets[0].dataUrl = 'data:image/png;base64,PHN2Zz48L3N2Zz4=',
    p => p.items[1].assetId = 'missing',
    p => p.items[0].color = 'url(https://example.org/style)',
    p => p.items[0].x = '20',
    p => p.items.push({ ...p.items[0] }),
  ]) {
    const p = fixture();
    mutate(p);
    assert.throws(() => decodeSelection(marker + JSON.stringify(p)), /Invalid figure project/);
  }
  const p = fixture();
  p.items[0].onclick = 'alert(1)';
  p.assets[0].fileHandle = { secret: 'not serializable authority' };
  const safe = decodeSelection(marker + JSON.stringify(p));
  assert.equal(safe.items[0].onclick, undefined);
  assert.equal(safe.assets[0].fileHandle, undefined);
});

test('same-deck pastes preserve appearances and source bytes, reuse assets, and create editable objects', () => {
  const deck = validateDeck(fixture());
  const selected = new Set(['text-a', 'image-a']);
  const selection = createSelection(slideProject(deck), selected);
  const original = structuredClone(selection);
  const sourceSlide = currentSlide(deck);
  addSlide(deck);
  const copyIds = pasteSelection(deck, selection);
  const copies = currentSlide(deck).items.filter(item => copyIds.includes(item.id));
  assert.deepEqual(copies.map(item => item.type), ['text', 'image']);
  assert.equal(deck.assets.length, 2);
  assert.equal(deck.assets[0].linkToken, 'binding-a');
  assert.equal(copies[1].assetId, 'asset-a');
  for (let i = 0; i < copies.length; i++) {
    assert.notEqual(copies[i].id, selection.items[i].id);
    assert.deepEqual({ ...copies[i], id: selection.items[i].id, x: copies[i].x - 20, y: copies[i].y - 20, locked: selection.items[i].locked, hidden: selection.items[i].hidden }, selection.items[i]);
    assert.equal(copies[i].locked, false);
    assert.equal(copies[i].hidden, false);
  }
  assert.deepEqual(selection, original);
  assert.deepEqual(sourceSlide.items, selection.items);
  const moreIds = pasteSelection(deck, selection, 40);
  const more = currentSlide(deck).items.filter(item => moreIds.includes(item.id));
  assert.equal(currentSlide(deck).items.length, 4);
  assert.equal(new Set([...copies, ...more].map(item => item.id)).size, 4);
  assert.equal(more[0].x, selection.items[0].x + 40);
});

test('new-project paste retains source provenance and bytes without local-link authority or unused assets', () => {
  const selection = fixture();
  const deck = createDeck();
  pasteSelection(deck, selection, 0);
  const copies = currentSlide(deck).items;
  assert.equal(deck.assets.length, 1);
  const added = deck.assets[0];
  assert.notEqual(added.id, 'asset-a');
  assert.equal(copies[1].assetId, added.id);
  assert.deepEqual({ ...added, id: selection.assets[0].id, sourceKind: 'linked', linkToken: 'binding-a', linkPersistence: 'browser' }, selection.assets[0]);
  assert.equal(added.sourceKind, 'copy');
  assert.equal(added.linkToken, undefined);
  assert.equal(added.linkPersistence, undefined);
  assert.doesNotThrow(() => validateDeck(deck));
});

test('repeated cross-project pastes reuse one portable asset without merging different provenance', () => {
  const selection = createSelection(fixture(), new Set(['image-a']));
  const deck = createDeck();
  const firstIds = pasteSelection(deck, selection);
  const portableId = deck.assets[0].id;
  const nextIds = pasteSelection(deck, selection, 40);
  assert.equal(deck.assets.length, 1);
  assert.equal(currentSlide(deck).items.length, 2);
  assert.deepEqual(currentSlide(deck).items.map(item => item.assetId), [portableId, portableId]);
  assert.notEqual(firstIds[0], nextIds[0]);
  for (const field of ['name', 'relativePath', 'fingerprint', 'lastModified']) {
    const other = structuredClone(selection);
    other.assets[0][field] = field === 'lastModified' ? 43 : `different-${field}`;
    const count = deck.assets.length;
    pasteSelection(deck, other);
    assert.equal(deck.assets.length, count + 1);
  }
  const otherDeck = createDeck();
  otherDeck.assets = [{ ...selection.assets[0], id: 'unrelated-local-link' }];
  pasteSelection(otherDeck, selection);
  assert.equal(otherDeck.assets.length, 2);
  assert.equal(otherDeck.assets[0].linkToken, 'binding-a');
  assert.notEqual(currentSlide(otherDeck).items[0].assetId, 'unrelated-local-link');
});

test('asset ID collisions never replace existing or copied image data', () => {
  for (const mutate of [
    a => a.width = 2,
    a => a.height = 3,
    a => a.dataUrl = a.dataUrl.slice(0, -4) + 'AAA=',
    a => { a.originalMime = 'image/svg+xml'; a.originalDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'; },
  ]) {
    const deck = validateDeck(fixture());
    const selection = createSelection(slideProject(deck), new Set(['image-a']));
    mutate(deck.assets[0]);
    const existing = structuredClone(deck.assets[0]);
    const [copyId] = pasteSelection(deck, selection);
    const copy = currentSlide(deck).items.find(item => item.id === copyId);
    assert.notEqual(copy.assetId, 'asset-a');
    assert.deepEqual(deck.assets[0], existing);
    assert.equal(deck.assets.find(a => a.id === copy.assetId).dataUrl, selection.assets[0].dataUrl);
    assert.equal(deck.assets.find(a => a.id === copy.assetId).originalDataUrl, selection.assets[0].originalDataUrl);
  }
});

test('copying rasterized SVG preserves both embedded representations after source refresh', () => {
  const deck = validateDeck(fixture());
  Object.assign(deck.assets[0], { originalMime: 'image/svg+xml', originalDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', rasterized: true, rasterizationScale: 3 });
  const selection = createSelection(slideProject(deck), new Set(['image-a']));
  deck.assets[0].originalDataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const [copyId] = pasteSelection(deck, selection);
  const copy = currentSlide(deck).items.find(item => item.id === copyId);
  const copied = deck.assets.find(a => a.id === copy.assetId);
  assert.equal(copied.originalDataUrl, selection.assets[0].originalDataUrl);
  assert.equal(copied.dataUrl, selection.assets[0].dataUrl);
  assert.equal(copied.rasterized, true);
  assert.equal(copied.rasterizationScale, 3);
});

test('failed paste leaves every deck record unchanged when geometry or object limits fail', () => {
  const selection = createSelection(fixture(), new Set(['text-a', 'image-a']));
  for (const prepare of [
    d => currentSlide(d).items.push(...Array.from({ length: 2000 }, (_, index) => text(`full-${index}`))),
    d => d.assets.push(...Array.from({ length: 500 }, (_, index) => ({ ...image(), id: `asset-${index}` }))),
    d => currentSlide(d).canvas.width = 0,
  ]) {
    const deck = createDeck();
    prepare(deck);
    const before = structuredClone(deck);
    assert.throws(() => pasteSelection(deck, selection), /Invalid figure/);
    assert.deepEqual(deck, before);
  }
  const deck = createDeck();
  const before = structuredClone(deck);
  for (const offset of [Infinity, NaN, '20', 100001]) {
    assert.throws(() => pasteSelection(deck, selection, offset));
    assert.deepEqual(deck, before);
  }
  const broken = structuredClone(selection);
  broken.items[1].assetId = 'missing';
  assert.throws(() => pasteSelection(deck, broken), /missing asset/);
  assert.deepEqual(deck, before);
  assert.deepEqual(pasteSelection(deck, createProject()), []);
  assert.deepEqual(deck, before);
});
