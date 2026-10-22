/** Persist clipboard bytes through the local launcher; embedded copies remain portable. */
const launchHint = 'To save pasted images as local files, restart Figure Editor with start.command (or npm start), then reload this page.';
const sourcePattern = /^local-assets\/pasted\/([a-f0-9]{64})\.(png|jpg|webp|svg)$/;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export function hasSavedLocalSource(asset) {
  const match = sourcePattern.exec(asset?.relativePath || '');
  return !!match && match[1] === asset?.fingerprint?.replace(/^sha256:/, '');
}

export function needsLocalSource(asset) {
  return asset?.sourceKind === 'copy' && (hasSavedLocalSource(asset)
    || (asset.sourceOrigin === 'clipboard' && !asset.relativePath));
}

export async function saveClipboardAsset(asset) {
  if (globalThis.location?.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname)) {
    throw new Error(launchHint);
  }
  let local;
  try {
    const response = await fetch('/api/local', {
      cache: 'no-store', mode: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    local = await response.json();
  } catch { throw new Error(launchHint); }
  if (local?.app !== 'figure-editor-local' || local.version !== 1 || local.saveClipboardImage !== true || typeof local.token !== 'string' || !local.token) {
    throw new Error(launchHint);
  }
  const dataUrl = asset.originalDataUrl || asset.dataUrl;
  const mime = asset.originalDataUrl ? asset.originalMime : asset.mime;
  if (!extensions[mime] || typeof dataUrl !== 'string' || !dataUrl.startsWith(`data:${mime};base64,`)) {
    throw new Error('The image has no supported embedded source to save.');
  }
  let response;
  try {
    response = await fetch('/api/clipboard-image', {
      method: 'POST', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token },
      body: JSON.stringify({ dataUrl }), signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('Could not save the local source file. Check the Figure Editor terminal and use Locate to retry.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(launchHint); }
  if (!response.ok) throw new Error(result?.error || 'Could not save the local source file. Use Locate to retry.');
  const match = sourcePattern.exec(result?.relativePath || '');
  if (!match || match[1] !== result.fingerprint || match[2] !== extensions[mime]
      || (asset.fingerprint && asset.fingerprint.replace(/^sha256:/, '') !== result.fingerprint)) {
    throw new Error('The local source file could not be verified. Use Locate to retry.');
  }
  return { ...asset, relativePath: result.relativePath, fingerprint: result.fingerprint };
}

export async function savePastedSources(result) {
  const assets = [], warnings = [...(result.warnings || [])];
  let savedSources = 0;
  for (const asset of result.assets) {
    // Preserve provenance even when saving fails, so Locate can retry after reopening.
    const pasted = { ...asset, sourceOrigin: 'clipboard' };
    try {
      assets.push(await saveClipboardAsset(pasted));
      savedSources++;
    } catch (error) {
      assets.push(pasted);
      warnings.push(`${asset.name}: Local source file was not saved. The image is kept in the project. ${error.message}`);
    }
  }
  return { ...result, assets, warnings, savedSources };
}
