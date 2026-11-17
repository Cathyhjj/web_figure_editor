/** Inert, portable native document paired with a rendered PNG asset. */
export function validateHTMLFigure(value) {
  const fail = () => { throw new Error('Invalid editable HTML Figure document.'); };
  if (!value || value.version !== 1 || typeof value.html !== 'string' || !value.html.trim() || value.html.length > 12 * 1024 * 1024) fail();
  if (!Number.isInteger(value.viewportWidth) || value.viewportWidth < 320 || value.viewportWidth > 2400 || ![150, 300, 600].includes(value.dpi)) fail();
  const crop = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = value.crop?.[key];
    if (!Number.isFinite(n) || n < (['width', 'height'].includes(key) ? 1 : 0) || n > (['width', 'height'].includes(key) ? 8000 : 100000)) fail();
    crop[key] = n;
  }
  return { version: 1, html: value.html, viewportWidth: value.viewportWidth, dpi: value.dpi, crop };
}

export function htmlBase64(html) {
  const bytes = new TextEncoder().encode(html); let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

export async function requestHTMLRender(payload, signal) {
  const local = await (await fetch('/api/local', { signal })).json();
  if (!local.htmlFigureImport) throw new Error('Restart the local Figure Editor server to edit HTML Figures.');
  const response = await fetch('/api/html-import', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Figure-Token': local.token }, body: JSON.stringify(payload) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not render the HTML Figure.');
  return result;
}

export async function renderEditedHTML(figure, html, signal) {
  return requestHTMLRender({ name: 'edited-figure.html', data: htmlBase64(html), width: figure.viewportWidth, dpi: figure.dpi, target: { page: 'edited-figure.html', figure: -1 }, frozen: true }, signal);
}

async function capturesAgree(left, right) {
  const images = await Promise.all([left, right].map(async src => { const image = new Image(); image.src = src; await image.decode(); return image; }));
  const width = 460, height = Math.max(1, Math.round(width * images[0].height / images[0].width));
  const pixels = images.map(image => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, width, height); return ctx.getImageData(0, 0, width, height).data; });
  let changed = 0;
  for (let i = 0; i < pixels[0].length; i += 4) if ([0, 1, 2].some(c => Math.abs(pixels[0][i + c] - pixels[1][i + c]) > 16)) changed++;
  return changed / (width * height) < .001;
}

/** Upgrade prior screenshot-only imports from the embedded source, unambiguously. */
export async function editableHTMLFigure(asset, signal) {
  if (asset.htmlFigure) return validateHTMLFigure(asset.htmlFigure);
  if (!['text/html', 'application/zip'].includes(asset.originalMime) || !asset.originalName) throw new Error('Import this HTML or ZIP again to enable native editing.');
  const payload = { name: asset.originalName, data: asset.originalDataUrl.split(',')[1], width: 1440, dpi: 300 };
  const inspected = await requestHTMLRender(payload, signal);
  const matches = inspected.candidates.filter(c => `${asset.originalName} / ${c.page} / ${c.label}`.slice(0, 2000) === asset.relativePath);
  if (matches.length !== 1) throw new Error('The original Figure cannot be identified uniquely. Import the HTML or ZIP again.');
  const c = matches[0], rendered = await requestHTMLRender({ ...payload, target: { page: c.page, figure: c.figure } }, signal);
  if (!rendered.htmlFigure) throw new Error(rendered.warnings?.join(' ') || 'Native editing is unavailable for this Figure.');
  // Older captures did not store viewport width. Never silently reflow one.
  if (Math.abs(rendered.width / rendered.height - asset.width / asset.height) > .002) throw new Error('This older Figure used a different page width. Import it again to enable native editing.');
  if (!await capturesAgree(asset.dataUrl, rendered.dataUrl)) throw new Error('The original page no longer matches this older capture. Import it again to enable native editing.');
  signal?.throwIfAborted();
  return validateHTMLFigure(rendered.htmlFigure);
}
