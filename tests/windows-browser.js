const STORAGE_KEY = 'figure-editor-window-layout-v1';
const checks = [];
const results = document.querySelector('#results');
const run = document.querySelector('#run');
const host = document.querySelector('#editor-host');

function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}

const close = (actual, expected, tolerance = 2) => Math.abs(actual - expected) <= tolerance;
const rect = node => node.getBoundingClientRect();
const shown = node => !!node && !node.hidden && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
const settle = async win => {
  await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
  await new Promise(resolve => setTimeout(resolve, 40));
};

async function loadEditor(width = 1400) {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under panel layout integration test';
  iframe.style.width = `${width}px`;
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?window-checks=${Date.now()}`;
  host.replaceChildren(iframe);
  await loaded;
  // Wait for the existing app module, including its top-level draft restore.
  // Loading the same URL does not initialize the application a second time.
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    const appURL = [...doc.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) { reject(new Error('The editor app module was not found.')); return; }
    const script = doc.createElement('script');
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(() => window.dispatchEvent(new Event('window-editor-ready')), error => window.dispatchEvent(new CustomEvent('window-editor-failed', {detail:error.message})));`;
    const cleanup = () => {
      clearTimeout(timeout);
      win.removeEventListener('window-editor-ready', ready);
      win.removeEventListener('window-editor-failed', failed);
      script.remove();
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module initialization failed.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('window-editor-ready', ready, { once: true });
    win.addEventListener('window-editor-failed', failed, { once: true });
    doc.body.append(script);
  });
  await settle(iframe.contentWindow);
  return iframe;
}

function keyboard(win, element, key, options = {}) {
  if (!element) throw new Error(`Missing keyboard target for ${key}.`);
  element.focus({ preventScroll: true });
  element.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

// Synthetic pointer events cannot establish native pointer capture. Stub only
// capture transport on this handle; dispatch the actual editor event handlers.
function drag(win, handle, dx, dy, cancel = false) {
  if (!handle) throw new Error('Missing drag handle.');
  const previous = new Map(['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'].map(key => [key, Object.getOwnPropertyDescriptor(handle, key)]));
  let captured = false;
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: () => { captured = true; } },
    hasPointerCapture: { configurable: true, value: () => captured },
    releasePointerCapture: { configurable: true, value: () => { captured = false; } },
  });
  try {
    const start = rect(handle);
    const point = { clientX: start.x + start.width / 2, clientY: start.y + start.height / 2 };
    const event = (type, x, y) => new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
    handle.dispatchEvent(event('pointerdown', point.clientX, point.clientY));
    win.document.dispatchEvent(event('pointermove', point.clientX + dx, point.clientY + dy));
    if (cancel) keyboard(win, handle, 'Escape');
    win.document.dispatchEvent(event('pointerup', point.clientX + dx, point.clientY + dy));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(handle, key, descriptor);
      else delete handle[key];
    }
  }
}

