import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck, serializeDeck, createDeck } from '../deck.js';
import { pasteSlides } from '../clipboard.js';
import { projectToSVG } from '../core.js';
import { slideProject } from '../deck.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function figure(mime) {
  const deck = createDeck(), page = deck.slides[0];
  deck.assets = [{ id: 'figure-asset', name: 'Figure.png', mime: 'image/png', dataUrl: png, width: 1, height: 1,
    originalMime: mime, originalName: mime === 'application/zip' ? 'figures.zip' : 'page.html', originalDataUrl: `data:${mime};base64,` + Buffer.from('<script>throw Error("must remain inert")</script>').toString('base64') }];
  page.items = [{ id: 'figure-item', type: 'image', assetId: 'figure-asset', name: 'Figure', x: 0, y: 0, width: 100, height: 100 }];
  return validateDeck(deck);
}
for (const mime of ['text/html', 'application/zip']) test(`${mime} original survives save/reopen and slide copy; exports contain only capture`, () => {
  const saved = JSON.parse(serializeDeck(figure(mime))), target = createDeck();
  pasteSlides(target, saved);
  assert.equal(target.assets[0].originalDataUrl, saved.assets[0].originalDataUrl);
  assert.equal(target.assets[0].originalName, saved.assets[0].originalName);
  const svg = projectToSVG(slideProject(target));
  assert.ok(svg.includes(png)); assert.ok(!svg.includes(saved.assets[0].originalDataUrl)); assert.ok(!svg.includes('<script>'));
});
test('arbitrary executable attachment MIME types remain unsupported', () => {
  assert.throws(() => figure('application/javascript'), /unsupported MIME/);
});

test('native HTML documents survive save/reopen and slide copy independently of originals', () => {
  const deck = figure('text/html');
  deck.assets[0].htmlFigure = { version: 1, html: '<html><body><figure data-fe-root="figure" data-fe-node="n0">Edited</figure></body></html>', viewportWidth: 1440, dpi: 300, crop: { x: 65, y: 1000, width: 1310, height: 900 } };
  const saved = JSON.parse(serializeDeck(deck)), target = createDeck(); pasteSlides(target, saved);
  assert.deepEqual(target.assets[0].htmlFigure, saved.assets[0].htmlFigure);
  assert.equal(target.assets[0].originalDataUrl, deck.assets[0].originalDataUrl);
  assert.ok(!projectToSVG(slideProject(target)).includes('data-fe-root'));
  const altered = structuredClone(saved); altered.assets[0].htmlFigure.html = altered.assets[0].htmlFigure.html.replace('Edited', 'Different source');
  pasteSlides(target, altered);
  assert.equal(target.assets.length, 2, 'equal PNGs must not collapse different editable documents');
});

test('native HTML metadata bounds reject corrupt documents before preview', () => {
  const deck = figure('text/html'), good = { version: 1, html: '<html>Source</html>', viewportWidth: 1440, dpi: 300, crop: { x: 0, y: 0, width: 500, height: 500 } };
  for (const bad of [{ ...good, version: 2 }, { ...good, html: '' }, { ...good, viewportWidth: 0 }, { ...good, dpi: 96 }, { ...good, crop: { ...good.crop, x: NaN } }, { ...good, crop: { ...good.crop, height: 9000 } }]) {
    deck.assets[0].htmlFigure = bad; assert.throws(() => validateDeck(deck), /Invalid editable HTML/);
  }
});
