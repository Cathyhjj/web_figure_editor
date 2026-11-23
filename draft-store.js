/**
 * Recovery drafts keep embedded asset data in separate records, so an ordinary edit
 * rewrites only the small project record instead of every image.
 * The project record keeps asset metadata; `draftData` marks an asset whose data is separate.
 */
const DATA_FIELDS = ['dataUrl', 'posterDataUrl', 'originalDataUrl', 'svgDocument', 'htmlFigure'];
const PREFIX = 'asset:';

export const draftAssetKey = id => PREFIX + id;
export const draftAssetRange = () => IDBKeyRange.bound(PREFIX, PREFIX + '￿');

/** Return the project record and one data record per asset ID. */
export function splitDraft(project) {
  const data = new Map();
  const assets = project.assets.map(asset => {
    const light = { ...asset }, record = {};
    for (const field of DATA_FIELDS) if (field in light) { record[field] = light[field]; delete light[field]; }
    data.set(asset.id, record);
    return { ...light, draftData: true };
  });
  return { project: { ...project, assets }, data };
}

/** Data is immutable: identical strings and the same validated documents need no rewrite. */
export function sameDraftData(left, right) {
  if (!left || !right) return false;
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every(key => left[key] === right[key]);
}

/** Rebuild a stored project. Drafts written before this format hold complete assets and pass through. */
export function mergeDraft(project, data) {
  if (!project || !Array.isArray(project.assets) || !project.assets.some(asset => asset?.draftData === true)) return project;
  return { ...project, assets: project.assets.map(asset => {
    if (asset?.draftData !== true) return asset;
    const record = data.get(draftAssetKey(asset.id));
    if (!record || typeof record !== 'object') throw new Error('The local draft is incomplete.');
    const { draftData, ...light } = asset;
    return { ...light, ...record };
  }) };
}
