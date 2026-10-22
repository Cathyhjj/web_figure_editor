/** Picture shadow controls. Values use PowerPoint's percent, degree and point units. */
import { DEFAULT_SHADOW, SHADOW_PRESETS } from './shadow.js';

const controls = [
  ['transparency', 'Transparency', '%', 100, 1],
  ['size', 'Size', '%', 200, 1],
  ['blur', 'Blur', 'pt', 100, 0.5],
  ['angle', 'Angle', '°', 360, 1],
  ['distance', 'Distance', 'pt', 200, 0.5],
];
const settings = item => ({ ...DEFAULT_SHADOW, ...item.shadow });
function presetId(shadow) {
  if (!shadow.enabled) return 'none';
  return SHADOW_PRESETS.find(preset => preset.id !== 'none' &&
    Object.entries({ ...DEFAULT_SHADOW, ...preset.values }).every(([key, value]) => shadow[key] === value))?.id || 'custom';
}

export function shadowEditorMarkup(item) {
  const shadow = settings(item);
  return `<section class="image-shadow" aria-label="${item.type === 'image' ? 'Image' : 'Object'} shadow">
    <label class="shadow-heading" for="shadow-enabled"><span>Shadow</span><input id="shadow-enabled" type="checkbox" ${shadow.enabled ? 'checked' : ''} ${item.locked ? 'disabled' : ''}></label>
    <label class="shadow-option"><span>Presets</span><select id="shadow-preset" ${item.locked ? 'disabled' : ''}>
      ${SHADOW_PRESETS.map(preset => `<option value="${preset.id}" ${preset.id === presetId(shadow) ? 'selected' : ''}>${preset.label}</option>`).join('')}
      <option value="custom" ${presetId(shadow) === 'custom' ? 'selected' : ''} disabled>Custom</option>
    </select></label>
    <label class="shadow-option"><span>Color</span><input data-shadow-property="color" type="color" value="${shadow.color}" aria-label="Shadow color"></label>
    ${controls.map(([key, label, unit, max, step]) => `<div class="shadow-control">
      <label for="shadow-${key}">${label}</label>
      <input type="range" data-shadow-property="${key}" min="0" max="${max}" step="${step}" value="${shadow[key]}" aria-label="Shadow ${label.toLowerCase()} slider">
      <div class="shadow-value"><input id="shadow-${key}" type="number" data-shadow-property="${key}" min="0" max="${max}" step="${step}" value="${shadow[key]}" aria-label="Shadow ${label.toLowerCase()} (${unit})"><span aria-hidden="true">${unit}</span></div>
    </div>`).join('')}
  </section>`;
}

export function bindShadowEditor(item, box, { begin, preview, commit, change }) {
  const enabled = box.querySelector('#shadow-enabled');
  if (!enabled) return;
  const preset = box.querySelector('#shadow-preset');
  enabled.onchange = () => {
    if (!item.locked) change(() => { item.shadow = { ...settings(item), enabled: enabled.checked }; });
  };
  preset.onchange = () => {
    if (item.locked) return;
    const chosen = SHADOW_PRESETS.find(value => value.id === preset.value);
    if (!chosen) return;
    change(() => { item.shadow = chosen.id === 'none' ? { ...settings(item), enabled: false } : { ...DEFAULT_SHADOW, ...chosen.values }; });
  };
  box.querySelectorAll('[data-shadow-property]').forEach(input => {
    input.disabled = item.locked || !settings(item).enabled;
    const key = input.dataset.shadowProperty;
    const apply = () => {
      if (item.locked || !settings(item).enabled || input.value === '') return;
      let value = input.type === 'color' ? input.value : Number(input.value);
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return;
        value = Math.max(0, Math.min(Number(input.max), value));
      }
      if (settings(item)[key] === value) return;
      begin();
      // Replace the settings object so an existing duplicate cannot share edits.
      item.shadow = { ...settings(item), [key]: value };
      box.querySelectorAll(`[data-shadow-property="${key}"]`).forEach(peer => {
        if (peer !== input) peer.value = value;
      });
      preset.value = presetId(item.shadow);
      preview();
    };
    const finish = () => {
      apply();
      input.value = settings(item)[key];
      commit();
    };
    input.oninput = apply;
    input.onchange = finish;
    input.onblur = finish;
  });
}
