import { FULL_CROP, MIN_CROP, imageCrop, dragCrop } from './crop.js';

/** A modal source-image preview; changes are committed only by Apply. */
export function createCropEditor(onApply) {
  const dialog = document.createElement('dialog');
  dialog.id = 'crop-dialog';
  dialog.className = 'crop-dialog';
  dialog.setAttribute('aria-labelledby', 'crop-title');
  dialog.innerHTML = `<div class="dialog-header"><span class="eyebrow">IMAGE</span><h2 id="crop-title">Crop image</h2><p id="crop-help">Drag the edges or corners to resize. Drag inside to move the crop. The original image is kept.</p></div>
    <div class="crop-body"><svg id="crop-preview" xmlns="http://www.w3.org/2000/svg" aria-label="Image crop preview" aria-describedby="crop-help"></svg>
    <output id="crop-size" aria-live="polite"></output><p class="hint">Preview shows the original image before rotation. Tab to a handle and use arrow keys for 1 px adjustments; hold Shift for 10 px.</p></div>
    <div class="dialog-actions"><button id="crop-reset" class="button">Full image</button><span class="crop-action-spacer"></span><button id="crop-cancel" class="button">Cancel</button><button id="crop-apply" class="button primary">Apply crop</button></div>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector('#' + id), preview = $('crop-preview');
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, values) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(values)) el.setAttribute(k, v);
    preview.append(el); return el;
  };
  let state = null, drag = null, shades = [], handles = [], grid = [], frame;
  const attrs = (el, values) => { for (const [k, v] of Object.entries(values)) el.setAttribute(k, v); };
  function render() {
    if (!state) return;
    const { crop: c, asset: a } = state, x = c.x * a.width, y = c.y * a.height, w = c.width * a.width, h = c.height * a.height;
    const rects = [[0, 0, a.width, y], [0, y + h, a.width, Math.max(0, a.height - y - h)], [0, y, x, h], [x + w, y, Math.max(0, a.width - x - w), h]];
    shades.forEach((el, j) => { const [x, y, width, height] = rects[j]; attrs(el, { x, y, width, height }); });
    attrs(frame, { x, y, width: w, height: h });
    grid.forEach((el, j) => attrs(el, j < 2 ? { x1: x + w * (j + 1) / 3, x2: x + w * (j + 1) / 3, y1: y, y2: y + h }
      : { x1: x, x2: x + w, y1: y + h * (j - 1) / 3, y2: y + h * (j - 1) / 3 }));
    const size = 12 / (preview.getScreenCTM()?.a || 1);
    handles.forEach(el => {
      const key = el.dataset.cropHandle, hx = key.includes('w') ? x : key.includes('e') ? x + w : x + w / 2;
      const hy = key.includes('n') ? y : key.includes('s') ? y + h : y + h / 2;
      attrs(el, { x: hx - size / 2, y: hy - size / 2, width: size, height: size });
    });
    $('crop-size').textContent = `Selected area: ${Math.round(w)} × ${Math.round(h)} px · Original: ${a.width} × ${a.height} px`;
  }
  function point(event) {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(preview.getScreenCTM().inverse());
    return { x: p.x / state.asset.width, y: p.y / state.asset.height };
  }
  preview.onpointerdown = event => {
    const handle = event.target.dataset.cropHandle;
    if (!state || !handle || event.button !== 0) return;
    event.preventDefault(); event.target.focus();
    drag = { handle, pointerId: event.pointerId, start: point(event), crop: { ...state.crop } };
    preview.setPointerCapture(event.pointerId);
  };
  preview.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const p = point(event);
    state.crop = dragCrop(drag.crop, drag.handle, p.x - drag.start.x, p.y - drag.start.y, state.minWidth, state.minHeight);
    render();
  };
  preview.onpointerup = event => { if (drag?.pointerId === event.pointerId) { drag = null; preview.releasePointerCapture(event.pointerId); } };
  preview.onpointercancel = event => { if (drag?.pointerId === event.pointerId) { state.crop = drag.crop; drag = null; render(); } };
  preview.onlostpointercapture = () => { drag = null; };
  preview.onkeydown = event => {
    const handle = event.target.dataset.cropHandle;
    if (!state || !handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -step / state.asset.width : event.key === 'ArrowRight' ? step / state.asset.width : 0;
    const dy = event.key === 'ArrowUp' ? -step / state.asset.height : event.key === 'ArrowDown' ? step / state.asset.height : 0;
    state.crop = dragCrop(state.crop, handle, dx, dy, state.minWidth, state.minHeight); render();
  };
  $('crop-reset').onclick = () => { state.crop = { ...FULL_CROP }; render(); };
  $('crop-cancel').onclick = () => dialog.close();
  $('crop-apply').onclick = () => { if (state && onApply(state.id, state.crop)) dialog.close(); };
  dialog.onclose = () => { state = null; drag = null; preview.replaceChildren(); };
  new ResizeObserver(render).observe(preview);
  return {
    get open() { return dialog.open; },
    show(item, asset) {
      if (!asset || item.locked || dialog.open) return;
      const c = imageCrop(item);
      state = { id: item.id, asset, crop: { ...c }, minWidth: Math.min(c.width, Math.max(MIN_CROP, 1 / asset.width, .010001 * c.width / item.width)), minHeight: Math.min(c.height, Math.max(MIN_CROP, 1 / asset.height, .010001 * c.height / item.height)) };
      preview.replaceChildren(); preview.setAttribute('viewBox', `0 0 ${asset.width} ${asset.height}`);
      make('image', { href: asset.dataUrl, width: asset.width, height: asset.height, preserveAspectRatio: 'none', 'pointer-events': 'none' });
      shades = Array.from({ length: 4 }, () => make('rect', { fill: '#16111e', opacity: '.58', 'pointer-events': 'none' }));
      frame = make('rect', { fill: 'transparent', class: 'crop-frame', 'data-crop-handle': 'move', tabindex: '0', role: 'button', 'aria-label': 'Move crop area with arrow keys' });
      grid = Array.from({ length: 4 }, () => make('line', { class: 'crop-grid', 'pointer-events': 'none' }));
      handles = [['nw','top left'],['n','top'],['ne','top right'],['e','right'],['se','bottom right'],['s','bottom'],['sw','bottom left'],['w','left']].map(([key, label]) => make('rect', {
        class: 'crop-handle', 'data-crop-handle': key, tabindex: '0', role: 'button', 'aria-label': `Resize crop ${label} with arrow keys`, style: `cursor:${key}-resize`,
      }));
      dialog.showModal(); render(); frame.focus();
    },
  };
}
