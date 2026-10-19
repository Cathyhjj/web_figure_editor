import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';
import { createDeck, cloneDeck, duplicateSlide, currentSlide, serializeDeck, validateDeck } from '../deck.js';
import { createSelection, encodeSelection, decodeSelection, pasteSelection } from '../clipboard.js';
import { selectionImageProject, selectionToPNG } from '../clipboard-image.js';
import { generateHTMLReport } from '../report.js';
import { DEFAULT_SHADOW, SHADOW_PRESETS, validateShadow, imageShadowSVG, shadowBounds } from '../shadow.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const asset = { id: 'asset', name: 'source.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PIXEL}`, width: 100, height: 50, sourceKind: 'copy' };
const picture = (extra = {}) => ({ id: 'picture', type: 'image', assetId: 'asset', x: 80, y: 60, width: 100, height: 50, ...extra });
const fixture = (extra = {}) => ({ ...createProject(), id: 'project', assets: [asset], items: [picture(extra)] });
const enabled = extra => ({ ...DEFAULT_SHADOW, enabled: true, ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);

test('optional picture shadow preserves legacy records and round-trips validated settings independently', () => {
  const legacy = validateProject(fixture());
  assert.equal(Object.hasOwn(legacy.items[0], 'shadow'), false);
  assert.equal(projectToSVG(legacy).includes('<filter'), false);
  const input = fixture({ shadow: enabled({ color: '#8844aa', transparency: 42, size: 115, blur: 8, angle: 123, distance: 9, unknown: 'discard' }) });
  const before = structuredClone(input);
  const restored = validateProject(JSON.parse(serializeProject(input)));
  assert.deepEqual(restored.items[0].shadow, enabled({ color: '#8844aa', transparency: 42, size: 115, blur: 8, angle: 123, distance: 9 }));
  restored.items[0].shadow.blur = 20;
  assert.deepEqual(input, before);
  assert.deepEqual(validateShadow({ enabled: true }), enabled());
  for (const preset of SHADOW_PRESETS) assert.deepEqual(validateShadow(preset.values), preset.values);
});

test('rejects malformed shadows, unsafe colors and out-of-range or non-finite fields', () => {
  for (const shadow of [null, [], 'shadow', { enabled: null }, { enabled: 1 }, { color: '#fff' }, { color: 'url(https://example.com/x)' }, { color: '#000000" onload="alert(1)' }]) {
    assert.throws(() => validateProject(fixture({ shadow })), /image\.shadow/);
  }
  for (const [key, maximum] of [['transparency', 100], ['size', 200], ['blur', 100], ['angle', 360], ['distance', 200]]) {
    for (const value of [-1, maximum + 1, NaN, Infinity, null, '5']) assert.throws(() => validateProject(fixture({ shadow: enabled({ [key]: value }) })), new RegExp(key));
    assert.doesNotThrow(() => validateProject(fixture({ shadow: enabled({ [key]: maximum }) })));
  }
  assert.throws(() => imageShadowSVG(picture({ shadow: enabled() }), asset, 'bad" onload="x'), /filter ID/);
});

test('shadow SVG colors only blurred source alpha, uses point units, and leaves the real picture above it', () => {
  const input = fixture({ opacity: .5, shadow: enabled({ color: '#123456', transparency: 25, size: 120, blur: 6, angle: 90, distance: 9 }) });
  const svg = projectToSVG(input);
  assert.match(svg, /<feGaussianBlur in="SourceAlpha" stdDeviation="4"/);
  assert.match(svg, /flood-color="#123456" flood-opacity="0.75"/);
  assert.match(svg, /<g filter="url\(#figure-shadow-project-picture-0\)" pointer-events="none"><image x="-10" y="7" width="120" height="60"/);
  assert.match(svg, /opacity="0.5"/);
  assert.equal((svg.match(/<image /g) || []).length, 2);
  assert.ok(svg.indexOf('</filter>') < svg.lastIndexOf('<image x="0"'));
  assert.equal(svg.includes('<feMerge'), false);
  assert.deepEqual(input.items[0].shadow, enabled({ color: '#123456', transparency: 25, size: 120, blur: 6, angle: 90, distance: 9 }));
});

test('cropped pictures cast their visible alpha and inactive shadows add no rendering or bounds', () => {
  const item = picture({ crop: { x: .2, y: .1, width: .4, height: .6 }, shadow: enabled() });
  assert.match(imageShadowSVG(item, asset, 'cropped-shadow'), /viewBox="0.2 0.1 0.4 0.6" preserveAspectRatio="none" overflow="hidden"><image width="1" height="1"/);
  for (const shadow of [undefined, { ...DEFAULT_SHADOW }, enabled({ transparency: 100 }), enabled({ size: 0 })]) {
    const plain = picture({ shadow });
    assert.equal(imageShadowSVG(plain, asset, 'unused'), '');
    assert.deepEqual(shadowBounds(plain), { x: 0, y: 0, width: 100, height: 50 });
  }
});

test('clipboard bounds include size, offset, blur and subsequent item rotation without changing sources', () => {
  const shadow = enabled({ blur: 6, angle: 0, distance: 30 });
  const input = fixture({ rotation: 90, shadow });
  assert.deepEqual(shadowBounds(input.items[0]), { x: 0, y: -17, width: 157, height: 84 });
  const before = structuredClone(input), result = selectionImageProject(input);
  near(result.canvas.width, 84); near(result.canvas.height, 157);
  assert.equal(result.canvas.background, 'transparent');
  assert.deepEqual(result.items[0].shadow, shadow);
  assert.equal(result.items[0].rotation, 90);
  assert.equal(result.assets[0].dataUrl, asset.dataUrl);
  assert.deepEqual(input, before);
  assert.deepEqual(shadowBounds(picture({ shadow: enabled({ size: 200, blur: 0 }) })), { x: -51, y: -26, width: 202, height: 102 });
});

test('copying an enabled shadow or crop cannot take the original-PNG shortcut', async () => {
  const plain = await selectionToPNG(fixture());
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), Buffer.from(PIXEL, 'base64'));
  await assert.rejects(selectionToPNG(fixture({ shadow: enabled() })), /requires a browser/);
  await assert.rejects(selectionToPNG(fixture({ crop: { x: 0, y: 0, width: .5, height: 1 } })), /requires a browser/);
  const disabled = await selectionToPNG(fixture({ shadow: { ...DEFAULT_SHADOW } }));
  assert.deepEqual(Buffer.from(await disabled.arrayBuffer()), Buffer.from(PIXEL, 'base64'));
});

test('undo snapshots, slide duplication, project reopening and editable clipboard preserve independent shadows', () => {
  const deck = createDeck();
  deck.assets = [asset];
  currentSlide(deck).items = [picture({ shadow: enabled({ blur: 9 }) })];
  const snapshot = cloneDeck(deck);
  snapshot.slides[0].items[0].shadow.blur = 30;
  assert.equal(deck.slides[0].items[0].shadow.blur, 9);
  const duplicate = duplicateSlide(deck);
  duplicate.items[0].shadow.blur = 18;
  assert.equal(deck.slides[0].items[0].shadow.blur, 9);
  assert.deepEqual(validateDeck(JSON.parse(serializeDeck(deck))), validateDeck(deck));
  const selection = createSelection(fixture({ shadow: enabled({ blur: 9 }) }), new Set(['picture']));
  const copied = decodeSelection(encodeSelection(selection));
  assert.deepEqual(copied.items[0].shadow, enabled({ blur: 9 }));
  const target = createDeck();
  pasteSelection(target, copied);
  currentSlide(target).items[0].shadow.blur = 25;
  assert.equal(copied.items[0].shadow.blur, 9);
});

test('report shadow filters are distinct across slides and avoid collisions with object IDs', () => {
  const deck = createDeck();
  deck.id = 'deck';
  deck.assets = [asset];
  currentSlide(deck).items = [picture({ shadow: enabled() })];
  duplicateSlide(deck);
  const report = generateHTMLReport(deck);
  const filterIDs = [...report.matchAll(/<filter id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(filterIDs.length, 2);
  assert.equal(new Set(filterIDs).size, 2);
  for (const id of filterIDs) assert.ok(report.includes(`filter="url(#${id})"`));
  const input = fixture({ shadow: enabled() });
  input.items.push({ id: 'figure-shadow-project-picture-0', type: 'rect', x: 0, y: 0, width: 10, height: 10 });
  const svg = projectToSVG(input);
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('report preflight includes the extra embedded raster used by visible shadows', () => {
  const deck = createDeck();
  const bytes = Buffer.alloc(1024 * 1024);
  Buffer.from(PIXEL, 'base64').copy(bytes);
  deck.assets = [{ ...asset, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }];
  currentSlide(deck).items = Array.from({ length: 100 }, (_, index) => picture({ id: `image-${index}`, shadow: enabled() }));
  assert.throws(() => generateHTMLReport(deck), /too large.*240 MB/);
});
