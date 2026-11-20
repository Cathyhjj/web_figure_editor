import { SOFT_EDGE_PRESETS, MAX_SOFT_EDGE, MAX_SOFT_EDGE_STRENGTH, DEFAULT_RADIAL_RADIUS, MAX_RADIAL_RADIUS } from './soft-edge.js';

const sizeOf = item => item.softEdge ?? 0;
const angleOf = item => item.softEdgeAngle ?? 0;
const strengthOf = item => item.softEdgeStrength ?? 100;
const radiusOf = item => item.softEdgeRadius ?? DEFAULT_RADIAL_RADIUS;
const radialDirections = [[0, 'Left'], [45, 'Top left'], [90, 'Top'], [135, 'Top right'], [180, 'Right'], [225, 'Bottom right'], [270, 'Bottom'], [315, 'Bottom left']];
const edgeDirections = radialDirections.filter(([degrees]) => degrees % 90 === 0);
const directionsFor = item => item.softEdgeMode === 'radial' ? radialDirections : edgeDirections;
const presetOf = item => SOFT_EDGE_PRESETS.includes(sizeOf(item)) ? String(sizeOf(item)) : 'custom';

function directionOf(item) {
  const angle = angleOf(item) % 360;
  return directionsFor(item).some(([degrees]) => degrees === angle) ? String(angle) : 'custom';
}

function valueControl(label, id, attribute, value, max, step, unit, disabled) {
  return `<div class="shadow-control"><label for="${id}">${label}</label>
    <input type="range" ${attribute} min="0" max="${max}" step="${step}" value="${value}" aria-label="Soft edges ${label.toLowerCase()} slider" ${disabled}>
    <div class="shadow-value"><input id="${id}" type="number" ${attribute} min="0" max="${max}" step="${step}" value="${value}" aria-label="Soft edges ${label.toLowerCase()} (${unit})" ${disabled}><span aria-hidden="true">${unit}</span></div>
  </div>`;
}

export function softEdgeEditorMarkup(item) {
  const disabled = item.locked ? 'disabled' : '';
  const mode = item.type === 'image' ? (item.softEdgeMode ?? 'all') : 'all';
  const radial = mode === 'radial';
  const modeControl = item.type !== 'image' ? '' : `<label class="shadow-option"><span>Edges</span>
    <select id="soft-edge-mode" ${disabled}><option value="all" ${mode === 'all' ? 'selected' : ''}>All edges</option><option value="single" ${mode === 'single' ? 'selected' : ''}>One edge</option><option value="radial" ${radial ? 'selected' : ''}>Radial</option></select></label>`;
  const directionControls = mode === 'all' ? '' : `<label class="shadow-option"><span>Fade from</span><select id="soft-edge-direction" ${disabled}>
    ${directionsFor(item).map(([angle, name]) => `<option value="${angle}" ${directionOf(item) === String(angle) ? 'selected' : ''}>${name}</option>`).join('')}
    <option value="custom" ${directionOf(item) === 'custom' ? 'selected' : ''} disabled>Custom angle</option>
  </select></label>
  ${valueControl('Angle', 'soft-edge-angle', 'data-soft-edge-angle', angleOf(item), 360, 1, '°', disabled)}`;
  const sizeControls = radial
    ? valueControl('Radius', 'soft-edge-radius', 'data-soft-edge-radius', radiusOf(item), MAX_RADIAL_RADIUS, 1, '%', disabled)
    : `<label class="shadow-option"><span>Presets</span><select id="soft-edge-preset" ${disabled}>
      ${SOFT_EDGE_PRESETS.map(radius => `<option value="${radius}" ${presetOf(item) === String(radius) ? 'selected' : ''}>${radius ? radius + ' pt' : 'No soft edges'}</option>`).join('')}
      <option value="custom" ${presetOf(item) === 'custom' ? 'selected' : ''} disabled>Custom</option>
    </select></label>
    ${valueControl('Size', 'soft-edge-size', 'data-soft-edge', sizeOf(item), MAX_SOFT_EDGE, 0.5, 'pt', disabled)}`;
  const hints = {
    all: 'Fade edges into the background. Set size to 0 to remove.',
    single: 'Size sets the fade width. Strength above 100% makes the transition more transparent within that width.',
    radial: 'Angle moves the center around the picture border. Radius is a percentage of the shorter visible side.'
  };
  return `<section class="image-shadow soft-edges" aria-label="Soft edges">
    ${modeControl}${directionControls}${sizeControls}
    ${mode === 'all' ? '' : valueControl('Strength', 'soft-edge-strength', 'data-soft-edge-strength', strengthOf(item), MAX_SOFT_EDGE_STRENGTH, 1, '%', disabled)}
    <p class="hint">${hints[mode]}</p></section>`;
}

export function bindSoftEdgeEditor(item, box, { begin, preview, commit, change }) {
  const preset = box.querySelector('#soft-edge-preset');
  const mode = box.querySelector('#soft-edge-mode');
  if (mode) mode.onchange = () => {
    if (item.locked) return;
    change(() => {
      item.softEdgeMode = mode.value;
      if (mode.value === 'single' && sizeOf(item) === 0) item.softEdge = 10;
    });
  };
  const direction = box.querySelector('#soft-edge-direction');
  if (direction) direction.onchange = () => {
    const angle = Number(direction.value);
    if (!item.locked && directionsFor(item).some(([degrees]) => degrees === angle)) {
      change(() => { item.softEdgeAngle = angle; });
    }
  };
  if (preset) preset.onchange = () => {
    const radius = Number(preset.value);
    if (!item.locked && SOFT_EDGE_PRESETS.includes(radius)) change(() => { item.softEdge = radius; });
  };

  function bindValue(attribute, key, valueOf, syncChoice) {
    const controls = box.querySelectorAll(`[${attribute}]`);
    controls.forEach(input => {
      const apply = () => {
        if (item.locked || input.value === '') return;
        const number = Number(input.value);
        if (!Number.isFinite(number)) return;
        const value = Math.max(0, Math.min(Number(input.max), number));
        if (valueOf(item) === value) return;
        begin();
        item[key] = value;
        controls.forEach(peer => { if (peer !== input) peer.value = value; });
        syncChoice?.();
        preview();
      };
      const finish = () => { apply(); input.value = valueOf(item); commit(); };
      input.oninput = apply; input.onchange = finish; input.onblur = finish;
    });
  }
  bindValue('data-soft-edge', 'softEdge', sizeOf, () => { preset.value = presetOf(item); });
  bindValue('data-soft-edge-radius', 'softEdgeRadius', radiusOf);
  if (direction) {
    bindValue('data-soft-edge-angle', 'softEdgeAngle', angleOf, () => { direction.value = directionOf(item); });
    bindValue('data-soft-edge-strength', 'softEdgeStrength', strengthOf);
  }
}
