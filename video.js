/** MP4 originals stay embedded; a PNG frame is used by static exports and thumbnails. */
import { requireHTMLSnapshots } from './html-chart.js';
export const isMediaItem = item => item.type === 'image' || item.type === 'video' || item.type === 'html';
export const posterSource = asset => ['video/mp4', 'text/html'].includes(asset.mime) ? asset.posterDataUrl : asset.dataUrl;

// Inspect the ISO base media file-type box, not the filename or supplied MIME label.
export function isMP4(bytes) {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || size > 4096 || size % 4) return false;
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ']);
  for (let at = 8; at < size; at += at === 8 ? 8 : 4) {
    if (brands.has(String.fromCharCode(...bytes.subarray(at, at + 4)))) return true;
  }
  return false;
}

/** Called only after byte/size validation. Decode locally, capture a frame, release media. */
export function readVideoMetadata(bytes) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      video.onloadedmetadata = video.onloadeddata = video.onerror = null;
      video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Video decoding timed out. Try a smaller H.264 MP4.')), 20000);
    video.preload = 'auto'; video.muted = true; video.playsInline = true;
    video.onerror = () => finish(new Error('This MP4 is damaged or cannot be decoded by this browser. Use H.264 video with AAC audio.'));
    video.onloadedmetadata = () => {
      const { videoWidth: width, videoHeight: height, duration } = video;
      if (!(width > 0 && height > 0 && duration > 0) || !Number.isFinite(duration) || width > 16384 || height > 16384 || width * height > 40000000) {
        finish(new Error('The MP4 needs a playable video track with valid dimensions and duration (at most 16,384 px per side and 40 million pixels).'));
      }
    };
    video.onloadeddata = () => {
      try {
        const { videoWidth: width, videoHeight: height, duration } = video;
        if (!(width > 0 && height > 0 && duration > 0) || !Number.isFinite(duration)) throw new Error('The MP4 has no playable video track.');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1920 / width, 1080 / height);
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create a video poster.');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const posterDataUrl = canvas.toDataURL('image/png');
        const result = { width, height, duration, posterDataUrl, posterWidth: canvas.width, posterHeight: canvas.height };
        canvas.width = canvas.height = 0;
        finish(null, result);
      } catch (error) { finish(error); }
    };
    video.src = url;
  });
}

/** Static output uses poster pixels without copying MP4 bytes into the exported document. */
export function posterProject(project) {
  requireHTMLSnapshots(project);
  return {
    ...project,
    items: project.items.map(item => ['video', 'html'].includes(item.type) ? { ...item, type: 'image' } : item),
    assets: project.assets.map(asset => {
      if (!['video/mp4', 'text/html'].includes(asset.mime)) return asset;
      const { posterDataUrl, posterWidth, posterHeight, duration, hasSnapshot, ...copy } = asset;
      return { ...copy, mime: 'image/png', dataUrl: posterDataUrl, width: posterWidth, height: posterHeight, size: Math.floor((posterDataUrl.length - posterDataUrl.indexOf(',') - 1) * 3 / 4) };
    }),
  };
}
