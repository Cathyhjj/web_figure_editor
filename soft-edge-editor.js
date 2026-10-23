import { SOFT_EDGE_PRESETS, MAX_SOFT_EDGE } from './soft-edge.js';

const valueOf = item => item.softEdge ?? 0;
const presetOf = item => SOFT_EDGE_PRESETS.includes(valueOf(item)) ? String(valueOf(item)) : 'custom';

export function softEdgeEditorMarkup(item) {
  const value = valueOf(item), disabled = item.locked ? 'disabled' : '';
  return `<section class="image-shadow soft-edges" aria-label="Soft edges">
    <label class="shadow-option"><span>Presets</span><select id="soft-edge-preset" ${disabled}>
      ${SOFT_EDGE_PRESETS.map(radius => `<option value="${radius}" ${presetOf(item) === String(radius) ? 'selected' : ''}>${radius ? radius + ' pt' : 'No soft edges'}</option>`).join('')}
      <option value="custom" ${presetOf(item) === 'custom' ? 'selected' : ''} disabled>Custom</option>
    </select></label>
    <div class="shadow-control"><label for="soft-edge-size">Size</label>
      <input type="range" data-soft-edge min="0" max="${MAX_SOFT_EDGE}" step="0.5" value="${value}" aria-label="Soft edges size slider" ${disabled}>
      <div class="shadow-value"><input id="soft-edge-size" type="number" data-soft-edge min="0" max="${MAX_SOFT_EDGE}" step="0.5" value="${value}" aria-label="Soft edges size (pt)" ${disabled}><span aria-hidden="true">pt</span></div>
    </div><p class="hint">Fade edges into the background. Set size to 0 to remove.</p>
  </section>`;
}

export function bindSoftEdgeEditor(item, box, { begin, preview, commit, change }) {
  const preset = box.querySelector('#soft-edge-preset');
  if (!preset) return;
  preset.onchange = () => {
    const radius = Number(preset.value);
    if (!item.locked && SOFT_EDGE_PRESETS.includes(radius)) change(() => { item.softEdge = radius; });
  };
  box.querySelectorAll('[data-soft-edge]').forEach(input => {
    const apply = () => {
      if (item.locked || input.value === '') return;
      const number = Number(input.value);
      if (!Number.isFinite(number)) return;
      const value = Math.max(0, Math.min(MAX_SOFT_EDGE, number));
      if (valueOf(item) === value) return;
      begin(); item.softEdge = value;
      box.querySelectorAll('[data-soft-edge]').forEach(peer => { if (peer !== input) peer.value = value; });
      preset.value = presetOf(item); preview();
    };
    const finish = () => { apply(); input.value = valueOf(item); commit(); };
    input.oninput = apply; input.onchange = finish; input.onblur = finish;
  });
}
