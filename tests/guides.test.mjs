import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, projectToSVG } from '../core.js';
import { createDeck, currentSlide, validateDeck, serializeDeck, cloneDeck, addSlide, duplicateSlide, slideProject } from '../deck.js';
import { readProjectFile } from '../project-files.js';
import { createSlideClipboard, encodeSlide, decodeSlide, pasteSlide, createSlidesClipboard, encodeSlides, decodeSlides, pasteSlides, encodeSelection, decodeSelection, pasteSelection } from '../clipboard.js';
import { generateHTMLReport } from '../report.js';
import { exportPDF } from '../pdf.js';
import { exportPPTX } from '../pptx.js';
import { MAX_GUIDES, validateGuides, cloneGuides, snapAxis } from '../guides.js';

const guides = () => [{ id: 'vertical-a', axis: 'x', position: 96 }, { id: 'horizontal-a', axis: 'y', position: 72.5 }];
function fixture() {
  const deck = createDeck();
  currentSlide(deck).guides = guides();
  currentSlide(deck).items = [{ id: 'rectangle-a', type: 'rect', x: 10, y: 20, width: 120, height: 80, fill: '#123456' }];
  return validateDeck(deck);
}

test('guide validation creates canonical independent records, including off-canvas positions', () => {
  const input = [...guides(), { id: 'edge-negative', axis: 'x', position: -100000, hidden: true }, { id: 'edge-positive', axis: 'y', position: 100000 }];
  const validated = validateGuides(input);
  assert.deepEqual(validated.map(guide => guide.position), [96, 72.5, -100000, 100000]);
  assert.equal(validated[2].hidden, undefined);
  validated[0].position = 1;
  assert.equal(input[0].position, 96);
  assert.deepEqual(validateGuides([]), []);
});

test('guide validation rejects invalid arrays, identities, axes, coordinates and count limits', () => {
  for (const input of [undefined, null, {}, [null], [[]], [{ ...guides()[0], id: '' }],
    [{ ...guides()[0], id: '../guide' }], [{ ...guides()[0], id: 'g'.repeat(101) }],
    [{ ...guides()[0], axis: 'horizontal' }], [{ ...guides()[0], axis: undefined }],
    ...[NaN, Infinity, -Infinity, '20', null, undefined, -100000.01, 100000.01].map(position => [{ ...guides()[0], position }]),
    [guides()[0], guides()[0]], Array.from({ length: MAX_GUIDES + 1 }, (_, i) => ({ id: `g-${i}`, axis: 'x', position: i })),
  ]) assert.throws(() => validateGuides(input), /Invalid figure guides/);
  assert.equal(validateGuides(Array.from({ length: MAX_GUIDES }, (_, i) => ({ id: `g-${i}`, axis: 'x', position: i }))).length, MAX_GUIDES);
  const deck = fixture();
  currentSlide(deck).guides.push({ ...currentSlide(deck).guides[0] });
  assert.throws(() => validateDeck(deck), /duplicate guide ID/);
});

test('absent guides stay absent in legacy projects, snapshots and clipboard round trips', () => {
  for (const deck of [createDeck(), validateDeck(createProject())]) {
    for (const copy of [validateDeck(deck), cloneDeck(deck), validateDeck(JSON.parse(serializeDeck(deck))), decodeSlides(encodeSlide(createSlideClipboard(deck)))]) {
      assert.equal(Object.hasOwn(currentSlide(copy), 'guides'), false);
    }
    assert.equal(Object.hasOwn(duplicateSlide(deck), 'guides'), false);
    assert.equal(Object.hasOwn(pasteSlide(createDeck(), createSlideClipboard(deck)), 'guides'), false);
  }
  assert.equal(cloneGuides(undefined), undefined);
});

test('saved project files reopen independent slide guides and retain guides after canvas resize', async () => {
  const deck = fixture();
  const first = currentSlide(deck);
  first.canvas.width = 50;
  const second = addSlide(deck);
  second.guides = [{ id: 'vertical-a', axis: 'x', position: -20 }];
  const file = new Blob([serializeDeck(deck)], { type: 'application/json' });
  const restored = await readProjectFile(file);
  assert.deepEqual(restored, validateDeck(deck));
  assert.equal(restored.slides[0].guides[0].position, 96);
  assert.equal(restored.slides[1].guides[0].position, -20, 'IDs are scoped to a slide');
  restored.slides[0].guides[0].position = 30;
  assert.equal(first.guides[0].position, 96);
  assert.equal(restored.slides[1].guides[0].position, -20);
});

