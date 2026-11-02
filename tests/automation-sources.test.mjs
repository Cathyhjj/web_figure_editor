import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProject } from '../automation.js';
import { addSlide, createAssetItem, createDeck, deckSourceManifest, validateDeck } from '../deck.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const image = id => ({ id, name: 'result.png', mime: 'image/png', width: 1, height: 1, dataUrl: png });

test('source identity distinguishes same-name assets and lists every use, including hidden objects on other slides', () => {
  const deck = createDeck();
  const original = { ...image('original'), sourceKind: 'linked', sourceOrigin: 'file', relativePath: 'raw/result.png',
    fingerprint: 'a'.repeat(64), linkToken: 'browser-only', linkPersistence: 'browser' };
  const revised = { ...image('revised'), sourceKind: 'copy', relativePath: 'revised/result.png', fingerprint: 'unknown' };
  deck.assets = [original, revised];
  const first = deck.slides[0], second = addSlide(deck);
  first.items = [createAssetItem(first, original)];
  second.items = [{ ...createAssetItem(second, original), hidden: true }];
  const project = validateDeck(deck);
  const manifest = deckSourceManifest(project);
  for (const asset of project.assets) {
    Object.defineProperty(asset, 'dataUrl', { get() { throw new Error('State read the embedded file'); } });
  }
  const state = describeProject(project, first.id);
  assert.deepEqual(state.assets, [
    { id: 'original', name: 'result.png', mime: 'image/png', width: 1, height: 1,
      sourceKind: 'linked', sourceOrigin: 'file', relativePath: 'raw/result.png', fingerprint: original.fingerprint,
      usedBy: [{ slideId: first.id, slideName: first.name, itemId: first.items[0].id, hidden: false },
        { slideId: second.id, slideName: second.name, itemId: second.items[0].id, hidden: true }] },
    { id: 'revised', name: 'result.png', mime: 'image/png', width: 1, height: 1,
      sourceKind: 'copy', relativePath: 'revised/result.png', usedBy: [] },
  ]);
  assert.deepEqual(state.assets.map(asset => asset.usedBy), manifest.sources.map(source => source.usedBy));
});

test('unsafe paths in imported projects are omitted from live state without altering saved metadata', () => {
  const deck = createDeck();
  const paths = ['/Users/user/figure.png', 'C:/users/plot.png', '\\\\host\\share\\plot.png', '~/plot.png',
    '../private/plot.png', 'plots/../private/plot.png', 'plots/%2e%2e/private.png',
    'file:///tmp/plot.png', 'https://example.org/plot.png', 'data:image/png;base64,abc', 'plots/\nsecret.png'];
  deck.assets = paths.map((relativePath, index) => ({ ...image('asset-' + index), relativePath }));
  const project = validateDeck(deck);
  assert.ok(describeProject(project).assets.every(asset => !('relativePath' in asset)));
  assert.deepEqual(deckSourceManifest(project).sources.map(source => source.relativePath), paths);
});
