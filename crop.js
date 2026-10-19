/** Non-destructive source coordinates. Object geometry describes the visible frame. */
export const FULL_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
export const MIN_CROP = 0.00001;

export function validateCrop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Image crop must be a rectangle.');
  const crop = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = value[key], min = key === 'width' || key === 'height' ? MIN_CROP : 0;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min - (min ? 1e-12 : 0) || n > 1) throw new Error('Image crop must stay within the original image and have a positive size.');
    crop[key] = Math.max(min, n);
  }
  if (crop.x + crop.width > 1 + 1e-10 || crop.y + crop.height > 1 + 1e-10) throw new Error('Image crop extends outside the original image.');
  crop.x = Math.min(crop.x, 1 - crop.width);
  crop.y = Math.min(crop.y, 1 - crop.height);
  return crop;
}

export function imageCrop(item) { return item.crop || FULL_CROP; }
export function isCropped(item) {
  const c = imageCrop(item);
  return c.x !== 0 || c.y !== 0 || c.width !== 1 || c.height !== 1;
}

/** Preserve the source image's scale and world position, including after rotation. */
export function cropImage(item, rectangle = FULL_CROP) {
  const crop = validateCrop(rectangle), previous = imageCrop(item);
  const fullWidth = item.width / previous.width, fullHeight = item.height / previous.height;
  const width = fullWidth * crop.width, height = fullHeight * crop.height;
  const dx = (crop.x - previous.x) * fullWidth + (width - item.width) / 2;
  const dy = (crop.y - previous.y) * fullHeight + (height - item.height) / 2;
  const angle = (item.rotation || 0) * Math.PI / 180;
  const result = { ...item, width, height,
    x: item.x + (item.width - width) / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: item.y + (item.height - height) / 2 + dx * Math.sin(angle) + dy * Math.cos(angle), crop };
  if (!isCropped(result)) delete result.crop;
  return result;
}

/** Move or resize a rectangle without flipping it or leaving the original image. */
export function dragCrop(start, handle, dx, dy, minWidth = MIN_CROP, minHeight = MIN_CROP) {
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
  let left = start.x, top = start.y, right = left + start.width, bottom = top + start.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, left + minWidth, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minHeight, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
