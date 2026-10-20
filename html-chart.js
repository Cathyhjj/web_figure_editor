/** Executable chart documents live only in an opaque-origin sandbox. */
export const HTML_MIME = 'text/html';
export const HTML_CDNS = 'https://cdn.plot.ly https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com';
export const CHART_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${HTML_CDNS}; style-src 'unsafe-inline' ${HTML_CDNS}; img-src data: blob: ${HTML_CDNS}; font-src data: ${HTML_CDNS}; connect-src ${HTML_CDNS}; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri https://figure-editor.invalid; form-action 'none'`;

export function looksLikeHTML(bytes) {
  const start = new TextDecoder().decode(bytes.subarray(0, 8192)).replace(/^\uFEFF/, '').trimStart().replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  return /^<!doctype\s+html\b/i.test(start) || /^<(?:html|head|body|div|script|style|meta|link)\b/i.test(start);
}

export function htmlSource(asset) {
  const bytes = Uint8Array.from(atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// This function is serialized into the child document, never run in the editor.
function chartBridge(channel) {
  const send = (kind, details = {}) => parent.postMessage({ channel, kind, ...details }, '*');
  addEventListener('keydown', e => { if (e.key === 'Escape') send('escape'); }, true);
  addEventListener('error', () => send('warning', { message: 'A chart resource failed to load. Use a self-contained HTML export or an allowed chart CDN.' }), true);
  addEventListener('securitypolicyviolation', () => send('warning', { message: 'This chart uses a blocked resource. Embed local scripts, data and images in the HTML file.' }));
  const loadImage = src => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Could not render this chart as a PNG.')); image.src = src;
  });
  async function chartInViewport(dataUrl, box) {
    const image = await loadImage(dataUrl), canvas = document.createElement('canvas');
    canvas.width = innerWidth * 2; canvas.height = innerHeight * 2;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, box.left * 2, box.top * 2, box.width * 2, box.height * 2);
    return canvas.toDataURL('image/png');
  }
  async function capture() {
    const plots = document.querySelectorAll('.js-plotly-plot'), plot = plots[0];
    if (plots.length > 1 || document.querySelectorAll('[_echarts_instance_]').length > 1) throw new Error('This HTML contains multiple charts. Export each chart as a separate HTML file to save a faithful snapshot.');
    if (plot && window.Plotly?.toImage) {
      const box = plot.getBoundingClientRect();
      return chartInViewport(await window.Plotly.toImage(plot, { format: 'png', width: plot.clientWidth, height: plot.clientHeight, scale: 2 }), box);
    }
    if (window.echarts?.getInstanceByDom) {
      for (const node of document.querySelectorAll('[_echarts_instance_]')) {
        const chart = window.echarts.getInstanceByDom(node);
        if (chart) return chartInViewport(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' }), node.getBoundingClientRect());
      }
    }
    const nodes = [...document.querySelectorAll('svg,canvas')].filter(node => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return !node.parentElement?.closest('svg') && box.width > 20 && box.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    });
    if (!nodes.length) throw new Error('No capturable chart found. Plotly, ECharts, SVG and canvas charts support snapshots; other HTML can still be viewed interactively.');
    // Composite all visible SVG/canvas surfaces at their document positions.
    const canvas = document.createElement('canvas'); canvas.width = innerWidth * 2; canvas.height = innerHeight * 2;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.scale(2, 2);
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      if (node.localName === 'canvas') ctx.drawImage(node, box.left, box.top, box.width, box.height);
      else {
        const copy = node.cloneNode(true), originals = [node, ...node.querySelectorAll('*')], copies = [copy, ...copy.querySelectorAll('*')];
        originals.forEach((original, index) => {
          const style = getComputedStyle(original);
          for (const key of ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'text-decoration', 'opacity', 'visibility', 'display', 'paint-order', 'vector-effect', 'transform', 'transform-origin', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']) {
            const value = style.getPropertyValue(key).replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, 'url(#$1)');
            copies[index].style.setProperty(key, value);
          }
        });
        copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); copy.setAttribute('width', box.width); copy.setAttribute('height', box.height);
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
        try { ctx.drawImage(await loadImage(url), box.left, box.top, box.width, box.height); } finally { URL.revokeObjectURL(url); }
      }
    }
    return canvas.toDataURL('image/png');
  }
  addEventListener('message', async event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.kind !== 'capture') return;
    const request = event.data.request;
    try { send('snapshot', { request, dataUrl: await capture() }); }
    catch (error) { send('capture-error', { request, message: String(error.message).slice(0, 500) }); }
  });
  addEventListener('load', () => send('ready'));
}

