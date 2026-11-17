import { editableHTMLFigure, renderEditedHTML, validateHTMLFigure } from './html-figure-model.js';

const make = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
export const isHTMLFigure = asset => !!asset?.htmlFigure || ['text/html', 'application/zip'].includes(asset?.originalMime);

/** Never mount imported markup in the editor's own origin. */
function cleanDocument(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,base,meta[http-equiv],iframe,object,embed,link,[data-fe-editor]').forEach(n => n.remove());
  for (const n of doc.querySelectorAll('*')) for (const a of [...n.attributes]) {
    if (/^on/i.test(a.name) || ['srcdoc', 'autofocus', 'contenteditable', 'nonce'].includes(a.name)) n.removeAttribute(a.name);
    if (n.localName === 'a' && ['href', 'xlink:href'].includes(a.name)) { if (/^\s*(?:javascript|data):/i.test(a.value)) n.removeAttribute(a.name); n.setAttribute('tabindex', '-1'); }
    else if (['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'poster'].includes(a.name) && !a.value.startsWith('#') && !/^data:image\//i.test(a.value)) n.removeAttribute(a.name);
  }
  const roots = doc.querySelectorAll('[data-fe-root="figure"]');
  if (roots.length !== 1) throw new Error('The editable Figure is missing from its document. Import the source again.');
  const ids = new Set();
  for (const n of [roots[0], ...roots[0].querySelectorAll('[data-fe-node]')]) {
    const id = n.getAttribute('data-fe-node');
    if (!/^n\d+$/.test(id) || ids.has(id)) throw new Error('The editable Figure has invalid element identifiers.'); ids.add(id);
  }
  if (ids.size > 4000) throw new Error('This Figure has too many editable elements.');
  return doc;
}

// Serialized into the isolated, script-free document. Only this hash-authorized
// bridge executes. Parent messages expose bounded operations, never HTML/CSS code.
function figureBridge(channel) {
  const root = document.querySelector('[data-fe-root="figure"]');
  const send = (kind, data = {}) => parent.postMessage({ channel, kind, ...data }, '*');
  const excluded = 'defs,clipPath,mask,pattern,marker,filter,linearGradient,radialGradient,style,script';
  const nodes = [root, ...root.querySelectorAll('[data-fe-node]')].filter(n => !n.closest(excluded));
  const byId = id => nodes.find(n => n.getAttribute('data-fe-node') === id);
  let selected = root, drag, moved = false, history = [], future = [];
  const overlay = document.createElement('div'); overlay.setAttribute('data-fe-editor', 'overlay');
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #8b4280;box-sizing:border-box;z-index:2147483647'; document.body.append(overlay);
  const slots = new Map(nodes.map(n => {
    // Empty Text nodes disappear in HTML serialization. Comment anchors retain
    // their identity across save/reopen without wrapping or restyling the text.
    let anchors = [...n.childNodes].filter(c => c.nodeType === 8 && c.data === 'figure-editor:text');
    if (!anchors.length) {
      anchors = [...n.childNodes].filter(c => c.nodeType === 3 && c.textContent.trim()).map(c => { const anchor = document.createComment('figure-editor:text'); n.insertBefore(anchor, c); return anchor; });
    }
    const texts = anchors.map(a => { if (a.nextSibling?.nodeType !== 3) n.insertBefore(document.createTextNode(''), a.nextSibling); return a.nextSibling; });
    n.removeAttribute('data-fe-text-slots'); return [n, texts];
  }));
  const segments = n => slots.get(n).map((node, index) => ({ index, text: node.textContent }));
  const label = n => (n.localName + (n.id ? ' #' + n.id : '') + ' · ' + (segments(n).map(s => s.text).join(' ').trim() || n.getAttribute('aria-label') || n.classList.value || '')).slice(0, 150);
  function info(n) {
    const style = getComputedStyle(n);
    return { id: n.getAttribute('data-fe-node'), label: label(n), tag: n.localName, svg: n.namespaceURI.includes('svg'), texts: segments(n), color: style.color, background: style.backgroundColor, fill: style.fill, stroke: style.stroke, fontSize: parseFloat(style.fontSize), x: Number(n.getAttribute('data-fe-x') || 0), y: Number(n.getAttribute('data-fe-y') || 0) };
  }
  function highlight() {
    const r = selected.getBoundingClientRect(); Object.assign(overlay.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const b = root.getBoundingClientRect(); send('bounds', { crop: { x: Math.max(0, Math.floor(b.x + scrollX)), y: Math.max(0, Math.floor(b.y + scrollY)), width: Math.ceil(b.width), height: Math.ceil(b.height) }, viewTop: Math.max(0, b.top), viewHeight: Math.max(1, Math.min(innerHeight, b.bottom) - Math.max(0, b.top)) });
  }
  function select(n) { selected = n; highlight(); send('selection', { element: info(n) }); }
  function snapshot() { return nodes.map(n => ({ id: n.getAttribute('data-fe-node'), attrs: [...n.attributes].filter(a => a.name === 'style' || a.name.startsWith('data-fe-')).map(a => [a.name, a.value]), texts: segments(n) })); }
  function checkpoint() { history.push(snapshot()); if (history.length > 30) history.shift(); future = []; }
  function restore(state) {
    for (const record of state) {
      const n = byId(record.id); if (!n) continue;
      for (const a of [...n.attributes]) if (a.name === 'style' || a.name.startsWith('data-fe-')) n.removeAttribute(a.name);
      for (const [k, v] of record.attrs) n.setAttribute(k, v);
      for (const s of record.texts) if (slots.get(n)[s.index]) slots.get(n)[s.index].textContent = s.text;
    }
    select(selected); send('changed');
  }
  function position(n, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000 || Math.abs(y) > 10000) throw new Error('Offsets must be between −10000 and 10000.');
    if (!n.hasAttribute('data-fe-base-translate')) n.setAttribute('data-fe-base-translate', getComputedStyle(n).translate || 'none');
    const base = n.getAttribute('data-fe-base-translate');
    // Independent translate composes with the existing CSS/SVG transform.
    const parts = []; let part = '', depth = 0;
    for (const char of (base === 'none' ? '0px 0px' : base)) {
      if (/\s/.test(char) && depth === 0) { if (part) parts.push(part); part = ''; }
      else { part += char; if (char === '(') depth++; if (char === ')') depth--; }
    }
    if (part) parts.push(part);
    n.style.setProperty('translate', `calc(${parts[0]} + ${x}px) calc(${parts[1] || '0px'} + ${y}px)${parts[2] ? ' ' + parts[2] : ''}`, 'important');
    n.setAttribute('data-fe-x', x); n.setAttribute('data-fe-y', y);
  }
  function patch(data) {
    const n = byId(data.id); if (!n) throw new Error('Select an element inside this Figure.');
    const key = data.key, value = data.value;
    if (key === 'text') {
      if (!Number.isInteger(data.index) || !slots.get(n)[data.index] || typeof value !== 'string' || value.length > 100000) throw new Error('Invalid text edit.');
      checkpoint(); slots.get(n)[data.index].textContent = value;
    } else if (['color', 'background-color', 'fill', 'stroke'].includes(key)) {
      if (typeof value !== 'string' || value.length > 80 || !/^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(value) || !(CSS.supports('color', value) || value === 'none' && ['fill', 'stroke'].includes(key))) throw new Error('Use a color name, hex, RGB or HSL color.');
      checkpoint(); n.style.setProperty(key, value, 'important');
    } else if (key === 'font-size') {
      if (!Number.isFinite(value) || value < 1 || value > 1000) throw new Error('Font size must be 1–1000.');
      checkpoint(); n.style.setProperty(key, value + 'px', 'important');
    } else if (key === 'position') { checkpoint(); position(n, value.x, value.y); }
    else throw new Error('Unsupported Figure edit.');
    selected = n; highlight(); send('changed');
  }
  document.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (moved) { moved = false; return; } const n = event.target.closest('[data-fe-node]'); if (nodes.includes(n)) select(n); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.preventDefault(); }, true);
  document.addEventListener('pointerdown', event => {
    const n = event.target.closest('[data-fe-node]'); if (!nodes.includes(n) || event.button !== 0) return;
    event.preventDefault(); selected = n; const data = info(n);
    drag = { n, x: event.clientX, y: event.clientY, dx: data.x, dy: data.y, checkpoint: false };
    n.setPointerCapture?.(event.pointerId);
  }, true);
  document.addEventListener('pointermove', event => {
    if (!drag) return;
    let x = event.clientX - drag.x, y = event.clientY - drag.y;
    if (!drag.checkpoint && Math.hypot(x, y) < 3) return;
    if (!drag.checkpoint) {
      checkpoint(); drag.checkpoint = true;
      // Measure the coordinate basis of independent translate. This handles
      // nested HTML/SVG scales and rotations without replacing any transform.
      const r = drag.n.getBoundingClientRect(); position(drag.n, drag.dx + 1, drag.dy); const a = drag.n.getBoundingClientRect();
      position(drag.n, drag.dx, drag.dy + 1); const b = drag.n.getBoundingClientRect(); position(drag.n, drag.dx, drag.dy);
      drag.matrix = { a: a.x - r.x, b: a.y - r.y, c: b.x - r.x, d: b.y - r.y };
    }
    const m = drag.matrix, determinant = m.a * m.d - m.b * m.c;
    if (Math.abs(determinant) < .000001) return;
    [x, y] = [(m.d * x - m.c * y) / determinant, (-m.b * x + m.a * y) / determinant];
    position(drag.n, drag.dx + x, drag.dy + y); highlight(); moved = true;
  }, true);
  document.addEventListener('pointerup', () => { if (drag) { const changed = drag.checkpoint; drag = null; select(selected); if (changed) send('changed'); } }, true);
  document.addEventListener('pointercancel', () => { drag = null; });
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const data = event.data;
    try {
      if (data.kind === 'select') { const n = byId(data.id); if (n) select(n); }
      else if (data.kind === 'patch') patch(data);
      else if (data.kind === 'undo' && history.length) { future.push(snapshot()); restore(history.pop()); }
      else if (data.kind === 'redo' && future.length) { history.push(snapshot()); restore(future.pop()); }
      else if (data.kind === 'serialize') {
        const clone = document.documentElement.cloneNode(true); clone.querySelectorAll('[data-fe-editor]').forEach(n => n.remove());
        send('document', { request: data.request, html: '<!doctype html>\n' + clone.outerHTML });
      }
    } catch (error) { send('error', { message: error.message }); }
  });
  addEventListener('load', async () => {
    await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
    scrollTo(0, root.getBoundingClientRect().top + scrollY);
    send('ready', { elements: nodes.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(n => ({ id: n.getAttribute('data-fe-node'), label: label(n), depth: (() => { let depth = 0, p = n; while (p !== root && p.parentElement) { depth++; p = p.parentElement; } return depth; })() })) }); select(root);
  });
  addEventListener('scroll', () => {
    const r = root.getBoundingClientRect(), top = r.top + scrollY;
    const minimum = Math.min(top, Math.max(0, document.documentElement.scrollHeight - innerHeight));
    const maximum = Math.max(minimum, top + r.height - innerHeight);
    if (scrollY < minimum || scrollY > maximum) scrollTo(0, Math.max(minimum, Math.min(maximum, scrollY)));
    highlight();
  });
}

