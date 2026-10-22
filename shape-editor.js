import { isShapeItem, isLineShape, shapeColor } from './shapes.js';
import { formatSection } from './format-inspector.js';
import { defaultGradient, gradientEditorMarkup, bindGradientEditors } from './gradient-editor.js';

const paints = new WeakMap();
const transparent = value => value === 'none' || value === 'transparent';
const percent = opacity => Math.round((1 - opacity) * 1000) / 10;
const slider = (label, key, value, disabled = false) => `<div class="transparency-control">
  <label for="${key}-transparency">${label}</label>
  <input id="${key}-transparency" data-transparency="${key}" type="range" min="0" max="100" step="0.1" value="${value}" aria-label="${label}" ${disabled ? 'disabled' : ''}>
  <label class="transparency-value"><input data-transparency="${key}" type="number" min="0" max="100" step="0.1" value="${value}" aria-label="${label} percent" ${disabled ? 'disabled' : ''}><span>%</span></label>
</div>`;

export function opacityEditorMarkup(item) {
  return slider('Transparency', 'opacity', percent(item.opacity ?? 1), item.locked);
}

export function shapeEditorMarkup(item) {
  if (!isShapeItem(item) && item.type !== 'shape' && item.type !== 'image') return '';
  const paint = (key, label) => {
    const gradient=item[key+'Gradient'];
    const none = !gradient && transparent(item[key]??'none');
    const { hex, alpha } = shapeColor(none ? (paints.get(item)?.[key] ?? (key === 'fill' ? '#ffffff' : '#252735')) : item[key]);
    const mode = gradient ? 'gradient' : none ? 'none' : 'solid';
    return `<fieldset class="shape-paint-modes" aria-label="${label} style">${[['none', 'No'], ['solid', 'Solid'], ['gradient', 'Gradient']].map(([value, title]) => `<label><input type="radio" name="shape-${key}-mode" data-shape-paint="${key}" value="${value}" ${value === mode ? 'checked' : ''} ${item.locked ? 'disabled' : ''}><span>${title} ${label.toLowerCase()}</span></label>`).join('')}</fieldset>
      ${gradient ? gradientEditorMarkup(item, key + 'Gradient') + ((item[key + 'Opacity'] ?? 1) < 1 ? slider(`Overall ${label.toLowerCase()} transparency`, key + 'Opacity', percent(item[key + 'Opacity']), item.locked) : '') : none ? '' : `<label class="format-option"><span>Color</span><input type="color" data-shape-color="${key}" value="${hex}" aria-label="${label} color" ${item.locked ? 'disabled' : ''}></label>${slider(`${label} transparency`, key + 'Opacity', percent((item[key + 'Opacity'] ?? 1) * alpha), item.locked)}`}`;
  };
  const line = paint('stroke', 'Line') + `<div class="field-row"><label class="field"><span>Width / px</span><input type="number" data-property="strokeWidth" value="${item.strokeWidth??0}" min="0" max="1000" step="0.5"></label>
    <label class="field"><span>Line style</span><select data-property="strokeDash" aria-label="Line style">
      ${[['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([key, label]) => `<option value="${key}" ${(item.strokeDash ?? 'solid') === key ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label></div>`;
  const hasFill = item.type !== 'image' && !isLineShape(item) && !(item.type === 'shape' && item.paths.every(path => path.fillMode === 'none'));
  return `<section class="shape-style" aria-label="Shape appearance">${hasFill ? formatSection('fill', 'Fill', paint('fill', 'Fill')) : ''}${formatSection('line', 'Line', line, !hasFill)}</section>`;
}

export function bindShapeEditor(item, box, bindings) {
  const { begin, preview, commit, change } = bindings;
  bindGradientEditors(item, box, bindings);
  box.querySelectorAll('[data-transparency]').forEach(input => {
    const key = input.dataset.transparency;
    const paintKey = key === 'fillOpacity' && !item.fillGradient ? 'fill' : key === 'strokeOpacity' && !item.strokeGradient ? 'stroke' : null;
    const current = () => (item[key] ?? 1) * (paintKey ? shapeColor(item[paintKey]).alpha : 1);
    const apply = () => {
      if (item.locked || input.disabled || input.value === '') return;
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      const opacity = 1 - Math.max(0, Math.min(100, value)) / 100;
      if (Math.abs(current() - opacity) < 1e-9) return;
      begin();
      // Migrate legacy RGBA paint to RGB + independent opacity on first edit.
      if (paintKey) item[paintKey] = shapeColor(item[paintKey]).hex;
      item[key] = opacity;
      box.querySelectorAll(`[data-transparency="${key}"]`).forEach(peer => { if (peer !== input) peer.value = percent(opacity); });
      preview();
    };
    const finish = () => { apply(); input.value = percent(current()); commit(); };
    input.oninput = apply;
    input.onchange = finish;
    input.onblur = finish;
  });
  box.querySelectorAll('[data-shape-paint]').forEach(input => {
    input.onchange = () => {
      if (item.locked || !input.checked) return;
      const key = input.dataset.shapePaint;
      change(() => {
        if(key==='stroke' && input.value!=='none' && !(item.strokeWidth>0))item.strokeWidth=2;
        const cache = { ...paints.get(item) };
        if (item[key+'Gradient']) cache[key+'Gradient'] = structuredClone(item[key+'Gradient']);
        else if (!transparent(item[key])) cache[key] = item[key];
        paints.set(item, cache);
        if(input.value==='gradient') item[key+'Gradient'] = structuredClone(cache[key+'Gradient'] ?? defaultGradient());
        else delete item[key+'Gradient'];
        item[key] = input.value === 'none' ? 'none' : cache[key] ?? (key === 'fill' ? '#4472c4' : '#252735');
      });
    };
  });
  box.querySelectorAll('[data-shape-color]').forEach(input => {
    const key = input.dataset.shapeColor;
    input.oninput = () => {
      if (item.locked || input.disabled || item[key] === input.value) return;
      begin();
      item[key + 'Opacity'] = (item[key + 'Opacity'] ?? 1) * shapeColor(item[key]).alpha;
      item[key] = input.value;
      preview();
    };
    input.onchange = input.onblur = () => commit();
  });
}
