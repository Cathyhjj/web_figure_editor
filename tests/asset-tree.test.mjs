import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssetTree } from '../asset-tree.js';
import { createDeck, serializeDeck, validateDeck, deckSourceManifest } from '../deck.js';

test('folder tree preserves nesting and duplicate names without moving loose images', () => {
  const assets = [
    { id: 'loose', name: 'loose.png' },
    { id: 'b', name: 'panel.png', relativePath: 'Study/run 2/panel.png' },
    { id: 'a', name: 'panel.png', relativePath: 'Study/run 1/panel.png' },
    { id: 'root', name: 'overview.png', relativePath: 'Study/overview.png' },
    { id: 'ten', name: 'plot10.png', relativePath: 'Study/run 1/plot10.png' },
    { id: 'two', name: 'plot2.png', relativePath: 'Study/run 1/plot2.png' },
  ];
  const tree = buildAssetTree(assets);
  assert.equal(tree.count, 6);
  assert.deepEqual(tree.assets.map(a => a.id), ['loose']);
  const study = tree.folders[0];
  assert.equal(study.count, 5);
  assert.deepEqual(study.folders.map(f => f.path), ['Study/run 1', 'Study/run 2']);
  assert.deepEqual(study.assets.map(a => a.id), ['root']);
  assert.deepEqual(study.folders[0].assets.map(a => a.id), ['a', 'two', 'ten']);
  assert.equal(study.folders[1].assets[0].id, 'b');
  assert.equal(assets[0].id, 'loose');
});

test('directory names are data, including object property names and unicode', () => {
  const tree = buildAssetTree([{ name: '图.png', relativePath: '__proto__/constructor/实验/图.png' }]);
  assert.equal(tree.folders[0].folders[0].folders[0].path, '__proto__/constructor/实验');
  assert.equal(buildAssetTree([]).count, 0);
});

test('folder paths survive project serialization and source manifest export', () => {
  const deck = createDeck();
  deck.assets = [{ id: 'a', name: 'panel.png', mime: 'image/png', width: 1, height: 1,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=', relativePath: 'Study/nested/panel.png', sourceKind: 'copy' }];
  const reopened = validateDeck(JSON.parse(serializeDeck(deck)));
  assert.equal(reopened.assets[0].relativePath, 'Study/nested/panel.png');
  assert.equal(deckSourceManifest(reopened).sources[0].relativePath, 'Study/nested/panel.png');
  assert.equal(buildAssetTree(reopened.assets).folders[0].folders[0].name, 'nested');
});
