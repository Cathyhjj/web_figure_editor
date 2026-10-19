import { createDeck, validateDeck, slideProject } from '../deck.js';
import { exportPNG, projectToSVG } from '../core.js';
import { generateHTMLReport } from '../report.js';

const checks = [];
const results = document.querySelector('#results');
const run = document.querySelector('#run');
const shadowProperties = ['color', 'transparency', 'size', 'blur', 'angle', 'distance'];

function check(name, pass) {
  checks.push({ name, pass: !!pass });
  const row = document.createElement('li');
  row.dataset.pass = String(!!pass);
  row.textContent = `${pass ? 'PASS' : 'FAIL'} — ${name}`;
  results.append(row);
}

async function loadEditor() {
  const iframe = document.createElement('iframe');
  iframe.title = 'Editor under image shadow integration test';
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The editor did not finish loading.')), 15000);
    iframe.onload = () => { clearTimeout(timeout); resolve(); };
    iframe.onerror = () => { clearTimeout(timeout); reject(new Error('Could not load the editor.')); };
  });
  iframe.src = `../index.html?shadow-checks=${Date.now()}`;
  document.querySelector('#editor-host').replaceChildren(iframe);
  await loaded;
  // Import the same module URL so app.js finishes draft restoration before the
  // fixture opens. Waiting only for iframe.onload races its top-level await.
  await new Promise((resolve, reject) => {
    const win = iframe.contentWindow;
    const script = iframe.contentDocument.createElement('script');
    const appURL = [...iframe.contentDocument.querySelectorAll('script[type="module"][src]')].find(node => new URL(node.src).pathname.endsWith('/app.js'))?.src;
    if (!appURL) throw new Error('The editor app module was not found.');
    script.type = 'module';
    script.textContent = `import(${JSON.stringify(appURL)}).then(
      () => window.dispatchEvent(new Event('shadow-editor-ready')),
      error => window.dispatchEvent(new CustomEvent('shadow-editor-failed', { detail: error.message }))
    );`;
    const cleanup = () => {
      clearTimeout(timeout);
      win.removeEventListener('shadow-editor-ready', ready);
      win.removeEventListener('shadow-editor-failed', failed);
      script.remove();
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = event => { cleanup(); reject(new Error(event.detail || 'Editor module failed to initialize.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The editor did not finish restoring its draft.')); }, 15000);
    win.addEventListener('shadow-editor-ready', ready, { once: true });
    win.addEventListener('shadow-editor-failed', failed, { once: true });
    iframe.contentDocument.body.append(script);
  });
  return iframe;
}

async function makeFixture() {
  const canvas = document.createElement('canvas');
  canvas.width = 40; canvas.height = 30;
  const context = canvas.getContext('2d');
  context.fillStyle = '#245cda';
  context.fillRect(10, 5, 20, 20);
  const sourcePNG = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not generate the PNG fixture.')), 'image/png'));
  const deck = createDeck();
  deck.name = 'Image shadow integration fixture';
  deck.assets = [{ id: 'shadow-asset', name: 'transparent-margins.png', mime: 'image/png', width: 40, height: 30, dataUrl: canvas.toDataURL('image/png'), size: sourcePNG.size, lastModified: 0, sourceKind: 'copy' }];
  deck.slides[0].canvas = { width: 240, height: 180, background: 'transparent' };
  deck.slides[0].items = [{ id: 'shadow-image', name: 'Image with transparent margins', type: 'image', assetId: 'shadow-asset', x: 40, y: 35, width: 80, height: 60, rotation: 0, opacity: 1 }];
  return { deck: validateDeck(deck), sourcePNG };
}

async function pixels(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return {
    width: canvas.width, height: canvas.height,
    at: (x, y) => [...data.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)],
    has: expected => {
      for (let i = 0; i < data.length; i += 4) if (expected.every((value, channel) => Math.abs(data[i + channel] - value) <= 4)) return true;
      return false;
    },
  };
}

function closeColor(actual, expected, tolerance = 4) {
  return actual.length === 4 && expected.every((value, channel) => Math.abs(actual[channel] - value) <= tolerance);
}

