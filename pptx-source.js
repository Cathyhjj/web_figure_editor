/** Preserve the original Office package only for a complete, unchanged import. */
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const trustedShape = new WeakSet();
const encoder = new TextEncoder();

function fail(message) { throw new Error('Original PowerPoint: ' + message); }

/** Only scalar fields; the immutable source can be shared between undo states. */
export function validateOriginalPPTX(source) {
  if (trustedShape.has(source)) return source;
  if (!source || typeof source !== 'object' || source.version !== 1
    || typeof source.name !== 'string' || source.name.length > 250 || !/\.pptx$/i.test(source.name) || /[/\\\u0000-\u001f]/.test(source.name)
    || typeof source.sha256 !== 'string' || !HASH.test(source.sha256)
    || typeof source.contentSha256 !== 'string' || !HASH.test(source.contentSha256)
    || typeof source.data !== 'string' || source.data.length < 32
    || source.data.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3) || source.data.length % 4 || !source.data.startsWith('UEsD')
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) fail('invalid source attachment.');
  const copy = Object.freeze({ version: 1, name: source.name, data: source.data, sha256: source.sha256, contentSha256: source.contentSha256 });
  trustedShape.add(copy);
  return copy;
}

async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Hash canonical items and actual asset contents, not mutable filenames, timestamps
// or stored asset fingerprints alone. Avoid serializing all asset bytes together.
async function contentDigest(deck) {
  const used = new Set(deck.slides.flatMap(slide => slide.items.map(item => item.assetId).filter(Boolean)));
  const assets = [];
  for (const asset of deck.assets) if (used.has(asset.id))
    assets.push([asset.id, await digest(encoder.encode(JSON.stringify(asset)))]);
  assets.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const slides = deck.slides.map(({ id, name, canvas, items }) => ({ id, name, canvas, items }));
  return digest(encoder.encode(JSON.stringify({ name: deck.name, slides, assets })));
}

// The server parsed and fingerprinted the original on import. On reopening an
// untrusted .figure.json, check the bytes and ZIP directory before emitting it.
async function verifiedBytes(source, expectedSlides) {
  const binary = atob(source.data);
  if (binary.length > MAX_SOURCE_BYTES) fail('source exceeds 100 MB.');
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (await digest(bytes) !== source.sha256) fail('the stored PPTX differs from the file verified at import.');
  const view = new DataView(bytes.buffer);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  const invalid = () => fail('expected a complete PowerPoint presentation with the imported page count.');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    end--;
  }
  if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) !== 0 || u16(end + 6) !== 0) invalid();
  const count = u16(end + 10), names = new Set();
  let at = u32(end + 16);
  if (!count || count > 10000 || u16(end + 8) !== count || at + u32(end + 12) !== end) invalid();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) invalid();
    const nameEnd = at + 46 + u16(at + 28), next = nameEnd + u16(at + 30) + u16(at + 32);
    if (next > end) invalid();
    names.add(new TextDecoder().decode(bytes.subarray(at + 46, nameEnd)));
    at = next;
  }
  if (at !== end || !names.has('[Content_Types].xml') || !names.has('ppt/presentation.xml')
    || Array.from(names).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length !== expectedSlides) invalid();
  return bytes;
}

/** Call after importing every slide in source order. sha256 is from the PPTX import API. */
export async function attachOriginalPPTX(deck, { name, data, sha256 }) {
  const { validateDeck } = await import('./deck.js');
  const canonical = validateDeck(deck);
  const source = validateOriginalPPTX({ version: 1, name, data, sha256, contentSha256: await contentDigest(canonical) });
  await verifiedBytes(source, canonical.slides.length);
  deck.originalPptx = source;
  return deck;
}

/** An edit, insertion, deletion or reorder must use the live editable model. */
export async function unchangedOriginalPPTX(deck) {
  if (deck?.originalPptx === undefined) return null;
  const { validateDeck } = await import('./deck.js');
  const canonical = validateDeck(deck), source = canonical.originalPptx;
  if (!source || await contentDigest(canonical) !== source.contentSha256) return null;
  return { name: source.name, data: source.data, sha256: source.sha256, bytes: await verifiedBytes(source, canonical.slides.length) };
}
