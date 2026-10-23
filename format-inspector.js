/** Presentation-only grouping: controls keep their existing model and undo bindings. */
const preferences = new Map();
const expanded = new Map();
const icons = {
  paint: '<path d="m5 11 7-7 7 7-7 7Z"/><path d="m9 3 3 3M3 21h17M20 14s-2 2-2 3a2 2 0 0 0 4 0c0-1-2-3-2-3Z"/>',
  picture: '<rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="8" cy="8" r="1.5"/><path d="m3 18 6-6 4 4 3-5 5 7"/>',
  effects: '<path d="m12 3 9 7-3.5 11h-11L3 10Z"/><path d="M6.5 23h11"/>',
  size: '<rect x="5" y="5" width="14" height="14"/><path d="M2 8V2h6M16 2h6v6M22 16v6h-6M8 22H2v-6"/>',
};
export const formatTitle = item => item?.type === 'image' ? 'Format Picture' : 'Format Shape';
export function formatSection(key, title, content, defaultOpen = true) {
  return `<details class="format-section" data-format-section="${key}" ${(expanded.get(key) ?? defaultOpen) ? 'open' : ''}><summary>${title}</summary><div class="format-section-body">${content}</div></details>`;
}
export function formatInspectorMarkup(item, { geometry, opacity, appearance, picture, effects, softEdges, properties }) {
  const kind = item.type === 'image' ? 'picture' : 'shape';
  const effectSections = (softEdges ? formatSection('soft-edges', 'Soft Edges', softEdges) : '') + formatSection('shadow', 'Shadow', effects);
  const tabs = kind === 'picture'
    ? [['picture', 'Picture', formatSection('picture-transparency', 'Picture Transparency', opacity) + formatSection('crop', 'Crop & Source', picture)], ['effects', 'Effects', effectSections]]
    : [['paint', 'Fill & Line', appearance + formatSection('object-transparency', 'Object Transparency', opacity)], ['effects', 'Effects', effectSections]];
  tabs.push(['size', 'Size & Properties', geometry + formatSection('properties', 'Properties', properties)]);
  const selected = tabs.some(([key]) => key === preferences.get(kind)) ? preferences.get(kind) : tabs[0][0];
  return `<div class="format-inspector" data-format-kind="${kind}">
    <div class="format-tabs" role="tablist" aria-label="${formatTitle(item)} options">${tabs.map(([key, label]) => `<button type="button" role="tab" id="format-tab-${key}" aria-controls="format-page-${key}" aria-selected="${key === selected}" tabindex="${key === selected ? 0 : -1}" data-format-tab="${key}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg><span>${label}</span></button>`).join('')}</div>
    ${item.locked ? '<p class="format-locked">This object is locked. Unlock it in Size & Properties to edit.</p>' : ''}
    ${tabs.map(([key, label, content]) => `<section class="format-page" role="tabpanel" id="format-page-${key}" aria-labelledby="format-tab-${key}" ${key === selected ? '' : 'hidden'}>${content}</section>`).join('')}
  </div>`;
}
export function bindFormatInspector(box, { beforeSwitch = () => {} } = {}) {
  const root = box.querySelector('.format-inspector');
  if (!root) return;
  const tabs = [...root.querySelectorAll('[data-format-tab]')];
  const activate = button => {
    beforeSwitch();
    preferences.set(root.dataset.formatKind, button.dataset.formatTab);
    tabs.forEach(tab => {
      const active = tab === button;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      root.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = !active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.onclick = () => activate(tab);
    tab.onkeydown = event => {
      // Keep application commands (Save, Undo, Copy, etc.) available from tabs.
      if (event.metaKey || event.ctrlKey) return;
      event.stopPropagation();
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); activate(tabs[next]); tabs[next].focus(); }
    };
  });
  root.querySelectorAll('[data-format-section]').forEach(section => {
    section.ontoggle = () => expanded.set(section.dataset.formatSection, section.open);
    section.querySelector('summary').onkeydown = event => { if (!event.metaKey && !event.ctrlKey) event.stopPropagation(); };
  });
}