test('undo and redo snapshots isolate guide edits, additions and deletions', () => {
  const deck = fixture();
  const before = cloneDeck(deck);
  currentSlide(deck).guides[0].position = 240;
  currentSlide(deck).guides.splice(1, 1);
  currentSlide(deck).guides.push({ id: 'new-horizontal', axis: 'y', position: 320 });
  const after = cloneDeck(deck);
  const undone = cloneDeck(before);
  assert.deepEqual(currentSlide(undone).guides, guides());
  const redone = cloneDeck(after);
  assert.deepEqual(currentSlide(redone).guides, currentSlide(deck).guides);
  currentSlide(redone).guides[0].position = 0;
  assert.equal(currentSlide(after).guides[0].position, 240);
  assert.equal(currentSlide(before).guides[0].position, 96);
});

test('duplicate slides carry independent guides with new IDs and blank slides start without guides', () => {
  const deck = fixture();
  const original = currentSlide(deck);
  const copy = duplicateSlide(deck);
  assert.deepEqual(copy.guides.map(({ axis, position }) => ({ axis, position })), original.guides.map(({ axis, position }) => ({ axis, position })));
  assert.ok(copy.guides.every(guide => !original.guides.some(source => source.id === guide.id)));
  assert.equal(new Set(copy.guides.map(guide => guide.id)).size, copy.guides.length);
  copy.guides[0].position = 1;
  assert.equal(original.guides[0].position, 96);
  assert.equal(Object.hasOwn(addSlide(deck), 'guides'), false);
  assert.deepEqual(validateDeck(deck), deck);
});

test('single-slide and cross-project batch clipboard paths carry independent guides', () => {
  const source = fixture();
  const payload = createSlideClipboard(source);
  const decoded = decodeSlide(encodeSlide(payload));
  assert.deepEqual(decoded.guides, guides());
  currentSlide(source).guides[0].position = 7;
  assert.deepEqual(payload.guides, guides());
  assert.deepEqual(decodeSlides(encodeSlide(payload)).slides[0].guides, guides());
  const destination = createDeck();
  const inserted = pasteSlide(destination, decoded);
  assert.deepEqual(inserted.guides.map(guide => guide.position), [96, 72.5]);
  assert.ok(inserted.guides.every(guide => !payload.guides.some(original => original.id === guide.id)));
  inserted.guides[0].position = 99;
  assert.deepEqual(decoded.guides, guides());
  addSlide(source).guides = [];
  const batch = createSlidesClipboard(source, source.slides.map(slide => slide.id));
  const batchDecoded = decodeSlides(encodeSlides(batch));
  assert.deepEqual(batchDecoded, batch);
  const pasted = pasteSlides(destination, batchDecoded);
  assert.deepEqual(pasted[0].guides.map(guide => guide.position), [7, 72.5]);
  assert.deepEqual(pasted[1].guides, []);
  pasted[0].guides[0].position = 999;
  assert.equal(batchDecoded.slides[0].guides[0].position, 7);
  assert.equal(currentSlide(destination), pasted[1]);
});

test('invalid guide clipboard payloads are rejected atomically and object-only copy omits guides', () => {
  const source = fixture();
  const payload = createSlideClipboard(source);
  const target = fixture();
  const before = serializeDeck(target);
  payload.guides[0].position = Infinity;
  assert.throws(() => encodeSlide(payload), /guide.position/);
  assert.throws(() => decodeSlide('Figure Editor slide v1\n' + JSON.stringify(payload)), /guide.position/);
  assert.throws(() => pasteSlide(target, payload), /guide.position/);
  assert.equal(serializeDeck(target), before);
  const batch = createSlidesClipboard(source);
  batch.slides[0].guides = [guides()[0], guides()[0]];
  assert.throws(() => pasteSlides(target, batch), /duplicate guide ID/);
  assert.equal(serializeDeck(target), before);
  const selection = decodeSelection(encodeSelection(createSlideClipboard(source)));
  assert.equal(Object.hasOwn(selection, 'guides'), false);
  pasteSelection(target, selection);
  assert.deepEqual(currentSlide(target).guides, guides());
});

