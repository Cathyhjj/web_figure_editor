import { isMediaItem } from './video.js';
import { isShapeItem, isLineShape } from './shapes.js';
/** Resize in the object's local axes while keeping the opposite edge/corner fixed. */
export function resizeItem(item, handle, dx, dy, { free = false } = {}) {
  const angle = (item.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos;
  const horizontal = handle === 'w' ? -1 : handle === 'e' || handle === 'se' ? 1 : 0;
  const vertical = handle === 'n' ? -1 : handle === 's' || handle === 'se' ? 1 : 0;
  const clamp = value => Math.max(isLineShape(item) ? 0 : 4, Math.min(20000, value));
  let width = horizontal ? clamp(item.width + horizontal * localX) : item.width;
  let height = vertical ? clamp(item.height + vertical * localY) : item.height;
  if (handle === 'se' && ((isMediaItem(item) && !free) || ((isShapeItem(item)||item.type==='shape') && !isLineShape(item) && free))) {
    const minScale = Math.max(4 / item.width, 4 / item.height);
    const maxScale = Math.min(20000 / item.width, 20000 / item.height);
    // Very narrow crops may not fit both limits; preserve the ratio and upper bound.
    const scale = Math.min(maxScale, Math.max(minScale, width / item.width));
    width = item.width * scale;
    height = item.height * scale;
  }
  const dw = width - item.width, dh = height - item.height;
  const centerX = horizontal * dw / 2, centerY = vertical * dh / 2;
  return {
    x: item.x + centerX * cos - centerY * sin - dw / 2,
    y: item.y + centerX * sin + centerY * cos - dh / 2,
    width, height,
  };
}
