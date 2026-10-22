import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck } from '../deck.js';
import { createRecentProjects, openRecentProject } from '../recent-projects.js';

function memoryStorage(initial = []) {
  return {
    saved: initial, writes: [],
    async load() { return this.saved; },
    async save(entries) { this.saved = entries; this.writes.push(entries); },
  };
}
function fileHandle(name, identity = name, project = createDeck()) {
  return {
    kind: 'file', name, identity,
    async getFile() { return Object.assign(new Blob([JSON.stringify(project)]), { name }); },
    async isSameEntry(other) { return identity === other.identity; },
    requestPermission() { assert.fail('History operations must never request access.'); },
  };
}

test('recent projects remain ordered, bounded, and deduplicate handles by file identity', async () => {
  const storage = memoryStorage(), recent = createRecentProjects({ storage, limit: 3 });
  const first = fileHandle('same.figure.json', 'folder-one');
  await recent.remember({ handle: first, projectName: 'First' });
  const firstId = recent.entries[0].id;
  await recent.remember({ handle: fileHandle('same.figure.json', 'folder-two'), projectName: 'Second' });
  await recent.remember({ handle: fileHandle('third.figure.json'), projectName: 'Third' });
  assert.equal(recent.entries.length, 3);
  await recent.remember({ handle: fileHandle('renamed.figure.json', 'folder-one'), projectName: 'First renamed' });
  assert.equal(recent.entries[0].id, firstId);
  assert.deepEqual(recent.entries.map(entry => entry.projectName), ['First renamed', 'Third', 'Second']);
  await recent.remember({ handle: fileHandle('fourth.figure.json') });
  assert.deepEqual(recent.entries.map(entry => entry.projectName), ['fourth.figure.json', 'First renamed', 'Third']);
  assert.ok(recent.entries.every(entry => entry.persistent && Number.isFinite(entry.lastOpened)));
  assert.deepEqual((await createRecentProjects({ storage, limit: 3 }).load()).map(entry => entry.id), recent.entries.map(entry => entry.id));
});

test('handleless names only merge with other handleless records', async () => {
  const recent = createRecentProjects({ storage: memoryStorage() });
  await recent.remember({ name: 'same.figure.json', projectName: 'Download' });
  const downloadId = recent.entries[0].id;
  await recent.remember({ handle: fileHandle('same.figure.json'), projectName: 'File' });
  await recent.remember({ name: 'same.figure.json', projectName: 'Updated download' });
  assert.equal(recent.entries.length, 2);
  assert.equal(recent.entries[0].id, downloadId);
  assert.deepEqual(recent.entries.map(entry => entry.projectName), ['Updated download', 'File']);
});

test('stale handle comparisons do not drop unrelated files with the same name', async () => {
  const recent = createRecentProjects({ storage: memoryStorage() }), first = fileHandle('same.figure.json');
  await recent.remember({ handle: first });
  const second = fileHandle('same.figure.json');
  second.isSameEntry = async () => { throw new DOMException('Deleted', 'NotFoundError'); };
  await recent.remember({ handle: second });
  assert.equal(recent.entries.length, 2);
  await recent.remember({ handle: second, projectName: 'Same handle object' });
  assert.equal(recent.entries.length, 2);
});

test('queued mutations and initial loading cannot overwrite newer history', async () => {
  let releaseLoad, releaseSave;
  const storage = memoryStorage();
  storage.load = () => new Promise(resolve => { releaseLoad = resolve; });
  const baseSave = storage.save.bind(storage);
  let firstWrite = true;
  storage.save = async entries => {
    if (firstWrite) { firstWrite = false; await new Promise(resolve => { releaseSave = resolve; }); }
    await baseSave(entries);
  };
  const recent = createRecentProjects({ storage });
  const loading = recent.load(), first = recent.remember({ name: 'first' }), clearing = recent.clear(), last = recent.remember({ name: 'last' });
  await Promise.resolve();
  releaseLoad([]);
  await loading;
  while (!releaseSave) await Promise.resolve();
  assert.deepEqual(recent.entries.map(entry => entry.name), ['first']);
  releaseSave();
  await Promise.all([first, clearing, last]);
  assert.deepEqual(storage.writes.map(entries => entries.map(entry => entry.name)), [['first'], [], ['last']]);
  assert.deepEqual(recent.entries.map(entry => entry.name), ['last']);
});

test('uncloneable handles retain session access and persist metadata for reload', async () => {
  const storage = memoryStorage(), baseSave = storage.save.bind(storage);
  storage.save = async entries => {
    if (entries.some(entry => entry.handle)) throw new DOMException('Handle cannot clone', 'DataCloneError');
    await baseSave(entries);
  };
  const recent = createRecentProjects({ storage }), handle = fileHandle('local.figure.json');
  await recent.remember({ handle, projectName: 'Local' });
  assert.equal(recent.entries[0].handle, handle);
  assert.equal(recent.entries[0].persistent, false);
  assert.equal(recent.storageError.name, 'DataCloneError');
  assert.equal(storage.saved[0].handle, null);
  const loaded = await createRecentProjects({ storage }).load();
  assert.equal(loaded[0].projectName, 'Local');
  assert.equal(loaded[0].handle, null);
  assert.equal(loaded[0].persistent, false);
});

