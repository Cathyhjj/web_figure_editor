/** Local, independent panel windows. Existing controls are moved, never cloned. */
const STORAGE_KEY = 'figure-editor-window-layout-v1';
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const limit = (value, min, max) => Math.min(max, Math.max(min, value));

/** Keep the entire panel reachable, including in a smaller or shifted visual viewport. */
export function clampWindowRect(rect = {}, viewport = {}, options = {}) {
  const left = finite(viewport.left, 0), top = finite(viewport.top, 0);
  const vw = Math.max(1, finite(viewport.width, 1)), vh = Math.max(1, finite(viewport.height, 1));
  const margin = limit(finite(options.margin, 8), 0, Math.min(vw, vh) / 4);
  const maxWidth = vw - margin * 2, maxHeight = vh - margin * 2;
  const minWidth = Math.min(maxWidth, Math.max(1, finite(options.minWidth, 180)));
  const minHeight = Math.min(maxHeight, Math.max(1, finite(options.minHeight, 150)));
  const width = limit(finite(rect.width, 280), minWidth, maxWidth);
  const height = limit(finite(rect.height, 360), minHeight, maxHeight);
  return {
    x: limit(finite(rect.x, left + margin), left + margin, left + vw - margin - width),
    y: limit(finite(rect.y, top + margin), top + margin, top + vh - margin - height),
    width, height,
  };
}

let activeController;

