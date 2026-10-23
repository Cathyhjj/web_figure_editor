import { isMediaItem } from './video.js';
import { isLineShape } from './shapes.js';

const MAX = 100000;
const fail = message => { throw new Error(message); };
function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} must be between ${min} and ${max} px.`);
}
function geometry(item) {
  if (!item || typeof item !== 'object') fail('Choose valid objects to arrange.');
  finite(item.x, 'Object x', -MAX, MAX); finite(item.y, 'Object y', -MAX, MAX);
  const minimum = isLineShape(item) ? 0 : 0.01;
  finite(item.width, 'Object width', minimum, MAX); finite(item.height, 'Object height', minimum, MAX);
  const rotation = item.rotation ?? 0;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation) || Math.abs(rotation) > 36000)
    fail('Object rotation must be between -36000 and 36000 degrees.');
}

/** Axis-aligned bounds of the rotated object frame, excluding strokes/effects. */
export function itemBounds(item) {
  geometry(item);
  const angle = (item.rotation ?? 0) % 360 * Math.PI / 180;
  // Exact quarter turns should not introduce tiny gaps or model-limit errors.
  const clean = value => Math.abs(value) < 1e-12 ? 0 : value;
  const cos = Math.abs(clean(Math.cos(angle))), sin = Math.abs(clean(Math.sin(angle)));
  const width = item.width * cos + item.height * sin;
  const height = item.width * sin + item.height * cos;
  return { x: item.x + (item.width - width) / 2, y: item.y + (item.height - height) / 2, width, height };
}

export function selectionBounds(items) {
  if (!Array.isArray(items) || !items.length) fail('Select at least one object.');
  const boxes = items.map(itemBounds);
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

/** Arrange a selection atomically. Dimensions and gaps are canonical CSS px. */
export function applyLayout(slide, itemIds, operation) {
  if (!slide || !Array.isArray(slide.items)) fail('Choose a slide to arrange.');
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 2000 ||
      itemIds.some(id => typeof id !== 'string') || new Set(itemIds).size !== itemIds.length)
    fail('itemIds must contain unique object IDs.');
  const selected = itemIds.map(id => {
    const matches = slide.items.filter(item => item.id === id);
    if (matches.length !== 1) fail(`Object ${id} is missing or ambiguous on this slide.`);
    if (matches[0].locked) fail(`Object ${id} is locked. Unlock it before arranging.`);
    if (matches[0].hidden) fail(`Object ${id} is hidden. Show it before arranging.`);
    geometry(matches[0]);
    return matches[0];
  });
  const items = selected.map(item => ({ ...item }));
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('Choose a layout operation.');
  if (operation.op === 'align') {
    const { alignment } = operation;
    if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(alignment)) fail('Invalid alignment.');
    const horizontal = ['left', 'center', 'right'].includes(alignment);
    const axis = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    let bounds;
    if (items.length === 1) {
      finite(slide.canvas?.width, 'Canvas width', 1, 16000);
      finite(slide.canvas?.height, 'Canvas height', 1, 16000);
      bounds = { x: 0, y: 0, ...slide.canvas };
    } else bounds = selectionBounds(items);
    const fraction = ['left', 'top'].includes(alignment) ? 0 : ['right', 'bottom'].includes(alignment) ? 1 : 0.5;
    const target = bounds[axis] + fraction * bounds[size];
    for (const item of items) {
      const box = itemBounds(item);
      item[axis] += target - (box[axis] + fraction * box[size]);
    }
  } else if (operation.op === 'distribute') {
    const { axis, gap: explicitGap } = operation;
    if (!['x', 'y'].includes(axis)) fail('axis must be x or y.');
    if (items.length < 2 || (explicitGap === undefined && items.length < 3))
      fail('Distribute needs 3 objects, or 2 with an explicit gap.');
    if (explicitGap !== undefined) finite(explicitGap, 'gap', 0, MAX);
    const size = axis === 'x' ? 'width' : 'height';
    const ordered = items.map(item => ({ item, box: itemBounds(item) })).sort((a, b) => a.box[axis] - b.box[axis]);
    const start = ordered[0].box[axis], end = ordered.at(-1).box[axis] + ordered.at(-1).box[size];
    const gap = explicitGap ?? (end - start - ordered.reduce((total, { box }) => total + box[size], 0)) / (items.length - 1);
    let position = start;
    for (const [index, { item, box }] of ordered.entries()) {
      // Keep the original endpoints exactly, avoiding accumulated rounding drift.
      if (explicitGap !== undefined || (index > 0 && index < ordered.length - 1)) item[axis] += position - box[axis];
      position += box[size] + gap;
    }
  } else if (operation.op === 'match_size') {
    const { dimension } = operation;
    if (!['width', 'height'].includes(dimension)) fail('dimension must be width or height.');
    if (items.length < 2) fail('Select at least 2 objects to match their size.');
    const reference = items[0][dimension];
    for (const item of items.slice(1)) {
      if (isMediaItem(item)) {
        const other = dimension === 'width' ? 'height' : 'width';
        item[other] *= reference / item[dimension];
      }
      item[dimension] = reference;
    }
  } else fail('Unsupported layout operation.');
  // Never partially move the selection when a later object would be invalid.
  for (const item of items) geometry(item);
  items.forEach((item, index) => {
    for (const key of ['x', 'y', 'width', 'height']) selected[index][key] = item[key];
  });
  return selected;
}