test('unavailable storage and quota failures preserve usable session history', async () => {
  for (const failure of ['load', 'save', 'fallback']) {
    const storage = memoryStorage();
    if (failure === 'load') storage.load = async () => { throw new Error('Storage unavailable'); };
    storage.save = async entries => {
      if (failure === 'load') assert.fail('Do not overwrite unavailable persisted history');
      if (failure === 'fallback' && entries.some(entry => entry.handle)) throw new DOMException('Cannot clone', 'DataCloneError');
      throw new DOMException('No space', 'QuotaExceededError');
    };
    const recent = createRecentProjects({ storage }), handle = fileHandle('project.figure.json');
    await recent.load();
    await recent.remember({ handle });
    assert.equal(recent.entries.length, 1);
    assert.equal(recent.entries[0].handle, handle);
    assert.equal(recent.entries[0].persistent, false);
    assert.ok(recent.storageError);
    await recent.clear();
    assert.deepEqual(recent.entries, []);
  }
});

test('history removal leaves files untouched and ignores malformed saved entries', async () => {
  const handle = fileHandle('safe.figure.json');
  handle.remove = () => assert.fail('History removal cannot delete a file');
  const storage = memoryStorage([null, {}, { id: 'valid', name: 'safe.figure.json', handle, lastOpened: 10 }, { id: 'valid', name: 'duplicate' }]);
  const recent = createRecentProjects({ storage });
  assert.equal((await recent.load()).length, 1);
  const view = recent.entries;
  view[0].name = 'changed externally'; view.length = 0;
  assert.equal(recent.entries[0].name, 'safe.figure.json');
  await recent.remove('missing');
  assert.equal(recent.entries.length, 1);
  await recent.remove('valid');
  assert.deepEqual(storage.saved, []);
});

test('recent history never grows beyond ten entries', async () => {
  const recent = createRecentProjects({ storage: memoryStorage(), limit: 100 });
  for (let index = 0; index < 12; index++) await recent.remember({ name: `project-${index}` });
  assert.equal(recent.entries.length, 10);
  assert.equal(recent.entries[0].name, 'project-11');
});

test('opening a recent file requests read access immediately and reads current file bytes', async () => {
  const project = createDeck(); project.name = 'Latest disk version';
  const events = [], handle = fileHandle('fresh.figure.json', 'fresh', project);
  const getFile = handle.getFile.bind(handle);
  handle.requestPermission = options => { events.push(['permission', options]); return Promise.resolve('granted'); };
  handle.getFile = async () => { events.push(['file']); return getFile(); };
  const opening = openRecentProject({ handle, name: 'old.figure.json', projectName: 'Stale metadata' });
  assert.deepEqual(events, [['permission', { mode: 'read' }]]);
  const opened = await opening;
  assert.equal(opened.project.name, 'Latest disk version');
  assert.equal(opened.handle, handle);
  assert.equal(opened.name, 'fresh.figure.json');
});

test('denied recent access never reads the file and explains how to recover', async () => {
  for (const permission of ['denied', 'prompt', 'throw']) {
    const handle = fileHandle('denied.figure.json');
    handle.requestPermission = async () => {
      if (permission === 'throw') throw new DOMException('Access denied', 'NotAllowedError');
      return permission;
    };
    handle.getFile = () => assert.fail('Do not read when permission is denied');
    await assert.rejects(openRecentProject({ handle }), error => error.name === 'NotAllowedError' && /Open/.test(error.message));
  }
});

test('missing file access, removed files, and invalid project data fail without modifying history', async () => {
  await assert.rejects(openRecentProject({ name: 'reselect.figure.json', handle: null }), error => error.name === 'NotSupportedError' && /again with Open/.test(error.message));
  const removed = fileHandle('removed.figure.json');
  removed.requestPermission = async () => 'granted';
  const missingError = new DOMException('File no longer exists', 'NotFoundError');
  removed.getFile = async () => { throw missingError; };
  await assert.rejects(openRecentProject({ handle: removed }), error => error === missingError);
  const invalid = fileHandle('invalid.figure.json');
  delete invalid.requestPermission;
  invalid.getFile = async () => new Blob(['not JSON']);
  await assert.rejects(openRecentProject({ handle: invalid }), SyntaxError);
  invalid.getFile = async () => new Blob(['{}']);
  await assert.rejects(openRecentProject({ handle: invalid }), /Invalid/);
});