export function chartDocument(source, channel) {
  // Policy and base precede ALL imported markup, including an imported <head>.
  // Additional policies in the source can only restrict this policy further.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CHART_CSP}"><base href="https://figure-editor.invalid/"><style>html,body{margin:0;width:100%;height:100%;}body{overflow:auto}</style><script>(${chartBridge.toString()})(${JSON.stringify(channel).replace(/</g, '\\u003c')})</script></head><body>${source}</body></html>`;
}

export function validateSnapshot(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 12 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error('The chart returned an invalid or oversized PNG snapshot.');
  const header = Uint8Array.from(atob(dataUrl.split(',')[1].slice(0, 44)), c => c.charCodeAt(0));
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => header[i] === v) || header.length < 24) throw new Error('The chart snapshot is not a PNG.');
  const view = new DataView(header.buffer), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('The chart snapshot dimensions are too large.');
  return { posterDataUrl: dataUrl, posterWidth: width, posterHeight: height, hasSnapshot: true };
}

export function createChartFrame(asset, { onEscape = () => {}, onWarning = () => {} } = {}) {
  const source = htmlSource(asset);
  const frame = document.createElement('iframe'), channel = crypto.randomUUID(), pending = new Map();
  frame.title = `Interactive chart: ${asset.name}`; frame.className = 'html-chart-frame';
  frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('credentialless', ''); frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  let resolveReady, readyTimer;
  const ready = new Promise(resolve => { resolveReady = resolve; readyTimer = setTimeout(() => resolve(false), 12000); });
  const listener = event => {
    if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;
    const data = event.data;
    if (data.kind === 'ready') { clearTimeout(readyTimer); resolveReady(true); }
    else if (data.kind === 'escape') onEscape();
    else if (data.kind === 'warning') onWarning(String(data.message).slice(0, 500));
    else if (pending.has(data.request) && ['snapshot', 'capture-error'].includes(data.kind)) {
      const job = pending.get(data.request); clearTimeout(job.timer); pending.delete(data.request);
      if (data.kind === 'capture-error') job.reject(new Error(String(data.message).slice(0, 500)));
      else { try { job.resolve(validateSnapshot(data.dataUrl)); } catch (error) { job.reject(error); } }
    }
  };
  window.addEventListener('message', listener);
  frame.srcdoc = chartDocument(source, channel);
  return {
    frame, ready,
    async capture() {
      if (!await ready) throw new Error('Chart loading timed out. Check that its scripts and data are embedded or available.');
      return new Promise((resolve, reject) => {
        const request = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(request); reject(new Error('Chart snapshot timed out. The interactive chart is still available.')); }, 12000);
        pending.set(request, { resolve, reject, timer }); frame.contentWindow.postMessage({ channel, kind: 'capture', request }, '*');
      });
    },
    dispose() {
      clearTimeout(readyTimer); resolveReady(false); window.removeEventListener('message', listener);
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Chart closed.')); }
      pending.clear(); frame.remove();
    },
  };
}

export async function readHTMLMetadata(bytes, name) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!source.trim() || !looksLikeHTML(bytes)) throw new Error('Choose a complete UTF-8 HTML chart document.');
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600;
  const context = canvas.getContext('2d'); context.fillStyle = '#f7f3f9'; context.fillRect(0, 0, 960, 600);
  context.fillStyle = '#743560'; context.font = '28px sans-serif'; context.fillText('Interactive HTML chart', 50, 260);
  context.fillStyle = '#51485a'; context.font = '20px sans-serif'; context.fillText(String(name).slice(0, 65), 50, 310);
  context.fillText('Double-click to interact', 50, 355);
  return { width: 960, height: 600, posterWidth: 960, posterHeight: 600, posterDataUrl: canvas.toDataURL('image/png'), hasSnapshot: false };
}

export function requireHTMLSnapshots(project) {
  const items = project.items || project.slides.flatMap(slide => slide.items);
  for (const item of items) {
    if (item.type !== 'html' || item.hidden || item.opacity === 0) continue;
    const asset = project.assets.find(asset => asset.id === item.assetId);
    if (!asset?.hasSnapshot) throw new Error(`“${asset?.name || item.name}” needs a chart snapshot for static export. Double-click the chart, then click Save snapshot.`);
  }
}

/** PPTX keeps videos but represents HTML charts as static images. */
export function htmlPosterDeck(deck) {
  requireHTMLSnapshots(deck);
  return { ...deck,
    slides: deck.slides.map(slide => ({ ...slide, items: slide.items.map(item => item.type === 'html' ? { ...item, type: 'image' } : item) })),
    assets: deck.assets.map(asset => {
      if (asset.mime !== HTML_MIME) return asset;
      const { posterDataUrl, posterWidth, posterHeight, hasSnapshot, ...copy } = asset;
      return { ...copy, mime: 'image/png', dataUrl: posterDataUrl, width: posterWidth, height: posterHeight };
    }),
  };
}
