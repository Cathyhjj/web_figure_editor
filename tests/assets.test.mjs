import test from 'node:test';
import assert from 'node:assert/strict';
import { importFiles, importFolderFiles, importDroppedFiles, pickFolder, replaceAsset, refreshAsset, assetLinkStatus, pickImages, linkAsset, MAX_FILE_BYTES } from '../assets.js';
import { needsLocalSource } from '../local-source.js';
import { createProject, serializeProject, validateProject } from '../core.js';

// Image decode itself is covered by browser checks. This stand-in keeps IO/permission tests deterministic.
globalThis.Image = class {
  naturalWidth = 1;
  naturalHeight = 1;
  set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
};
const pngBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nxsAAAAASUVORK5CYII=', 'base64'));
const png = (name = 'panel.png') => Object.assign(new Blob([pngBytes], { type: 'image/png' }), { name, lastModified: 123 });

test('imports portable original PNG bytes and records source metadata', async () => {
  const { assets, errors } = await importFiles([png()]);
  assert.deepEqual(errors, []);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].mime, 'image/png');
  assert.equal(assets[0].name, 'panel.png');
  assert.equal(assets[0].sourceKind, 'copy');
  assert.equal(assets[0].sourceOrigin, 'file');
  assert.equal(assets[0].lastModified, 123);
  assert.equal(assets[0].dataUrl, `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`);
  assert.equal(await assetLinkStatus(assets[0]), 'Embedded project copy');
});

test('rejects spoofed formats independently while importing valid siblings', async () => {
  const spoof = Object.assign(new Blob(['not a png'], { type: 'image/png' }), { name: 'spoof.png' });
  const result = await importFiles([spoof, png()]);
  assert.equal(result.assets.length, 1);
  assert.equal(result.errors[0].name, 'spoof.png');
  assert.match(result.errors[0].message, /actual file contents/);
});

test('rejects oversize files before reading and huge dimensions before decoding', async () => {
  let read = false;
  const huge = { name: 'huge.png', size: MAX_FILE_BYTES + 1, arrayBuffer() { read = true; } };
  assert.match((await importFiles([huge])).errors[0].message, /25 MB/);
  assert.equal(read, false);
  const bombBytes = pngBytes.slice();
  new DataView(bombBytes.buffer).setUint32(16, 40_000);
  const bomb = Object.assign(new Blob([bombBytes]), { name: 'bomb.png' });
  assert.match((await importFiles([bomb])).errors[0].message, /dimensions are too large/);
});

test('uses only real selected handles, requests read permission, and preserves ids on refresh', async () => {
  const original = png();
  const requests = [];
  const handle = {
    kind: 'file', name: 'panel.png',
    async getFile() { return png('updated.png'); },
    async queryPermission(options) { requests.push(['query', options]); return 'prompt'; },
    async requestPermission(options) { requests.push(['request', options]); return 'granted'; },
  };
  const asset = (await importFiles([original], new Map([[original, handle]]))).assets[0];
  assert.equal(asset.sourceKind, 'linked');
  assert.ok(asset.linkToken);
  assert.equal(asset.linkPersistence, 'session');
  assert.match(await assetLinkStatus(asset), /permission required to refresh/);
  assert.equal(requests.filter(([type]) => type === 'request').length, 0);
  const refreshed = await refreshAsset(asset);
  assert.equal(refreshed.id, asset.id);
  assert.equal(refreshed.linkToken, asset.linkToken);
  assert.equal(refreshed.name, 'updated.png');
  assert.ok(requests.every(([, options]) => options.mode === 'read'));
  assert.equal(requests.filter(([type]) => type === 'request').length, 1);
  const replaced = await replaceAsset(asset, png('copy.png'));
  assert.equal(replaced.id, asset.id);
  assert.equal(replaced.sourceKind, 'copy');
  assert.equal(replaced.linkToken, undefined);
  await assert.rejects(refreshAsset(replaced), /Relink/);
});

