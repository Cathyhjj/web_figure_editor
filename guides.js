import { uid } from './core.js';

/** Slide-local, non-printing layout guides, stored in CSS pixels. */
export const MAX_GUIDES = 100;
export const MAX_GUIDE_POSITION = 100000;

function fail(message) { throw new Error(`Invalid figure guides: ${message}`); }

/** Validate explicitly present guide arrays without adding fields to older projects. */
export function validateGuides(value) {
  if (!Array.isArray(value) || value.length > MAX_GUIDES) fail(`guides must be an array of at most ${MAX_GUIDES} guides.`);
  const ids = new Set();
  return value.map(guide => {
    if (!guide || typeof guide !== 'object' || Array.isArray(guide)) fail('each guide must be an object.');
    const { id, axis, position } = guide;
    if (typeof id !== 'string' || id.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail('guide.id must be a safe ID of 1–100 characters.');
    if (ids.has(id)) fail(`duplicate guide ID ${id}.`);
    ids.add(id);
    if (axis !== 'x' && axis !== 'y') fail('guide.axis must be x or y.');
    if (typeof position !== 'number' || !Number.isFinite(position) || Math.abs(position) > MAX_GUIDE_POSITION) fail(`guide.position must be a finite number between -${MAX_GUIDE_POSITION} and ${MAX_GUIDE_POSITION}.`);
    return { id, axis, position };
  });
}

/** Independent undo/clipboard records; optional fresh IDs distinguish copied guides. */
export function cloneGuides(guides, { newIds = false } = {}) {
  if (guides === undefined) return undefined;
  const used = new Set(guides.map(guide => guide.id));
  return guides.map(guide => {
    let id = guide.id;
    if (newIds) {
      do { id = uid(); } while (used.has(id));
      used.add(id);
    }
    return { id, axis: guide.axis, position: guide.position };
  });
}

/** Snap a proposed visual start/center/end to the nearest matching guide.
 * Tolerance is in canvas pixels; callers convert their screen-pixel threshold
 * by the current zoom. Ties keep guide order, then anchor order, for stability.
 */
export function snapAxis(anchors, guides, axis, tolerance) {
  if (!Array.isArray(anchors) || !Array.isArray(guides) || (axis !== 'x' && axis !== 'y') || !Number.isFinite(tolerance) || tolerance < 0) return null;
  let match = null;
  let distance = Infinity;
  for (const guide of guides) {
    if (guide.axis !== axis || !Number.isFinite(guide.position)) continue;
    for (const anchor of anchors) {
      if (!Number.isFinite(anchor)) continue;
      const delta = guide.position - anchor;
      const candidate = Math.abs(delta);
      if (candidate <= tolerance && candidate < distance) {
        match = { delta, guideId: guide.id, position: guide.position };
        distance = candidate;
      }
    }
  }
  return match;
}
