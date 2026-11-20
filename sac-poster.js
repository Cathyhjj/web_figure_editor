// Editable arrangements and individual components from the SAC poster reference sheet.
import { uid } from './core.js';
import { POSTER_LAYERS, POSTER_PICTURES } from './sac-poster-parts.js';

const nodeColors = ['lavender', 'blue', 'periwinkle', 'gray'];
const rowColors = ['blue', 'purple', 'magenta', 'rose', 'coral', 'peach'];
const applications = ['battery', 'inverter', 'motor'];
const title = word => word[0].toUpperCase() + word.slice(1);
const ring = ['ring', ...nodeColors.flatMap(color => ['node-' + color, 'callout-' + color])];
const rows = ['orb', ...rowColors.map(color => 'row-' + color)];
const fields = name => ['badge-' + name, 'fields-' + name, ...(name === 'battery' ? ['cell-sample'] : [])];
const matrix = applications.flatMap(fields);

function style(id, name, category, width, height, parts) {
  return {id, name, category, width, height, parts};
}

export const SAC_POSTER_STYLES = [
  style('poster-reference-layout', 'Complete poster reference', 'Poster layouts', 620, 820, [...ring, ...rows, ...matrix]),
  style('ecosystem-ring', 'Ecosystem ring & callouts', 'Poster layouts', 650, 495, ring),
  style('method-table', 'Six gradient method rows', 'Poster layouts', 700, 410, rows),
  style('application-matrix', 'Three-category matrix', 'Poster layouts', 760, 335, matrix),
  style('crescent-orb', 'Two-tone crescent orb', 'Ring & nodes', 130, 130, ['orb']),
  ...nodeColors.map(color => style('teardrop-' + color, title(color) + ' teardrop node', 'Ring & nodes', 130, 130, ['node-' + color])),
  style('node-callout', 'Node callout with leader', 'Ring & nodes', 250, 75, ['callout-lavender']),
  ...rowColors.map(color => style('method-row-' + color, title(color) + ' gradient row', 'Gradient rows', 550, 80, ['row-' + color])),
  ...applications.map(name => style('category-row-' + name, title(name) + ' category row', 'Category cards', 740, 85, fields(name))),
  ...applications.map(name => style('category-badge-' + name, title(name) + ' hexagon badge', 'Category cards', 170, 75, ['badge-' + name])),
  style('category-field', 'Outlined category field', 'Category cards', 205, 52, ['cell-sample']),
];

export function posterLayers(parts) {
  return POSTER_LAYERS.filter(layer => parts.includes(layer.part))
    .map(({part, ...item}) => structuredClone(item));
}

function requiredPictures(items) {
  const ids = new Set(items.filter(item => item.type === 'image').map(item => item.assetId));
  return POSTER_PICTURES.filter(picture => ids.has(picture.id));
}

export function posterPreviewAssets(items) {
  return requiredPictures(items).map(({id, width, height, name, preview}) =>
    ({id, width, height, name, mime:'image/png', dataUrl:preview}));
}

async function readBundledPicture(file) {
  const response = await fetch(new URL('./assets/sac-poster/' + file, import.meta.url));
  if (!response.ok) throw new Error('Could not load SAC poster picture: ' + file);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Reading media never touches the document. The editor applies it with the shapes in one undo step. */
export async function loadPosterPictures(items, readPicture = readBundledPicture) {
  return Promise.all(requiredPictures(items).map(async ({id, name, file, fingerprint, width, height}) =>
    ({id, name, fingerprint, width, height, mime:'image/png', sourceKind:'copy', dataUrl:await readPicture(file)})));
}

/** Share identical originals across inserts; honor IDs and edits already present in the destination. */
export function attachPosterPictures(project, items, pictures) {
  const assetIDs = new Map();
  for (const picture of pictures) {
    const existing = project.assets.find(asset => asset.dataUrl === picture.dataUrl && asset.mime === picture.mime);
    const id = existing?.id ?? (project.assets.some(asset => asset.id === picture.id) ? uid() : picture.id);
    if (!existing) project.assets.push({...picture, id});
    assetIDs.set(picture.id, id);
  }
  for (const item of items) if (assetIDs.has(item.assetId)) item.assetId = assetIDs.get(item.assetId);
}
