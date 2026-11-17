// Dedicated offline Chromium process. No npm runtime dependencies, sockets or user profile.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { freezeHTMLFigure } from './html-freeze.js';

const [chrome, temporary, destination] = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input), origin = 'https://html-import.invalid';
const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://html-import.invalid data: blob:; style-src 'unsafe-inline' https://html-import.invalid data:; img-src https://html-import.invalid data: blob:; font-src https://html-import.invalid data:; connect-src https://html-import.invalid; frame-src 'self' data: blob:; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; sandbox allow-scripts allow-same-origin";
const child = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${path.join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-crash-reporter', '--disable-features=Translate,MediaRouter', '--mute-audio', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', session;
const pending = new Map(), warnings = new Set();
function send(method, params = {}, sessionId = session) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
function failPending(message) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } pending.clear(); }
child.on('error', () => failPending('Could not start Chromium.'));
child.on('exit', () => failPending('The HTML renderer closed unexpectedly.'));
child.stdio[4].setEncoding('utf8');
child.stdio[4].on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\0')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const call = pending.get(message.id);
    if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
    else if (message.method === 'Fetch.requestPaused') void respond(message.params, message.sessionId).catch(() => {});
    else if (message.method === 'Runtime.exceptionThrown') warnings.add('A page script reported an error; check the preview before importing.');
    else if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security' && message.params.entry.level === 'error') warnings.add('The page requested blocked resources or capabilities. Include required resources in the ZIP or HTML and check the preview.');
  }
});
async function respond(event, sessionId) {
  const url = new URL(event.request.url);
  let file;
  try { const name = decodeURIComponent(url.pathname.slice(1)); file = url.origin === origin && Object.hasOwn(job.files, name) && job.files[name]; } catch {}
  if (!file || event.request.method !== 'GET') {
    if (url.pathname !== '/favicon.ico') warnings.add(`Resource unavailable or blocked: ${url.pathname.slice(0, 120)}. Include required resources in the ZIP or HTML.`);
    return send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sessionId);
  }
  return send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, body: file.data,
    responseHeaders: [{ name: 'Content-Type', value: file.mime + (file.mime.startsWith('text/') ? '; charset=utf-8' : '') }, { name: 'Content-Security-Policy', value: job.frozen ? policy.replace(/script-src [^;]+;/, "script-src 'none';") : policy }, { name: 'X-Content-Type-Options', value: 'nosniff' }] }, sessionId);
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 12000 });
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || 'The HTML page could not be inspected.').split('\n')[0].replace(/^Error: /, '').slice(0, 500));
  return result.result.value;
}
const urlFor = name => origin + '/' + name.split('/').map(encodeURIComponent).join('/');
async function load(name) {
  await send('Page.navigate', { url: urlFor(name) });
  const readiness = await evaluate(`(async()=>{for(let i=0;i<100&&document.readyState!=='complete';i++)await new Promise(r=>setTimeout(r,50));await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,3000))]);await Promise.race([Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,3000))]);await new Promise(r=>setTimeout(r,500));return {images:[...document.images].some(i=>!i.complete||!i.naturalWidth),fonts:document.fonts.status!=='loaded'}})()`);
  if (readiness.images || readiness.fonts) warnings.add('Some images or fonts did not finish loading. Check the preview before importing.');
}
// JSON-only extraction of embedded HTML galleries, without evaluating their wrapper script.
function galleryPages(source) {
  const match = /\b(?:const|let|var)\s+pages\s*=\s*(\[)/.exec(source);
  if (!match) return [];
  const rest = source.slice(match.index + match[0].length - 1);
  let quoted = false, escaped = false;
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === ']') {
      try { const pages = JSON.parse(rest.slice(0, i + 1)); return Array.isArray(pages) && pages.length <= 32 && pages.every(p => typeof p === 'string' && /<html\b/i.test(p)) ? pages : []; } catch { return []; }
    }
  }
  return [];
}
// A gallery wrapper may replace navigation and source-download links. Everything
// else must agree before suppressing an embedded copy; titles alone are not IDs.
function documentKey(source) {
  return source.replace(/href="[^"]*"\s+download/g, 'href="embedded-source" download')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, nav => nav.replace(/\s(?:href|onclick)="[^"]*"/g, ''));
}
const documents = [];
const directDocuments = new Set(job.documents.map(name => documentKey(Buffer.from(job.files[name].data, 'base64').toString('utf8'))));
let preparationError;
for (const name of job.documents) {
  const pages = job.frozen ? [] : galleryPages(Buffer.from(job.files[name].data, 'base64').toString('utf8'));
  if (!pages.length) { documents.push(name); continue; }
  for (const [index, source] of pages.entries()) {
    if (directDocuments.has(documentKey(source))) continue;
    const virtual = path.posix.join(path.posix.dirname(name), `__gallery_${path.posix.basename(name)}_${index + 1}.html`);
    if (Object.hasOwn(job.files, virtual)) { preparationError = 'A generated gallery page conflicts with a package file.'; continue; }
    job.files[virtual] = { data: Buffer.from(source).toString('base64'), mime: 'text/html' }; documents.push(virtual);
  }
}
if (!documents.length || documents.length > 32) preparationError = 'The package must contain 1–32 distinct pages.';

