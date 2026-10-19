// Font sizes use the same CSS-pixel bounds as the portable project model.
export const MIN_FONT_SIZE = 1;
export const MAX_FONT_SIZE = 2000;
export const FONT_FAMILIES = [
  'Aptos', 'Aptos Display', 'Arial', 'Arial Narrow', 'Calibri', 'Cambria',
  'Helvetica', 'Helvetica Neue', 'Avenir', 'Avenir Next', 'Times New Roman',
  'Georgia', 'Palatino', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New',
  'Menlo', 'PingFang SC', 'Microsoft YaHei', 'SimSun', 'Songti SC', 'Heiti SC',
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'sans-serif', 'serif', 'monospace',
];
const SIZE_STEPS = [1, 2, 4, 6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36,
  40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 120, 144, 192, 256, 384, 500, 750, 1000, 1500, 2000];

export function fontValue(property, value) {
  if (property === 'fontFamily') {
    const family = String(value).trim();
    return family && family.length <= 200 ? family : null;
  }
  if (property !== 'fontSize' || String(value).trim() === '') return null;
  const size = Number(value);
  return Number.isFinite(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE ? size : null;
}

export function steppedFontSize(size, direction) {
  return direction > 0
    ? SIZE_STEPS.find(step => step > size) ?? MAX_FONT_SIZE
    : SIZE_STEPS.findLast(step => step < size) ?? MIN_FONT_SIZE;
}

export function initFontTools({ getItems, change }) {
  const family = document.getElementById('font-family');
  const size = document.getElementById('font-size');
  const increase = document.getElementById('font-increase');
  const decrease = document.getElementById('font-decrease');
  const suggestions = document.getElementById('font-families');
  const editable = () => getItems().filter(item => item.type === 'text' && !item.locked);

  function render() {
    const text = getItems().filter(item => item.type === 'text');
    const items = editable(), display = items.length ? items : text;
    for (const [input, property] of [[family, 'fontFamily'], [size, 'fontSize']]) {
      input.disabled = !items.length;
      input.value = display.length && display.every(item => item[property] === display[0][property]) ? display[0][property] : '';
      input.placeholder = display.length ? 'Mixed' : input === family ? 'Select text' : '—';
    }
    increase.disabled = !items.some(item => item.fontSize < MAX_FONT_SIZE);
    decrease.disabled = !items.some(item => item.fontSize > MIN_FONT_SIZE);
    const families = [...new Set([...text.map(item => item.fontFamily), ...FONT_FAMILIES])];
    suggestions.replaceChildren(...families.map(value => {
      const option = document.createElement('option'); option.value = value; return option;
    }));
  }

  function apply(property, valueFor) {
    const updates = editable().map(item => [item, valueFor(item)])
      .filter(([item, value]) => value !== null && item[property] !== value);
    if (updates.length) change(() => { for (const [item, value] of updates) item[property] = value; });
    else render();
  }

  for (const [input, property] of [[family, 'fontFamily'], [size, 'fontSize']]) {
    input.onchange = () => { const value = fontValue(property, input.value); apply(property, () => value); };
    input.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); input.onchange(); input.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); render(); input.blur(); }
    };
  }
  increase.onclick = () => apply('fontSize', item => steppedFontSize(item.fontSize, 1));
  decrease.onclick = () => apply('fontSize', item => steppedFontSize(item.fontSize, -1));
  return { render };
}