test('undo and redo of reassociation refresh the matching source, including after a copy replacement', async () => {
  const reads = [];
  const makeHandle = (name) => ({
    kind: 'file', name,
    async getFile() { reads.push(name); return png(name); },
    async queryPermission() { return 'granted'; },
  });
  const firstFile = png('first.png');
  const firstHandle = makeHandle('first.png');
  const secondHandle = makeHandle('second.png');
  const first = (await importFiles([firstFile], new Map([[firstFile, firstHandle]]))).assets[0];
  // Undo history stores serializable asset metadata, never a live file handle.
  const undoSnapshot = JSON.parse(JSON.stringify(first));
  const second = await replaceAsset(first, png('second.png'), secondHandle);
  const redoSnapshot = JSON.parse(JSON.stringify(second));
  assert.equal(first.id, second.id);
  assert.notEqual(first.linkToken, second.linkToken);
  const undone = await refreshAsset(undoSnapshot);
  const redone = await refreshAsset(redoSnapshot);
  assert.equal(undone.name, 'first.png');
  assert.equal(redone.name, 'second.png');
  assert.equal(undone.linkToken, first.linkToken);
  assert.equal(redone.linkToken, second.linkToken);
  const copy = await replaceAsset(second, png('portable.png'));
  assert.equal(copy.sourceKind, 'copy');
  assert.equal(copy.linkToken, undefined);
  assert.equal(copy.linkPersistence, undefined);
  await assert.rejects(refreshAsset(copy), /Relink/);
  assert.equal((await refreshAsset(undoSnapshot)).name, 'first.png');
  assert.equal((await refreshAsset(redoSnapshot)).name, 'second.png');
  assert.deepEqual(reads, ['first.png', 'second.png', 'first.png', 'second.png']);
});

test('permission denial retains the embedded asset without reading the original', async () => {
  const file = png();
  let reads = 0;
  const handle = { kind: 'file', async getFile() { reads++; return file; }, async queryPermission() { return 'denied'; }, async requestPermission() { return 'denied'; } };
  const asset = (await importFiles([file], new Map([[file, handle]]))).assets[0];
  const copy = asset.dataUrl;
  await assert.rejects(refreshAsset(asset), /Read permission/);
  assert.equal(reads, 0);
  assert.equal(asset.dataUrl, copy);
});

test('picker fallback and cancellation keep existing state untouched', async () => {
  assert.equal(await pickImages(), null);
  assert.equal(await linkAsset({ id: 'asset' }), null);
  globalThis.showOpenFilePicker = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
  assert.deepEqual(await pickImages(), { assets: [], errors: [] });
  await assert.rejects(linkAsset({ id: 'asset' }), { name: 'AbortError' });
  delete globalThis.showOpenFilePicker;
});

const folderFile = (name, path) => Object.assign(png(name), { webkitRelativePath: path });
const textFile = (name = 'notes.txt') => Object.assign(new Blob(['notes'], { type: 'text/plain' }), { name });
const fileHandle = (file) => ({ kind: 'file', name: file.name, async getFile() { return file; }, async queryPermission() { return 'granted'; } });
const directoryHandle = (name, children) => ({ kind: 'directory', name, async *values() { yield* children; } });
const fileEntry = (file, error) => ({ name: file.name, isFile: true, file(resolve, reject) { error ? reject(error) : resolve(file); } });
function directoryEntry(name, batches) {
  let reads = 0;
  return {
    name, isDirectory: true,
    get reads() { return reads; },
    createReader() {
      return { readEntries(resolve, reject) {
        const batch = batches[reads++] || [];
        batch instanceof Error ? reject(batch) : resolve(batch);
      } };
    },
  };
}

test('directory inputs retain root/subfolder paths and skip unrelated files before reading them', async () => {
  const good = folderFile('plot.PNG', 'Results/Day 1/plot.PNG');
  const spoof = Object.assign(new Blob(['not an image'], { type: 'image/png' }), { name: 'spoof.png', webkitRelativePath: 'Results/spoof.png' });
  const ignored = { name: 'notes.txt', type: 'text/plain', size: MAX_FILE_BYTES + 1, arrayBuffer() { assert.fail('Non-images must be skipped'); } };
  const result = await importFolderFiles([good, ignored, spoof, folderFile('plot.png', 'Results/Day 2/plot.png')]);
  assert.deepEqual(result.assets.map((asset) => asset.relativePath), ['Results/Day 1/plot.PNG', 'Results/Day 2/plot.png']);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors[0].name, 'Results/spoof.png');
  assert.match(result.errors[0].message, /actual file contents/);
  assert.equal(result.assets[0].sourceKind, 'copy');
});

