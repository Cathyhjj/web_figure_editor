/** Content stays local to its SVG group; position and opacity belong to the group. */
export function itemContentKey(item) {
  // Keep rotation: some shadow and gradient geometry is derived from it.
  return JSON.stringify({ ...item, x: undefined, y: undefined, opacity: undefined });
}

/** Compare immutable source strings directly instead of serializing their bytes. */
export function assetVisualInputs(asset) {
  return asset ? [asset.id, asset.mime, asset.dataUrl, asset.posterDataUrl, asset.width, asset.height] : [];
}

export function sameInputs(a, b) {
  return !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Retain identity as card callbacks close over the original asset object. */
export function createAssetLibrarySnapshot(assets) {
  return assets.map(asset => ({ asset, fields: { ...asset } }));
}

export function assetLibraryMatches(snapshot, assets) {
  return !!snapshot && snapshot.length === assets.length && snapshot.every((entry, index) => {
    const asset = assets[index];
    if (entry.asset !== asset) return false;
    const keys = Object.keys(asset);
    return keys.length === Object.keys(entry.fields).length
      && keys.every(key => Object.hasOwn(entry.fields, key) && entry.fields[key] === asset[key]);
  });
}
