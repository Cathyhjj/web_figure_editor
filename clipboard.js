import { isMediaItem } from './video.js';
/** Portable editable selections and whole slides for the browser clipboard. */
import { uid, validateProject } from './core.js';
import { cloneDeck, currentSlide, validateDeck } from './deck.js';

export const CLIPBOARD_MIME = 'application/x-figure-editor-selection';
export const SLIDE_CLIPBOARD_MIME = 'application/x-figure-editor-slide';
export const SLIDES_CLIPBOARD_MIME = 'application/x-figure-editor-slides';
const PREFIX = 'Figure Editor selection v1\n';
const SLIDE_PREFIX = 'Figure Editor slide v1\n';
const SLIDES_PREFIX = 'Figure Editor slides v1\n';
const MAX_TEXT_LENGTH = 240 * 1024 * 1024;

/** Capture independent records in layer order, retaining only used original assets. */
export function createSelection(view, selected) {
  const items = view.items.filter(item => selected.has(item.id));
  if (!items.length) return null;
  const assetIds = new Set(items.filter(item => isMediaItem(item)).map(item => item.assetId));
  return validateProject({ ...view, items, assets: view.assets.filter(asset => assetIds.has(asset.id)) });
}

export function encodeSelection(selection) {
  const text = PREFIX + JSON.stringify(validateProject(selection));
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied selection exceeds the 240 MB clipboard limit. Copy fewer objects.');
  return text;
}

/** Ordinary text is not an editor selection; recognized corrupt data must not fall back. */
export function decodeSelection(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied selection exceeds the 240 MB clipboard limit. Copy fewer objects.');
  let parsed;
  try { parsed = JSON.parse(text.slice(PREFIX.length)); }
  catch { throw new Error('The copied Figure Editor selection is damaged. Copy it again.'); }
  return validateProject(parsed);
}

/** Capture a whole slide, including hidden/locked objects, without unrelated assets. */
export function createSlideClipboard(deck, slideId = deck.activeSlideId) {
  const slide = deck.slides.find(value => value.id === slideId);
  if (!slide) throw new Error('The slide to copy does not exist.');
  const assetIds = new Set(slide.items.filter(item => isMediaItem(item)).map(item => item.assetId));
  return validateProject({
    format: 'figure-editor', version: 1, id: slide.id, name: slide.name,
    canvas: slide.canvas, items: slide.items, assets: deck.assets.filter(asset => assetIds.has(asset.id)),
  });
}

export function encodeSlide(slidePayload) {
  const text = SLIDE_PREFIX + JSON.stringify(validateProject(slidePayload));
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied slide exceeds the 240 MB clipboard limit. Reduce its embedded assets.');
  return text;
}

/** Slide and object clipboard formats remain distinct, including empty slides. */
export function decodeSlide(text) {
  if (typeof text !== 'string' || !text.startsWith(SLIDE_PREFIX)) return null;
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied slide exceeds the 240 MB clipboard limit. Reduce its embedded assets.');
  let parsed;
  try { parsed = JSON.parse(text.slice(SLIDE_PREFIX.length)); }
  catch { throw new Error('The copied Figure Editor slide is damaged. Copy it again.'); }
  return validateProject(parsed);
}

/** Capture selected slides in deck order, sharing only the originals they actually use. */
export function createSlidesClipboard(deck, selectedSlideIds = new Set([deck.activeSlideId])) {
  const ids = new Set(selectedSlideIds);
  if (!ids.size) throw new Error('Select at least one slide to copy.');
  const slides = deck.slides.filter(slide => ids.has(slide.id));
  if (slides.length !== ids.size) throw new Error('A slide selected for copying does not exist.');
  const assetIds = new Set(slides.flatMap(slide => slide.items.filter(item => isMediaItem(item)).map(item => item.assetId)));
  return validateDeck({
    ...deck, slides, assets: deck.assets.filter(asset => assetIds.has(asset.id)),
    activeSlideId: ids.has(deck.activeSlideId) ? deck.activeSlideId : slides.at(-1).id,
  });
}

/** Keep the established single-slide format when just one slide was copied. */
export function encodeSlides(slidesPayload) {
  const source = validateDeck(slidesPayload);
  if (source.slides.length === 1) return encodeSlide(createSlideClipboard(source));
  const text = SLIDES_PREFIX + JSON.stringify(source);
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied slides exceed the 240 MB clipboard limit. Copy fewer slides.');
  return text;
}

function singleSlideDeck(source) {
  return {
    format: 'figure-editor', version: 2, id: source.id, name: source.name, assets: source.assets,
    slides: [{ id: source.id, name: source.name, canvas: source.canvas, items: source.items }], activeSlideId: source.id,
  };
}

