import { createProject, validateProject } from './core.js';

function syntheticDemo() {
  const project = createProject();
  project.name = 'Synthetic figure example';
  project.canvas = { width: 960, height: 640, background: '#ffffff' };
  const text = (id, value, x, y, width, fontSize = 18, extra = {}) => ({
    id, type: 'text', name: value, text: value, x, y, width,
    height: fontSize * 1.3, fontSize, color: '#243247', ...extra,
  });
  const rect = (id, x, y, width, height, fill, stroke = 'none') => ({
    id, type: 'rect', name: id, x, y, width, height, fill, stroke, strokeWidth: 1,
  });
  const line = (id, x, y, width, height) => ({
    id, type: 'line', name: id, x, y, width, height, stroke: '#65758b', strokeWidth: 2,
  });
  project.items.push(
    text('title', 'A figure you can edit', 32, 40, 896, 32, { fontWeight: 700 }),
    text('subtitle', 'Synthetic shapes and labels. Select any object to move or restyle it.', 32, 92, 896),
    rect('chart-panel', 32, 160, 424, 384, '#f8fafc', '#d8e0eb'),
    rect('workflow-panel', 480, 160, 448, 384, '#f8fafc', '#d8e0eb'),
    text('chart-title', 'A  Illustrative comparison', 56, 180, 376, 22, { fontWeight: 700 }),
    text('workflow-title', 'B  Build a figure', 504, 180, 400, 22, { fontWeight: 700 }),
    line('chart-y-axis', 76, 244, 0, 196),
    line('chart-x-axis', 76, 440, 330, 0),
  );
  const colors = ['#4f46a5', '#c44d79', '#ed965d'];
  [72, 128, 184].forEach((height, index) => {
    const x = 110 + index * 100;
    project.items.push(
      rect(`bar-${index + 1}`, x, 440 - height, 56, height, colors[index]),
      text(`bar-label-${index + 1}`, `Sample ${String.fromCharCode(65 + index)}`, x - 12, 452, 80, 16, { align: 'center' }),
    );
  });
  project.items.push(text('chart-note', 'Illustrative values only', 76, 496, 330, 16, { color: '#65758b' }));
  ['Arrange panels', 'Add annotations', 'Export your figure'].forEach((label, index) => {
    const y = 248 + index * 80;
    project.items.push(
      rect(`step-${index + 1}`, 560, y, 288, 52, '#ffffff', '#b9c6d9'),
      text(`step-label-${index + 1}`, label, 580, y + 12, 248, 20, { align: 'center' }),
    );
    if (index < 2) project.items.push(line(`connector-${index + 1}`, 704, y + 52, 0, 28));
  });
  project.items.push(text('footer', 'All objects are editable. This example contains no research data or imported images.', 32, 584, 896, 17));
  return validateProject(project);
}

/** Use an optional local-only project; a clean checkout gets a synthetic example. */
export async function makeDemo() {
  const response = await fetch(new URL('./examples/local-demo.figure.json', import.meta.url));
  if (response.status === 404) return syntheticDemo();
  if (!response.ok) throw new Error(`Could not load the local example (${response.status}). Check the local server and try again.`);
  return validateProject(await response.json());
}
