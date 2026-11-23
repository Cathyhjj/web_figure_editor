import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDraft, mergeDraft, sameDraftData, draftAssetKey } from '../draft-store.js';

const svgDocument = { tag: 'svg', attrs: {}, children: [] };
const project = () => ({ format: 'figure-editor', version: 2, id: 'deck', name: 'Deck', activeSlideId: 's', slides: [{ id: 's', items: [] }], assets: [
  { id: 'photo', name: 'photo.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: 2, height: 1 },
  { id: 'plot', name: 'plot.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,BBBB', svgDocument, width: 3, height: 4, originalDataUrl: 'data:text/html;base64,CCCC' },
] });
const stored = draft => new Map([...draft.data].map(([id, record]) => [draftAssetKey(id), record]));

test('a draft keeps asset metadata in the project record and data in separate records', () => {
  const source = project(), draft = splitDraft(source);
  assert.deepEqual(draft.project.assets, [
    { id: 'photo', name: 'photo.png', mime: 'image/png', width: 2, height: 1, draftData: true },
    { id: 'plot', name: 'plot.svg', mime: 'image/svg+xml', width: 3, height: 4, draftData: true },
  ]);
  assert.deepEqual([...draft.data.keys()], ['photo', 'plot']);
  assert.equal(draft.data.get('plot').svgDocument, svgDocument);
  assert.deepEqual(source, project(), 'the live project is not modified');
  assert.deepEqual(mergeDraft(draft.project, stored(draft)), source);
});

test('only changed asset data needs rewriting', () => {
  const before = splitDraft(project()).data, edited = project();
  edited.slides[0].items.push({ id: 'text' }); edited.assets[0].name = 'renamed.png';
  const after = splitDraft(edited).data;
  assert.equal(sameDraftData(before.get('photo'), after.get('photo')), true);
  assert.equal(sameDraftData(before.get('plot'), after.get('plot')), true);
  edited.assets[0].dataUrl = 'data:image/png;base64,DDDD';
  assert.equal(sameDraftData(before.get('photo'), splitDraft(edited).data.get('photo')), false);
  delete edited.assets[1].originalDataUrl;
  assert.equal(sameDraftData(before.get('plot'), splitDraft(edited).data.get('plot')), false);
  assert.equal(sameDraftData(undefined, after.get('photo')), false);
});

test('earlier complete drafts load unchanged and incomplete drafts are rejected', () => {
  const complete = project();
  assert.equal(mergeDraft(complete, new Map()), complete);
  assert.equal(mergeDraft(undefined, new Map()), undefined);
  const draft = splitDraft(project()), records = stored(draft);
  records.delete(draftAssetKey('plot'));
  assert.throws(() => mergeDraft(draft.project, records), /incomplete/);
});
