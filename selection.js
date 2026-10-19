/** Normalize a marquee dragged in any direction into canvas coordinates. */
export function selectionRect(start, end) {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  };
}

/** Select only unlocked, visible items whose rotated bounds are fully enclosed. */
export function enclosedItemIds(items, rect) {
  if (rect.width <= 0 || rect.height <= 0) return [];
  const epsilon = 1e-7;
  const left = rect.x - epsilon, top = rect.y - epsilon;
  const right = rect.x + rect.width + epsilon, bottom = rect.y + rect.height + epsilon;
  return items.filter(item => {
    if (item.hidden || item.locked) return false;
    const halfWidth = item.width / 2, halfHeight = item.height / 2;
    const centerX = item.x + halfWidth, centerY = item.y + halfHeight;
    const angle = (item.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return [-1, 1].every(sx => [-1, 1].every(sy => {
      const x = centerX + sx * halfWidth * cos - sy * halfHeight * sin;
      const y = centerY + sx * halfWidth * sin + sy * halfHeight * cos;
      return x >= left && x <= right && y >= top && y <= bottom;
    }));
  }).map(item => item.id);
}
