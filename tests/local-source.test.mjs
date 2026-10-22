import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProject, serializeProject, validateProject } from '../core.js';
import { hasSavedLocalSource, needsLocalSource, saveClipboardAsset, savePastedSources } from '../local-source.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = hash(Buffer.from(pixel, 'base64'));
const asset = () => ({ id: 'pasted', name: 'image.png', sourceKind: 'copy', sourceOrigin: 'clipboard', mime: 'image/png', dataUrl: `data:image/png;base64,${pixel}`, fingerprint, width: 1, height: 1 });
const capability = { app: 'figure-editor-local', version: 1, token: 'test-token', saveClipboardImage: true };
const saved = { relativePath: `local-assets/pasted/${fingerprint}.png`, fingerprint };
const json = (value, ok = true) => ({ ok, async json() { return value; } });

async function withLocal(fetch, run, location = { protocol: 'http:', hostname: '127.0.0.1' }) {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.fetch = fetch;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  try { await run(); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }
}

test('pasted bytes save locally with authenticated same-origin requests and portable metadata', async () => {
  const original = asset(), before = structuredClone(original), calls = [];
  await withLocal(async (url, options) => { calls.push({ url, options }); return json(url === '/api/local' ? capability : saved); }, async () => {
    const result = await saveClipboardAsset(original);
    assert.deepEqual(result, { ...before, ...saved });
    assert.deepEqual(original, before, 'input remains unchanged until caller installs the result');
    assert.deepEqual(calls.map(call => call.url), ['/api/local', '/api/clipboard-image']);
    assert.deepEqual(JSON.parse(calls[1].options.body), { dataUrl: original.dataUrl });
    assert.equal(calls[1].options.headers['X-Figure-Token'], capability.token);
    assert.ok(calls.every(({ options }) => options.mode === 'same-origin' && options.redirect === 'error' && options.cache === 'no-store' && options.signal instanceof AbortSignal));
    assert.ok(hasSavedLocalSource(result));
    assert.ok(needsLocalSource(result), 'Locate can restore a missing managed file');
  });
});

test('SVG saves original vector bytes while retaining raster preview', async () => {
  const vector = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const source = { ...asset(), originalMime: 'image/svg+xml', originalDataUrl: `data:image/svg+xml;base64,${Buffer.from(vector).toString('base64')}`, fingerprint: hash(vector) };
  const vectorPath = `local-assets/pasted/${source.fingerprint}.svg`;
  await withLocal(async (url, options) => {
    if (url === '/api/local') return json(capability);
    assert.equal(JSON.parse(options.body).dataUrl, source.originalDataUrl);
    return json({ relativePath: vectorPath, fingerprint: source.fingerprint });
  }, async () => {
    const result = await saveClipboardAsset(source);
    assert.equal(result.relativePath, vectorPath);
    assert.equal(result.dataUrl, source.dataUrl);
    assert.equal(result.originalDataUrl, source.originalDataUrl);
  });
});

test('remote pages and unavailable or old backends never receive clipboard bytes', async () => {
  for (const location of [{ protocol: 'https:', hostname: 'example.test' }, { protocol: 'file:', hostname: '' }]) {
    await withLocal(() => assert.fail('No request from a remote page'), async () => {
      await assert.rejects(saveClipboardAsset(asset()), /start\.command/);
    }, location);
  }
  for (const reply of [json({}, false), json(null), json({ ...capability, saveClipboardImage: undefined }), json({ ...capability, token: '' })]) {
    await withLocal(async url => { assert.equal(url, '/api/local'); return reply; }, async () => {
      await assert.rejects(saveClipboardAsset(asset()), /start\.command/);
    });
  }
});

test('unverified paths, formats and fingerprints do not become local source metadata', async () => {
  for (const result of [null, {}, { ...saved, relativePath: '../image.png' }, { ...saved, relativePath: saved.relativePath.replace('.png', '.svg') }, { ...saved, fingerprint: '0'.repeat(64) }, { relativePath: `local-assets/pasted/${'0'.repeat(64)}.png`, fingerprint: '0'.repeat(64) }]) {
    await withLocal(async url => json(url === '/api/local' ? capability : result), async () => {
      await assert.rejects(saveClipboardAsset(asset()), /could not be verified/);
    });
  }
});

test('per-image write failures retain every portable asset, report warnings, and allow other saves', async () => {
  const one = asset(), two = { ...asset(), id: 'second', name: 'second.png' };
  let writes = 0;
  await withLocal(async url => {
    if (url === '/api/local') return json(capability);
    return ++writes === 1 ? json({ error: 'The disk is full.' }, false) : json(saved);
  }, async () => {
    const imported = { assets: [one, two], errors: [{ name: 'bad.png', message: 'Unreadable' }] };
    const result = await savePastedSources(imported);
    assert.deepEqual(result.assets[0], one);
    assert.deepEqual(result.assets[1], { ...two, ...saved });
    assert.equal(result.savedSources, 1);
    assert.match(result.warnings[0], /Local source file was not saved.*kept in the project.*disk is full/);
    assert.deepEqual(result.errors, imported.errors);
    assert.deepEqual(imported.assets, [one, two]);
  });
});

test('Locate materializes only known clipboard sources or verified managed copies', () => {
  assert.ok(needsLocalSource(asset()));
  assert.ok(needsLocalSource({ ...asset(), ...saved }));
  assert.equal(needsLocalSource({ ...asset(), relativePath: 'examples/original.png' }), false);
  assert.equal(needsLocalSource({ ...asset(), sourceKind: 'linked' }), false);
  assert.equal(needsLocalSource({ ...asset(), sourceOrigin: 'file' }), false, 'Dropped originals are never saved as pasted copies');
  assert.equal(needsLocalSource({ ...asset(), sourceOrigin: undefined }), false, 'Legacy copies have unknown provenance');
  assert.ok(needsLocalSource({ ...asset(), ...saved, sourceOrigin: undefined }), 'Existing managed files can still be restored');
  assert.equal(hasSavedLocalSource({ ...asset(), ...saved, fingerprint: 'wrong' }), false);
});

test('failed paste preserves clipboard provenance through project save/open for Locate retry', async () => {
  const input = { ...asset(), sourceOrigin: 'file' };
  await withLocal(async url => json(url === '/api/local' ? capability : { error: 'Disk full' }, url === '/api/local'), async () => {
    const result = await savePastedSources({ assets: [input], errors: [] });
    assert.equal(input.sourceOrigin, 'file');
    assert.equal(result.assets[0].sourceOrigin, 'clipboard');
    const project = createProject();
    project.assets = result.assets;
    const reopened = validateProject(JSON.parse(serializeProject(project))).assets[0];
    assert.ok(needsLocalSource(reopened));
    assert.equal(reopened.relativePath, undefined);
    assert.equal(reopened.dataUrl, input.dataUrl);
  });
});
