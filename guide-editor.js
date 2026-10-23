import { uid } from './core.js';
import { MAX_GUIDES, snapAxis } from './guides.js';
import { fromPixels, formatMeasurement, showMeasurement, readMeasurement } from './units.js';

// Drag previews never touch the project; only a successful pointerup adds an Undo step.
export function initGuideEditor({ context, getUnit, getZoom, point, svg, change, renderStage, status, prepare, isBusy }) {
  const $ = id => document.getElementById(id), stage = $('stage');
  let activeId = null, drag = null, visible = true, snapping = true;
  try {
    visible = localStorage.getItem('figure-editor-guides-visible') !== 'off';
    snapping = localStorage.getItem('figure-editor-guides-snap') !== 'off';
  } catch { /* Preferences are optional. */ }
  const guides = () => context().slide.guides || [];
  const current = () => guides().find(guide => guide.id === activeId);
  const sameContext = token => {
    const now = context();
    return now.project === token.project && now.slide === token.slide && now.revision === token.revision;
  };
  function preference(key, value) { try { localStorage.setItem('figure-editor-guides-' + key, value ? 'on' : 'off'); } catch {} }
  function release() {
    const previous = drag; drag = null;
    if (previous && stage.hasPointerCapture(previous.pointerId)) stage.releasePointerCapture(previous.pointerId);
    return previous;
  }
  function cancel() { if (!drag) return false; release(); renderStage(); renderControls(); return true; }
  function renderControls() {
    if (!current()) activeId = guides()[0]?.id || null;
    $('guides-visible').checked = visible; $('guides-snap').checked = snapping;
    const select = $('guide-select'); select.replaceChildren();
    for (const guide of guides()) {
      const option = document.createElement('option'); option.value = guide.id;
      option.textContent = `${guide.axis === 'x' ? 'Vertical' : 'Horizontal'} · ${formatMeasurement(guide.position, getUnit())} ${getUnit()}`;
      select.append(option);
    }
    select.value = activeId || ''; select.disabled = !guides().length;
    const input = $('guide-position'), guide = current(); input.disabled = !guide;
    input.min = fromPixels(-100000, getUnit()); input.max = fromPixels(100000, getUnit());
    if (guide) showMeasurement(input, guide.position, getUnit()); else input.value = '';
    $('guide-delete').disabled = !guide;
    for (const axis of ['x', 'y']) $('guide-add-' + axis).disabled = guides().length >= MAX_GUIDES;
  }
  function render() {
    if (drag && !sameContext(drag)) release();
    if (!visible) return;
    const { slide } = context();
    for (const guide of guides()) {
      const position = drag?.id === guide.id ? drag.position : guide.position;
      if (position < 0 || position > (guide.axis === 'x' ? slide.canvas.width : slide.canvas.height)) continue;
      const attrs = guide.axis === 'x'
        ? { x1: position, x2: position, y1: 0, y2: slide.canvas.height }
        : { x1: 0, x2: slide.canvas.width, y1: position, y2: position };
      const group = svg('g', { 'data-guide': guide.id });
      group.append(svg('line', { ...attrs, class: `layout-guide${activeId === guide.id ? ' is-active' : ''}` }));
      const hit = svg('line', { ...attrs, class: 'layout-guide-hit', style: `cursor:${guide.axis === 'x' ? 'ew' : 'ns'}-resize` });
      hit.append(svg('title', {}, `${guide.axis === 'x' ? 'Vertical' : 'Horizontal'} guide: ${formatMeasurement(position, getUnit())} ${getUnit()}`));
      group.append(hit); stage.append(group);
    }
  }
  for (const axis of ['x', 'y']) $('guide-add-' + axis).onclick = () => {
    cancel(); prepare();
    const slide = context().slide, guide = { id: uid(), axis, position: slide.canvas[axis === 'x' ? 'width' : 'height'] / 2 };
    if ((slide.guides?.length || 0) >= MAX_GUIDES) return;
    activeId = guide.id; visible = true; preference('visible', true);
    if (change(() => { (slide.guides ||= []).push(guide); })) status('Guide added. Drag it on the canvas or set its position here.');
  };
  $('guide-select').onchange = event => { activeId = event.target.value; renderControls(); renderStage(); };
  $('guide-position').onchange = () => {
    const guide = current(); if (!guide) return;
    try {
      const position = readMeasurement($('guide-position'), getUnit());
      if (position < -100000 || position > 100000) throw new Error('Guide position is outside the supported range.');
      if (position !== guide.position) change(() => { guide.position = position; });
    } catch (error) { status(error.message, true); }
    renderControls();
  };
  $('guide-position').onkeydown = event => { if (event.key === 'Enter') { $('guide-position').onchange(); event.preventDefault(); } };
  $('guide-delete').onclick = () => {
    cancel(); const guide = current(); if (!guide) return;
    change(() => { context().slide.guides = guides().filter(item => item.id !== guide.id); });
  };
  $('guides-visible').onchange = event => { cancel(); visible = event.target.checked; preference('visible', visible); renderStage(); };
  $('guides-snap').onchange = event => { snapping = event.target.checked; preference('snap', snapping); };
  stage.addEventListener('pointerdown', event => {
    const id = event.target.closest('[data-guide]')?.dataset.guide;
    if (!id || event.button !== 0 || event.ctrlKey || isBusy()) return;
    event.preventDefault(); event.stopImmediatePropagation(); prepare();
    const guide = guides().find(item => item.id === id); if (!guide) return;
    activeId = id; stage.setAttribute('tabindex', '-1'); stage.focus({ preventScroll: true });
    const start = point(event)[guide.axis];
    drag = { ...context(), id, axis: guide.axis, start, original: guide.position, position: guide.position, pointerId: event.pointerId };
    stage.setPointerCapture(event.pointerId); renderStage(); renderControls();
  }, true);
  stage.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!sameContext(drag)) { cancel(); return; }
    drag.position = Math.max(-100000, Math.min(100000, drag.original + point(event)[drag.axis] - drag.start));
    renderStage(); showMeasurement($('guide-position'), drag.position, getUnit());
  }, true);
  stage.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const token = release();
    if (sameContext(token) && token.position !== token.original) {
      const guide = guides().find(item => item.id === token.id);
      if (guide) change(() => { guide.position = token.position; });
    }
    renderStage(); renderControls();
  }, true);
  for (const event of ['pointercancel', 'lostpointercapture']) stage.addEventListener(event, e => {
    if (drag?.pointerId === e.pointerId) { e.stopImmediatePropagation(); cancel(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (drag) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') cancel();
    }
    else if (document.activeElement === stage && activeId && ['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation(); $('guide-delete').click();
    }
  }, true);
  window.addEventListener('blur', cancel);
  function snap(bounds, dx, dy, skip) {
    if (skip || !visible || !snapping) return { dx, dy };
    const slide = context().slide;
    const available = guides().filter(g => g.position >= 0 && g.position <= slide.canvas[g.axis === 'x' ? 'width' : 'height']);
    const x = snapAxis([bounds.x + dx, bounds.x + bounds.width / 2 + dx, bounds.x + bounds.width + dx], available, 'x', 6 / getZoom());
    const y = snapAxis([bounds.y + dy, bounds.y + bounds.height / 2 + dy, bounds.y + bounds.height + dy], available, 'y', 6 / getZoom());
    return { dx: dx + (x?.delta || 0), dy: dy + (y?.delta || 0) };
  }
  return { render, renderControls, snap, cancel, isDragging: () => !!drag };
}