/** Call once after app controls are bound. onLayoutChange can refit the canvas. */
export function initWindows({ onLayoutChange } = {}) {
  if (activeController) return activeController;
  const panels = new Map(), cleanup = [];
  const layout = document.querySelector('.editor-layout');
  let topZ = 30, gesture = null, frame = 0, destroyed = false;
  const viewport = () => {
    const v = window.visualViewport;
    return { left: v?.offsetLeft || 0, top: v?.offsetTop || 0, width: v?.width || window.innerWidth, height: v?.height || window.innerHeight };
  };
  const announcer = document.createElement('div');
  announcer.className = 'window-sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  document.body.append(announcer);
  const help = document.createElement('p');
  help.id = 'window-keyboard-help';
  help.className = 'window-sr-only';
  help.textContent = 'Drag the header to float and move this panel. With the header focused, arrow keys move 10 pixels; Shift and arrow keys move 1 pixel. Press Escape to cancel a drag. Use Dock to return it to its original position.';
  document.body.append(help);
  const say = text => { announcer.textContent = text; };
  const listen = (target, event, fn, options) => {
    target.addEventListener(event, fn, options);
    cleanup.push(() => target.removeEventListener(event, fn, options));
  };
  function notifyLayout() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!destroyed) onLayoutChange?.(); });
  }
  function persist() {
    const saved = {};
    for (const [key, panel] of panels) saved[key] = { floating: panel.floating, rect: panel.rect };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, panels: saved })); }
    catch { say('Panel layout could not be saved in this browser. The current layout is still usable.'); }
  }
  function dockColumns() {
    layout?.classList.toggle('window-slides-floating', !!panels.get('slides')?.floating);
    layout?.classList.toggle('window-assets-floating', !!panels.get('assets')?.floating);
    layout?.classList.toggle('window-layers-floating', !!panels.get('layers')?.floating);
    layout?.classList.toggle('window-all-properties-floating', ['layers', 'canvas', 'objects'].every(key => panels.get(key)?.floating));
  }
  function raise(panel) {
    if (panel.floating) panel.element.style.zIndex = String(++topZ);
  }
  function applyRect(panel, rect) {
    panel.rect = clampWindowRect(rect, viewport());
    const { x, y, width, height } = panel.rect;
    Object.assign(panel.element.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  }
  function chrome(panel) {
    panel.element.classList.toggle('is-floating', panel.floating);
    panel.element.dataset.windowState = panel.floating ? 'floating' : 'docked';
    panel.toggle.textContent = panel.floating ? 'Dock' : 'Float';
    panel.toggle.setAttribute('aria-label', `${panel.floating ? 'Dock' : 'Float'} ${panel.title} panel`);
    panel.toggle.title = panel.floating ? 'Return to the original dock' : 'Float this panel';
    panel.toggle.setAttribute('aria-pressed', String(panel.floating));
    panel.resize.hidden = !panel.floating;
  }
  function float(panel, rect) {
    if (!panel.floating) {
      const current = panel.element.getBoundingClientRect();
      const widths = { slides: 220, assets: 260, layers: 280, canvas: 300, objects: 310 };
      const initial = rect || panel.rect || { x: current.left + 12, y: current.top + 12, width: widths[panel.key], height: Math.min(540, Math.max(260, current.height)) };
      panel.floating = true;
      document.body.append(panel.element);
      chrome(panel);
      applyRect(panel, initial);
      dockColumns();
      notifyLayout();
    } else if (rect) applyRect(panel, rect);
    raise(panel);
  }
  function dock(panel) {
    if (!panel.floating) return;
    panel.floating = false;
    panel.marker.after(panel.element);
    for (const key of ['left', 'top', 'width', 'height', 'zIndex']) panel.element.style[key] = '';
    chrome(panel);
    dockColumns();
    notifyLayout();
  }
  function finishGesture(cancel = false) {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.handle.hasPointerCapture?.(g.pointerId)) g.handle.releasePointerCapture(g.pointerId);
    document.body.classList.remove('panel-pointer-active');
    g.panel.element.classList.remove('is-moving', 'is-resizing');
    if (cancel && g.moved) {
      if (g.wasFloating) applyRect(g.panel, g.before);
      else { dock(g.panel); g.panel.rect = g.savedRect; }
      g.handle.focus({ preventScroll: true });
    }
    if (g.moved) {
      persist();
      say(cancel ? `${g.panel.title} movement cancelled.` : `${g.panel.title} panel ${g.mode === 'resize' ? 'resized' : 'moved'}.`);
    }
  }
  function beginGesture(event, panel, mode, handle) {
    if (event.button !== 0 || gesture || (mode === 'move' && event.target.closest('button,input,select,textarea,a'))) return;
    if (mode === 'resize' && !panel.floating) return;
    event.preventDefault();
    event.stopPropagation();
    const r = panel.element.getBoundingClientRect();
    gesture = { panel, mode, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, before: { x: r.left, y: r.top, width: r.width, height: r.height }, wasFloating: panel.floating, savedRect: panel.rect && { ...panel.rect }, moved: false };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture?.(event.pointerId);
    raise(panel);
  }
  function pointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const g = gesture, dx = event.clientX - g.startX, dy = event.clientY - g.startY;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    event.preventDefault();
    event.stopPropagation();
    if (!g.moved) {
      g.moved = true;
      if (!g.panel.floating) {
        float(g.panel, { ...g.before, width: Math.max(220, g.before.width), height: Math.min(540, g.before.height) });
        // Reparenting the panel clears browser focus; keep keys on panel chrome.
        g.handle.focus({ preventScroll: true });
        g.handle.setPointerCapture?.(event.pointerId);
      }
      document.body.classList.add('panel-pointer-active');
      g.panel.element.classList.add(g.mode === 'resize' ? 'is-resizing' : 'is-moving');
    }
    if (g.mode === 'move') applyRect(g.panel, { ...g.panel.rect, x: g.before.x + dx, y: g.before.y + dy });
    else {
      const v = viewport();
      applyRect(g.panel, { ...g.before, width: Math.min(g.before.width + dx, v.left + v.width - 8 - g.before.x), height: Math.min(g.before.height + dy, v.top + v.height - 8 - g.before.y) });
    }
  }
  function headerKey(event, panel) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
    // Panel chrome must never trigger the figure's delete/duplicate/nudge shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape' && gesture) { event.preventDefault(); finishGesture(true); return; }
    if (event.target !== panel.header || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    float(panel);
    const n = event.shiftKey ? 1 : 10, rect = { ...panel.rect };
    rect.x += event.key === 'ArrowRight' ? n : event.key === 'ArrowLeft' ? -n : 0;
    rect.y += event.key === 'ArrowDown' ? n : event.key === 'ArrowUp' ? -n : 0;
    applyRect(panel, rect);
    panel.header.focus({ preventScroll: true });
    persist();
  }

  for (const element of document.querySelectorAll('[data-window]')) {
    const key = element.dataset.window, title = element.dataset.windowTitle || key;
    const header = element.querySelector(':scope > [data-window-handle]');
    if (!header || panels.has(key)) continue;
    const marker = document.createComment(`Dock: ${key}`);
    element.before(marker);
    const body = document.createElement('div');
    body.className = 'window-body';
    for (const node of [...element.childNodes]) if (node !== header) body.append(node);
    element.append(body);
    element.classList.add('panel-window');
    header.classList.add('window-header');
    header.tabIndex = 0;
    header.setAttribute('role', 'group');
    header.setAttribute('aria-label', `${title} panel header`);
    header.setAttribute('aria-describedby', help.id);
    header.title = 'Drag to move. Arrow keys move 10 px; Shift + arrows move 1 px.';
    const grip = document.createElement('span');
    grip.className = 'window-grip';
    grip.setAttribute('aria-hidden', 'true');
    header.prepend(grip);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'window-toggle';
    header.append(toggle);
    const resize = document.createElement('button');
    resize.type = 'button';
    resize.className = 'window-resize';
    resize.title = 'Drag to resize. Arrow keys resize 10 px; Shift + arrows resize 1 px.';
    resize.setAttribute('aria-label', `Resize ${title} panel`);
    element.append(resize);
    const panel = { key, title, element, header, body, marker, toggle, resize, grip, floating: false, rect: null };
    panels.set(key, panel);
    chrome(panel);
    listen(toggle, 'click', event => {
      event.stopPropagation();
      if (panel.floating) dock(panel); else float(panel);
      toggle.focus({ preventScroll: true });
      persist();
      say(`${title} panel ${panel.floating ? 'floating. Drag its header to move it.' : 'docked.'}`);
    });
    listen(header, 'pointerdown', event => beginGesture(event, panel, 'move', header));
    listen(header, 'keydown', event => headerKey(event, panel));
    listen(resize, 'pointerdown', event => beginGesture(event, panel, 'resize', resize));
    listen(resize, 'keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
      event.stopPropagation();
      if (event.key === 'Escape' && gesture) { event.preventDefault(); finishGesture(true); return; }
      if (!panel.floating || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const n = event.shiftKey ? 1 : 10, rect = { ...panel.rect }, v = viewport();
      rect.width += event.key === 'ArrowRight' ? n : event.key === 'ArrowLeft' ? -n : 0;
      rect.height += event.key === 'ArrowDown' ? n : event.key === 'ArrowUp' ? -n : 0;
      rect.width = Math.min(rect.width, v.left + v.width - 8 - rect.x);
      rect.height = Math.min(rect.height, v.top + v.height - 8 - rect.y);
      applyRect(panel, rect); raise(panel); persist();
    });
    listen(element, 'pointerdown', () => raise(panel), { capture: true });
    listen(element, 'focusin', () => raise(panel));
  }

  function reset() {
    finishGesture(true);
    for (const panel of panels.values()) { dock(panel); panel.rect = null; }
    persist();
    say('All panels returned to their default docks.');
    notifyLayout();
  }
  listen(document, 'pointermove', pointerMove, { capture: true, passive: false });
  listen(document, 'pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.stopPropagation(); finishGesture();
  }, true);
  listen(document, 'pointercancel', () => finishGesture(true), true);
  listen(window, 'blur', () => finishGesture(true));
  const viewportChanged = () => {
    finishGesture(true);
    for (const panel of panels.values()) if (panel.floating) applyRect(panel, panel.rect);
    persist(); notifyLayout();
  };
  listen(window, 'resize', viewportChanged);
  if (window.visualViewport) { listen(window.visualViewport, 'resize', viewportChanged); listen(window.visualViewport, 'scroll', viewportChanged); }
  const resetButton = document.getElementById('reset-layout');
  if (resetButton) listen(resetButton, 'click', reset);
  layout?.classList.add('windows-ready');
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const saved = value && value.length < 50000 ? JSON.parse(value) : null;
    if (saved?.version === 1 && saved.panels && typeof saved.panels === 'object') {
      for (const [key, panel] of panels) {
        const entry = saved.panels[key];
        if (entry?.rect && typeof entry.rect === 'object') panel.rect = clampWindowRect(entry.rect, viewport());
        if (entry?.floating === true) float(panel);
      }
    }
  } catch { /* Unavailable storage or old/corrupt state leaves the default docks intact. */ }
  dockColumns();
  activeController = {
    reset,
    destroy() {
      finishGesture(true);
      for (const panel of panels.values()) {
        dock(panel);
        panel.body.replaceWith(...panel.body.childNodes);
        panel.toggle.remove(); panel.resize.remove(); panel.grip.remove(); panel.marker.remove();
        panel.element.classList.remove('panel-window', 'is-floating');
        delete panel.element.dataset.windowState;
        panel.header.classList.remove('window-header');
        for (const attr of ['tabindex', 'role', 'aria-label', 'aria-describedby', 'title']) panel.header.removeAttribute(attr);
      }
      destroyed = true;
      cancelAnimationFrame(frame);
      cleanup.forEach(remove => remove());
      announcer.remove(); help.remove();
      layout?.classList.remove('windows-ready', 'window-slides-floating', 'window-assets-floating', 'window-layers-floating', 'window-all-properties-floating');
      activeController = null;
    },
  };
  return activeController;
}
