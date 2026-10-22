import { gradientStopColor, shadeColor } from './shape.js';
import { shapeColor } from './shapes.js';

const selections = new WeakMap();
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round = v => Math.round(v * 10) / 10;
const presets = [
  ['blue', 'Blue', ['#ffffff', '#8faadc']],
  ['ocean', 'Ocean', ['#d6f5f2', '#168aad', '#184e77']],
  ['sunset', 'Sunset', ['#fff1b8', '#f59e69', '#bd5375']],
  ['gray', 'Grayscale', ['#ffffff', '#747474']],
  ['fade', 'Transparent fade', ['#4472c400', '#4472c4']],
];
const linearDirections = [[0, 'To right'], [45, 'To bottom right'], [90, 'To bottom'], [135, 'To bottom left'], [180, 'To left'], [225, 'To top left'], [270, 'To top'], [315, 'To top right']];
const radialDirections = [['.5,.5', 'From center'], ['0,0', 'From top left'], ['.5,0', 'From top'], ['1,0', 'From top right'], ['1,.5', 'From right'], ['1,1', 'From bottom right'], ['.5,1', 'From bottom'], ['0,1', 'From bottom left'], ['0,.5', 'From left']];
const defaultGradient = () => ({ angle: 90, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#8faadc' }] });
export { defaultGradient };

function selectedStop(item, key) {
  const g = item[key], previous = selections.get(item)?.[key];
  const stop = g.stops.includes(previous) ? previous : g.stops[0];
  selections.set(item, { ...selections.get(item), [key]: stop });
  return stop;
}
function chooseStop(item, key, stop) { selections.set(item, { ...selections.get(item), [key]: stop }); }
const transparency = stop => Math.round((1 - shapeColor(stop.color).alpha) * 100);
const stopColor = (color, opacity) => shapeColor(color).hex + Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0');
const disabled = value => value ? 'disabled' : '';
const previewSVG = (g, key) => `<svg viewBox="0 0 256 32" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${key}-stop-preview">${g.stops.map(s => `<stop offset="${s.offset}" stop-color="${gradientStopColor(s)}"/>`).join('')}</linearGradient></defs><rect width="256" height="32" fill="url(#${key}-stop-preview)"/></svg>`;
const presetId = g => presets.find(([, , colors]) => colors.length === g.stops.length && g.stops.every((s, i) => s.offset === i / (colors.length - 1) && !(s.brightness ?? 0) && shapeColor(s.color).hex.toLowerCase() === shapeColor(colors[i]).hex.toLowerCase() && shapeColor(s.color).alpha === shapeColor(colors[i]).alpha))?.[0] ?? '';

function handles(item, key) {
  const g = item[key], selected = selectedStop(item, key);
  return g.stops.map((s, index) => `<button type="button" class="gradient-stop ${s === selected ? 'is-selected' : ''}" data-gradient-stop="${index}" style="left:${s.offset * 100}%;--stop-color:${gradientStopColor(s)}" aria-label="${key === 'fillGradient' ? 'Fill' : 'Line'} gradient stop ${index + 1}, ${round(s.offset * 100)} percent" aria-pressed="${s === selected}" title="Stop ${index + 1}: ${round(s.offset * 100)}% · Drag to move" ${disabled(item.locked)}><span></span></button>`).join('');
}
function contents(item, key) {
  const g = item[key], s = selectedStop(item, key), label = key === 'fillGradient' ? 'Fill' : 'Line';
  const locked = disabled(item.locked), radial = g.type === 'radial';
  const angle = ((g.angle % 360) + 360) % 360;
  const center = g.center ?? { x: .5, y: .5 };
  const options = radial ? radialDirections : linearDirections;
  const direction = radial ? radialDirections.find(([v]) => v.split(',').every((n, i) => +n === (i ? center.y : center.x)))?.[0] : angle;
  const number = (field, title, value, min, max, unit, inactive = false) => `<label class="format-option"><span>${title}</span><span class="format-number"><input type="number" data-gradient-field="${field}" value="${value}" min="${min}" max="${max}" step="0.1" aria-label="${label} gradient ${title.toLowerCase()}" ${disabled(item.locked || inactive)}><span aria-hidden="true">${unit}</span></span></label>`;
  const slider = (field, title, value, min = 0) => `<div class="gradient-slider"><label for="${key}-${field}">${title}</label><input type="range" data-gradient-field="${field}" min="${min}" max="100" step="1" value="${value}" aria-label="${label} gradient ${title.toLowerCase()} slider" ${locked}><span class="format-number"><input id="${key}-${field}" type="number" data-gradient-field="${field}" min="${min}" max="100" step="1" value="${value}" aria-label="${label} gradient ${title.toLowerCase()}" ${locked}><span aria-hidden="true">%</span></span></div>`;
  return `<label class="format-option gradient-presets"><span>Preset gradients</span><select data-gradient-action="preset" aria-label="${label} preset gradients" ${locked}><option value="" disabled ${presetId(g) ? '' : 'selected'}>Custom</option>${presets.map(([id, title]) => `<option value="${id}" ${presetId(g) === id ? 'selected' : ''}>${title}</option>`).join('')}</select></label>
    <label class="format-option"><span>Type</span><select data-gradient-action="type" aria-label="${label} gradient type" ${locked}><option value="linear" ${radial ? '' : 'selected'}>Linear</option><option value="radial" ${radial ? 'selected' : ''}>Radial</option></select></label>
    <label class="format-option"><span>Direction</span><select data-gradient-action="direction" aria-label="${label} gradient direction" ${locked}><option value="" disabled ${options.some(([v]) => v === direction) ? '' : 'selected'}>Custom</option>${options.map(([v, title]) => `<option value="${v}" ${v === direction ? 'selected' : ''}>${title}</option>`).join('')}</select></label>
    ${number('angle', 'Angle', angle, 0, 360, '°', radial)}
    <div class="gradient-stops-heading"><span>Gradient stops</span><div><button type="button" data-gradient-action="add" aria-label="Add ${label.toLowerCase()} gradient stop" title="Add gradient stop" ${disabled(item.locked || g.stops.length >= 16)}>＋</button><button type="button" data-gradient-action="remove" aria-label="Remove selected ${label.toLowerCase()} gradient stop" title="Remove selected gradient stop" ${disabled(item.locked || g.stops.length <= 2)}>−</button></div></div>
    <div class="gradient-track" title="Double-click to add a stop"><div class="gradient-preview">${previewSVG(g, key)}</div><div class="gradient-handles">${handles(item, key)}</div></div>
    <label class="format-option"><span>Color</span><input type="color" data-gradient-field="color" value="${shapeColor(s.color).hex}" aria-label="${label} gradient stop color" ${locked}></label>
    ${number('offset', 'Position', round(s.offset * 100), 0, 100, '%')}
    ${slider('transparency', 'Transparency', transparency(s))}
    ${slider('brightness', 'Brightness', s.brightness ?? 0, -100)}
    <label class="format-checkbox"><input type="checkbox" data-gradient-action="rotate" ${g.rotateWithShape !== false ? 'checked' : ''} ${locked}><span>Rotate with shape</span></label>`;
}
export function gradientEditorMarkup(item, key) {
  return `<div class="gradient-editor" data-gradient-editor="${key}">${contents(item, key)}</div>`;
}

/** Interpolate the rendered stop colors, including alpha, for a newly inserted stop. */
export function interpolatedStop(g, offset) {
  const left = [...g.stops].reverse().find(s => s.offset <= offset) ?? g.stops[0];
  const right = g.stops.find(s => s.offset >= offset) ?? g.stops.at(-1);
  const t = left.offset === right.offset ? 0 : (offset - left.offset) / (right.offset - left.offset);
  const rgba = stop => { const c = shadeColor(gradientStopColor(stop)); return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).concat(shapeColor(c).alpha * 255); };
  const a = rgba(left), b = rgba(right);
  return { offset, color: '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('') };
}

export function bindGradientEditors(item, box, bindings) {
  box.querySelectorAll('[data-gradient-editor]').forEach(root => {
    const key = root.dataset.gradientEditor;
    let dragging = null;
    const g = () => item[key];
    const stop = () => selectedStop(item, key);
    const updateVisuals = () => {
      root.querySelector('.gradient-preview').innerHTML = previewSVG(g(), key);
      root.querySelector('.gradient-handles').innerHTML = handles(item, key);
      const values = { angle: g().angle, color: shapeColor(stop().color).hex, offset: round(stop().offset * 100), transparency: transparency(stop()), brightness: stop().brightness ?? 0 };
      root.querySelectorAll('[data-gradient-field]').forEach(input => { if (input !== root.ownerDocument.activeElement) input.value = values[input.dataset.gradientField]; });
      root.querySelector('[data-gradient-action="preset"]').value = presetId(g());
    };
    const redraw = () => { root.innerHTML = contents(item, key); bindControls(); };
    const add = offset => {
      if (item.locked || g().stops.length >= 16) return;
      bindings.commit();
      bindings.change(() => {
        const added = interpolatedStop(g(), offset);
        g().stops.push(added); g().stops.sort((a, b) => a.offset - b.offset); chooseStop(item, key, added);
      });
    };
    function bindControls() {
      root.querySelectorAll('[data-gradient-action]').forEach(input => {
        const action = input.dataset.gradientAction;
        const act = () => {
          if (item.locked || input.disabled) return;
          if (action === 'add') {
            // Add midway through the largest gap; this also works for coincident stops.
            const offsets = [0, ...g().stops.map(s => s.offset), 1];
            let start = 0, end = 1, largest = -1;
            for (let i = 1; i < offsets.length; i++) if (offsets[i] - offsets[i - 1] > largest) { start = offsets[i - 1]; end = offsets[i]; largest = end - start; }
            add((start + end) / 2); return;
          }
          bindings.commit();
          bindings.change(() => {
            if (action === 'preset') {
              const preset = presets.find(([id]) => id === input.value); if (!preset) return;
              g().stops = preset[2].map((color, i, colors) => ({ color, offset: i / (colors.length - 1) }));
              chooseStop(item, key, g().stops[0]);
            } else if (action === 'type') g().type = input.value;
            else if (action === 'direction') {
              if (input.value === '') return;
              if (g().type === 'radial') { const [x, y] = input.value.split(',').map(Number); g().center = { x, y }; }
              else g().angle = Number(input.value);
            } else if (action === 'rotate') g().rotateWithShape = input.checked;
            else if (action === 'remove' && g().stops.length > 2) {
              const index = g().stops.indexOf(stop()); g().stops.splice(index, 1);
              chooseStop(item, key, g().stops[Math.min(index, g().stops.length - 1)]);
            }
          });
        };
        if (input.tagName === 'BUTTON') input.onclick = act; else input.onchange = act;
      });
      root.querySelectorAll('[data-gradient-field]').forEach(input => {
        const field = input.dataset.gradientField;
        const apply = () => {
          if (item.locked || input.disabled || input.value === '') return;
          const raw = input.type === 'color' ? input.value : Number(input.value);
          if (typeof raw === 'number' && !Number.isFinite(raw)) return;
          const value = typeof raw === 'number' ? clamp(raw, Number(input.min), Number(input.max)) : raw;
          const s = stop();
          if (field === 'angle' && g().angle === value || field === 'offset' && s.offset === value / 100 || field === 'brightness' && (s.brightness ?? 0) === value || field === 'color' && shapeColor(s.color).hex === value || field === 'transparency' && (transparency(s) === value || stopColor(s.color, 1 - value / 100) === stopColor(s.color, shapeColor(s.color).alpha))) return;
          bindings.begin();
          if (field === 'angle') g().angle = value;
          else if (field === 'offset') { s.offset = value / 100; g().stops.sort((a, b) => a.offset - b.offset); }
          else if (field === 'brightness') s.brightness = value;
          else if (field === 'color') s.color = stopColor(value, shapeColor(s.color).alpha);
          else if (field === 'transparency') s.color = stopColor(s.color, 1 - value / 100);
          root.querySelectorAll(`[data-gradient-field="${field}"]`).forEach(peer => { if (peer !== input) peer.value = value; });
          if (field === 'angle') {
            const angle = (value % 360 + 360) % 360;
            root.querySelector('[data-gradient-action="direction"]').value = linearDirections.some(([v]) => v === angle) ? String(angle) : '';
          }
          updateVisuals(); bindings.preview();
        };
        input.oninput = apply;
        input.onchange = input.onblur = () => {
          apply(); bindings.commit(); updateVisuals();
          if (field === 'transparency') input.value = transparency(stop());
          else if (field === 'offset') input.value = round(stop().offset * 100);
          else if (field === 'brightness') input.value = stop().brightness ?? 0;
          else if (field === 'angle') input.value = g().angle;
        };
      });
    }
    root.onpointerdown = event => {
      const button = event.target.closest('[data-gradient-stop]');
      if (!button || item.locked || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); bindings.commit();
      chooseStop(item, key, g().stops[Number(button.dataset.gradientStop)]);
      dragging = { id: event.pointerId, startX: event.clientX, moved: false, before: stop().offset };
      redraw(); root.setPointerCapture(event.pointerId);
      root.querySelector('.gradient-stop.is-selected')?.focus({ preventScroll: true });
    };
    root.onpointermove = event => {
      if (!dragging || event.pointerId !== dragging.id || item.locked) return;
      if (!dragging.moved && Math.abs(event.clientX - dragging.startX) < 2) return;
      event.preventDefault(); event.stopPropagation(); dragging.moved = true;
      const bounds = root.querySelector('.gradient-track').getBoundingClientRect();
      const offset = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      if (stop().offset === offset) return;
      bindings.begin(); stop().offset = offset; g().stops.sort((a, b) => a.offset - b.offset);
      updateVisuals(); bindings.preview();
    };
    const finishDrag = event => {
      if (!dragging || event.pointerId !== dragging.id) return;
      event.stopPropagation();
      if (event.type === 'pointercancel' && dragging.moved) { stop().offset = dragging.before; g().stops.sort((a, b) => a.offset - b.offset); bindings.preview(); }
      dragging = null;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      bindings.commit(); updateVisuals(); root.querySelector('.gradient-stop.is-selected')?.focus({ preventScroll: true });
    };
    root.onpointerup = root.onpointercancel = finishDrag;
    root.onclick = event => {
      const button = event.target.closest('[data-gradient-stop]');
      if (!button || item.locked) return;
      chooseStop(item, key, g().stops[Number(button.dataset.gradientStop)]); redraw();
      root.querySelector('.gradient-stop.is-selected')?.focus({ preventScroll: true });
    };
    root.ondblclick = event => {
      if (!event.target.closest('.gradient-track') || event.target.closest('[data-gradient-stop]')) return;
      const bounds = root.querySelector('.gradient-track').getBoundingClientRect();
      add(clamp((event.clientX - bounds.left) / bounds.width, 0, 1));
    };
    root.onkeydown = event => {
      if (event.metaKey || event.ctrlKey) return;
      event.stopPropagation();
      const button = event.target.closest('[data-gradient-stop]');
      if (!button || item.locked) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); bindings.commit();
      chooseStop(item, key, g().stops[Number(button.dataset.gradientStop)]);
      bindings.begin();
      stop().offset = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : clamp(stop().offset + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .1 : .01), 0, 1);
      g().stops.sort((a, b) => a.offset - b.offset); bindings.preview(); bindings.commit(); redraw();
      root.querySelector('.gradient-stop.is-selected')?.focus({ preventScroll: true });
    };
    bindControls();
  });
}
