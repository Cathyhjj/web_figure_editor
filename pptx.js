/** Offline, editable PowerPoint export. CSS pixels are 96/in; OOXML uses 914400 EMU/in. */
import { validateDeck } from './deck.js';

const EMU_PER_PX = 9525;
const EMU_PER_PT = 12700;
const MIN_SLIDE_PX = 96;
const MAX_SLIDE_PX = 56 * 96;
const MAX_EXPORT_BYTES = 240 * 1024 * 1024;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const encoder = new TextEncoder();

function escapeXML(value) {
  // XML 1.0 excludes controls and unpaired UTF-16 surrogates, even in valid JSON.
  return Array.from(String(value), char => {
    const code = char.codePointAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000 ? char : '\uFFFD';
  }).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function emu(px) { return Math.round(px * EMU_PER_PX); }
function error(message) { throw new Error(`PowerPoint export: ${message}`); }
function checkBudget(bytes) {
  if (bytes > MAX_EXPORT_BYTES) error('this deck would be too large to generate safely (about 240 MB). Use fewer text lines, fewer slides, or smaller image copies.');
}

function preflightSize(deck) {
  const assets = new Map(deck.assets.map(asset => [asset.id, asset]));
  const used = new Set();
  let xmlBytes = 20000;
  let mediaBytes = 0;
  for (const slide of deck.slides) {
    xmlBytes += 10000 + slide.name.length * 12;
    for (const item of slide.items) {
      if (item.hidden) continue;
      xmlBytes += 2600 + item.name.length * 6;
      if (item.type === 'text') {
        // Count without split(): hostile newline-heavy text must not allocate XML first.
        let paragraphs = 1;
        for (let i = 0; i < item.text.length; i++) if (item.text.charCodeAt(i) === 10) paragraphs++;
        xmlBytes += item.text.length * 6 + paragraphs * (2000 + item.fontFamily.length * 54);
      } else if (item.type === 'image') {
        const asset = assets.get(item.assetId);
        xmlBytes += asset.name.length * 6;
        if (!used.has(asset.id)) {
          used.add(asset.id);
          // Estimate WebP with source bytes; check its converted PNG size below.
          mediaBytes += (asset.dataUrl.length - asset.dataUrl.indexOf(',') - 1) * 3 / 4;
        }
      }
      checkBudget(xmlBytes + mediaBytes);
    }
  }
  checkBudget(xmlBytes + mediaBytes);
  return xmlBytes;
}

function layoutForDeck(deck) {
  const first = deck.slides[0].canvas;
  const minScale = Math.max(MIN_SLIDE_PX / first.width, MIN_SLIDE_PX / first.height);
  const maxScale = Math.min(MAX_SLIDE_PX / first.width, MAX_SLIDE_PX / first.height);
  if (minScale > maxScale) error('the first slide has an aspect ratio outside PowerPoint’s 1–56 inch slide limits. Adjust its canvas proportions.');
  const scale = Math.min(maxScale, Math.max(1, minScale));
  const width = first.width * scale;
  const height = first.height * scale;
  return {
    width, height, widthInches: width / 96, heightInches: height / 96, scale,
    mixedSizes: deck.slides.some(slide => slide.canvas.width !== first.width || slide.canvas.height !== first.height),
    slides: deck.slides.map(slide => {
      const fit = Math.min(width / slide.canvas.width, height / slide.canvas.height);
      const fittedWidth = slide.canvas.width * fit;
      const fittedHeight = slide.canvas.height * fit;
      return { id: slide.id, scale: fit, x: (width - fittedWidth) / 2, y: (height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight };
    }),
  };
}

/** Report the common slide size and each canvas's proportional fit, all geometry in CSS px. */
export function pptxLayout(input) { return layoutForDeck(validateDeck(input)); }

function color(value) {
  const named = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', gray: '808080', grey: '808080' };
  const input = value.toLowerCase();
  if (input === 'none' || input === 'transparent') return { hex: '000000', alpha: 0 };
  let hex = named[input] ?? input.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = Array.from(hex, char => char + char).join('');
  return { hex: hex.slice(0, 6).toUpperCase(), alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
}
function fill(value, opacity = 1) {
  const { hex, alpha } = color(value);
  const amount = Math.round(alpha * opacity * 100000);
  return amount === 0 ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${hex}">${amount === 100000 ? '' : `<a:alpha val="${amount}"/>`}</a:srgbClr></a:solidFill>`;
}
function line(item, scale) {
  const width = emu(item.strokeWidth * scale);
  if (width > 20116800) error(`the outline of “${item.name}” exceeds PowerPoint’s supported line width after scaling. Reduce the outline width.`);
  if (!width || item.stroke === 'none') return '<a:ln><a:noFill/></a:ln>';
  return `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${fill(item.stroke, item.opacity)}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
}
function transform(item, layout) {
  const rotation = Math.round(((item.rotation % 360 + 360) % 360) * 60000) % 21600000;
  return `<a:xfrm${rotation ? ` rot="${rotation}"` : ''}><a:off x="${emu(layout.x + item.x * layout.scale)}" y="${emu(layout.y + item.y * layout.scale)}"/><a:ext cx="${emu(item.width * layout.scale)}" cy="${emu(item.height * layout.scale)}"/></a:xfrm>`;
}
function nonVisual(id, name, textBox = false) {
  return `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXML(name)}"/><p:cNvSpPr${textBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>`;
}
function shape(item, id, layout) {
  const geometry = item.type === 'line' ? 'line' : 'rect';
  return `<p:sp>${nonVisual(id, item.name)}<p:spPr>${transform(item, layout)}<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${item.type === 'line' ? '<a:noFill/>' : fill(item.fill, item.opacity)}${line(item, layout.scale)}</p:spPr></p:sp>`;
}
function fontFamily(value) {
  const family = value.split(',')[0].trim().replace(/^(['"])(.*)\1$/, '$2');
  return { 'sans-serif': 'Arial', serif: 'Times New Roman', monospace: 'Courier New' }[family.toLowerCase()] ?? (family || 'Arial');
}
function textShape(item, id, layout) {
  // DrawingML sizes are hundredths of a point. CSS px -> pt is exactly 72/96.
  const requestedSize = item.fontSize * layout.scale * 75;
  if (requestedSize > 400000) error(`the text “${item.name}” exceeds PowerPoint’s 4000 pt font limit after scaling. Reduce its font size or increase the first canvas size.`);
  if (requestedSize < 1) error(`the text “${item.name}” becomes smaller than PowerPoint’s supported 0.01 pt scaled text after fitting. Increase its font size or use a larger first canvas.`);
  const spacing = Math.round(requestedSize * 1.2);
  if (spacing > 158400) error(`the line spacing of “${item.name}” exceeds PowerPoint’s supported 1584 pt limit after scaling. Reduce its font size or increase the first canvas size.`);
  const size = Math.max(100, Math.round(requestedSize));
  // PowerPoint's smallest nominal font is 1 pt; fontScale retains sub-point text.
  const autofit = requestedSize < 100 ? `<a:normAutofit fontScale="${Math.round(requestedSize / 100 * 100000)}"/>` : '<a:noAutofit/>';
  const bold = item.fontWeight === 'bold' || Number(item.fontWeight) >= 600;
  const italic = item.fontStyle === 'italic' || item.fontStyle === 'oblique';
  const typeface = escapeXML(fontFamily(item.fontFamily));
  const runStyle = `sz="${size}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}" lang="en-US" dirty="0"`;
  const runContent = `${fill(item.color, item.opacity)}<a:latin typeface="${typeface}"/><a:ea typeface="${typeface}"/><a:cs typeface="${typeface}"/>`;
  const alignment = { left: 'l', center: 'ctr', right: 'r' }[item.align];
  const paragraphs = item.text.split('\n').map(text => `<a:p><a:pPr algn="${alignment}" marL="0" marR="0" indent="0"><a:lnSpc><a:spcPts val="${spacing}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/><a:defRPr ${runStyle}>${runContent}</a:defRPr></a:pPr><a:r><a:rPr ${runStyle}>${runContent}</a:rPr><a:t xml:space="preserve">${escapeXML(text)}</a:t></a:r><a:endParaRPr ${runStyle}>${runContent}</a:endParaRPr></a:p>`).join('');
  return `<p:sp>${nonVisual(id, item.name, true)}<p:spPr>${transform(item, layout)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0" horzOverflow="overflow" vertOverflow="overflow">${autofit}</a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}
function imageShadow(item, layout) {
  const shadow = item.shadow;
  if (!shadow?.enabled) return '';
  // Native DrawingML keeps the effect editable in PowerPoint's Shadow panel.
  // Shadow lengths are points; percentages and clockwise angles are independent
  // of canvas fitting. Center alignment scales the shadow about the picture.
  const blur = Math.round(shadow.blur * EMU_PER_PT * layout.scale);
  const distance = Math.round(shadow.distance * EMU_PER_PT * layout.scale);
  const direction = Math.round(shadow.angle * 60000) % 21600000;
  const size = Math.round(shadow.size * 1000);
  const { hex } = color(shadow.color);
  // The native effect already inherits alphaModFix from the picture's blip;
  // multiplying item.opacity here would attenuate the shadow a second time.
  const alpha = Math.round((1 - shadow.transparency / 100) * 100000);
  return `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${distance}" dir="${direction}" sx="${size}" sy="${size}" algn="ctr" rotWithShape="1"><a:srgbClr val="${hex}"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw></a:effectLst>`;
}
function imageShape(item, asset, id, relationship, layout) {
  const alpha = Math.round(item.opacity * 100000);
  const c = item.crop, percent = value => Math.max(0, Math.round(value * 100000));
  const left = c ? Math.min(99999, percent(c.x)) : 0, top = c ? Math.min(99999, percent(c.y)) : 0;
  const crop = c ? `<a:srcRect l="${left}" t="${top}" r="${Math.min(99999 - left, percent(1 - c.x - c.width))}" b="${Math.min(99999 - top, percent(1 - c.y - c.height))}"/>` : '';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXML(item.name)}" descr="${escapeXML(asset.name)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relationship}">${alpha === 100000 ? '' : `<a:alphaModFix amt="${alpha}"/>`}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(item, layout)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln>${imageShadow(item, layout)}</p:spPr></p:pic>`;
}

const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const namespaces = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
function relationships(entries) {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(({ id, type, target }) => `<Relationship Id="${id}" Type="${type.startsWith('http:') ? type : NS.r + '/' + type}" Target="${escapeXML(target)}"/>`).join('')}</Relationships>`;
}
function slideXML(slide, layout, assets, media) {
  const relationshipsList = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
  const imageRelationships = new Map();
  // A real shape preserves each original canvas background when fitted into a common slide.
  const background = { type: 'rect', name: 'Slide background', x: 0, y: 0, width: slide.canvas.width, height: slide.canvas.height, rotation: 0, opacity: 1, fill: slide.canvas.background, stroke: 'none', strokeWidth: 0 };
  const shapes = [shape(background, 2, layout)];
  for (const item of slide.items) {
    if (item.hidden) continue;
    const id = shapes.length + 2;
    if (item.type === 'image') {
      if (!imageRelationships.has(item.assetId)) {
        const relationship = `rId${relationshipsList.length + 1}`;
        imageRelationships.set(item.assetId, relationship);
        relationshipsList.push({ id: relationship, type: 'image', target: `../media/${media.get(item.assetId).filename}` });
      }
      shapes.push(imageShape(item, assets.get(item.assetId), id, imageRelationships.get(item.assetId), layout));
    } else shapes.push(item.type === 'text' ? textShape(item, id, layout) : shape(item, id, layout));
  }
  // PowerPoint has one common page boundary. Cover fitted-canvas margins so objects
  // extending beyond a smaller source canvas stay clipped, as in SVG/PNG exports.
  // The original objects remain native and editable behind these named masks.
  const pageWidth = layout.width + layout.x * 2;
  const pageHeight = layout.height + layout.y * 2;
  const margins = [];
  if (layout.x > 1e-7) margins.push(
    { name: 'Canvas margin — left', x: 0, y: 0, width: layout.x, height: pageHeight },
    { name: 'Canvas margin — right', x: layout.x + layout.width, y: 0, width: layout.x, height: pageHeight },
  );
  if (layout.y > 1e-7) margins.push(
    { name: 'Canvas margin — top', x: 0, y: 0, width: pageWidth, height: layout.y },
    { name: 'Canvas margin — bottom', x: 0, y: layout.y + layout.height, width: pageWidth, height: layout.y },
  );
  for (const margin of margins) shapes.push(shape(
    { ...margin, type: 'rect', rotation: 0, opacity: 1, fill: 'white', stroke: 'none', strokeWidth: 0 },
    shapes.length + 2, { x: 0, y: 0, scale: 1 },
  ));
  return {
    xml: `${XML}<p:sld ${namespaces}><p:cSld name="${escapeXML(slide.name)}"><p:bg><p:bgPr>${fill('white')}<a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyTree}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    rels: relationships(relationshipsList),
  };
}

async function imageBytes(asset) {
  if (asset.mime !== 'image/webp') {
    const binary = atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1));
    return { bytes: Uint8Array.from(binary, char => char.charCodeAt(0)), extension: asset.mime === 'image/png' ? 'png' : 'jpeg' };
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') error(`converting WebP image “${asset.name}” requires a browser.`);
  const checkDimensions = (width, height) => {
    if (!width || !height || width > 32767 || height > 32767 || width * height > 100000000) error(`WebP image “${asset.name}” exceeds the 100 megapixel or 32767 pixel conversion limit. Use a smaller PNG or JPEG.`);
  };
  checkDimensions(asset.width, asset.height);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { img.onload = null; img.onerror = null; resolve(img); };
    img.onerror = () => reject(new Error(`PowerPoint export: could not decode WebP image “${asset.name}”. Reimport it or convert it to PNG.`));
    img.src = asset.dataUrl;
  });
  checkDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) error(`could not allocate a canvas for WebP image “${asset.name}”. Use a smaller PNG or JPEG.`);
    context.drawImage(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) error(`could not convert WebP image “${asset.name}” to PNG.`);
    checkBudget(blob.size);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: 'png' };
  } finally { canvas.width = 0; canvas.height = 0; }
}

