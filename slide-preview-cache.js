import { assetVisualInputs, sameInputs } from './render-cache.js';

/**
 * Track thumbnail inputs without serializing every slide during selection.
 * Call prepare(assets, pages) once before rendering; invalidate(id) after a known
 * slide edit, or invalidate() after an edit whose affected slides are unknown.
 */
export function createSlidePreviewTracker() {
  const entries = new Map(), dependents = new Map();
  let assetInputs = new Map(), generation = 0;

  function unlink(entry) {
    for (const assetId of entry.dependencies) {
      const ids = dependents.get(assetId);
      ids?.delete(entry.id);
      if (!ids?.size) dependents.delete(assetId);
    }
  }

  function invalidate(slideId) {
    if (slideId === undefined) generation++;
    else {
      const entry = entries.get(slideId);
      if (entry) entry.dirty = true;
    }
  }

  function prepare(assets, pages) {
    // Prune removed pages so reopening projects does not retain their metadata.
    if (pages) {
      const ids = new Set(pages.map(page => page.id));
      for (const [id, entry] of entries) if (!ids.has(id)) {
        unlink(entry); entries.delete(id);
      }
    }
    const nextInputs = new Map(assets.map(asset => [asset.id, assetVisualInputs(asset)]));
    const changed = new Set();
    for (const [id, inputs] of nextInputs) if (!sameInputs(assetInputs.get(id), inputs)) changed.add(id);
    for (const id of assetInputs.keys()) if (!nextInputs.has(id)) changed.add(id);
    assetInputs = nextInputs;
    // One changed shared source can affect many pages, including offscreen ones.
    for (const assetId of changed) for (const slideId of dependents.get(assetId) || []) invalidate(slideId);
  }

  function get(page) {
    const cached = entries.get(page.id);
    if (cached?.page === page && cached.generation === generation && !cached.dirty) return cached.result;
    const dependencies = new Set(), sources = [];
    for (const item of page.items) if (!item.hidden && item.assetId) {
      // Remember missing sources too, so adding one later invalidates this page.
      dependencies.add(item.assetId);
      sources.push(...(assetInputs.get(item.assetId) || []));
    }
    const result = { key: JSON.stringify([page.canvas, page.items]), sources };
    if (cached) unlink(cached);
    for (const assetId of dependencies) {
      if (!dependents.has(assetId)) dependents.set(assetId, new Set());
      dependents.get(assetId).add(page.id);
    }
    entries.set(page.id, { id: page.id, page, dependencies, result, generation, dirty: false });
    return result;
  }

  function clear() {
    entries.clear(); dependents.clear(); assetInputs.clear(); generation = 0;
  }

  return { prepare, get, invalidate, clear };
}
