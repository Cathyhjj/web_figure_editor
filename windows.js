/** Local, independent panel windows. Existing controls are moved, never cloned. */
const STORAGE_KEY = 'figure-editor-window-layout-v1';
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const limit = (value, min, max) => Math.min(max, Math.max(min, value));
const dockMinimums = { slides: 136, assets: 170, properties: 220 };

/** Fit saved sidebar widths while keeping room for the figure workspace. */
export function fitDockWidths(widths, availableWidth, minimumCanvas = 280) {
  const entries = Object.entries(widths).filter(([key]) => Object.hasOwn(dockMinimums, key));
  const minimum = entries.reduce((sum, [key]) => sum + dockMinimums[key], 0);
  const budget = Math.max(minimum, finite(availableWidth, minimum) - minimumCanvas);
  const desired = entries.map(([key, value]) => [key, limit(finite(value, dockMinimums[key]), dockMinimums[key], 600)]);
  const extra = desired.reduce((sum, [key, value]) => sum + value - dockMinimums[key], 0);
  const scale = extra ? Math.min(1, Math.max(0, budget - minimum) / extra) : 1;
  return Object.fromEntries(desired.map(([key, value]) => [key, dockMinimums[key] + (value - dockMinimums[key]) * scale]));
}

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
  const properties = layout?.querySelector('.properties-panel');
  const propertyScroll = properties?.querySelector('.property-scroll');
  const precisionNote = properties?.querySelector('.precision-note');
  const viewToggle = document.getElementById('view-toggle');
  const viewMenu = document.getElementById('view-menu');
  const viewOptions = document.getElementById('view-panel-options');
  let dockWidths = {};
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
  help.textContent = 'Drag the header to float and move this panel. Drag panel edges to resize. With a header or resize handle focused, arrow keys adjust 10 pixels; Shift and arrow keys adjust 1 pixel. Press Escape to cancel a drag. Use Dock to return it to its original position.';
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
    for (const [key, panel] of panels) saved[key] = { visible: panel.visible, floating: panel.floating, rect: panel.rect, dockHeight: panel.dockHeight };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, panels: saved, dockWidths })); }
    catch { say('Panel layout could not be saved in this browser. The current layout is still usable.'); }
  }
  const inDock = key => !!panels.get(key)?.visible && !panels.get(key).floating;
  function dockColumns() {
    for (const key of ['slides', 'assets', 'layers']) layout?.classList.toggle(`window-${key}-empty`, !inDock(key));
    const settingsEmpty = !inDock('canvas') && !inDock('objects');
    layout?.classList.toggle('window-properties-empty', !inDock('layers') && settingsEmpty);
    layout?.classList.toggle('window-settings-empty', settingsEmpty);
    layout?.classList.toggle('window-single-setting', inDock('canvas') !== inDock('objects'));
    if (propertyScroll) propertyScroll.hidden = settingsEmpty;
    if (precisionNote) precisionNote.hidden = !inDock('objects');
    syncDockSizes();
  }
  function widthKey(panel) {
    return panel.key === 'slides' || panel.key === 'assets' ? panel.key : 'properties';
  }
  function dockWidth(panel) {
    // Properties sections sit inside the sidebar border; measure its grid track
    // so one-pixel keyboard adjustments do not get lost to that border.
    return parseFloat(getComputedStyle(layout).getPropertyValue(`--${widthKey(panel)}-dock-width`));
  }
  function heightRange(panel) {
    const min = panel.key === 'slides' ? 220 : 150;
    return { min, max: Math.max(min, panel.key === 'layers' && window.innerWidth > 1050 ? layout.clientHeight - (propertyScroll?.hidden ? 0 : 150) : window.innerHeight - 100) };
  }
  function syncDockSizes() {
    if (!layout) return;
    const desktop = window.innerWidth > 1050, columns = window.innerWidth > 760;
    // Read responsive defaults before applying saved preferences. Narrow windows do
    // not overwrite those preferences, so widening the browser restores them.
    for (const key of Object.keys(dockMinimums)) layout.style.removeProperty(`--${key}-dock-width`);
    const defaults = getComputedStyle(layout), widths = {};
    for (const key of Object.keys(dockMinimums)) {
      const visible = key === 'properties' ? desktop && !layout.classList.contains('window-properties-empty') : inDock(key);
      if (columns && visible) widths[key] = dockWidths[key] ?? parseFloat(defaults.getPropertyValue(`--${key}-dock-width`));
    }
    const fitted = fitDockWidths(widths, layout.clientWidth);
    for (const [key, value] of Object.entries(fitted)) layout.style.setProperty(`--${key}-dock-width`, `${value}px`);
    properties?.style.removeProperty('grid-template-rows');
    for (const panel of panels.values()) {
      const key = widthKey(panel), range = heightRange(panel);
      const height = panel.dockHeight === null ? null : limit(panel.dockHeight, range.min, range.max);
      const canHeight = !['slides', 'assets'].includes(panel.key) || !columns;
      const constrained = inDock(panel.key) && canHeight && height !== null;
      panel.element.classList.toggle('has-dock-height', constrained);
      if (constrained) panel.element.style.setProperty('--window-dock-height', `${height}px`);
      else panel.element.style.removeProperty('--window-dock-height');
      if (constrained && panel.key === 'layers' && desktop) properties.style.gridTemplateRows = propertyScroll?.hidden ? `${height}px` : `${height}px minmax(0,1fr)`;
      panel.widthResize.hidden = panel.floating || !columns || (key === 'properties' && !desktop);
      panel.heightResize.hidden = panel.floating || !canHeight;
      panel.widthResize.setAttribute('aria-valuenow', String(Math.round(fitted[key] || panel.element.getBoundingClientRect().width)));
      panel.widthResize.setAttribute('aria-valuemin', String(dockMinimums[key]));
      panel.widthResize.setAttribute('aria-valuemax', String(Math.floor(Math.min(600, (fitted[key] || 0) + Math.max(0, layout.clientWidth - Object.values(fitted).reduce((a, b) => a + b, 0) - 280)))));
      panel.heightResize.setAttribute('aria-valuenow', String(Math.round(height ?? panel.element.getBoundingClientRect().height)));
      panel.heightResize.setAttribute('aria-valuemin', String(range.min));
      panel.heightResize.setAttribute('aria-valuemax', String(Math.round(range.max)));
    }
  }
  function resizeDock(panel, axis, value) {
    if (axis === 'width') {
      const key = widthKey(panel), current = {};
      const css = getComputedStyle(layout);
      for (const name of Object.keys(dockMinimums)) {
        const width = parseFloat(css.getPropertyValue(`--${name}-dock-width`));
        if (width > 0 && (name !== 'properties' || window.innerWidth > 1050)) current[name] = width;
      }
      const others = Object.entries(current).reduce((sum, [name, width]) => sum + (name === key ? 0 : width), 0);
      dockWidths = { ...dockWidths, ...current, [key]: limit(value, dockMinimums[key], Math.max(dockMinimums[key], Math.min(600, layout.clientWidth - others - 280))) };
    } else {
      const range = heightRange(panel);
      panel.dockHeight = limit(value, range.min, range.max);
    }
    syncDockSizes();
    notifyLayout();
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
    panel.element.hidden = !panel.visible;
    if (panel.visibilityToggle) panel.visibilityToggle.checked = panel.visible;
    panel.element.classList.toggle('is-floating', panel.floating);
    panel.element.dataset.windowState = panel.floating ? 'floating' : 'docked';
    panel.toggle.textContent = panel.floating ? 'Dock' : 'Float';
    panel.toggle.setAttribute('aria-label', `${panel.floating ? 'Dock' : 'Float'} ${panel.title} panel`);
    panel.toggle.title = panel.floating ? 'Return to the original dock' : 'Float this panel';
    panel.toggle.setAttribute('aria-pressed', String(panel.floating));
    panel.resize.hidden = !panel.floating;
  }
  function syncTitle(panel) {
    panel.element.dataset.windowTitle = panel.title;
    if (panel.element.hasAttribute('aria-label')) panel.element.setAttribute('aria-label', panel.title);
    const heading = panel.header.querySelector('h2');
    if (heading) heading.textContent = panel.title;
    panel.header.setAttribute('aria-label', `${panel.title} panel header`);
    panel.resize.setAttribute('aria-label', `Resize ${panel.title} panel`);
    if (panel.visibilityLabel) panel.visibilityLabel.nodeValue = panel.title;
    for (const [axis, handle] of [['width', panel.widthResize], ['height', panel.heightResize]]) {
      const label = axis === 'width' && widthKey(panel) === 'properties' ? 'Resize properties sidebar width' : `Resize ${panel.title} panel ${axis}`;
      handle.setAttribute('aria-label', label);
      handle.title = `${label}. Drag or use arrow keys; Shift + arrows adjusts 1 px.`;
    }
    chrome(panel);
  }
  function setVisible(panel, visible) {
    if (panel.visible === visible) return;
    if (gesture?.panel === panel) finishGesture(true);
    if (!visible && panel.element.contains(document.activeElement)) viewToggle?.focus({ preventScroll: true });
    panel.visible = visible;
    chrome(panel);
    if (visible && panel.floating) { applyRect(panel, panel.rect); raise(panel); }
    dockColumns();
    persist();
    notifyLayout();
    say(`${panel.title} panel ${visible ? 'shown' : 'hidden'}.`);
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
      if (g.mode.startsWith('dock-')) {
        dockWidths = g.savedWidths;
        g.panel.dockHeight = g.savedHeight;
        syncDockSizes(); notifyLayout();
      } else if (g.wasFloating) applyRect(g.panel, g.before);
      else { dock(g.panel); g.panel.rect = g.savedRect; }
      g.handle.focus({ preventScroll: true });
    }
    if (g.moved) {
      persist();
      say(cancel ? `${g.panel.title} adjustment cancelled.` : `${g.panel.title} panel ${g.mode === 'move' ? 'moved' : 'resized'}.`);
    }
  }
  function beginGesture(event, panel, mode, handle) {
    if (event.button !== 0 || gesture || (mode === 'move' && event.target.closest('button,input,select,textarea,a'))) return;
    if (mode === 'resize' && !panel.floating) return;
    event.preventDefault();
    event.stopPropagation();
    const r = panel.element.getBoundingClientRect();
    gesture = { panel, mode, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, before: { x: r.left, y: r.top, width: mode === 'dock-width' ? dockWidth(panel) : r.width, height: r.height }, wasFloating: panel.floating, savedRect: panel.rect && { ...panel.rect }, savedWidths: { ...dockWidths }, savedHeight: panel.dockHeight, moved: false };
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
      if (!g.panel.floating && g.mode === 'move') {
        float(g.panel, { ...g.before, width: Math.max(220, g.before.width), height: Math.min(540, g.before.height) });
        // Reparenting the panel clears browser focus; keep keys on panel chrome.
        g.handle.focus({ preventScroll: true });
        g.handle.setPointerCapture?.(event.pointerId);
      }
      document.body.classList.add('panel-pointer-active');
      g.panel.element.classList.add(g.mode === 'move' ? 'is-moving' : 'is-resizing');
    }
    if (g.mode === 'dock-width') resizeDock(g.panel, 'width', g.before.width + (g.panel.key === 'slides' ? dx : -dx));
    else if (g.mode === 'dock-height') resizeDock(g.panel, 'height', g.before.height + dy);
    else if (g.mode === 'move') applyRect(g.panel, { ...g.panel.rect, x: g.before.x + dx, y: g.before.y + dy });
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
    const widthResize = document.createElement('button'), heightResize = document.createElement('button');
    const panel = { key, title, element, header, body, marker, toggle, resize, widthResize, heightResize, grip, visible: true, floating: false, rect: null, dockHeight: null };
    if (viewOptions) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.panel = key;
      panel.visibilityToggle = input;
      panel.visibilityLabel = document.createTextNode(title);
      label.append(input, panel.visibilityLabel);
      viewOptions.append(label);
      listen(input, 'change', () => setVisible(panel, input.checked));
    }
    for (const [axis, handle] of [['width', widthResize], ['height', heightResize]]) {
      handle.type = 'button';
      handle.className = `window-edge-resize window-resize-${axis}`;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', axis === 'width' ? 'vertical' : 'horizontal');
      const label = axis === 'width' && widthKey(panel) === 'properties' ? 'Resize properties sidebar width' : `Resize ${title} panel ${axis}`;
      handle.setAttribute('aria-label', label);
      handle.title = `${label}. Drag or use arrow keys; Shift + arrows adjusts 1 px.`;
      element.append(handle);
      listen(handle, 'pointerdown', event => beginGesture(event, panel, `dock-${axis}`, handle));
      listen(handle, 'keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
        event.stopPropagation();
        if (event.key === 'Escape' && gesture) { event.preventDefault(); finishGesture(true); return; }
        const keys = axis === 'width' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const direction = axis === 'width' && key !== 'slides' ? -1 : 1;
        const delta = (event.shiftKey ? 1 : 10) * (event.key === keys[0] ? -1 : 1) * direction;
        resizeDock(panel, axis, (axis === 'width' ? dockWidth(panel) : element.getBoundingClientRect().height) + delta);
        persist();
      });
    }
    panels.set(key, panel);
    chrome(panel);
    listen(toggle, 'click', event => {
      event.stopPropagation();
      if (panel.floating) dock(panel); else float(panel);
      toggle.focus({ preventScroll: true });
      persist();
      say(`${panel.title} panel ${panel.floating ? 'floating. Drag its header to move it.' : 'docked.'}`);
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
    dockWidths = {};
    for (const panel of panels.values()) { panel.visible = true; panel.dockHeight = null; dock(panel); panel.rect = null; chrome(panel); }
    dockColumns();
    persist();
    say('All panels shown in their default docks.');
    notifyLayout();
  }
  listen(document, 'pointermove', pointerMove, { capture: true, passive: false });
  listen(document, 'pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.stopPropagation(); finishGesture();
  }, true);
  listen(document, 'pointercancel', () => finishGesture(true), true);
  listen(window, 'blur', () => finishGesture(true));
  function positionViewMenu() {
    if (!viewMenu || !viewToggle) return;
    const bounds = viewToggle.getBoundingClientRect(), v = viewport();
    const width = Math.min(240, v.width - 16);
    viewMenu.style.width = `${width}px`;
    viewMenu.style.left = `${limit(bounds.right - width, v.left + 8, v.left + v.width - width - 8)}px`;
    viewMenu.style.top = `${bounds.bottom + 6}px`;
    viewMenu.style.maxHeight = `${Math.max(0, v.top + v.height - bounds.bottom - 14)}px`;
  }
  if (viewMenu) {
    listen(viewMenu, 'beforetoggle', event => { if (event.newState === 'open') positionViewMenu(); });
    // Keep menu navigation from triggering the figure's keyboard shortcuts.
    const menuKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
      event.stopPropagation();
    };
    listen(viewMenu, 'keydown', menuKey);
    if (viewToggle) listen(viewToggle, 'keydown', menuKey);
    listen(document, 'focusin', event => {
      if (viewMenu.matches(':popover-open') && !viewMenu.contains(event.target) && event.target !== viewToggle) viewMenu.hidePopover();
    });
  }
  const showAllButton = document.getElementById('show-all-panels');
  if (showAllButton) listen(showAllButton, 'click', () => {
    for (const panel of panels.values()) setVisible(panel, true);
    say('All panels shown.');
  });
  const viewportChanged = () => {
    finishGesture(true);
    for (const panel of panels.values()) if (panel.floating) applyRect(panel, panel.rect);
    syncDockSizes();
    if (viewMenu?.matches(':popover-open')) positionViewMenu();
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
      for (const key of Object.keys(dockMinimums)) {
        const width = saved.dockWidths?.[key];
        if (typeof width === 'number' && Number.isFinite(width)) dockWidths[key] = limit(width, dockMinimums[key], 600);
      }
      for (const [key, panel] of panels) {
        const entry = saved.panels[key];
        panel.visible = entry?.visible !== false;
        chrome(panel);
        if (typeof entry?.dockHeight === 'number' && Number.isFinite(entry.dockHeight)) panel.dockHeight = limit(entry.dockHeight, 150, 2000);
        if (entry?.rect && typeof entry.rect === 'object') panel.rect = clampWindowRect(entry.rect, viewport());
        if (entry?.floating === true) float(panel);
      }
    }
  } catch { /* Unavailable storage or old/corrupt state leaves the default docks intact. */ }
  dockColumns();
  activeController = {
    reset,
    /** Reveal a panel without resetting the user's other panel preferences. */
    show(key, { dock: docked = false, focus = false } = {}) {
      const panel = panels.get(key);
      if (destroyed || !panel) return false;
      if (gesture?.panel === panel) finishGesture(true);
      const wasVisible = panel.visible;
      panel.visible = true;
      if (docked) dock(panel);
      chrome(panel);
      if (panel.floating) { applyRect(panel, panel.rect); raise(panel); }
      dockColumns();
      persist();
      notifyLayout();
      if (focus) {
        panel.header.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        panel.header.focus({ preventScroll: true });
      }
      if (!wasVisible) say(`${panel.title} panel shown.`);
      return true;
    },
    hide(key) {
      const panel = panels.get(key);
      if (destroyed || !panel) return false;
      setVisible(panel, false);
      return true;
    },
    /** Keep visible and accessible panel names aligned with its current content. */
    setTitle(key, title) {
      const panel = panels.get(key);
      if (destroyed || !panel || typeof title !== 'string' || !title.trim()) return false;
      panel.title = title.trim();
      syncTitle(panel);
      return true;
    },
    destroy() {
      finishGesture(true);
      for (const panel of panels.values()) { panel.visible = true; chrome(panel); dock(panel); }
      for (const panel of panels.values()) {
        panel.body.replaceWith(...panel.body.childNodes);
        panel.toggle.remove(); panel.resize.remove(); panel.widthResize.remove(); panel.heightResize.remove(); panel.grip.remove(); panel.marker.remove();
        panel.element.classList.remove('panel-window', 'is-floating', 'has-dock-height');
        panel.element.style.removeProperty('--window-dock-height');
        delete panel.element.dataset.windowState;
        panel.header.classList.remove('window-header');
        for (const attr of ['tabindex', 'role', 'aria-label', 'aria-describedby', 'title']) panel.header.removeAttribute(attr);
      }
      destroyed = true;
      cancelAnimationFrame(frame);
      cleanup.forEach(remove => remove());
      announcer.remove(); help.remove();
      viewOptions?.replaceChildren();
      if (viewMenu?.matches(':popover-open')) viewMenu.hidePopover();
      if (propertyScroll) propertyScroll.hidden = false;
      if (precisionNote) precisionNote.hidden = false;
      layout?.classList.remove('windows-ready', 'window-slides-empty', 'window-assets-empty', 'window-layers-empty', 'window-properties-empty', 'window-settings-empty', 'window-single-setting');
      for (const key of Object.keys(dockMinimums)) layout?.style.removeProperty(`--${key}-dock-width`);
      properties?.style.removeProperty('grid-template-rows');
      activeController = null;
    },
  };
  return activeController;
}