test('directory filtering accepts supported MIME and retains per-file size protection', async () => {
  const noExtension = folderFile('plot', 'Root/plot');
  const huge = { name: 'huge.jpg', webkitRelativePath: 'Root/huge.jpg', size: MAX_FILE_BYTES + 1, arrayBuffer() { assert.fail('Oversize images must not be read'); } };
  const result = await importFolderFiles([noExtension, huge]);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].relativePath, 'Root/plot');
  assert.equal(result.errors[0].name, 'Root/huge.jpg');
  assert.match(result.errors[0].message, /25 MB/);
});

test('native folder picker recursively links images using read-only access and isolates failures', async () => {
  const requests = [];
  const broken = { kind: 'file', name: 'missing.png', async getFile() { throw new DOMException('gone', 'NotFoundError'); } };
  const deniedFolder = { kind: 'directory', name: 'Private', async *values() { throw new Error('Cannot read this directory'); } };
  const root = directoryHandle('Results', [fileHandle(png('top.png')), directoryHandle('Sub', [broken, fileHandle(textFile()), fileHandle(png('nested.png'))]), deniedFolder]);
  globalThis.showDirectoryPicker = async (options) => { requests.push(options); return root; };
  try {
    const result = await pickFolder();
    assert.deepEqual(requests, [{ mode: 'read' }]);
    assert.deepEqual(result.assets.map((asset) => asset.relativePath), ['Results/top.png', 'Results/Sub/nested.png']);
    assert.ok(result.assets.every((asset) => asset.sourceKind === 'linked'));
    assert.deepEqual(result.errors.map((error) => error.name), ['Results/Sub/missing.png', 'Results/Private']);
    assert.equal(result.skipped, 1);
    assert.equal((await refreshAsset(result.assets[1])).relativePath, 'Results/Sub/nested.png');
  } finally { delete globalThis.showDirectoryPicker; }
});

test('folder picker absence, blocked environments, and cancellation have explicit fallback results', async () => {
  assert.equal(await pickFolder(), null);
  try {
    globalThis.showDirectoryPicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
    assert.deepEqual(await pickFolder(), { assets: [], errors: [] });
    globalThis.showDirectoryPicker = async () => { throw new DOMException('blocked', 'SecurityError'); };
    assert.equal(await pickFolder(), null);
    globalThis.showDirectoryPicker = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    assert.match((await pickFolder()).errors[0].message, /permission/);
  } finally { delete globalThis.showDirectoryPicker; }
});

test('directory drops recurse across all readEntries batches and keep valid siblings after read errors', async () => {
  const sub = directoryEntry('Sub', [
    [fileEntry(png('one.png')), fileEntry(png('bad.png'), new Error('Unreadable image'))],
    [fileEntry(png('two.png')), fileEntry(textFile())],
    [],
  ]);
  const blocked = directoryEntry('Blocked', [new Error('Unreadable folder')]);
  const root = directoryEntry('Results', [[sub, blocked], [fileEntry(png('top.png'))], []]);
  const result = await importDroppedFiles({ files: [], items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }] });
  assert.deepEqual(result.assets.map((asset) => asset.relativePath), ['Results/Sub/one.png', 'Results/Sub/two.png', 'Results/top.png']);
  assert.deepEqual(result.errors.map((error) => error.name), ['Results/Sub/bad.png', 'Results/Blocked']);
  assert.equal(result.skipped, 1);
  assert.equal(root.reads, 3);
  assert.equal(sub.reads, 3);
});

test('drop snapshots all entries, files, and handle promises synchronously before browser protection', async () => {
  let accessible = true;
  const calls = [];
  const files = [png('a.png'), png('b.png')];
  const check = (method, index, value) => {
    assert.equal(accessible, true, `${method} must be called during drop`);
    calls.push(`${method}:${index}`);
    return value;
  };
  const transfer = {
    get files() { assert.equal(accessible, true); return files; },
    items: files.map((file, index) => ({
      kind: 'file',
      getAsFile: () => check('file', index, file),
      webkitGetAsEntry: () => check('entry', index, fileEntry(file)),
      getAsFileSystemHandle: () => check('handle', index, index ? Promise.reject(new Error('No handle access')) : Promise.resolve(null)),
    })),
  };
  const pending = importDroppedFiles(transfer);
  accessible = false;
  assert.equal(calls.length, 6);
  const result = await pending;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.assets.map((asset) => asset.name), ['a.png', 'b.png']);
  assert.ok(result.assets.every((asset) => !asset.relativePath));
});