/** Read both batch and legacy single-slide clipboards as an independent v2 deck. */
export function decodeSlides(text) {
  if (typeof text !== 'string') return null;
  if (text.startsWith(SLIDE_PREFIX)) return singleSlideDeck(decodeSlide(text));
  if (!text.startsWith(SLIDES_PREFIX)) return null;
  if (text.length > MAX_TEXT_LENGTH) throw new Error('The copied slides exceed the 240 MB clipboard limit. Copy fewer slides.');
  let parsed;
  try { parsed = JSON.parse(text.slice(SLIDES_PREFIX.length)); }
  catch { throw new Error('The copied Figure Editor slides are damaged. Copy them again.'); }
  if (parsed?.version !== 2) throw new Error('Invalid figure slides clipboard data: expected a version 2 deck.');
  return validateDeck(parsed);
}

function sameImage(left, right) {
  return ['mime', 'dataUrl', 'width', 'height', 'originalMime', 'originalDataUrl', 'posterDataUrl', 'posterWidth', 'posterHeight', 'duration', 'hasSnapshot'].every(key => left[key] === right[key]);
}

function reusablePortableAsset(existing, source) {
  return existing.sourceKind === 'copy' && existing.linkToken === undefined && existing.linkPersistence === undefined
    && sameImage(existing, source)
    && ['name', 'relativePath', 'fingerprint', 'lastModified'].every(key => existing[key] === source[key]);
}

function freshId(used) {
  let id;
  do { id = uid(); } while (used.has(id));
  used.add(id);
  return id;
}

/** Reuse exact originals or compatible portable copies; never transfer local link authority. */
function importAssets(candidate, source) {
  const assetIds = new Set(candidate.assets.map(asset => asset.id));
  const usedAssets = new Set(source.items.filter(item => isMediaItem(item)).map(item => item.assetId));
  const assetMap = new Map();
  for (const asset of source.assets) {
    if (!usedAssets.has(asset.id)) continue;
    const sameId = candidate.assets.find(value => value.id === asset.id);
    const existing = sameId && sameImage(sameId, asset) ? sameId
      : candidate.assets.find(value => reusablePortableAsset(value, asset));
    if (existing) {
      assetMap.set(asset.id, existing.id);
      continue;
    }
    const copy = { ...asset, id: freshId(assetIds), sourceKind: 'copy' };
    delete copy.linkToken;
    delete copy.linkPersistence;
    candidate.assets.push(copy);
    assetMap.set(asset.id, copy.id);
  }
  return assetMap;
}

/** Paste atomically, preserving copied bytes even if a source asset changed after copying. */
export function pasteSelection(deck, selection, offset = 20) {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) throw new Error('Paste offset must be a finite number.');
  const source = validateProject(selection);
  if (!source.items.length) return [];
  const candidate = cloneDeck(deck);
  const target = currentSlide(candidate);
  const itemIds = new Set(candidate.slides.flatMap(slide => slide.items.map(item => item.id)));
  const assetMap = importAssets(candidate, source);
  const copies = source.items.map(item => ({
    ...item, id: freshId(itemIds), x: item.x + offset, y: item.y + offset,
    locked: false, hidden: false,
    ...(isMediaItem(item) ? { assetId: assetMap.get(item.assetId) } : {}),
  }));
  target.items.push(...copies);
  const validated = validateDeck(candidate);
  const items = currentSlide(validated).items;
  // Assign only after every asset, slide, and total-size constraint has passed.
  deck.assets = validated.assets;
  currentSlide(deck).items = items;
  return items.slice(-copies.length).map(item => item.id);
}

/** Insert an independent slide after the active one, committing only a fully valid deck. */
export function pasteSlide(deck, slidePayload) {
  return pasteSlides(deck, singleSlideDeck(validateProject(slidePayload)))[0];
}

/** Insert an ordered block atomically; repeated pastes append after its last slide. */
export function pasteSlides(deck, slidesPayload) {
  const source = validateDeck(slidesPayload);
  const candidate = cloneDeck(deck);
  const active = currentSlide(candidate);
  const insertionIndex = candidate.slides.indexOf(active) + 1;
  const sourceItems = source.slides.flatMap(slide => slide.items);
  const slideIds = new Set([...source.slides.map(slide => slide.id), ...candidate.slides.map(slide => slide.id)]);
  const itemIds = new Set([
    ...sourceItems.map(item => item.id),
    ...candidate.slides.flatMap(slide => slide.items.map(item => item.id)),
  ]);
  const assetMap = importAssets(candidate, { assets: source.assets, items: sourceItems });
  const slides = source.slides.map(slide => ({
    id: freshId(slideIds), name: slide.name, canvas: slide.canvas,
    items: slide.items.map(item => ({
      ...item, id: freshId(itemIds),
      ...(isMediaItem(item) ? { assetId: assetMap.get(item.assetId) } : {}),
    })),
  }));
  candidate.slides.splice(insertionIndex, 0, ...slides);
  candidate.activeSlideId = slides.at(-1).id;
  const validated = validateDeck(candidate);
  deck.assets = validated.assets;
  deck.slides = validated.slides;
  deck.activeSlideId = validated.activeSlideId;
  return deck.slides.slice(insertionIndex, insertionIndex + slides.length);
}