function themeXML() {
  const palette = { dk2: '20212B', lt2: 'F5F3F7', accent1: '714A85', accent2: 'B73779', accent3: 'ED826D', accent4: '4472C4', accent5: '70AD47', accent6: 'FFC000', hlink: '0563C1', folHlink: '954F72' };
  const schemeFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const fonts = '<a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/>';
  return `${XML}<a:theme xmlns:a="${NS.a}" name="Figure Editor"><a:themeElements><a:clrScheme name="Figure Editor"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${Object.entries(palette).map(([name, hex]) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="Arial"><a:majorFont>${fonts}</a:majorFont><a:minorFont>${fonts}</a:minorFont></a:fontScheme><a:fmtScheme name="Figure Editor"><a:fillStyleLst>${schemeFill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 19050, 28575].map(width => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${schemeFill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${schemeFill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
function masterXML() {
  return `${XML}<p:sldMaster ${namespaces}><p:cSld name="Figure Editor"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
}
function contentTypes(deck, media) {
  const types = [
    ['ppt/presentation.xml', 'presentationml.presentation.main'],
    ['ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster'],
    ['ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout'],
    ['ppt/theme/theme1.xml', 'theme'],
    ['docProps/app.xml', 'extended-properties'],
    ...deck.slides.map((_, i) => [`ppt/slides/slide${i + 1}.xml`, 'presentationml.slide']),
  ];
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...new Set([...media.values()].map(value => value.extension))].map(extension => `<Default Extension="${extension}" ContentType="image/${extension}"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${types.map(([path, type]) => `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`;
}
function coreProperties(deck) {
  const now = new Date().toISOString();
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXML(deck.name)}</dc:title><dc:creator>Figure Editor</dc:creator><dc:description>Editable Figure Editor slides. Text and shapes remain native; imported images remain separate raster images. Fonts are referenced, not embedded.</dc:description><cp:lastModifiedBy>Figure Editor</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}
function appProperties(deck) {
  return `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Figure Editor</Application><PresentationFormat>Custom</PresentationFormat><Slides>${deck.slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant><vt:variant><vt:i4>${deck.slides.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${deck.slides.length}" baseType="lpstr">${deck.slides.map(slide => `<vt:lpstr>${escapeXML(slide.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts><AppVersion>1.0</AppVersion></Properties>`;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  // Stored ZIP entries need no library or network. PNG/JPEG are already compressed.
  const parts = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  for (const [path, value] of entries) {
    const name = encoder.encode(path);
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    checkBudget(offset + centralSize + bytes.length + name.length * 2 + 98);
    if (offset + bytes.length + name.length + 30 > 0xffffffff) error('this deck exceeds the supported 4 GB archive size.');
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names.
    view.setUint16(12, 33, true); // ZIP epoch: 1980-01-01.
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, bytes);
    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(8, 0x0800, true);
    recordView.setUint16(14, 33, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, bytes.length, true);
    recordView.setUint32(24, bytes.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    centralSize += record.length;
    offset += local.length + bytes.length;
  }
  if (entries.length > 65535 || offset + centralSize + 22 > 0xffffffff) error('this deck exceeds the supported ZIP archive limits.');
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: PPTX_MIME });
}

