/** Script-free, self-contained presentation report. Original project data are never modified. */
import { projectToSVG } from './core.js';
import { validateDeck, slideProject } from './deck.js';

const MAX_REPORT_CHARACTERS = 240 * 1024 * 1024;

function html(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function millimeters(pixels) { return (pixels / 96 * 25.4).toFixed(1); }

function checkReportSize(deck, assets) {
  // Each inline SVG is independently renderable. Count repeated images before allocating large strings.
  let estimate = 20000;
  for (const slide of deck.slides) {
    estimate += 2000 + slide.name.length * 6;
    for (const item of slide.items) {
      if (item.hidden) continue;
      estimate += 2048;
      if (item.type === 'image') {
        const shadow = item.shadow;
        const copies = shadow?.enabled && shadow.transparency < 100 && shadow.size > 0 ? 2 : 1;
        estimate += assets.get(item.assetId).dataUrl.length * copies;
      }
      else if (item.type === 'text') {
        let lines = 1;
        for (let index = 0; index < item.text.length; index++) if (item.text.charCodeAt(index) === 10) lines++;
        // Every line emits its own positioned tspan, including empty lines.
        estimate += item.text.length * 6 + lines * 80;
      }
      if (estimate > MAX_REPORT_CHARACTERS) throw new Error('This HTML report would be too large to generate safely (about 240 MB). Use fewer slides or smaller image copies, or export individual slides.');
    }
  }
}

function slideSVG(deck, slide, index, assets) {
  const items = slide.items.filter(item => !item.hidden);
  const used = new Set(items.filter(item => item.type === 'image').map(item => item.assetId));
  const view = {
    ...slideProject(deck, slide.id), name: slide.name || `Slide ${index + 1}`, items,
    // A report needs rendered copies, not private local paths, fingerprints, or browser binding tokens.
    assets: [...used].map(id => {
      const asset = assets.get(id);
      return { id: asset.id, name: 'Embedded image', mime: asset.mime, dataUrl: asset.dataUrl, width: asset.width, height: asset.height, size: asset.size, lastModified: 0, sourceKind: 'copy' };
    }),
  };
  // These transformations operate only on controlled core-generated SVG, never arbitrary source SVG.
  return projectToSVG(view)
    .replace(/^<\?xml[^>]*\?>\s*/, '')
    .replace(/<metadata>[\s\S]*?<\/metadata>\s*/, '')
    .replace(/<g id="[^"]*"/g, '<g')
    .replace('<svg ', `<svg role="img" aria-label="${html(view.name)}" `);
}

/** Generate a read-only offline HTML document containing every slide in project order. */
export function generateHTMLReport(input) {
  const deck = validateDeck(input);
  const assets = new Map(deck.assets.map(asset => [asset.id, asset]));
  checkReportSize(deck, assets);
  const title = deck.name || 'Untitled figure';
  const slideCount = `${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}`;
  const contents = deck.slides.map((slide, index) => `<li><a href="#slide-${index + 1}"><span class="toc-number">${String(index + 1).padStart(2, '0')}</span><span>${html(slide.name || `Slide ${index + 1}`)}</span></a></li>`).join('\n');
  const slides = deck.slides.map((slide, index) => `<section class="report-slide" id="slide-${index + 1}" aria-labelledby="slide-${index + 1}-title">
  <header class="slide-heading"><div><p class="eyebrow">Slide ${String(index + 1).padStart(2, '0')}</p><h2 id="slide-${index + 1}-title">${html(slide.name || `Slide ${index + 1}`)}</h2></div><a class="back-to-top" href="#report-top">Back to top ↑</a></header>
  <figure><div class="slide-figure">${slideSVG(deck, slide, index, assets)}</div><figcaption>Canvas: ${slide.canvas.width} × ${slide.canvas.height} CSS px · ${millimeters(slide.canvas.width)} × ${millimeters(slide.canvas.height)} mm at 96 px/in.</figcaption></figure>
</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${html(title)} — Figure report</title>
<style>
:root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#25232b;background:#f5f4f1;font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:32px}body{margin:0;line-height:1.55}a{color:inherit}a:focus-visible{outline:3px solid #8b3d76;outline-offset:4px}.layout{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid #dedbd7;padding:32px 22px;background:#fbfaf8}.brand{font-size:13px;font-weight:700;letter-spacing:.05em}.report-type{color:#767079;font-size:12px;margin:5px 0 32px}.sidebar h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#746d76}.toc{list-style:none;margin:14px 0 0;padding:0}.toc li+li{margin-top:8px}.toc a{display:flex;gap:12px;align-items:baseline;padding:8px 9px;border-radius:6px;text-decoration:none;font-size:13px;overflow-wrap:anywhere}.toc a:hover{background:#eee8ee}.toc-number{font-size:11px;flex:0 0 20px;color:#8c4a7c;font-variant-numeric:tabular-nums}.sidebar-note{font-size:12px;color:#767079;margin-top:32px}.main{width:100%;max-width:1300px;padding:48px 5vw 64px}.report-header{margin:0 0 40px;max-width:900px}.eyebrow{text-transform:uppercase;font-weight:700;letter-spacing:.13em;font-size:10px;color:#8c4a7c;margin:0 0 9px}h1{font-size:clamp(25px,3vw,40px);line-height:1.2;margin:0 0 16px;overflow-wrap:anywhere;font-weight:600;letter-spacing:-.025em}.intro{color:#66616a;max-width:780px;font-size:14px;margin:0}.badge{display:inline-block;font-size:11px;letter-spacing:.02em;background:#eee8ef;color:#743560;padding:4px 8px;border-radius:4px;margin-bottom:18px}.report-slide{scroll-margin-top:32px;margin-top:42px}.slide-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:16px}.slide-heading h2{font-size:20px;line-height:1.3;margin:0;font-weight:600;overflow-wrap:anywhere}.back-to-top{flex-shrink:0;font-size:11px;color:#7d6a7c;text-decoration:none}figure{margin:0}.slide-figure{background:#fff;border:1px solid #dedbd7;box-shadow:0 8px 30px #25232b08;overflow:hidden}.slide-figure>svg{display:block;width:100%;height:auto}figcaption{font-size:11px;color:#7b747d;margin-top:10px}.report-notes{border-top:1px solid #dedbd7;margin-top:48px;padding-top:22px;color:#706974;font-size:12px;max-width:900px}.report-notes p{margin:0 0 10px}.report-notes strong{color:#39343d;font-weight:600}.skip-link{position:absolute;top:-80px;left:16px;padding:8px 12px;background:#fff;z-index:2}.skip-link:focus{top:12px}
@media(max-width:850px){.layout{grid-template-columns:1fr}.sidebar{position:static;height:auto;max-height:none;border-right:0;border-bottom:1px solid #dedbd7;padding:22px 24px}.report-type{margin-bottom:18px}.toc{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:3px 12px}.toc li+li{margin-top:0}.sidebar-note{margin:15px 0 0}.main{padding:30px 24px 48px}.report-header{margin-bottom:30px}.report-slide{margin-top:32px}.slide-heading{gap:12px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@page{size:A4 landscape;margin:12mm}
@media print{:root{background:#fff;color:#000}html{scroll-behavior:auto}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.layout{display:block}.sidebar,.back-to-top,.skip-link{display:none}.main{max-width:none;padding:0}.report-header{margin:0 0 8mm;max-width:none}.report-header h1{font-size:26pt}.intro{font-size:10pt}.badge{background:none;border:1px solid #bbb;color:#333}.report-slide{break-before:page;break-inside:avoid;margin:0}.slide-heading{margin:0 0 5mm}.slide-heading h2{font-size:16pt}.eyebrow{font-size:8pt}.slide-figure{border:0;box-shadow:none}.slide-figure>svg{width:100%;height:150mm}figcaption{font-size:8pt;margin-top:3mm}.report-notes{break-before:page;margin-top:0;padding-top:4mm;font-size:9pt}}
</style>
</head>
<body id="report-top">
<a class="skip-link" href="#report-main">Skip to report</a>
<div class="layout">
<aside class="sidebar"><div class="brand">FIGURE EDITOR</div><p class="report-type">Offline HTML report</p><nav aria-label="Slide contents"><h2>Contents · ${slideCount}</h2><ol class="toc">${contents}</ol></nav><p class="sidebar-note">All figures are embedded in this file. Open it locally in a browser, or use the browser’s Print command.</p></aside>
<main class="main" id="report-main">
<header class="report-header"><p class="eyebrow">Figure report · ${slideCount}</p><h1>${html(title)}</h1><span class="badge">Read-only report</span><p class="intro">All slides from this project, in order. This file is for viewing and sharing; keep the .figure.json project to continue editing.</p></header>
${slides}
<footer class="report-notes"><p><strong>About this report.</strong> Text and editor shapes remain vector SVG objects. Imported images, including SVG files flattened during import, remain embedded rasters at their stored resolution. Fonts are not embedded; appearance depends on fonts installed on the viewing computer.</p><p>Report layout scales slides to fit the screen or printed page. Use the dedicated SVG or PNG exports when you need publication dimensions or a specific raster DPI. A browser may rasterize some content when printing.</p><p>This file contains no scripts, external images, or font downloads. Original source files and local file permissions remain in the editable project and browser. Repeated images are embedded in each slide for independent rendering.</p></footer>
</main>
</div>
</body>
</html>`;
}
