import { downloadBlob } from './core.js';
import { serializeDeck, validateDeck } from './deck.js';

export const MAX_PROJECT_BYTES = 240 * 1024 * 1024;

const projectTypes = [{ description: 'Figure Editor project', accept: { 'application/json': ['.figure.json', '.json'] } }];
const limitMessage = 'Project exceeds the 240 MB file limit. Split it into smaller projects before saving.';

export async function readProjectFile(file) {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds 240 MB. Split it into smaller projects.');
  return validateDeck(JSON.parse(await file.text()));
}

/** Invoke from the Open click handler so the picker retains browser user activation. */
export async function pickProjectFile({ pickerHost = globalThis } = {}) {
  const [handle] = await pickerHost.showOpenFilePicker({ multiple: false, types: projectTypes });
  if (!handle) throw new DOMException('No project selected.', 'AbortError');
  const file = await handle.getFile();
  return { project: await readProjectFile(file), handle, name: handle.name || file.name };
}

/** Resolve only after the selected file has been committed by close(). */
export async function writeProjectFile(project, { handle = null, name = 'figure.figure.json', saveAs = false, pickerHost = globalThis, download = downloadBlob } = {}) {
  let target = handle;
  if (target && !saveAs && typeof target.requestPermission === 'function') {
    const denied = () => new DOMException('Write access was not granted. Allow access to this file or use Save As to choose another destination.', 'NotAllowedError');
    let permission;
    try {
      // Restored handles may need a fresh grant; request while the Save gesture is active.
      permission = await target.requestPermission({ mode: 'readwrite' });
    } catch (error) {
      if (error.name === 'NotAllowedError') throw denied();
      throw error;
    }
    if (permission !== 'granted') throw denied();
  }
  if (!target || saveAs) {
    if (typeof pickerHost.showSaveFilePicker === 'function') {
      // Pick before serialization, which can be expensive for embedded images.
      target = await pickerHost.showSaveFilePicker({ suggestedName: name, types: projectTypes });
      if (!target) throw new DOMException('No save destination selected.', 'AbortError');
    } else if (target) {
      throw new Error('Save As requires a browser that supports choosing a project file.');
    }
  }
  const file = new Blob([serializeDeck(project)], { type: 'application/json' });
  if (file.size > MAX_PROJECT_BYTES) throw new Error(limitMessage);
  if (!target) {
    await download(file, name);
    return { handle: null, name, downloaded: true };
  }
  let writer;
  try {
    writer = await target.createWritable();
    await writer.write(file);
    await writer.close();
  } catch (error) {
    try { await writer?.abort(); } catch { /* Preserve the original write or close failure. */ }
    throw error;
  }
  return { handle: target, name: target.name || name, downloaded: false };
}
