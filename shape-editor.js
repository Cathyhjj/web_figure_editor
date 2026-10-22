import { isShapeItem, isLineShape, shapeColor } from './shapes.js';

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
  if (!isShapeItem(item) && item.type !== 'shape') return '';
  const paint = (key, label) => {
    const gradient=item[key+'Gradient'];
    const none = !gradient && transparent(item[key]);
    const { hex, alpha } = shapeColor(none ? (paints.get(item)?.[key] ?? (key === 'fill' ? '#ffffff' : '#252735')) : item[key]);
    return `<fieldset class="shape-paint"><legend>${label}</legend>
      <div class="shape-paint-row"><select data-shape-paint="${key}" aria-label="${label} style" ${item.locked ? 'disabled' : ''}>
        <option value="solid" ${none || gradient ? '' : 'selected'}>Solid ${label.toLowerCase()}</option>
        ${key==='stroke'?`<option value="gradient" ${gradient?'selected':''}>Gradient border</option>`:''}
        <option value="none" ${none ? 'selected' : ''}>No ${label.toLowerCase()}</option>
      </select><input type="color" data-shape-color="${key}" value="${hex}" aria-label="${label} color" ${item.locked || none || gradient ? 'disabled' : ''}></div>
      ${slider(`${label} transparency`, key + 'Opacity', percent((item[key + 'Opacity'] ?? 1) * (gradient ? 1 : alpha)), item.locked || none)}
    </fieldset>`;
  };
  return `<section class="shape-style" aria-label="Shape appearance">
    ${isLineShape(item) || item.type === 'shape' && item.paths.every(path => path.fillMode === 'none') ? '' : item.fillGradient ? slider('Fill transparency', 'fillOpacity', percent(item.fillOpacity ?? 1), item.locked) : paint('fill', 'Fill')}
    ${paint('stroke', 'Border')}
    <div class="field-row"><label class="field"><span>Line width / px</span><input type="number" data-property="strokeWidth" value="${item.strokeWidth}" min="0" max="1000" step="0.5"></label>
    <label class="field"><span>Line style</span><select data-property="strokeDash" aria-label="Line style">
      ${[['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([key, label]) => `<option value="${key}" ${(item.strokeDash ?? 'solid') === key ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label></div>
    <p class="hint">0% is opaque; 100% is transparent.${isLineShape(item) ? ' Border settings control the line and arrowheads.' : ' Fill and border can be adjusted separately. Hold Shift while resizing a corner to keep proportions.'}</p>
  </section>`;
}

export function bindShapeEditor(item, box, { begin, preview, commit, change }) {
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
      if (item.locked) return;
      const key = input.dataset.shapePaint;
      change(() => {
        if(input.value==='gradient'){
          item.strokeGradient ||= {angle:0,stops:[{offset:0,color:'#4472c4'},{offset:1,color:'#ffffff'}]};
          item.stroke='#4472c4';return;
        }
        delete item[key+'Gradient'];
        if (input.value === 'none') {
          paints.set(item, { ...paints.get(item), [key]: item[key] });
          item[key] = 'none';
        } else {
          item[key] = paints.get(item)?.[key] ?? (key === 'fill' ? '#ffffff' : '#252735');
        }
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