async function checkRasterOutput(deck) {
  const project = slideProject(deck);
  project.items[0].shadow = { enabled: true, color: '#00cc44', transparency: 25, size: 100, blur: 0, angle: 0, distance: 24 };
  const original = JSON.stringify(project);
  const raster = await pixels(await exportPNG(project, 96));
  check('PNG export applies shadow color and transparency outside the image, using points for distance', raster.width === 240 && raster.height === 180 && closeColor(raster.at(125, 65), [0, 204, 68, 191]));
  check('Transparent source margins do not cast a rectangular shadow', raster.at(145, 65)[3] === 0 && raster.at(125, 40)[3] === 0);
  check('The original opaque image remains above its shadow with its original color', closeColor(raster.at(70, 65), [36, 92, 218, 255]));

  const faded = structuredClone(project);
  faded.items[0].opacity = 0.5;
  faded.items[0].shadow.transparency = 50;
  const fadedPixels = await pixels(await exportPNG(faded, 96));
  check('Object opacity multiplies shadow opacity while retaining the source image opacity', closeColor(fadedPixels.at(125, 65), [0, 204, 68, 64]) && closeColor(fadedPixels.at(70, 65), [36, 92, 218, 128]));

  const cropped = structuredClone(project);
  cropped.items[0].crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
  const croppedPixels = await pixels(await exportPNG(cropped, 96));
  check('A cropped image and its shadow use only the visible source alpha, retaining transparent margins', closeColor(croppedPixels.at(45, 65), [36, 92, 218, 255]) && closeColor(croppedPixels.at(95, 65), [0, 204, 68, 191]) && croppedPixels.at(125, 65)[3] === 0 && croppedPixels.at(95, 40)[3] === 0);

  const large = structuredClone(project);
  large.items[0].shadow.size = 200;
  const largePixels = await pixels(await exportPNG(large, 96));
  check('Shadow size expands the alpha silhouette around the image center', closeColor(largePixels.at(145, 65), [0, 204, 68, 191]) && raster.at(145, 65)[3] === 0);

  const blurred = structuredClone(project);
  blurred.items[0].shadow.blur = 12;
  const blurredPixels = await pixels(await exportPNG(blurred, 96));
  check('Blur produces partially transparent soft pixels beyond the sharp silhouette', blurredPixels.at(137, 65)[3] > 0 && blurredPixels.at(137, 65)[3] < 191 && raster.at(137, 65)[3] === 0);

  const rotated = structuredClone(project);
  rotated.items[0].rotation = 90;
  const rotatedPixels = await pixels(await exportPNG(rotated, 96));
  check('A rotated image rotates its shadow geometry without losing the shadow', closeColor(rotatedPixels.at(80, 110), [0, 204, 68, 191]) && rotatedPixels.at(125, 65)[3] === 0);

  const svg = projectToSVG(project), svgDoc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  check('SVG export contains a valid embedded shadow filter and the original raster image', !svgDoc.querySelector('parsererror') && svgDoc.querySelectorAll('filter').length > 0 && svg.includes('data:image/png;base64,'));
  const reportDeck = structuredClone(deck);
  reportDeck.slides[0].items = structuredClone(project.items);
  const report = new DOMParser().parseFromString(generateHTMLReport(reportDeck), 'text/html');
  check('The portable HTML report retains shadow rendering in its slide SVG', report.querySelectorAll('svg filter').length > 0 && !report.querySelector('script'));
  check('Raster, SVG and HTML generation leave the source project unchanged', JSON.stringify(project) === original);
}

