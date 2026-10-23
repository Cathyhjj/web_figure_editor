import { downloadBlob } from './core.js';
import { serializeDeck, validateDeck } from './deck.js';

export const MAX_PROJECT_BYTES = 240 * 1024 * 1024;

const projectTypes = [{ description: 'Figure Editor project', accept: { 'application/json': ['.figure.json', '.json'] } }];
const limitMessage = 'Project exceeds the 240 MB file limit. Split it into smaller projects before saving.';

export class ProjectFileConflictError extends Error {
  constructor(message = 'This file changed outside this editor. Use Save As to keep your edits in another file, or reopen the file to load its latest version.') {
    super(message);
    this.name = 'ProjectFileConflictError';
  }
}

/** Content, rather than timestamps, identifies the exact file version we observed. */
export async function projectFileRevision(file) {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds 240 MB. Split it into smaller projects.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function checkProjectFileRevision(handle, expectedRevision) {
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new ProjectFileConflictError('The saved file version could not be verified. Use Save As to keep your edits in another file, or reopen the file before editing.');
  }
  if (await projectFileRevision(await handle.getFile()) !== expectedRevision) throw new ProjectFileConflictError();
}

async function sameFile(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === 'function') return left.isSameEntry(right);
  if (typeof right?.isSameEntry === 'function') return right.isSameEntry(left);
  return false;
}

export async function readProjectFile(file) {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds 240 MB. Split it into smaller projects.');
  return validateDeck(JSON.parse(await file.text()));
}

export async function readProjectFileState(file) {
  const [project, revision] = await Promise.all([readProjectFile(file), projectFileRevision(file)]);
  return { project, revision };
}

/** Invoke from the Open click handler so the picker retains browser user activation. */
export async function pickProjectFile({ pickerHost = globalThis } = {}) {
  const [handle] = await pickerHost.showOpenFilePicker({ multiple: false, types: projectTypes });
  if (!handle) throw new DOMException('No project selected.', 'AbortError');
  const file = await handle.getFile();
  return { ...await readProjectFileState(file), handle, name: handle.name || file.name };
}

/** Resolve only after close(); automatic writes require an already-authorized destination. */
export async function writeProjectFile(project, { handle = null, revision = null, name = 'figure.figure.json', saveAs = false, automatic = false, pickerHost = globalThis, download = downloadBlob } = {}) {
  let target = handle;
  let expectedRevision = revision;
  if (automatic) {
    const denied = () => new DOMException('Autosave needs an existing file with write access. Use Save to choose a file or allow access.', 'NotAllowedError');
    if (!target || saveAs || typeof target.queryPermission !== 'function') throw denied();
    let permission;
    try {
      permission = await target.queryPermission({ mode: 'readwrite' });
    } catch {
      throw denied();
    }
    if (permission !== 'granted') throw denied();
  } else if (target && !saveAs && typeof target.requestPermission === 'function') {
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
      // Save As to the same entry must not bypass an existing conflict. For a
      // different destination, protect the version the user just selected.
      if (!handle || !await sameFile(handle, target)) expectedRevision = await projectFileRevision(await target.getFile());
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
  const writtenRevision = await projectFileRevision(file);
  try {
    await checkProjectFileRevision(target, expectedRevision);
    writer = await target.createWritable();
    await writer.write(file);
    // Writable streams stage their changes until close. Catch external changes
    // during the write too; the API offers no atomic compare-and-swap with disk.
    await checkProjectFileRevision(target, expectedRevision);
    await writer.close();
  } catch (error) {
    try { await writer?.abort(); } catch { /* Preserve the original write or close failure. */ }
    throw error;
  }
  return { handle: target, name: target.name || name, downloaded: false, revision: writtenRevision };
}
