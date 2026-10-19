/** Reveal source images through the local macOS launcher; never send image contents. */
const launchHint = 'To use Locate, restart Figure Editor with start.command (or npm start), then reload this page.';

export async function locateAsset(asset) {
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
  if (!local || local.app !== 'figure-editor-local' || local.version !== 1 || typeof local.token !== 'string' || !local.token) {
    throw new Error(launchHint);
  }
  if (!local.locate) throw new Error('Locate is available on macOS.');
  const source = {};
  for (const key of ['id', 'name', 'relativePath', 'fingerprint', 'linkToken']) {
    if (typeof asset?.[key] === 'string') source[key] = asset[key];
  }
  let response;
  try {
    response = await fetch('/api/locate', {
      method: 'POST', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token },
      body: JSON.stringify({ asset: source }), signal: AbortSignal.timeout(150000),
    });
  } catch { throw new Error('Could not reach Finder. Check the local Figure Editor terminal and try Locate again.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(launchHint); }
  if (!response.ok) throw new Error(result?.error || 'Could not show the source image in Finder.');
  if (!['revealed', 'cancelled'].includes(result?.status)) throw new Error('Finder returned an unexpected response. Try Locate again.');
  return result.status;
}
