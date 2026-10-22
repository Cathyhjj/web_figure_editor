import { SHAPE_CATEGORIES, PRESET_PATHS } from './shape-presets.js';
import { shapeSVG as vectorSVG } from './shape.js';
import { shapeSVG as basicSVG } from './shapes.js';

export { SHAPE_CATEGORIES };
export const DRAWING_TOOLS = ['curve', 'freeform', 'scribble'];
const entries = new Map(SHAPE_CATEGORIES.flatMap(group => group.shapes.map(shape => [shape.id, shape])));
const connectors = {
  bentConnector3: ['line', 'elbow'], elbowArrow: ['arrow', 'elbow'], elbowDoubleArrow: ['doubleArrow', 'elbow'],
  curvedConnector3: ['line', 'curved'], curvedArrow: ['arrow', 'curved'], curvedDoubleArrow: ['doubleArrow', 'curved'],
};

/** Independent, portable editable geometry; no server is needed for insertion. */
export function createCatalogShape(key) {
  const entry = entries.get(key);
  if (!entry || DRAWING_TOOLS.includes(key) || key === 'textBox') throw new Error('Choose an insertable shape.');
  const [type, connector] = connectors[key] || [key === 'circle' ? 'ellipse' : PRESET_PATHS[key] ? 'shape' : key];
  const line = ['line', 'arrow', 'doubleArrow'].includes(type);
  return {
    type, name: entry.name, width: entry.width, height: line && !connector ? 0 : entry.height,
    fill: line || entry.outline ? 'none' : '#ffffff', stroke: '#252735', strokeWidth: 2,
    fillOpacity: 1, strokeOpacity: 1, strokeDash: 'solid',
    ...(connector ? { connector } : {}),
    ...(type === 'shape' ? { paths: PRESET_PATHS[key].map(path => ({...path, commands: path.commands.map(command => [...command])})) } : {}),
  };
}

const drawingIcons = {
  curve: 'M3 24 C10 -8 16 -8 22 13 C26 28 30 29 35 25',
  freeform: 'M3 27 L3 10 L12 3 L27 3 L20 12 L24 17 L35 17 L35 27 Z',
  scribble: 'M7 3 C-5 17 6 18 18 11 C34 1 37 13 23 20 C9 27 23 32 33 25',
};
export function catalogIcon(key) {
  if (key === 'textBox') return '<svg viewBox="0 0 40 32" aria-hidden="true"><rect x="4" y="3" width="32" height="26" fill="none" stroke="currentColor"/><path d="M10 24L16 9L22 24M12 19H20M25 11H31M25 17H31M25 23H31" fill="none" stroke="currentColor"/></svg>';
  if (drawingIcons[key]) return `<svg viewBox="0 0 40 32" aria-hidden="true"><path d="${drawingIcons[key]}" fill="${key==='freeform'?'currentColor':'none'}" stroke="currentColor" stroke-width="1.5"/></svg>`;
  const item = createCatalogShape(key), scale = Math.min(32 / item.width, 24 / (item.height || 1));
  item.fill = item.fill === 'none' ? 'none' : '#696472'; item.stroke = '#55505e'; item.strokeWidth = 1.4 / scale;
  const body = item.type === 'shape' ? vectorSVG(item, `gallery-${key}`) : basicSVG(item);
  return `<svg viewBox="0 0 40 32" aria-hidden="true"><g transform="translate(${(40-item.width*scale)/2} ${(32-item.height*scale)/2}) scale(${scale})">${body}</g></svg>`;
}

export function initShapeGallery(menu, { insert, draw, text }) {
  menu.replaceChildren();
  const search = document.createElement('input');
  search.type = 'search'; search.className = 'shape-search'; search.placeholder = 'Search shapes';
  search.setAttribute('aria-label', 'Search shapes'); menu.append(search);
  for (const group of SHAPE_CATEGORIES) {
    const section = document.createElement('section'); section.className = 'shape-category';
    const heading = document.createElement('h3'); heading.textContent = group.name; section.append(heading);
    const grid = document.createElement('div'); grid.className = 'shape-options';
    for (const entry of group.shapes) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.shapeChoice = entry.id;
      button.title = entry.name; button.setAttribute('aria-label', entry.name);
      button.innerHTML = catalogIcon(entry.id);
      const label = document.createElement('span'); label.textContent = entry.name; button.append(label);
      if (entry.id === 'rect') button.id = 'add-rect';
      if (entry.id === 'line') button.id = 'add-line';
      // Keep existing integrations' legacy insertion selectors available.
      if (['rect','roundRect','circle','ellipse','line','arrow','doubleArrow'].includes(entry.id)) {
        button.dataset.addShape = entry.id === 'circle' ? 'ellipse' : entry.id;
        if (entry.id === 'circle') button.dataset.circle = 'true';
      }
      button.onclick = () => {
        menu.hidePopover();
        if (entry.id === 'textBox') text();
        else if (DRAWING_TOOLS.includes(entry.id)) draw(entry.id);
        else insert(createCatalogShape(entry.id));
      };
      grid.append(button);
    }
    section.append(grid); menu.append(section);
  }
  const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No matching shapes.'; empty.hidden = true; menu.append(empty);
  search.oninput = () => {
    const query = search.value.trim().toLowerCase(); let count = 0;
    for (const section of menu.querySelectorAll('.shape-category')) {
      let visible = 0;
      for (const button of section.querySelectorAll('button')) {
        button.hidden = !button.title.toLowerCase().includes(query);
        if (!button.hidden) visible++;
      }
      section.hidden = !visible; count += visible;
    }
    empty.hidden = count > 0;
  };
  menu.addEventListener('toggle', event => { if (event.newState === 'open') { search.value = ''; search.oninput(); } });
}
