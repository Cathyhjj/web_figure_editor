import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, validateDeck } from '../deck.js';
import { prepareBatch, describeProject } from '../automation.js';

function fixture() {
  const deck = createDeck();
  deck.slides[0].items = ['a', 'b', 'c'].map((id, n) => ({ id, type: 'text', x: n * 100, y: n * 30, width: 40, height: 20, text: id }));
  return validateDeck(deck);
}
const op = (deck, operation) => ({ slideId: deck.activeSlideId, ...operation });

test('batch layout changes a candidate only and precisely spaces objects', () => {
  const deck = fixture(), before = structuredClone(deck);
  const result = prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['a', 'b', 'c'], properties: { width: 50, fontSize: 16 } }),
    op(deck, { op: 'align', itemIds: ['a', 'b', 'c'], alignment: 'top' }),
    op(deck, { op: 'distribute', itemIds: ['a', 'b', 'c'], axis: 'x', gap: 12 })]);
  assert.deepEqual(deck, before);
  assert.deepEqual(result.project.slides[0].items.map(i => [i.x, i.y, i.width, i.fontSize]), [[0, 0, 50, 16], [62, 0, 50, 16], [124, 0, 50, 16]]);
  assert.deepEqual(result.changedItemIds, ['a', 'b', 'c']);
});

test('late invalid operations and locked objects leave the source untouched', () => {
  for (const invalid of [{ op: 'set', itemIds: ['missing'], properties: { x: 5 } },
    { op: 'set', itemIds: ['a'], properties: { width: -1 } },
    { op: 'set', itemIds: ['a'], properties: { assetId: 'evil' } },
    { op: 'set', itemIds: ['a', 'a'], properties: { x: 3 } }]) {
    const deck = fixture(), before = structuredClone(deck);
    assert.throws(() => prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['a'], properties: { x: 70 } }), op(deck, invalid)]));
    assert.deepEqual(deck, before);
  }
  const deck = fixture(); deck.slides[0].items[1].locked = true;
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a', 'b'], alignment: 'left' })]), /locked/);
});

test('add_text creates unique IDs, cross-slide edits are explicit, and rotation is guarded', () => {
  const deck = fixture();
  const next = prepareBatch(deck, [op(deck, { op: 'add_text', properties: { text: '(a)', x: 10, y: 20 } })]);
  assert.equal(next.createdItemIds.length, 1);
  assert.equal(next.project.slides[0].items.at(-1).text, '(a)');
  assert.throws(() => prepareBatch(deck, [{ op: 'set', slideId: 'other', itemIds: ['a'], properties: { x: 8 } }]), /Unknown slide/);
  deck.slides[0].items[0].rotation = 15;
  assert.throws(() => prepareBatch(deck, [op(deck, { op: 'align', itemIds: ['a', 'b'], alignment: 'left' })]), /unrotated/);
});

test('single media dimension preserves aspect ratio; state excludes embedded asset data', () => {
  const deck = fixture();
  deck.assets = [{ id: 'image', name: 'panel.png', mime: 'image/png', width: 1, height: 1,
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=' }];
  deck.slides[0].items.push({ id: 'picture', type: 'image', assetId: 'image', x: 0, y: 0, width: 100, height: 50 });
  const next = prepareBatch(deck, [op(deck, { op: 'set', itemIds: ['picture'], properties: { width: 200 } })]);
  assert.equal(next.project.slides[0].items.at(-1).height, 100);
  const state = describeProject(next.project);
  assert.equal(state.assets[0].name, 'panel.png');
  assert.equal(JSON.stringify(state).includes('base64'), false);
  assert.equal('dataUrl' in state.assets[0], false);
});