run.onclick = async () => {
  results.replaceChildren(); checks.length = 0; run.disabled = true;
  window.shadowChecks = { finished: false, checks };
  document.title = 'RUNNING — Figure Editor image shadow checks';
  let restore = () => {};
  try {
    if (!location.port || location.port === '8766' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Use a separate localhost server on a test port such as 18769 to protect the normal editor draft.');
    const { DEFAULT_SHADOW, SHADOW_PRESETS } = await import('../shadow.js');
    const { deck } = await makeFixture();
    const iframe = await loadEditor();
    const win = iframe.contentWindow, doc = iframe.contentDocument, get = id => doc.getElementById(id);
    const oldCreateURL = win.URL.createObjectURL, oldClick = win.HTMLAnchorElement.prototype.click, oldConfirm = win.confirm, oldSavePicker = win.showSaveFilePicker;
    const urls = new Map(), downloads = [];
    win.confirm = () => true;
    win.showSaveFilePicker = undefined;
    win.URL.createObjectURL = blob => { const url = oldCreateURL.call(win.URL, blob); urls.set(url, blob); return url; };
    win.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(urls.get(this.href)); else oldClick.call(this); };
    restore = () => {
      win.URL.createObjectURL = oldCreateURL; win.HTMLAnchorElement.prototype.click = oldClick; win.confirm = oldConfirm; win.showSaveFilePicker = oldSavePicker;
      for (const url of urls.keys()) win.URL.revokeObjectURL(url);
    };
    const save = async () => {
      const index = downloads.length;
      await get('save-project').onclick();
      if (!downloads[index]) throw new Error('Could not capture the project snapshot.');
      return JSON.parse(await downloads[index].text());
    };
    const open = async fixture => {
      const files = new win.DataTransfer();
      files.items.add(new win.File([JSON.stringify(fixture)], 'shadow.figure.json', { type: 'application/json' }));
      get('project-input').files = files.files;
      await get('project-input').onchange({ target: get('project-input') });
    };
    const selectAll = () => {
      get('workspace').focus();
      get('workspace').dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', metaKey: true }));
    };
    const control = (property, type = property === 'color' ? 'color' : 'number') => doc.querySelector(`[data-shadow-property="${property}"][type="${type}"]`);
    const edit = (property, value, type) => {
      const input = control(property, type);
      if (!input) throw new Error(`Missing ${type || 'number'} control for shadow ${property}.`);
      input.value = value;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    await open(deck); selectAll();
    check('Selecting an image exposes an initially disabled shadow with all PowerPoint-style controls', get('shadow-enabled')?.checked === false && shadowProperties.every(property => control(property)));
    check('A legacy image without a shadow opens with the advertised default control values', shadowProperties.every(property => property === 'color' ? control(property)?.value.toLowerCase() === DEFAULT_SHADOW[property].toLowerCase() : Number(control(property)?.value) === DEFAULT_SHADOW[property]));
    get('shadow-enabled').click();
    const enabled = await save();
    check('Enabling the shadow stores its defaults on the image and immediately draws a filter', enabled.slides[0].items[0].shadow?.enabled === true && shadowProperties.every(property => enabled.slides[0].items[0].shadow[property] === DEFAULT_SHADOW[property]) && get('stage').querySelectorAll('filter').length > 0);
    const slider = control('distance', 'range'), oldStage = get('stage').innerHTML;
    if (!slider) throw new Error('Missing shadow distance slider.');
    slider.value = '12'; slider.dispatchEvent(new win.Event('input', { bubbles: true }));
    check('Moving a shadow slider updates the number field and canvas before committing', Number(control('distance').value) === 12 && get('stage').innerHTML !== oldStage);
    slider.value = '18'; slider.dispatchEvent(new win.Event('input', { bubbles: true }));
    slider.dispatchEvent(new win.Event('change', { bubbles: true }));
    const slid = await save();
    get('undo').click();
    check('One Undo reverses a whole slider gesture without removing the enabled shadow', JSON.stringify(await save()) === JSON.stringify(enabled));
    get('redo').click();
    check('One Redo restores the committed slider gesture', JSON.stringify(await save()) === JSON.stringify(slid));
    selectAll();
    edit('transparency', 35); edit('size', 125); edit('blur', 8); edit('angle', 135); edit('color', '#327caa');
    const custom = await save(), customShadow = custom.slides[0].items[0].shadow;
    check('Numeric and color edits persist independently and synchronize their range controls', customShadow.transparency === 35 && customShadow.size === 125 && customShadow.blur === 8 && customShadow.angle === 135 && customShadow.color === '#327caa' && Number(control('blur', 'range').value) === 8);
    get('shadow-enabled').click();
    const removed = await save();
    check('Turning the shadow off removes its rendering while preserving the chosen settings', removed.slides[0].items[0].shadow?.enabled === false && shadowProperties.every(property => removed.slides[0].items[0].shadow[property] === customShadow[property]) && get('stage').querySelectorAll('filter').length === 0);
    get('shadow-enabled').click();
    check('Turning the shadow on again restores all custom settings', JSON.stringify(await save()) === JSON.stringify(custom));
    await open(custom); selectAll();
    check('Save and reopen preserves the complete shadow and reflected controls', JSON.stringify(await save()) === JSON.stringify(custom) && get('shadow-enabled').checked && Number(control('angle').value) === 135 && control('color').value === '#327caa');

    get('duplicate').click();
    edit('distance', 30);
    const duplicated = await save(), [originalImage, duplicateImage] = duplicated.slides[0].items;
    check('Duplicated images keep independent shadow settings', duplicated.slides[0].items.length === 2 && originalImage.id !== duplicateImage.id && originalImage.shadow.distance === customShadow.distance && duplicateImage.shadow.distance === 30 && duplicateImage.shadow.color === customShadow.color);
    get('undo').click();
    const duplicateUndone = await save();
    check('Undoing a duplicate shadow edit restores that copy without altering the original', duplicateUndone.slides[0].items.every(item => JSON.stringify(item.shadow) === JSON.stringify(customShadow)));

    await open(custom); selectAll();
    const preset = get('shadow-preset');
    const presetChoice = [...preset.options].find(option => !['none', 'custom', ''].includes(option.value));
    if (!presetChoice) throw new Error('No image shadow presets are available.');
    preset.value = presetChoice.value; preset.dispatchEvent(new win.Event('change', { bubbles: true }));
    const presetDeck = await save();
    const expectedPreset = { ...DEFAULT_SHADOW, ...SHADOW_PRESETS.find(value => value.id === presetChoice.value).values };
    check('Selecting a shadow preset applies its complete stored appearance', Object.entries(expectedPreset).every(([key, value]) => presetDeck.slides[0].items[0].shadow[key] === value) && presetDeck.slides[0].items[0].shadow.enabled);
    get('undo').click();
    check('A preset is one undoable change', JSON.stringify(await save()) === JSON.stringify(custom));
    selectAll();
    get('object-locked').click();
    const locked = await save();
    check('A locked image disables its shadow switch, presets and all property inputs', get('shadow-enabled').disabled && get('shadow-preset').disabled && [...doc.querySelectorAll('[data-shadow-property]')].every(input => input.disabled));
    // Synthetic events deliberately bypass disabled DOM controls; app handlers
    // must still refuse mutation of a locked model.
    edit('distance', 40);
    check('Even synthetic shadow input events cannot mutate a locked image', JSON.stringify(await save()) === JSON.stringify(locked));

    const croppedDeck = structuredClone(custom);
    croppedDeck.slides[0].items[0].crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
    await open(croppedDeck); selectAll();
    const nestedViewports = [...doc.querySelectorAll('.slide-preview svg')];
    const viewportDimensions = nestedViewports.map(viewport => {
      // Chromium reports auto for SVG CSS sizes; its bounding rectangle also
      // includes source pixels outside the crop. The viewport matrix measures
      // the actual source-coordinate scale after CSS and viewport sizing.
      const matrix = viewport.getScreenCTM(), rootMatrix = viewport.closest('.slide-preview').getScreenCTM(), viewBox = viewport.viewBox.baseVal;
      return { scale: [matrix.a / rootMatrix.a, matrix.d / rootMatrix.d], expected: [Number(viewport.getAttribute('width')) / viewBox.width, Number(viewport.getAttribute('height')) / viewBox.height] };
    });
    const thumbnailsCorrect = viewportDimensions.length === 2 && viewportDimensions.every(({ scale, expected }) => Math.abs(scale[0] - expected[0]) < 0.01 && Math.abs(scale[1] - expected[1]) < 0.01);
    check(`Slide thumbnails preserve cropped picture and shadow viewport dimensions${thumbnailsCorrect ? '' : `: ${JSON.stringify(viewportDimensions)}`}`, thumbnailsCorrect);

    await checkRasterOutput(deck);
  } catch (error) { check(error.stack || error.message, false); }
  finally {
    restore(); run.disabled = false;
    const passed = checks.length > 0 && checks.every(result => result.pass);
    window.shadowChecks = { finished: true, passed, checks: [...checks] };
    document.title = `${passed ? 'PASS' : 'FAIL'} — Figure Editor image shadow checks`;
  }
};
