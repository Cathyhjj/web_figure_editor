import test from 'node:test';
import assert from 'node:assert/strict';
import { importFiles, replaceAsset, refreshAsset, assetLinkStatus, pickImages, linkAsset, MAX_FILE_BYTES } from '../assets.js';

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