test('drop handles support nested directories and linked images, with plain FileList fallback', async () => {
  const root = directoryHandle('Native', [directoryHandle('Sub', [fileHandle(png())])]);
  const native = await importDroppedFiles({ items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(root) }] });
  assert.equal(native.assets[0].relativePath, 'Native/Sub/panel.png');
  assert.equal(native.assets[0].sourceKind, 'linked');
  const plain = await importDroppedFiles({ files: [png('loose.png'), textFile()] });
  assert.equal(plain.assets[0].name, 'loose.png');
  assert.equal(plain.assets[0].relativePath, undefined);
  const project = createProject();
  project.assets = plain.assets;
  const reopened = validateProject(JSON.parse(serializeProject(project))).assets[0];
  assert.equal(reopened.sourceOrigin, 'file');
  assert.equal(needsLocalSource(reopened), false);
  assert.equal(plain.errors[0].name, 'notes.txt');
});

test('legacy dropped entries retain session links and reread original bytes on Refresh', async () => {
  let current = png('original.png'), reads = 0, missing = false;
  const entry = { name: current.name, isFile: true, file(resolve, reject) {
    reads++;
    if (missing) reject(new DOMException('Missing', 'NotFoundError')); else resolve(current);
  } };
  const result = await importDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => entry }] });
  const original = result.assets[0];
  assert.deepEqual(result.errors, []);
  assert.equal(original.sourceKind, 'linked');
  assert.equal(original.linkPersistence, 'session');
  assert.equal(needsLocalSource(original), false);
  assert.match(await assetLinkStatus(original), /Local file linked \(this session only\)/);
  current = Object.assign(new Blob([pngBytes, new Uint8Array([1])], { type: 'image/png' }), { name: 'original.png', lastModified: 456 });
  const refreshed = await refreshAsset(JSON.parse(JSON.stringify(original)));
  assert.equal(reads, 2);
  assert.equal(refreshed.id, original.id);
  assert.equal(refreshed.linkToken, original.linkToken);
  assert.equal(refreshed.linkPersistence, 'session');
  assert.notEqual(refreshed.dataUrl, original.dataUrl);
  assert.equal(refreshed.lastModified, 456);
  missing = true;
  await assert.rejects(refreshAsset(refreshed), /moved or deleted/);
  assert.equal(refreshed.lastModified, 456, 'A failed read leaves the embedded source unchanged');
});

test('one decoded-image budget applies across every subfolder in a recursive import', async () => {
  const OriginalImage = globalThis.Image;
  globalThis.Image = class extends OriginalImage { naturalWidth = 4000; naturalHeight = 4000; };
  const root = directoryHandle('Root', Array.from({ length: 5 }, (_, index) => directoryHandle(`Sub${index}`, [fileHandle(png())])));
  try {
    const result = await importDroppedFiles({ items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(root) }] });
    assert.equal(result.assets.length, 4);
    assert.equal(result.errors[0].name, 'Root/Sub4/panel.png');
    assert.match(result.errors[0].message, /64 million pixels/);
  } finally { globalThis.Image = OriginalImage; }
});

test('replacing, refreshing, and relinking keep directory grouping while updating the filename', async () => {
  const original = folderFile('old.png', 'Root/Sub/old.png');
  const handle = fileHandle(png('new.png'));
  const asset = (await importFiles([original], new Map([[original, handle]]))).assets[0];
  assert.equal((await refreshAsset(asset)).relativePath, 'Root/Sub/new.png');
  assert.equal((await replaceAsset(asset, png('replacement.png'))).relativePath, 'Root/Sub/replacement.png');
  assert.equal((await replaceAsset(asset, folderFile('other.png', 'Elsewhere/other.png'))).relativePath, 'Elsewhere/other.png');
  globalThis.showOpenFilePicker = async () => [handle];
  try {
    const linked = await linkAsset(asset);
    assert.equal(linked.relativePath, 'Root/Sub/new.png');
    assert.equal(linked.id, asset.id);
  } finally { delete globalThis.showOpenFilePicker; }
});
