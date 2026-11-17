import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlidePreviewTracker } from '../slide-preview-cache.js';

const asset = (id, dataUrl = 'data:image/png;base64,AAAA') => ({ id, mime: 'image/png', dataUrl, width: 20, height: 10 });
const picture = (id, assetId) => ({ id, type: 'image', assetId, x: 10, y: 20, width: 30, height: 40 });
const page = (id, items = []) => ({ id, name: id, canvas: { width: 400, height: 300, background: '#ffffff' }, items });

test('selection and metadata-only asset changes reuse thumbnail inputs without rereading page items', () => {
  const tracker = createSlidePreviewTracker(), source = asset('source'), slide = page('one', [picture('image', 'source')]);
  let reads = 0;
  const items = slide.items;
  Object.defineProperty(slide, 'items', { get() { reads++; return items; } });
  tracker.prepare([source], [slide]);
  const initial = tracker.get(slide), initialReads = reads;
  source.name = 'Renamed source'; source.relativePath = 'folder/source.png';
  tracker.prepare([source], [slide]);
  assert.equal(tracker.get(slide), initial);
  assert.equal(reads, initialReads);
  assert.equal(JSON.parse(initial.key)[1][0].assetId, 'source');
});

test('a known local edit recomputes only that slide and keeps unrelated cached inputs', () => {
  const tracker = createSlidePreviewTracker(), slides = [page('one', [picture('a', 'source')]), page('two')];
  tracker.prepare([asset('source')], slides);
  const first = tracker.get(slides[0]), second = tracker.get(slides[1]);
  slides[0].items[0].x = 90;
  tracker.invalidate('one');
  const updated = tracker.get(slides[0]);
  assert.notEqual(updated, first);
  assert.equal(JSON.parse(updated.key)[1][0].x, 90);
  assert.equal(tracker.get(slides[1]), second);
});

test('unknown edits invalidate every page and capture nested style and canvas changes', () => {
  const tracker = createSlidePreviewTracker(), slides = [page('one', [{ id: 'shape', fillGradient: { stops: [{ color: '#000000' }] } }]), page('two')];
  tracker.prepare([], slides);
  const previous = slides.map(slide => tracker.get(slide));
  slides[0].items[0].fillGradient.stops[0].color = '#ff0000';
  slides[1].canvas.background = '#112233';
  tracker.invalidate();
  const updated = slides.map(slide => tracker.get(slide));
  assert.notEqual(updated[0], previous[0]); assert.notEqual(updated[1], previous[1]);
  assert.equal(JSON.parse(updated[0].key)[1][0].fillGradient.stops[0].color, '#ff0000');
  assert.equal(JSON.parse(updated[1].key)[0].background, '#112233');
});

test('in-place same-length shared-source replacement invalidates all referencing pages only', () => {
  const tracker = createSlidePreviewTracker(), source = asset('shared');
  const slides = [page('one', [picture('a', 'shared')]), page('two', [picture('b', 'shared')]), page('three')];
  tracker.prepare([source], slides);
  const previous = slides.map(slide => tracker.get(slide));
  source.dataUrl = 'data:image/png;base64,BBBB';
  tracker.prepare([source], slides);
  for (let index = 0; index < 2; index++) {
    const updated = tracker.get(slides[index]);
    assert.notEqual(updated, previous[index]);
    assert.equal(updated.key, previous[index].key);
    assert.equal(updated.sources[2], source.dataUrl);
    assert.equal(previous[index].sources[2], 'data:image/png;base64,AAAA');
  }
  assert.equal(tracker.get(slides[2]), previous[2]);
});

test('poster and dimension updates invalidate a page without serializing source documents', () => {
  const tracker = createSlidePreviewTracker(), source = { ...asset('chart'), mime: 'text/html', posterDataUrl: 'poster-a' };
  const cyclic = {}; cyclic.self = cyclic;
  source.svgDocument = cyclic;
  const slide = page('one', [picture('chart-item', 'chart')]);
  tracker.prepare([source], [slide]);
  let previous = tracker.get(slide);
  for (const update of [{ posterDataUrl: 'poster-b' }, { width: 40 }, { height: 30 }]) {
    Object.assign(source, update); tracker.prepare([source], [slide]);
    const next = tracker.get(slide);
    assert.notEqual(next, previous); previous = next;
  }
});

test('added and removed sources refresh pages even when the source was initially missing', () => {
  const tracker = createSlidePreviewTracker(), slide = page('one', [picture('a', 'missing')]);
  tracker.prepare([], [slide]);
  const missing = tracker.get(slide);
  assert.deepEqual(missing.sources, []);
  tracker.prepare([asset('missing')], [slide]);
  const available = tracker.get(slide);
  assert.notEqual(available, missing); assert.equal(available.sources[0], 'missing');
  tracker.prepare([], [slide]);
  const removed = tracker.get(slide);
  assert.notEqual(removed, available); assert.deepEqual(removed.sources, []);
});

test('changed references and visibility update source dependencies without stale invalidation', () => {
  const tracker = createSlidePreviewTracker(), a = asset('a'), b = asset('b');
  const slide = page('one', [picture('image', 'a')]);
  tracker.prepare([a, b], [slide]); tracker.get(slide);
  slide.items[0].assetId = 'b'; tracker.invalidate('one');
  const changed = tracker.get(slide);
  a.dataUrl = 'replaced-a'; tracker.prepare([a, b], [slide]);
  assert.equal(tracker.get(slide), changed);
  b.dataUrl = 'replaced-b'; tracker.prepare([a, b], [slide]);
  assert.notEqual(tracker.get(slide), changed);
  slide.items[0].hidden = true; tracker.invalidate('one');
  const hidden = tracker.get(slide);
  b.dataUrl = 'newest-b'; tracker.prepare([a, b], [slide]);
  assert.equal(tracker.get(slide), hidden);
  slide.items[0].hidden = false; tracker.invalidate('one');
  assert.equal(tracker.get(slide).sources[2], 'newest-b');
});

test('Undo or reopen with a new page identity invalidates an otherwise identical page', () => {
  const tracker = createSlidePreviewTracker(), slide = page('one', [picture('a', 'source')]);
  tracker.prepare([asset('source')], [slide]);
  const previous = tracker.get(slide), restored = structuredClone(slide);
  tracker.prepare([asset('source')], [restored]);
  const next = tracker.get(restored);
  assert.notEqual(next, previous); assert.equal(next.key, previous.key);
});

test('removed pages are evicted and clear resets both pages and source inputs', () => {
  const tracker = createSlidePreviewTracker(), source = asset('source'), slide = page('one', [picture('a', 'source')]);
  tracker.prepare([source], [slide]);
  const initial = tracker.get(slide);
  tracker.prepare([source], []);
  tracker.prepare([source], [slide]);
  const reinserted = tracker.get(slide);
  assert.notEqual(reinserted, initial);
  tracker.clear(); tracker.prepare([source], [slide]);
  const reset = tracker.get(slide);
  assert.notEqual(reset, reinserted); assert.deepEqual(reset.sources, initial.sources);
});
