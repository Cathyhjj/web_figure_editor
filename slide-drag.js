/** Find the insertion boundary under a pointer in a row-major grid. */
function gridPosition(pages, x, y) {
  const rects = pages.map(card => card.getBoundingClientRect());
  let first = 0, end = rects.length;
  for (let i = 1; i < rects.length; i++) {
    if (Math.abs(rects[i].top - rects[first].top) < 1) continue;
    if (y < (rects[i - 1].bottom + rects[i].top) / 2) { end = i; break; }
    first = i;
  }
  let index = first;
  if (y > rects.at(-1).bottom) index = end;
  else if (y >= rects[0].top) {
    while (index < end && x >= (rects[index].left + rects[index].right) / 2) index++;
  }
  // A wrapped boundary can appear at the end of one row or the start of the
  // next. Keep the marker on the row the user is actually pointing at.
  const rect = rects[Math.min(index, end - 1)];
  const edge = index === first ? rect.left - 4 : index === end ? rect.right + 4 : (rects[index - 1].right + rect.left) / 2;
  return { index, gridMarker: { edge, top: rect.top, bottom: rect.bottom } };
}

/** Pointer-driven slide reordering in the sorter and scrollable/floating rails. */
export function initSlideDrag({ list, context, start, isCurrent, drop, cancel }) {
  let gesture = null, frame = 0, suppressClickUntil = 0;
  const cards = () => [...list.querySelectorAll('.slide-card')];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function position() {
    const layout = getComputedStyle(list);
    const grid = layout.display === 'grid', row = !grid && layout.flexDirection.startsWith('row');
    const bounds = list.getBoundingClientRect(), pages = cards();
    const { x, y } = gesture;
    const inside = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    if (grid && pages.length) return { bounds, row, pages, inside, ...gridPosition(pages, x, y) };
    const coordinate = row ? x : y;
    let index = pages.findIndex(card => {
      const rect = card.getBoundingClientRect();
      return coordinate < (row ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2);
    });
    if (index < 0) index = pages.length;
    return { bounds, row, pages, inside, index };
  }

  function paint() {
    if (!gesture?.active) return;
    const target = position(), { marker, preview } = gesture;
    const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight;
    preview.style.left = `${clamp(gesture.x + 16, 4, viewportWidth - preview.offsetWidth - 4)}px`;
    preview.style.top = `${clamp(gesture.y + 16, 4, viewportHeight - preview.offsetHeight - 4)}px`;
    marker.hidden = !target.inside;
    if (!target.inside || !target.pages.length) return;
    if (target.gridMarker) {
      const { edge, top, bottom } = target.gridMarker;
      const visibleTop = Math.max(top, target.bounds.top), visibleBottom = Math.min(bottom, target.bounds.bottom);
      marker.hidden = visibleTop >= visibleBottom;
      Object.assign(marker.style, { left: `${clamp(edge, target.bounds.left + 2, target.bounds.right - 2)}px`, top: `${visibleTop}px`, width: '3px', height: `${Math.max(0, visibleBottom - visibleTop)}px` });
      return;
    }
    const next = target.pages[target.index]?.getBoundingClientRect();
    const previous = target.pages[target.index - 1]?.getBoundingClientRect();
    const edge = next && previous
      ? (target.row ? (previous.right + next.left) / 2 : (previous.bottom + next.top) / 2)
      : next ? (target.row ? next.left - 4 : next.top - 4)
      : (target.row ? previous.right + 4 : previous.bottom + 4);
    if (target.row) {
      Object.assign(marker.style, { left: `${clamp(edge, target.bounds.left + 2, target.bounds.right - 2)}px`, top: `${target.bounds.top + 6}px`, width: '3px', height: `${Math.max(3, target.bounds.height - 12)}px` });
    } else {
      Object.assign(marker.style, { left: `${target.bounds.left + 6}px`, top: `${clamp(edge, target.bounds.top + 2, target.bounds.bottom - 2)}px`, width: `${Math.max(3, target.bounds.width - 12)}px`, height: '3px' });
    }
  }

  function finish(commit, reason = 'cancelled') {
    if (!gesture) return;
    const current = gesture;
    const target = current.active ? position() : null;
    const valid = current.active && isCurrent(current.token);
    gesture = null;
    cancelAnimationFrame(frame);
    if (!current.active) return;
    suppressClickUntil = performance.now() + 400;
    current.marker.remove();
    current.preview.remove();
    list.classList.remove('is-reordering');
    for (const card of cards()) card.classList.remove('is-dragging');
    if (list.hasPointerCapture?.(current.pointerId)) list.releasePointerCapture(current.pointerId);
    if (commit && valid && target.inside) drop(current.token, target.index);
    else cancel?.(valid ? reason : 'changed');
  }

  function tick(time) {
    if (!gesture?.active) return;
    if (!isCurrent(gesture.token)) { finish(false, 'changed'); return; }
    const target = position();
    const dt = Math.min(32, Math.max(1, time - (gesture.time || time - 16)));
    gesture.time = time;
    if (target.inside) {
      const coordinate = target.row ? gesture.x : gesture.y;
      const low = target.row ? target.bounds.left : target.bounds.top;
      const high = target.row ? target.bounds.right : target.bounds.bottom;
      const margin = Math.min(36, (high - low) / 3);
      const speed = coordinate < low + margin ? -(low + margin - coordinate) / margin
        : coordinate > high - margin ? (coordinate - high + margin) / margin : 0;
      if (target.row) list.scrollLeft += speed * dt * .65;
      else list.scrollTop += speed * dt * .65;
    }
    paint();
    frame = requestAnimationFrame(tick);
  }

  list.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || gesture) return;
    if (event.pointerType === 'touch' && getComputedStyle(list).display === 'grid') return;
    const card = event.target.closest('.slide-card');
    if (!card || !list.contains(card)) return;
    suppressClickUntil = 0;
    gesture = { id: card.dataset.slide, source: context(), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
  });
  document.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (!gesture.active) {
      if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 6) return;
      const token = start(gesture.id, gesture.source);
      if (!token) { gesture = null; return; }
      gesture.token = token;
      gesture.active = true;
      const preview = document.createElement('div'), marker = document.createElement('div');
      preview.className = 'slide-drag-preview';
      preview.textContent = `${token.ids.size} slide${token.ids.size === 1 ? '' : 's'}`;
      preview.setAttribute('aria-hidden', 'true');
      marker.className = 'slide-drop-marker';
      marker.setAttribute('aria-hidden', 'true');
      gesture.preview = preview;
      gesture.marker = marker;
      document.body.append(marker, preview);
      list.classList.add('is-reordering');
      for (const card of cards()) card.classList.toggle('is-dragging', token.ids.has(card.dataset.slide));
      try { list.setPointerCapture(event.pointerId); } catch { /* Synthetic checks have no active native pointer. */ }
      frame = requestAnimationFrame(tick);
    }
    event.preventDefault();
    paint();
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.active) event.preventDefault();
    finish(true, 'outside');
  });
  document.addEventListener('pointercancel', event => { if (gesture?.pointerId === event.pointerId) finish(false); });
  list.addEventListener('lostpointercapture', event => { if (gesture?.pointerId === event.pointerId) finish(false); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !gesture) return;
    event.preventDefault();
    finish(false);
  }, { capture: true });
  window.addEventListener('blur', () => finish(false));
  list.addEventListener('click', event => {
    if (event.detail !== 0 && performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  list.addEventListener('dragstart', event => event.preventDefault());
}
