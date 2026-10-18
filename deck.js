/** Multi-slide projects. The asset registry is shared; each slide owns its canvas and items. */
import { createProject, uid, validateProject, validateProjectBatch, sourceManifest } from './core.js';

const MAX_SLIDES = 100;
const MAX_ITEMS = 10000;

function fail(message) { throw new Error(`Invalid figure deck: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}
function safeId(value, label) {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) fail(`${label} must be a safe ID of 1–100 characters.`);
  return value;
}
function safeName(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 300) fail(`${label} must be text of at most 300 characters.`);
  return value;
}

export function createDeck() {
  const p = createProject();
  const slide = { id: uid(), name: 'Slide 1', canvas: p.canvas, items: [] };
  return { format: 'figure-editor', version: 2, id: p.id, name: p.name, assets: [], slides: [slide], activeSlideId: slide.id };
}

/** Return a canonical copy. Existing single-figure v1 files migrate without altering assets. */
export function validateDeck(input) {
  const p = object(input, 'project');
  if (p.format !== 'figure-editor') fail('only figure-editor projects are supported.');
  if (p.version === 1) {
    const legacy = validateProject(p);
    const slide = { id: uid(), name: 'Slide 1', canvas: legacy.canvas, items: legacy.items };
    return { format: 'figure-editor', version: 2, id: legacy.id, name: legacy.name, assets: legacy.assets, slides: [slide], activeSlideId: slide.id };
  }
  if (p.version !== 2) fail('only figure-editor versions 1 and 2 are supported.');
  const deckId = safeId(p.id, 'project.id');
  const name = safeName(p.name, 'project.name', 'Untitled figure');
  if (!Array.isArray(p.slides) || !p.slides.length || p.slides.length > MAX_SLIDES) fail(`projects must contain 1–${MAX_SLIDES} slides.`);
  const slideIDs = new Set();
  let itemCount = 0;
  const views = p.slides.map((raw, index) => {
    const slide = object(raw, `slide ${index + 1}`);
    const slideId = safeId(slide.id, 'slide.id');
    if (slideIDs.has(slideId)) fail(`duplicate slide ID ${slideId}.`);
    slideIDs.add(slideId);
    if (!Array.isArray(slide.items)) fail('slide.items must be an array.');
    itemCount += slide.items.length;
    if (itemCount > MAX_ITEMS) fail(`projects may contain at most ${MAX_ITEMS.toLocaleString('en-US')} objects across all slides.`);
    return { format: 'figure-editor', version: 1, id: slideId, name: safeName(slide.name, 'slide.name', `Slide ${index + 1}`), canvas: slide.canvas, items: slide.items, assets: p.assets };
  });
  const activeSlideId = safeId(p.activeSlideId, 'activeSlideId');
  if (!slideIDs.has(activeSlideId)) fail('activeSlideId refers to a missing slide.');
  // Asset bytes are validated once; every slide still receives full geometry and reference checks.
  const validated = validateProjectBatch(views);
  const itemIDs = new Set();
  for (const slide of validated) for (const item of slide.items) {
    if (itemIDs.has(item.id)) fail(`duplicate object ID ${item.id} across slides.`);
    itemIDs.add(item.id);
  }
  return {
    format: 'figure-editor', version: 2, id: deckId, name, assets: validated[0].assets,
    slides: validated.map(slide => ({ id: slide.id, name: slide.name, canvas: slide.canvas, items: slide.items })), activeSlideId,
  };
}

/** Cheap independent undo snapshot of an already validated deck; binary data are immutable strings. */
export function cloneDeck(deck) {
  return { ...deck, assets: deck.assets.map(asset => ({ ...asset })), slides: deck.slides.map(slide => ({ ...slide, canvas: { ...slide.canvas }, items: slide.items.map(item => ({ ...item })) })) };
}

export function currentSlide(deck) {
  const slide = deck.slides.find(value => value.id === deck.activeSlideId);
  if (!slide) fail('activeSlideId refers to a missing slide.');
  return slide;
}

/** Lightweight live v1 view for the existing editor/exporter. Reassignments must be synced to the deck. */
export function slideProject(deck, slideId = deck.activeSlideId) {
  const slide = deck.slides.find(value => value.id === slideId);
  if (!slide) fail('requested slide does not exist.');
  return { format: 'figure-editor', version: 1, id: deck.id, name: deck.name, assets: deck.assets, canvas: slide.canvas, items: slide.items };
}

export function serializeDeck(deck) { return JSON.stringify(validateDeck(deck), null, 2); }

function ensureRoom(deck, extraItems = 0) {
  if (deck.slides.length >= MAX_SLIDES) throw new Error(`A project can contain at most ${MAX_SLIDES} slides.`);
  if (deck.slides.reduce((sum, slide) => sum + slide.items.length, extraItems) > MAX_ITEMS) throw new Error(`A project can contain at most ${MAX_ITEMS.toLocaleString('en-US')} objects across all slides.`);
}

/** Insert a blank slide after the active slide, retaining its canvas dimensions/background. */
export function addSlide(deck) {
  const active = currentSlide(deck);
  ensureRoom(deck);
  const slide = { id: uid(), name: `Slide ${deck.slides.length + 1}`, canvas: { ...active.canvas }, items: [] };
  deck.slides.splice(deck.slides.indexOf(active) + 1, 0, slide);
  deck.activeSlideId = slide.id;
  return slide;
}

/** Duplicate editable content, giving the slide and its objects new identities; assets remain shared. */
export function duplicateSlide(deck) {
  const active = currentSlide(deck);
  ensureRoom(deck, active.items.length);
  const slide = { id: uid(), name: `${active.name.slice(0, 295)} copy`, canvas: { ...active.canvas }, items: active.items.map(item => ({ ...item, id: uid() })) };
  deck.slides.splice(deck.slides.indexOf(active) + 1, 0, slide);
  deck.activeSlideId = slide.id;
  return slide;
}

/** Delete only the active slide. Original/shared assets are retained for the remaining project. */
export function deleteSlide(deck) {
  const active = currentSlide(deck);
  if (deck.slides.length <= 1) throw new Error('The last slide cannot be deleted.');
  const index = deck.slides.indexOf(active);
  deck.slides.splice(index, 1);
  const next = deck.slides[Math.min(index, deck.slides.length - 1)];
  deck.activeSlideId = next.id;
  return next;
}

export function deckSourceManifest(input) {
  const deck = validateDeck(input);
  const base = sourceManifest(slideProject(deck));
  const usage = new Map(deck.assets.map(asset => [asset.id, []]));
  for (const slide of deck.slides) for (const item of slide.items) if (item.type === 'image') {
    usage.get(item.assetId).push({ slideId: slide.id, slideName: slide.name, itemId: item.id, hidden: item.hidden });
  }
  return {
    format: 'figure-editor-source-manifest', version: 2, project: { id: deck.id, name: deck.name }, activeSlideId: deck.activeSlideId,
    slides: deck.slides.map(slide => ({
      id: slide.id, name: slide.name, itemCount: slide.items.length,
      canvas: { ...slide.canvas, unit: 'CSS px', pixelsPerInch: 96, widthMM: slide.canvas.width / 96 * 25.4, heightMM: slide.canvas.height / 96 * 25.4 },
    })),
    exportNotes: { ...base.exportNotes, slides: 'PNG and SVG exports contain only the selected slide. The editable project retains all slides and their shared original assets.' },
    sources: base.sources.map(source => ({ ...source, usedBy: usage.get(source.id) })),
  };
}