/** Export all slides in order without changing the deck, assets, or active slide. */
export async function exportPPTX(input) {
  const deck = validateDeck(input);
  const layout = layoutForDeck(deck);
  const xmlBudget = preflightSize(deck);
  const assets = new Map(deck.assets.map(asset => [asset.id, asset]));
  const media = new Map();
  let mediaSize = 0;
  for (const slide of deck.slides) for (const item of slide.items) {
    if (item.type !== 'image' || item.hidden || media.has(item.assetId)) continue;
    const encoded = await imageBytes(assets.get(item.assetId));
    mediaSize += encoded.bytes.length;
    checkBudget(xmlBudget + mediaSize);
    media.set(item.assetId, { ...encoded, filename: `image${media.size + 1}.${encoded.extension}` });
  }
  const presentation = `${XML}<p:presentation ${namespaces} autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(layout.width)}" cy="${emu(layout.height)}" type="custom"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const entries = [
    ['[Content_Types].xml', contentTypes(deck, media)],
    ['_rels/.rels', relationships([
      { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
    ])],
    ['docProps/core.xml', coreProperties(deck)], ['docProps/app.xml', appProperties(deck)],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', relationships([
      { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      ...deck.slides.map((_, i) => ({ id: `rId${i + 2}`, type: 'slide', target: `slides/slide${i + 1}.xml` })),
    ])],
    ['ppt/slideMasters/slideMaster1.xml', masterXML()],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' },
    ])],
    ['ppt/slideLayouts/slideLayout1.xml', `${XML}<p:sldLayout ${namespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }])],
    ['ppt/theme/theme1.xml', themeXML()],
  ];
  for (const [index, slide] of deck.slides.entries()) {
    const content = slideXML(slide, layout.slides[index], assets, media);
    entries.push([`ppt/slides/slide${index + 1}.xml`, content.xml], [`ppt/slides/_rels/slide${index + 1}.xml.rels`, content.rels]);
  }
  for (const entry of media.values()) entries.push([`ppt/media/${entry.filename}`, entry.bytes]);
  return zip(entries);
}
