/** Runs in the isolated renderer, after fonts, images and page scripts settle. */
export async function freezeHTMLFigure(figureIndex) {
  const sourceRoot = figureIndex === -1 ? document.body : [...document.querySelectorAll('figure')].filter(n => !n.parentElement.closest('figure'))[figureIndex];
  if (!sourceRoot || sourceRoot.querySelector('iframe,object,embed,video,canvas') || document.querySelector('animate,animateTransform,animateMotion,set')) throw new Error('This page contains a canvas, video, nested frame or SVG animation. Its image is preserved; native editing is unavailable.');
  const copy = document.documentElement.cloneNode(true);
  const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  const resources = new Map();
  async function resource(raw, base = document.baseURI) {
    if (!raw || raw.startsWith('#') || raw.startsWith('data:')) return raw;
    const url = new URL(raw, base);
    if (url.origin !== location.origin) throw new Error('Native editing needs all images, fonts and styles inside the HTML or ZIP.');
    if (url.pathname === location.pathname && url.hash) return url.hash;
    const fragment = url.hash; url.hash = ''; const key = url.href;
    if (!resources.has(key)) resources.set(key, (async () => {
      const response = await fetch(key); if (!response.ok) throw new Error('A Figure resource could not be embedded.');
      const blob = await response.blob();
      return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    })());
    return await resources.get(key) + fragment;
  }
  async function css(text, base) {
    const matches = [...text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)];
    for (const match of matches.reverse()) {
      const value = await resource(match[1] ?? match[2] ?? match[3], base);
      text = text.slice(0, match.index) + 'url(' + JSON.stringify(value) + ')' + text.slice(match.index + match[0].length);
    }
    return text;
  }
  async function stylesheet(sheet) {
    let text = '';
    for (const rule of sheet.cssRules) {
      if (rule.type === CSSRule.IMPORT_RULE) {
        const imported = await stylesheet(rule.styleSheet);
        text += rule.media.mediaText ? `@media ${rule.media.mediaText}{${imported}}` : imported;
      } else text += await css(rule.cssText, sheet.href || document.baseURI) + '\n';
    }
    return text;
  }
  // Keep stylesheet order and selectors (including pseudo-elements and variables).
  for (const sheet of document.styleSheets) {
    const node = copies[originals.indexOf(sheet.ownerNode)];
    if (!node) continue;
    if (sheet.disabled) { node.remove(); continue; }
    const style = document.createElement('style'); style.textContent = await stylesheet(sheet);
    if (sheet.media.mediaText) style.media = sheet.media.mediaText;
    node.replaceWith(style);
  }
  let index = 0;
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i], node = copies[i];
    if (!copy.contains(node) && node !== copy) continue;
    node.removeAttribute('data-fe-node'); node.removeAttribute('data-fe-root');
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ['srcdoc', 'nonce', 'integrity', 'autofocus', 'contenteditable'].includes(attr.name)) node.removeAttribute(attr.name);
    if (original === sourceRoot || sourceRoot.contains(original)) node.setAttribute('data-fe-node', 'n' + index++);
    if (original === sourceRoot) node.setAttribute('data-fe-root', 'figure');
    if (node.hasAttribute('style')) node.setAttribute('style', await css(node.getAttribute('style'), document.baseURI));
    if (node.localName === 'img') { node.src = await resource(original.currentSrc || original.src); node.removeAttribute('srcset'); node.removeAttribute('loading'); }
    if (['image', 'use', 'textPath', 'linearGradient', 'radialGradient', 'pattern'].includes(node.localName)) {
      for (const attr of ['href', 'xlink:href']) if (node.hasAttribute(attr)) node.setAttribute(attr, await resource(node.getAttribute(attr)));
    } else if (node.localName === 'a') {
      for (const attr of ['href', 'xlink:href']) if (/^\s*(?:javascript|data):/i.test(node.getAttribute(attr) || '')) node.removeAttribute(attr);
      node.setAttribute('tabindex', '-1');
    } else { node.removeAttribute('href'); node.removeAttribute('xlink:href'); }
  }
  copy.querySelectorAll('script,base,meta[http-equiv],iframe,object,embed,link,source').forEach(n => n.remove());
  const stable = document.createElement('style'); stable.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; copy.querySelector('head').append(stable);
  if (index > 4000) throw new Error('This Figure has too many elements for native editing. Its image is preserved.');
  return '<!doctype html>\n' + copy.outerHTML;
}
