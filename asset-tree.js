/** Derive the library hierarchy from portable source paths; no filesystem access. */
export function buildAssetTree(assets) {
  const node = (name = '', path = '') => ({ name, path, folders: new Map(), assets: [], count: 0 });
  const root = node();
  for (const asset of assets) {
    const parts = typeof asset.relativePath === 'string' ? asset.relativePath.split('/').filter(Boolean).slice(0, -1) : [];
    let current = root;
    current.count++;
    for (const name of parts) {
      const path = current.path ? `${current.path}/${name}` : name;
      if (!current.folders.has(name)) current.folders.set(name, node(name, path));
      current = current.folders.get(name);
      current.count++;
    }
    current.assets.push(asset);
  }
  const order = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  function sort(current) {
    current.folders = [...current.folders.values()].sort(order).map(sort);
    // Keep individually added images in import order, as before.
    if (current !== root) current.assets.sort(order);
    return current;
  }
  return sort(root);
}
