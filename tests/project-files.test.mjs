import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../core.js';
import { createDeck, validateDeck } from '../deck.js';
import { MAX_PROJECT_BYTES, readProjectFile, pickProjectFile, writeProjectFile } from '../project-files.js';

const fileFor = (project, name = 'research.figure.json') => Object.assign(new Blob([JSON.stringify(project)], { type: 'application/json' }), { name });
function destination(name = 'research.figure.json') {
  const calls = [];
  const writer = {
    async write(file) { calls.push(['write', file]); },
    async close() { calls.push(['close']); },
    async abort() { calls.push(['abort']); },
  };
  const handle = { name, async createWritable() { calls.push(['createWritable']); return writer; } };
  return { handle, writer, calls };
}
const noDownload = () => assert.fail('Must not download when using a file handle.');

test('Save reuses the opened file and commits a complete editable project', async () => {
  const project = createDeck(), { handle, calls } = destination();
  const result = await writeProjectFile(project, {
    handle, pickerHost: { showSaveFilePicker() { assert.fail('Save must reuse its target.'); } }, download: noDownload,
  });
  assert.deepEqual(result, { handle, name: handle.name, downloaded: false });
  assert.deepEqual(calls.map(([step]) => step), ['createWritable', 'write', 'close']);
  assert.deepEqual(JSON.parse(await calls[1][1].text()), validateDeck(project));
});

test('Save requests readwrite access for an existing handle before serializing', async () => {
  const project = createDeck(), target = destination(), events = [];
  Object.defineProperty(project, 'name', { get() { events.push('serialize'); return 'Restored project'; } });
  target.handle.requestPermission = async options => {
    events.push('permission');
    assert.deepEqual(options, { mode: 'readwrite' });
    return 'granted';
  };
  const result = await writeProjectFile(project, { handle: target.handle, download: noDownload });
  assert.equal(events[0], 'permission');
  assert.ok(events.includes('serialize'));
  assert.equal(result.handle, target.handle);
  assert.equal(target.calls.at(-1)[0], 'close');
});

test('denied write permission explains recovery and leaves the file untouched', async () => {
  for (const permission of ['denied', 'prompt', 'throw']) {
    const project = createDeck(), target = destination();
    Object.defineProperty(project, 'name', { get() { assert.fail('Denied Save must not serialize.'); } });
    target.handle.requestPermission = async () => {
      if (permission === 'throw') throw new DOMException('Access denied', 'NotAllowedError');
      return permission;
    };
    await assert.rejects(writeProjectFile(project, { handle: target.handle, download: noDownload }), error => {
      assert.equal(error.name, 'NotAllowedError');
      assert.match(error.message, /Allow access.*Save As/);
      return true;
    });
    assert.deepEqual(target.calls, []);
  }
});

test('automatic Save checks existing access, commits a complete project, and never prompts', async () => {
  const project = createDeck(), target = destination(), events = [];
  Object.defineProperty(project, 'name', { get() { events.push('serialize'); return 'Autosaved project'; } });
  target.handle.queryPermission = async options => {
    events.push('queryPermission');
    assert.deepEqual(options, { mode: 'readwrite' });
    return 'granted';
  };
  target.handle.requestPermission = () => assert.fail('Autosave must never request permission.');
  const result = await writeProjectFile(project, {
    automatic: true, handle: target.handle, download: noDownload,
    pickerHost: { showSaveFilePicker() { assert.fail('Autosave must never open a picker.'); } },
  });
  assert.equal(events[0], 'queryPermission');
  assert.ok(events.includes('serialize'));
  assert.deepEqual(result, { handle: target.handle, name: target.handle.name, downloaded: false });
  assert.deepEqual(target.calls.map(([step]) => step), ['createWritable', 'write', 'close']);
  assert.deepEqual(JSON.parse(await target.calls[1][1].text()), validateDeck(project));
});

