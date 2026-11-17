import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftWriter, sameDraftFile } from '../draft-persistence.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const metadata = (patch = {}) => ({ handle: null, name: '', revision: null, dirty: true, ...patch });
function fixture(write) {
  const state = { captures: 0, validations: 0, writes: [], requests: 0, project: { text: 'first' }, stored: null };
  const writer = createDraftWriter({
    validate(project) { state.validations++; assert.ok(project); return { ...project }; },
    async write(project, file, tokens) {
      state.requests++;
      const own = state.stored?.token === tokens.content;
      if (own && sameDraftFile(state.stored.file, file)) return { persistent: true };
      state.writes.push({ project: own ? undefined : project, file });
      const result = await (write?.(project, file) ?? { persistent: true });
      state.stored = { token: tokens.content, file, project };
      return result;
    },
  });
  const save = (revision = 1, file = metadata(), epoch = 1) => writer.save({ epoch, revision, file, capture() { state.captures++; return { ...state.project }; } });
  return { state, save };
}

test('duplicate requests share in-flight work and successful content is not rewritten', async () => {
  const gate = deferred(), { state, save } = fixture(() => gate.promise);
  const first = save(), second = save();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(state.writes.length, 1);
  gate.resolve({ persistent: true }); await first; await save();
  assert.deepEqual([state.captures, state.validations, state.writes.length], [1, 1, 1]);
  assert.equal(state.requests, 2, 'completed duplicate requests still check storage ownership');
});

test('AutoSave and Save As update only file metadata after the same content revision', async () => {
  const { state, save } = fixture(); await save();
  const handle = {};
  await save(1, metadata({ handle, name: 'first.figure.json', revision: 'hash-one', dirty: false }));
  await save(1, metadata({ handle: {}, name: 'second.figure.json', revision: 'hash-two', dirty: false }));
  assert.deepEqual([state.captures, state.validations, state.writes.length], [1, 1, 3]);
  assert.deepEqual(state.writes.slice(1).map(write => write.project), [undefined, undefined]);
  assert.equal(state.writes[2].file.name, 'second.figure.json');
});

test('queued metadata requests share a captured revision and never observe subsequent edits', async () => {
  const gate = deferred(); let count = 0;
  const { state, save } = fixture(async () => { if (!count++) await gate.promise; return { persistent: true }; });
  const first = save();
  const afterSave = save(1, metadata({ name: 'saved.figure.json', dirty: false }));
  state.project.text = 'second'; const second = save(2);
  state.project.text = 'third';
  gate.resolve(); await Promise.all([first, afterSave, second]);
  assert.deepEqual(state.writes.map(write => write.project?.text), ['first', undefined, 'second']);
  assert.deepEqual([state.captures, state.validations], [2, 2]);
});

test('failed content and metadata writes can retry and do not mark content as saved', async () => {
  let failures = 1;
  const { state, save } = fixture(() => { if (failures--) throw new Error('storage unavailable'); return { persistent: true }; });
  await assert.rejects(save(), /storage unavailable/);
  await save(); assert.ok(state.writes[1].project);
  failures = 1;
  const file = metadata({ dirty: false });
  await assert.rejects(save(1, file), /storage unavailable/);
  await save(1, file);
  assert.equal(state.writes[3].project, undefined);
  assert.deepEqual([state.captures, state.validations], [2, 2]);
});

test('new epochs and Undo revisions write their own content even when revision numbers repeat', async () => {
  const { state, save } = fixture(); await save();
  state.project.text = 'other project'; await save(1, metadata(), 2);
  state.project.text = 'undo value'; await save(2, metadata(), 2);
  assert.deepEqual(state.writes.map(write => write.project.text), ['first', 'other project', 'undo value']);
  assert.equal(state.validations, 3);
});

test('a failed queued content write is retried by the next metadata request with the same snapshot', async () => {
  let fail = true;
  const { state, save } = fixture(() => { if (fail) { fail = false; throw new Error('quota'); } return { persistent: false }; });
  const first = save(), second = save(1, metadata({ name: 'copy.figure.json' }));
  await assert.rejects(first, /quota/); assert.equal((await second).persistent, false);
  assert.deepEqual(state.writes.map(write => write.project.text), ['first', 'first']);
  assert.deepEqual([state.captures, state.validations], [1, 1]);
});

test('another tab replacing the draft forces a full write using the retained validated content', async () => {
  const { state, save } = fixture(); await save();
  state.stored = { token: 'different-tab', file: metadata(), project: { text: 'other tab' } };
  await save();
  assert.equal(state.writes[1].project.text, 'first');
  assert.deepEqual([state.captures, state.validations], [1, 1]);
  state.stored = null;
  await save(1, metadata({ dirty: false }));
  assert.equal(state.writes[2].project.text, 'first');
  assert.equal(state.validations, 1);
});
