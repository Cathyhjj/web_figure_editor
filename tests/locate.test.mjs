import test from 'node:test';
import assert from 'node:assert/strict';
import { locateAsset } from '../locate.js';

const capability = { app: 'figure-editor-local', version: 1, token: 'test-token', locate: true };
const json = (value, ok = true) => ({ ok, async json() { return value; } });

async function withLocal(fetch, run, location = { protocol: 'http:', hostname: '127.0.0.1' }) {
  const savedFetch = globalThis.fetch;
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.fetch = fetch;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  try { await run(); }
  finally {
    globalThis.fetch = savedFetch;
    if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
    else delete globalThis.location;
  }
}

test('Locate sends source identifiers only, retains local origin protections, and accepts Finder outcomes', async () => {
  for (const status of ['revealed', 'cancelled']) {
    const calls = [];
    const source = { id: 'asset-a', name: 'plot.png', relativePath: 'Study/plot.png', fingerprint: 'abc123', linkToken: 'link-a' };
    await withLocal(async (url, options) => {
      calls.push({ url, options });
      return json(url === '/api/local' ? capability : { status });
    }, async () => {
      assert.equal(await locateAsset({ ...source, dataUrl: 'data:image/png;base64,PRIVATE', width: 4, fileHandle: { private: true } }), status);
      assert.deepEqual(calls.map(call => call.url), ['/api/local', '/api/locate']);
      assert.deepEqual(JSON.parse(calls[1].options.body), { asset: source });
      assert.equal(calls[1].options.method, 'POST');
      assert.equal(calls[1].options.headers['X-Figure-Token'], capability.token);
      assert.ok(calls.every(({ options }) => options.mode === 'same-origin' && options.redirect === 'error' && options.cache === 'no-store' && options.signal instanceof AbortSignal));
    });
  }
});

test('Locate requires the local launcher and rejects invalid capabilities before any reveal request', async () => {
  for (const location of [{ protocol: 'https:', hostname: 'example.test' }, { protocol: 'file:', hostname: '' }]) {
    await withLocal(() => assert.fail('Remote or file pages must not request a local API.'), async () => {
      await assert.rejects(locateAsset({}), /start\.command/);
    }, location);
  }
  for (const response of [json({}, false), json(null), json({}), json({ ...capability, version: 2 }), json({ ...capability, token: '' }), { ok: true, async json() { throw new SyntaxError('Not JSON'); } }]) {
    let calls = 0;
    await withLocal(async () => { calls++; return response; }, async () => {
      await assert.rejects(locateAsset({}), /start\.command/);
      assert.equal(calls, 1);
    });
  }
  await withLocal(async () => { throw new TypeError('Offline'); }, async () => {
    await assert.rejects(locateAsset({}), /start\.command/);
  });
});

test('Locate reports unsupported platforms without requesting Finder', async () => {
  const calls = [];
  await withLocal(async url => { calls.push(url); return json({ ...capability, locate: false }); }, async () => {
    await assert.rejects(locateAsset({}), /available on macOS/);
    assert.deepEqual(calls, ['/api/local']);
  });
});

test('Locate surfaces backend, network, and malformed-response failures', async () => {
  const cases = [
    [() => json({ error: 'The selected source does not match.' }, false), /selected source does not match/],
    [() => json({}, false), /Could not show the source image/],
    [() => { throw new TypeError('Offline'); }, /Could not reach Finder/],
    [() => ({ ok: true, async json() { throw new SyntaxError('Not JSON'); } }), /start\.command/],
    [() => json({ status: 'unknown' }), /unexpected response/],
    [() => json(null), /unexpected response/],
  ];
  for (const [reply, expected] of cases) {
    await withLocal(async url => url === '/api/local' ? json(capability) : reply(), async () => {
      await assert.rejects(locateAsset({ id: 'asset-a', name: 'plot.png' }), expected);
    });
  }
});