export function openHTMLFigureEditor(asset, onApply) {
  const dialog = make('dialog', 'html-figure-editor'); dialog.id = 'html-figure-editor';
  const heading = make('div', 'dialog-header'); heading.append(make('h2', '', 'Edit HTML Figure'), make('p', 'hint', 'Choose an element in the preview or list. Edit text and colors, or drag to offset its position. Scroll the preview for tall Figures. Changes stay in this draft until Apply.'));
  const body = make('div', 'html-figure-editor-body'), list = make('select', 'html-figure-elements'); list.id = 'html-figure-elements'; list.size = 18; list.setAttribute('aria-label', 'HTML element');
  const pane = make('div', 'html-figure-preview-pane'), viewport = make('div', 'html-figure-preview-clip'); pane.append(viewport);
  const properties = make('div', 'html-figure-properties'); body.append(list, pane, properties);
  const status = make('p', 'hint', 'Preparing the native HTML document…'); status.id = 'html-figure-status'; status.setAttribute('role', 'status');
  const actions = make('div', 'dialog-actions'), undo = make('button', 'button', 'Undo edit'), redo = make('button', 'button', 'Redo edit'), cancel = make('button', 'button', 'Cancel'), apply = make('button', 'button primary', 'Apply');
  apply.id = 'html-figure-apply'; cancel.id = 'html-figure-cancel'; apply.disabled = true; undo.disabled = redo.disabled = true;
  actions.append(undo, redo, cancel, apply); dialog.append(heading, body, status, actions); document.body.append(dialog); dialog.showModal();
  let closed = false, figure, frame, selected, serial = 0, crop, readyTimer, viewTop = 0, viewHeight = 900;
  const channel = crypto.randomUUID(), abort = new AbortController(), pending = new Map();
  const send = (kind, data = {}) => frame?.contentWindow.postMessage({ channel, kind, ...data }, '*');
  const resize = () => {
    if (!crop || !frame) return;
    const scale = Math.min((pane.clientWidth - 16) / crop.width, (pane.clientHeight - 16) / viewHeight, 1);
    viewport.style.width = crop.width * scale + 'px'; viewport.style.height = viewHeight * scale + 'px';
    frame.style.width = figure.viewportWidth + 'px'; frame.style.height = '900px';
    frame.style.transform = `scale(${scale})`; frame.style.left = -crop.x * scale + 'px'; frame.style.top = -viewTop * scale + 'px';
  };
  const observer = new ResizeObserver(resize); observer.observe(pane);
  const close = () => { closed = true; abort.abort(); clearTimeout(readyTimer); observer.disconnect(); window.removeEventListener('message', listener); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Editor closed.')); } pending.clear(); dialog.close(); dialog.remove(); };
  cancel.onclick = close; dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('keydown', e => e.stopPropagation()); for (const kind of ['copy', 'cut', 'paste']) dialog.addEventListener(kind, e => e.stopPropagation());
  function form(element) {
    selected = element; list.value = element.id; properties.replaceChildren(make('h3', '', element.label));
    function field(label, value, key, type = 'text', index) {
      const wrap = make('label', 'field'); wrap.append(make('span', '', label)); const input = make(key === 'text' ? 'textarea' : 'input');
      if (input.tagName === 'INPUT') input.type = type; input.value = value; input.dataset.htmlField = key; input.setAttribute('aria-label', label);
      if (key === 'text') { input.rows = 3; input.dataset.textIndex = index; }
      input.onchange = () => {
        let value = type === 'number' ? Number(input.value) : input.value;
        if (key === 'x' || key === 'y') { selected[key] = value; send('patch', { id: element.id, key: 'position', value: { x: selected.x, y: selected.y } }); }
        else send('patch', { id: element.id, key, value, ...(index !== undefined ? { index } : {}) });
      };
      if (['color', 'background-color', 'fill', 'stroke'].includes(key)) {
        const row = make('div', 'html-figure-color-field'), picker = make('input'); picker.type = 'color'; picker.setAttribute('aria-label', label + ' picker');
        const rgb = String(value).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        picker.value = /^#[\da-f]{6}$/i.test(value) ? value : rgb ? '#' + rgb.slice(1).map(v => Number(v).toString(16).padStart(2, '0')).join('') : '#000000';
        picker.onchange = () => { input.value = picker.value; send('patch', { id: element.id, key, value: picker.value }); };
        row.append(picker, input); wrap.append(row);
      } else wrap.append(input);
      properties.append(wrap);
    }
    element.texts.forEach((s, i) => field(element.texts.length === 1 ? 'Text' : 'Text segment ' + (i + 1), s.text, 'text', 'text', s.index));
    if (element.texts.length) field('Font size', element.fontSize, 'font-size', 'number');
    field('Text color', element.color, 'color');
    if (element.svg) { field('Fill color', element.fill, 'fill'); field('Stroke color', element.stroke, 'stroke'); }
    else field('Background color', element.background, 'background-color');
    field('Offset X', element.x, 'x', 'number'); field('Offset Y', element.y, 'y', 'number');
    properties.append(make('p', 'hint', (element.svg ? 'Offsets use SVG units. Existing transforms are retained.' : 'Offsets use CSS pixels and keep the original layout space. Text wraps within the original layout.') + ' Content outside the Figure boundary is clipped.'));
    if (!element.texts.length) properties.append(make('p', 'hint', 'Select a text child to change its wording. This keeps nested labels and graphics intact.'));
  }
  function listener(event) {
    if (closed || event.source !== frame?.contentWindow || event.data?.channel !== channel) return;
    const data = event.data;
    if (data.kind === 'ready') {
      clearTimeout(readyTimer); list.replaceChildren(); for (const n of data.elements) { const option = make('option', '', '  '.repeat(Math.min(n.depth, 6)) + n.label); option.value = n.id; list.append(option); }
      apply.disabled = undo.disabled = redo.disabled = false; status.textContent = 'Native HTML · text, colors and offsets are editable. Apply updates the project and every export.';
    } else if (data.kind === 'selection') form(data.element);
    else if (data.kind === 'bounds') { crop = data.crop; viewTop = data.viewTop; viewHeight = data.viewHeight; resize(); }
    else if (data.kind === 'changed') status.textContent = 'Draft changed. Apply saves the edited HTML and a matching export image together.';
    else if (data.kind === 'error') status.textContent = data.message;
    else if (data.kind === 'document' && pending.has(data.request)) { const p = pending.get(data.request); clearTimeout(p.timer); pending.delete(data.request); p.resolve(data.html); }
  }
  window.addEventListener('message', listener);
  list.onchange = () => send('select', { id: list.value }); undo.onclick = () => send('undo'); redo.onclick = () => send('redo');
  const serialize = () => new Promise((resolve, reject) => { const request = ++serial, timer = setTimeout(() => { pending.delete(request); reject(new Error('The HTML preview did not respond. Reopen its editor.')); }, 10000); pending.set(request, { resolve, reject, timer }); send('serialize', { request }); });
  apply.onclick = async () => {
    apply.disabled = true; body.inert = true; undo.disabled = redo.disabled = true; status.textContent = 'Rendering the edited Figure for saving and export…';
    try {
      const html = '<!doctype html>\n' + cleanDocument(await serialize()).documentElement.outerHTML;
      const rendered = await renderEditedHTML(figure, html, abort.signal);
      if (closed) return;
      validateHTMLFigure(rendered.htmlFigure); const image = new Image(); image.src = rendered.dataUrl; await image.decode();
      if (closed) return;
      await onApply(rendered); close();
    } catch (error) { if (!closed) { status.textContent = error.message; apply.disabled = false; body.inert = false; undo.disabled = redo.disabled = false; } }
  };
  (async () => {
    try {
      figure = await editableHTMLFigure(asset, abort.signal); if (closed) return;
      const doc = cleanDocument(figure.html);
      const script = doc.createElement('script'); script.setAttribute('data-fe-editor', 'bridge'); script.textContent = `(${figureBridge.toString()})(${JSON.stringify(channel)})`;
      const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script.textContent)))));
      if (closed) return;
      const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`; csp.setAttribute('data-fe-editor', 'policy'); doc.head.prepend(csp); doc.body.append(script);
      frame = make('iframe'); frame.id = 'html-figure-preview'; frame.title = 'Editable HTML Figure'; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = '<!doctype html>\n' + doc.documentElement.outerHTML; viewport.append(frame); crop = figure.crop; resize();
      readyTimer = setTimeout(() => { if (!closed) status.textContent = 'The HTML preview did not finish loading. Cancel and reopen the editor.'; }, 15000);
    } catch (error) { if (!closed) status.textContent = error.message; }
  })();
  return dialog;
}