test('automatic Save refuses missing or unconfirmed access without serializing, prompting, or downloading', async () => {
  for (const permission of ['denied', 'prompt', undefined, 'unavailable', 'throw', 'missing-handle', 'save-as']) {
    const project = createDeck(), target = destination();
    Object.defineProperty(project, 'name', { get() { assert.fail('Unauthorized autosave must not serialize.'); } });
    target.handle.requestPermission = () => assert.fail('Autosave must never request permission.');
    if (permission !== 'unavailable') target.handle.queryPermission = async () => {
      assert.notEqual(permission, 'save-as', 'Autosave must reject Save As before checking access.');
      if (permission === 'throw') throw new Error('Unable to query access.');
      return permission;
    };
    await assert.rejects(writeProjectFile(project, {
      automatic: true, handle: permission === 'missing-handle' ? null : target.handle,
      saveAs: permission === 'save-as', download: noDownload,
      pickerHost: { showSaveFilePicker() { assert.fail('Autosave must never open a picker.'); } },
    }), error => {
      assert.equal(error.name, 'NotAllowedError', `Permission state: ${permission}`);
      assert.match(error.message, /Use Save/);
      return true;
    });
    assert.deepEqual(target.calls, []);
  }
});

test('automatic Save waits for close and aborts the writer when close fails', async () => {
  const target = destination(), failure = new Error('Autosave close failed');
  target.handle.queryPermission = async () => 'granted';
  let failClose, enteredClose, settled = false;
  const closing = new Promise(resolve => { enteredClose = resolve; });
  target.writer.close = () => {
    enteredClose();
    return new Promise((resolve, reject) => { failClose = reject; });
  };
  const saving = writeProjectFile(createDeck(), {
    automatic: true, handle: target.handle, download: noDownload,
  });
  saving.then(() => { settled = true; }, () => { settled = true; });
  await closing;
  assert.equal(settled, false);
  failClose(failure);
  await assert.rejects(saving, error => error === failure);
  assert.equal(target.calls.at(-1)[0], 'abort');
});

test('first Save picks its destination before serializing project content', async () => {
  const project = createDeck(), { handle } = destination('chosen.figure.json');
  const events = [];
  Object.defineProperty(project, 'name', { get() { events.push('serialize'); return 'Research'; } });
  const result = await writeProjectFile(project, {
    name: 'suggested.figure.json', download: noDownload,
    pickerHost: { showSaveFilePicker(options) {
      events.push('picker');
      assert.equal(options.suggestedName, 'suggested.figure.json');
      assert.ok(options.types[0].accept['application/json'].includes('.figure.json'));
      return Promise.resolve(handle);
    } },
  });
  assert.equal(events[0], 'picker');
  assert.ok(events.includes('serialize'));
  assert.equal(result.handle, handle);
});

test('Save As writes only to the newly selected file', async () => {
  const original = destination('original.figure.json'), copy = destination('copy.figure.json');
  const result = await writeProjectFile(createDeck(), {
    handle: original.handle, saveAs: true, download: noDownload,
    pickerHost: { async showSaveFilePicker() { return copy.handle; } },
  });
  assert.deepEqual(original.calls, []);
  assert.equal(result.handle, copy.handle);
  assert.equal(result.name, 'copy.figure.json');
  assert.equal(copy.calls.at(-1)[0], 'close');
});

test('a save is not successful until close resolves', async () => {
  const target = destination();
  let completeClose, enteredClose, resolved = false;
  const closing = new Promise(resolve => { enteredClose = resolve; });
  target.writer.close = () => { enteredClose(); return new Promise(resolve => { completeClose = resolve; }); };
  const saving = writeProjectFile(createDeck(), { handle: target.handle, download: noDownload }).then(result => { resolved = true; return result; });
  await closing;
  assert.equal(resolved, false);
  completeClose();
  assert.equal((await saving).handle, target.handle);
  assert.equal(resolved, true);
});

test('picker cancellation leaves the existing destination untouched without downloading', async () => {
  const target = destination(), cancelled = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(writeProjectFile(createDeck(), {
    handle: target.handle, saveAs: true, download: noDownload,
    pickerHost: { async showSaveFilePicker() { throw cancelled; } },
  }), error => error === cancelled);
  assert.deepEqual(target.calls, []);
});

test('picker permission failures do not silently download a copy', async () => {
  const denied = new DOMException('Permission denied', 'NotAllowedError');
  await assert.rejects(writeProjectFile(createDeck(), {
    download: noDownload, pickerHost: { async showSaveFilePicker() { throw denied; } },
  }), error => error === denied);
});

