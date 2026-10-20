import { createDeck, validateDeck, slideProject } from '../deck.js';
import { importFiles, importFolderFiles, replaceAsset, refreshAsset } from '../assets.js';
import { generateHTMLReport } from '../report.js';
import { exportPNG } from '../core.js';
import { exportPDF } from '../pdf.js';
const run = document.querySelector('#run'), results = document.querySelector('#results');
function check(name, pass) {
  const row = document.createElement('li'); row.dataset.pass = String(!!pass); row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`; results.append(row);
  if (!pass) throw new Error(name);
}
function unzip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), n = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true), start = at + 30 + n + extra;
    files.set(new TextDecoder().decode(bytes.slice(at + 30, at + 30 + n)), bytes.slice(start, start + size)); at = start + size;
  }
  return files;
}
run.onclick = async () => {
  run.disabled = true; results.replaceChildren(); let restore = () => {};
  try {
    if (location.port !== '18766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use isolated test port 18766.');
    const bytes = await (await fetch('./fixtures/video.mp4')).arrayBuffer();
    const file = new File([bytes], 'motion.mp4', { type: 'video/mp4', lastModified: 123 });
    const imported = await importFiles([file]);
    check('Real H.264/AAC MP4 decodes with dimensions, duration and PNG poster', !imported.errors.length && imported.assets[0]?.duration === 6 && imported.assets[0].width === 320 && imported.assets[0].posterDataUrl.startsWith('data:image/png;'));
    const asset = imported.assets[0];
    check('Original MP4 bytes retained without re-encoding', atob(asset.dataUrl.split(',')[1]).length === bytes.byteLength);
    const folderFile = new File([bytes], 'nested.mp4', { type: 'video/mp4' }); Object.defineProperty(folderFile, 'webkitRelativePath', { value: 'Study/movies/nested.mp4' });
    const folder = await importFolderFiles([folderFile]);
    check('Folder import retains nested MP4 path', folder.assets[0]?.relativePath === 'Study/movies/nested.mp4' && !folder.errors.length);
    const linked = await importFiles([file], new Map([[file, { kind: 'file', getFile: async () => file, queryPermission: async () => 'granted' }]]));
    const refreshed = await refreshAsset(linked.assets[0]);
    check('Refresh updates video metadata and preserves identity', refreshed.id === linked.assets[0].id && refreshed.duration === 6 && refreshed.dataUrl === asset.dataUrl);
    const png = new File([await (await fetch('./fixtures/video-poster.png')).arrayBuffer()], 'poster.png', { type: 'image/png' });
    let rejected = false; try { await replaceAsset(asset, png); } catch { rejected = true; }
    check('Relink cannot accidentally change a video into an image', rejected);
    const deck = createDeck(); deck.name = 'MP4 playback test'; deck.assets = [asset];
    deck.slides[0].items = [{ id: 'movie', type: 'video', assetId: asset.id, name: 'Motion test', x: 60, y: 100, width: 640, height: 360 }];
    const saved = validateDeck(JSON.parse(JSON.stringify(deck)));
    check('Save and reopen retain video original and poster', saved.assets[0].dataUrl === asset.dataUrl && saved.assets[0].posterDataUrl === asset.posterDataUrl);
    const view = slideProject(saved);
    check('PNG export renders the video poster', (await exportPNG(view, 96)).size > 1000);
    check('PDF export renders the video poster', (await exportPDF(view)).size > 1000);
    const report = generateHTMLReport(saved); check('HTML report uses poster without full MP4 payload', report.includes(asset.posterDataUrl) && !report.includes(asset.dataUrl));
    const iframe = document.createElement('iframe'); iframe.title = 'Video test editor';
    const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = reject; }); iframe.src = '../index.html'; document.querySelector('#editor-host').replaceChildren(iframe); await loaded;
    const win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    const originalConfirm = win.confirm, originalClick = win.HTMLAnchorElement.prototype.click, originalURL = win.URL.createObjectURL;
    const urls = new Map(), downloads = [];
    win.confirm = () => true; win.URL.createObjectURL = blob => { const url = originalURL.call(win.URL, blob); urls.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: urls.get(this.href) }); else originalClick.call(this); };
    restore = () => { win.confirm = originalConfirm; win.HTMLAnchorElement.prototype.click = originalClick; win.URL.createObjectURL = originalURL; for (const url of urls.keys()) win.URL.revokeObjectURL(url); };
    const open = async deck => { const transfer = new win.DataTransfer(); transfer.items.add(new win.File([JSON.stringify(deck)], 'test.figure.json', { type: 'application/json' })); get('project-input').files = transfer.files; await get('project-input').onchange({ target: get('project-input') }); };
    await new Promise((resolve, reject) => {
      if (!get('open-project').disabled) return resolve();
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Editor draft restore timed out')); }, 15000);
      const observer = new win.MutationObserver(() => { if (!get('open-project').disabled) { clearTimeout(timer); observer.disconnect(); resolve(); } });
      observer.observe(get('open-project'), { attributes: true, attributeFilter: ['disabled'] });
    });
    await open(createDeck());
    const transfer = new win.DataTransfer(); transfer.items.add(new win.File([bytes], 'motion.mp4', { type: 'video/mp4' })); get('file-input').files = transfer.files; await get('file-input').onchange({ target: get('file-input') });
    check('Editor file input imports MP4 onto canvas with preview control', !!doc.querySelector('#stage image') && !!get('preview-video') && get('status').textContent.includes('Imported 1 asset'));
    get('undo').click(); check('Undo removes imported video', !doc.querySelector('#stage image'));
    get('redo').click(); check('Redo restores video and poster', !!doc.querySelector('#stage image') && !!doc.querySelector('[data-action="preview"]'));
    doc.querySelector('#layer-list .layer-select').click();
    get('preview-video').click();
    const player = get('video-player'); player.muted = true; await player.play();
    await new Promise(resolve => { const start = player.currentTime; const listener = () => { if (player.currentTime > start + .25) { player.removeEventListener('timeupdate', listener); resolve(); } }; player.addEventListener('timeupdate', listener); });
    check('Preview video actually advances playback time', !player.paused && player.currentTime > .25 && get('video-dialog').open);
    get('video-close').click(); await new Promise(resolve => win.requestAnimationFrame(resolve));
    check('Closing preview releases video playback', !get('video-dialog').open && !player.getAttribute('src'));
    get('export-open').click(); get('export-format').value = 'pptx'; get('export-format').onchange(); await get('export-submit').onclick();
    const download = downloads.at(-1); check('Editor exports PPTX through the Export dialog', download?.name.endsWith('.pptx') && download.blob?.size > bytes.byteLength);
    const files = unzip(await download.blob.arrayBuffer());
    const video = [...files.entries()].find(([name]) => name.endsWith('.mp4'))?.[1];
    check('Downloaded PPTX contains byte-identical MP4', video?.length === bytes.byteLength && video.every((byte, i) => byte === new Uint8Array(bytes)[i]));
    const slideXML = new TextDecoder().decode(files.get('ppt/slides/slide1.xml'));
    check('Downloaded PPTX contains poster, embedded media and click-play timing', files.has('ppt/media/poster1.png') && slideXML.includes('ppaction://media') && slideXML.includes('<p:timing>') && slideXML.includes('<p14:media'));
    document.title = 'PASS — MP4 import and PPTX checks';
  } catch (error) { const row = document.createElement('li'); row.dataset.pass = 'false'; row.textContent = `ERROR — ${error.stack || error.message}`; results.append(row); document.title = 'FAIL — MP4 checks'; }
  finally { restore(); run.disabled = false; }
};