test('snapping uses nearest visual edge or center, correct axis and inclusive tolerance', () => {
  const input = [{ id: 'wrong-axis', axis: 'y', position: 10 }, { id: 'left', axis: 'x', position: 9 }, { id: 'center', axis: 'x', position: 20.5 }];
  assert.deepEqual(snapAxis([10, 20, 30], input, 'x', 1), { delta: .5, guideId: 'center', position: 20.5 });
  assert.deepEqual(snapAxis([10, 20, 30], [input[1]], 'x', 1), { delta: -1, guideId: 'left', position: 9 });
  assert.deepEqual(snapAxis([10, 20, 30], input, 'y', 0), { delta: 0, guideId: 'wrong-axis', position: 10 });
  assert.equal(snapAxis([10, 20, 30], input, 'x', .49), null);
  assert.deepEqual(snapAxis([10, 20, 30], [{ id: 'end', axis: 'x', position: 32 }], 'x', 2), { delta: 2, guideId: 'end', position: 32 });
  assert.equal(snapAxis([10], guides(), 'x', 0), null);
});

test('snapping ties are deterministic, handles zoom-scaled tolerance and never mutates inputs', () => {
  const input = [{ id: 'first', axis: 'x', position: 95 }, { id: 'second', axis: 'x', position: 105 }];
  const anchors = [100, 120, 140];
  assert.deepEqual(snapAxis(anchors, input, 'x', 6), { delta: -5, guideId: 'first', position: 95 });
  assert.deepEqual(snapAxis([90, 100], input, 'x', 6), { delta: 5, guideId: 'first', position: 95 });
  assert.equal(snapAxis(anchors, input, 'x', 6 / 2), null, 'a 6 screen-pixel threshold at 200% zoom is 3 canvas pixels');
  assert.equal(snapAxis(anchors, input, 'x', 6 / .5)?.guideId, 'first');
  assert.deepEqual(anchors, [100, 120, 140]);
  assert.deepEqual(input.map(guide => guide.position), [95, 105]);
  for (const tolerance of [-1, NaN, Infinity, '6']) assert.equal(snapAxis(anchors, input, 'x', tolerance), null);
  assert.equal(snapAxis([], input, 'x', 6), null);
  assert.equal(snapAxis(anchors, undefined, 'x', 6), null);
  assert.equal(snapAxis(anchors, input, 'z', 6), null);
});

function storedZipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'PPTX writer uses stored entries');
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extraSize;
    if (name !== 'docProps/core.xml') entries.set(name, bytes.subarray(start, start + size).toString());
    offset = start + size;
  }
  return entries;
}

test('non-printing guides cannot alter SVG, PDF, PPTX or HTML report content', async () => {
  const withGuides = fixture();
  const withoutGuides = cloneDeck(withGuides);
  delete currentSlide(withoutGuides).guides;
  const original = serializeDeck(withGuides);
  const view = slideProject(withGuides);
  assert.equal(Object.hasOwn(view, 'guides'), false, 'rendering/PNG export receives only figure objects');
  assert.equal(projectToSVG(view), projectToSVG(slideProject(withoutGuides)));
  assert.equal(generateHTMLReport(withGuides), generateHTMLReport(withoutGuides));
  assert.deepEqual(await (await exportPDF(view)).arrayBuffer(), await (await exportPDF(slideProject(withoutGuides))).arrayBuffer());
  const withPPTX = storedZipEntries(Buffer.from(await (await exportPPTX(withGuides)).arrayBuffer()));
  const withoutPPTX = storedZipEntries(Buffer.from(await (await exportPPTX(withoutGuides)).arrayBuffer()));
  assert.deepEqual(withPPTX, withoutPPTX);
  assert.equal(serializeDeck(withGuides), original, 'exports retain editable guide metadata without mutation');
});