run.onclick = async () => {
  results.replaceChildren();
  checks.length = 0;
  run.disabled = true;
  document.title = 'RUNNING — Figure Editor panel layout checks';
  window.windowChecks = { finished: false, checks };
  let savedLayout;
  let restoreLayout = false;
  try {
    if (location.port !== '18768' || !['127.0.0.1', 'localhost'].includes(location.hostname)) {
      throw new Error('Use the separate localhost test origin on port 18768.');
    }
    savedLayout = localStorage.getItem(STORAGE_KEY);
    restoreLayout = true;
    localStorage.removeItem(STORAGE_KEY);
    let iframe = await loadEditor();
    let win = iframe.contentWindow;
    let doc = iframe.contentDocument;
    const panel = key => doc.querySelector(`[data-window="${key}"]`);
    const widthHandle = key => panel(key).querySelector('.window-resize-width');
    const heightHandle = key => panel(key).querySelector('.window-resize-height');
    const reset = async () => { doc.getElementById('reset-layout').click(); await settle(win); };
    const initial = Object.fromEntries(['slides', 'assets', 'layers', 'canvas', 'objects'].map(key => [key, { width: rect(panel(key)).width, height: rect(panel(key)).height }]));
    const canvasInput = doc.getElementById('canvas-width');
    const originalCanvasValue = canvasInput.value;
    const inspector = doc.getElementById('inspector');
    check('All five panels begin docked', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => panel(key).dataset.windowState === 'docked'));
    check('Desktop resize separators are keyboard accessible', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => shown(widthHandle(key)) && widthHandle(key).getAttribute('role') === 'separator' && widthHandle(key).tabIndex >= 0));

    keyboard(win, widthHandle('assets'), 'ArrowLeft');
    await settle(win);
    check('Assets dock grows with the left boundary keyboard control', rect(panel('assets')).width > initial.assets.width + 5 && panel('assets').dataset.windowState === 'docked');
    const assetWidth = rect(panel('assets')).width;
    drag(win, widthHandle('assets'), -36, 0, true);
    await settle(win);
    check('Escape restores the dock width after a drag', close(rect(panel('assets')).width, assetWidth));
    drag(win, widthHandle('assets'), -24, 0);
    await settle(win);
    check('Dragging a dock boundary resizes without floating the panel', rect(panel('assets')).width > assetWidth + 15 && panel('assets').dataset.windowState === 'docked');

    keyboard(win, widthHandle('slides'), 'ArrowRight');
    await settle(win);
    check('Slides dock grows with its right boundary control', rect(panel('slides')).width > initial.slides.width + 5);
    const beforeFineWidth = rect(panel('slides')).width;
    keyboard(win, widthHandle('slides'), 'ArrowRight', { shiftKey: true });
    await settle(win);
    check('Shift and arrow keys adjust dock width by one pixel', close(rect(panel('slides')).width - beforeFineWidth, 1, .1));
    keyboard(win, widthHandle('canvas'), 'ArrowLeft');
    await settle(win);
    const sharedWidth = rect(panel('canvas')).width;
    check('A Properties width resize applies to Layers, Canvas, and Objects', sharedWidth > initial.canvas.width + 5 && close(rect(panel('layers')).width, sharedWidth) && close(rect(panel('objects')).width, sharedWidth));
    for (const key of ['canvas', 'objects']) {
      const before = Object.fromEntries(['layers', 'canvas', 'objects'].map(other => [other, rect(panel(other)).width]));
      keyboard(win, widthHandle(key), 'ArrowLeft', { shiftKey: true });
      await settle(win);
      check(`Shift resize from ${key} changes shared Properties width by one pixel`, ['layers', 'canvas', 'objects'].every(other => close(rect(panel(other)).width - before[other], 1, .1)));
    }
    const propertiesWidth = rect(panel('canvas')).width;

    for (const key of ['layers', 'canvas', 'objects']) {
      const before = rect(panel(key)).height;
      keyboard(win, heightHandle(key), 'ArrowDown');
      await settle(win);
      check(`${key} dock height can grow independently`, rect(panel(key)).height > before + 5 && panel(key).dataset.windowState === 'docked');
    }
    const canvasHeight = rect(panel('canvas')).height;
    drag(win, heightHandle('canvas'), 0, 35, true);
    await settle(win);
    check('Escape restores the panel height after a drag', close(rect(panel('canvas')).height, canvasHeight));

    panel('canvas').querySelector('.window-toggle').click();
    await settle(win);
    // Canvas settings floats near the right viewport edge. Move it inward so
    // increasing size exercises resizing rather than the correct edge clamp.
    const floatingHeader = panel('canvas').querySelector('[data-window-handle]');
    for (let index = 0; index < 4; index++) {
      keyboard(win, floatingHeader, 'ArrowLeft');
      keyboard(win, floatingHeader, 'ArrowUp');
    }
    await settle(win);
    const floatingBefore = rect(panel('canvas'));
    const corner = panel('canvas').querySelector('.window-resize');
    check('Float exposes the corner resize control', panel('canvas').dataset.windowState === 'floating' && shown(corner));
    keyboard(win, corner, 'ArrowRight');
    keyboard(win, corner, 'ArrowDown');
    await settle(win);
    check('Floating panel width and height remain resizable', rect(panel('canvas')).width > floatingBefore.width + 5 && rect(panel('canvas')).height > floatingBefore.height + 5);
    const beforeFineHeight = rect(panel('canvas')).height;
    keyboard(win, corner, 'ArrowDown', { shiftKey: true });
    await settle(win);
    check('Shift and arrow keys adjust floating size by one pixel', close(rect(panel('canvas')).height - beforeFineHeight, 1, .1));
    const beforeMove = rect(panel('canvas'));
    drag(win, panel('canvas').querySelector('[data-window-handle]'), -30, -25);
    await settle(win);
    check('Floating panel header remains draggable', !close(rect(panel('canvas')).x, beforeMove.x) || !close(rect(panel('canvas')).y, beforeMove.y));
    drag(win, floatingHeader, 5000, 5000);
    await settle(win);
    const boundary = rect(panel('canvas'));
    keyboard(win, corner, 'ArrowRight');
    keyboard(win, corner, 'ArrowDown');
    await settle(win);
    const clamped = rect(panel('canvas'));
    check('Floating move and resize keep the entire panel within the viewport', clamped.left >= 7 && clamped.top >= 7 && clamped.right <= win.innerWidth - 7 && clamped.bottom <= win.innerHeight - 7 && close(clamped.width, boundary.width) && close(clamped.height, boundary.height));
    panel('canvas').querySelector('.window-toggle').click();
    await settle(win);
    check('Dock restores custom width and height', panel('canvas').dataset.windowState === 'docked' && close(rect(panel('canvas')).width, propertiesWidth) && close(rect(panel('canvas')).height, canvasHeight));
    check('Float and Dock retain the original editable controls', doc.getElementById('canvas-width') === canvasInput && canvasInput.value === originalCanvasValue && doc.getElementById('inspector') === inspector);

    const expectedReload = { assets: rect(panel('assets')).width, slides: rect(panel('slides')).width, properties: rect(panel('canvas')).width, canvasHeight: rect(panel('canvas')).height };
    iframe = await loadEditor();
    win = iframe.contentWindow;
    doc = iframe.contentDocument;
    check('Dock dimensions survive reloading the editor', close(rect(panel('assets')).width, expectedReload.assets) && close(rect(panel('slides')).width, expectedReload.slides) && close(rect(panel('canvas')).width, expectedReload.properties) && close(rect(panel('canvas')).height, expectedReload.canvasHeight));

    await reset();
    check('Reset restores default dock sizes and clears floating state', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => panel(key).dataset.windowState === 'docked' && close(rect(panel(key)).width, initial[key].width) && close(rect(panel(key)).height, initial[key].height)));
    iframe.style.width = '900px';
    await settle(win);
    check('Tablet layout keeps Properties width handles inactive', ['layers', 'canvas', 'objects'].every(key => !shown(widthHandle(key)) || widthHandle(key).disabled));
    check('Tablet panels remain within the page width', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => rect(panel(key)).left >= -2 && rect(panel(key)).right <= win.innerWidth + 2));
    const tabletHeight = rect(panel('canvas')).height;
    keyboard(win, heightHandle('canvas'), 'ArrowDown');
    await settle(win);
    check('Tablet Canvas panel height remains resizable', rect(panel('canvas')).height > tabletHeight + 5);
    iframe.style.width = '600px';
    await settle(win);
    check('Stacked layout keeps all dock width handles inactive', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => !shown(widthHandle(key)) || widthHandle(key).disabled));
    for (const key of ['slides', 'assets']) {
      const before = rect(panel(key)).height;
      keyboard(win, heightHandle(key), 'ArrowDown');
      await settle(win);
      check(`Stacked ${key} height is resizable`, shown(heightHandle(key)) && rect(panel(key)).height > before + 5);
    }
    check('Stacked panels remain within the page width', ['slides', 'assets', 'layers', 'canvas', 'objects'].every(key => rect(panel(key)).left >= -2 && rect(panel(key)).right <= win.innerWidth + 2));
  } catch (error) {
    check(`Unexpected error: ${error.message}`, false);
    console.error(error);
  } finally {
    // Remove the editor before restoring its preference so later resize/unload
    // notifications cannot overwrite the pre-test layout.
    host.replaceChildren();
    if (restoreLayout) {
      if (savedLayout === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, savedLayout);
    }
    const passed = checks.length > 0 && checks.every(result => result.pass);
    window.windowChecks = { finished: true, passed, checks: [...checks] };
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor panel layout checks`;
    run.disabled = false;
  }
};