async function regions() {
  return evaluate(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x+scrollX)),y:Math.max(0,Math.floor(r.y+scrollY)),width:Math.ceil(r.width),height:Math.ceil(r.height)}};
    const figures=[...document.querySelectorAll('figure')].filter(n=>!n.parentElement.closest('figure')).map((n,index)=>({...rect(n),figure:index,label:(n.querySelector('.figtitle label')?.textContent||n.getAttribute('aria-label')||'Figure '+(index+1)).trim().slice(0,160),heading:(n.querySelector('h1,h2,h3')?.textContent||n.querySelector('figcaption')?.textContent||'').trim().slice(0,160)})).filter(r=>r.width>1&&r.height>1);
    return {title:(document.title||'HTML page').slice(0,240),figures,page:{x:0,y:0,width:Math.max(innerWidth,document.documentElement.scrollWidth),height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)},nested:document.querySelectorAll('iframe').length}})()`);
}
async function capture(rect, dpi, preview = false) {
  if (rect.width > 8000 || rect.height > 8000 || rect.width * rect.height > 25_000_000) throw new Error('This region is too large. Choose an individual Figure or a narrower page width.');
  // Round source pixels up so a nominal 300 DPI capture never fails the editor's
  // quality check merely because Chromium rounded a fractional pixel downward.
  const requestedScale = Math.max(Math.ceil(rect.width * dpi / 96) / rect.width, Math.ceil(rect.height * dpi / 96) / rect.height);
  const scale = preview ? Math.min(1, 460 / rect.width, 500 / rect.height) : Math.min(requestedScale, 16384 / rect.width, 16384 / rect.height, Math.sqrt(39_000_000 / (rect.width * rect.height)));
  if (!preview && scale < dpi / 96 - .001) warnings.add(`Capture resolution was limited to ${Math.floor(scale * 96)} DPI to fit the image size limit.`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale } });
  const png = Buffer.from(data, 'base64');
  if (png.length > 25 * 1024 * 1024) throw new Error('The rendered image exceeds 25 MB. Choose a lower resolution.');
  return { dataUrl: 'data:image/png;base64,' + data, pixelWidth: png.readUInt32BE(16), pixelHeight: png.readUInt32BE(20), effectiveDpi: scale * 96 };
}
const watchdog = setTimeout(() => child.kill('SIGKILL'), 100000);
try {
  if (preparationError) throw new Error(preparationError);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  session = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
  await send('Browser.setDownloadBehavior', { behavior: 'deny' }, null);
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: job.width, height: 900, deviceScaleFactor: 1, mobile: false });
  let result;
  if (job.target) {
    if (!documents.includes(job.target.page)) throw new Error('The selected page is no longer available. Inspect the file again.');
    await load(job.target.page); const found = await regions();
    const rect = job.frozen ? await evaluate(`(()=>{const roots=document.querySelectorAll('[data-fe-root="figure"]');if(roots.length!==1)throw Error('Missing Figure');const r=roots[0].getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x+scrollX)),y:Math.max(0,Math.floor(r.y+scrollY)),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`) : job.target.figure === -1 ? found.page : found.figures.find(f => f.figure === job.target.figure);
    if (!rect) throw new Error('The selected Figure is no longer available. Inspect the file again.');
    const { x, y, width, height } = rect;
    result = { ...await capture({ x, y, width, height }, job.dpi), width, height, title: found.title, label: rect.label || 'Full page', target: job.target };
    try {
      const html = job.frozen ? Buffer.from(job.files[job.target.page].data, 'base64').toString('utf8') : await evaluate(`(${freezeHTMLFigure.toString()})(${job.target.figure})`);
      if (Buffer.byteLength(html) > 12 * 1024 * 1024) throw new Error('The editable document exceeds 12 MB. Its image is preserved.');
      if (!job.frozen) {
        const before = await capture({ x, y, width, height }, 96, true);
        const virtual = '__frozen_' + Date.now() + '.html'; job.files[virtual] = { data: Buffer.from(html).toString('base64'), mime: 'text/html' };
        job.frozen = true;
        try {
          await load(virtual);
          const bounds = await evaluate(`(()=>{const r=document.querySelector('[data-fe-root="figure"]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x+scrollX)),y:Math.max(0,Math.floor(r.y+scrollY)),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
          if (bounds.width !== width || bounds.height !== height) throw new Error('Freezing this document changes its layout.');
          const after = await capture(bounds, 96, true);
          const difference = await evaluate(`(async()=>{const sources=${JSON.stringify([before.dataUrl, after.dataUrl])};const images=await Promise.all(sources.map(src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src})));const pixels=images.map(i=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,c.width,c.height).data});if(pixels[0].length!==pixels[1].length)return 1;let changed=0;for(let i=0;i<pixels[0].length;i+=4)if([0,1,2].some(c=>Math.abs(pixels[0][i+c]-pixels[1][i+c])>12))changed++;return changed/(pixels[0].length/4)})()`);
          if (difference > .001) throw new Error('Freezing this document changes its appearance.');
        } finally { job.frozen = false; delete job.files[virtual]; }
      }
      result.htmlFigure = { version: 1, html, viewportWidth: job.width, dpi: job.dpi, crop: { x, y, width, height } };
    } catch (error) {
      if (job.frozen) throw error;
      warnings.add('Native editing is unavailable for this Figure. ' + error.message);
    }
  } else {
    const candidates = [];
    for (const name of documents) {
      await load(name); const found = await regions();
      if (found.nested) warnings.add('This page contains nested frames. Use the preview to check their contents; embedded pages[] galleries are split automatically.');
      for (const region of [...found.figures, { ...found.page, figure: -1, label: 'Full page', heading: '' }]) {
        if (candidates.length >= 100) throw new Error('The package contains more than 100 page and Figure candidates. Import a smaller package.');
        const { x, y, width, height, figure, label, heading } = region;
        if (width > 8000 || height > 8000 || width * height > 25_000_000) { warnings.add(`${found.title}: an oversized region was skipped. Choose individual Figures.`); continue; }
        candidates.push({ page: name, figure, title: found.title, label, heading, width, height, preview: (await capture({ x, y, width, height }, 96, true)).dataUrl });
      }
    }
    result = { candidates };
  }
  result.warnings = [...warnings].slice(0, 20);
  await fs.writeFile(destination, JSON.stringify(result));
} catch (error) { process.stderr.write(String(error.message).slice(0, 500) + '\n'); process.exitCode = 1; }
finally { clearTimeout(watchdog); child.kill('SIGKILL'); }