for (const phase of ['createWritable', 'write', 'close']) {
  test(`${phase} failure rejects, attempts cleanup, and never falls back to download`, async () => {
    const target = destination(), failure = new Error(`${phase} failed`);
    (phase === 'createWritable' ? target.handle : target.writer)[phase] = async () => { throw failure; };
    target.writer.abort = async () => { target.calls.push(['abort']); throw new Error('Cleanup failed'); };
    await assert.rejects(writeProjectFile(createDeck(), { handle: target.handle, download: noDownload }), error => error === failure);
    assert.equal(target.calls.filter(([step]) => step === 'abort').length, phase === 'createWritable' ? 0 : 1);
    assert.equal(target.calls.some(([step]) => step === 'close'), false);
  });
}

test('unsupported browsers download a portable project when no target is bound', async () => {
  const project = createDeck(), downloads = [];
  const result = await writeProjectFile(project, {
    name: 'portable.figure.json', pickerHost: {}, download: async (file, name) => downloads.push({ file, name }),
  });
  assert.deepEqual(result, { handle: null, name: 'portable.figure.json', downloaded: true });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, result.name);
  assert.deepEqual(await readProjectFile(downloads[0].file), validateDeck(project));
});

test('Save As cannot overwrite a bound file when the save picker is unavailable', async () => {
  const target = destination();
  await assert.rejects(writeProjectFile(createDeck(), {
    handle: target.handle, saveAs: true, pickerHost: {}, download: noDownload,
  }), /Save As requires/);
  assert.deepEqual(target.calls, []);
});

test('Open returns the selected handle and validates its complete deck', async () => {
  const project = createDeck(), file = fileFor(project);
  const handle = { name: file.name, async getFile() { return file; } };
  const opened = await pickProjectFile({ pickerHost: { async showOpenFilePicker(options) {
    assert.equal(options.multiple, false);
    return [handle];
  } } });
  assert.equal(opened.handle, handle);
  assert.equal(opened.name, file.name);
  assert.deepEqual(opened.project, validateDeck(project));
});

test('Open migrates legacy single-slide projects and rejects malformed content', async () => {
  const legacy = createProject();
  const opened = await readProjectFile(fileFor(legacy));
  assert.equal(opened.version, 2);
  assert.equal(opened.id, legacy.id);
  assert.deepEqual(opened.slides[0].canvas, legacy.canvas);
  assert.equal(opened.slides.length, 1);
  await assert.rejects(readProjectFile(new Blob(['{'])), SyntaxError);
  await assert.rejects(readProjectFile(fileFor({ ...createDeck(), slides: [] })), /1–100 slides/);
});

test('Open propagates cancellation and refuses oversize files before reading', async () => {
  const cancelled = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(pickProjectFile({ pickerHost: { async showOpenFilePicker() { throw cancelled; } } }), error => error === cancelled);
  await assert.rejects(readProjectFile({ size: MAX_PROJECT_BYTES + 1, text() { assert.fail('Oversize file must not be read.'); } }), /240 MB/);
});

test('invalid project data cannot open a writable stream', async () => {
  const target = destination();
  await assert.rejects(writeProjectFile({ ...createDeck(), slides: [] }, { handle: target.handle, download: noDownload }), /1–100 slides/);
  assert.deepEqual(target.calls, []);
});

test('serialized size limit is checked before opening a writer or downloading', async () => {
  const NativeBlob = globalThis.Blob, target = destination();
  // Simulate a large encoded Blob without allocating 240 MB in the unit suite.
  globalThis.Blob = class extends NativeBlob { get size() { return MAX_PROJECT_BYTES + 1; } };
  try {
    await assert.rejects(writeProjectFile(createDeck(), { handle: target.handle, download: noDownload }), /240 MB/);
    target.handle.queryPermission = async () => 'granted';
    await assert.rejects(writeProjectFile(createDeck(), { automatic: true, handle: target.handle, download: noDownload }), /240 MB/);
    await assert.rejects(writeProjectFile(createDeck(), { pickerHost: {}, download: noDownload }), /240 MB/);
    assert.deepEqual(target.calls, []);
  } finally { globalThis.Blob = NativeBlob; }
});
