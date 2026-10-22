import { uid } from './core.js';
import { readProjectFile } from './project-files.js';

const DB_NAME = 'figure-editor-recent-projects';
const STORE = 'recent';

function indexedDBStorage() {
  let database;
  function open() {
    return database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Recent project storage is unavailable.'));
      request.onsuccess = () => resolve(request.result);
    });
  }
  return {
    async load() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get('entries');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async save(entries) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Recent project storage was interrupted.'));
        try { transaction.objectStore(STORE).put(entries, 'entries'); }
        catch (error) { transaction.abort(); reject(error); }
      });
    },
  };
}

const fileHandle = handle => handle && typeof handle.getFile === 'function' ? handle : null;
const text = (value, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, 500) : fallback;

async function sameFile(left, right) {
  if (left === right) return true;
  try {
    if (typeof left.isSameEntry === 'function') return await left.isSameEntry(right);
    if (typeof right.isSameEntry === 'function') return await right.isSameEntry(left);
  } catch { /* A stale handle must not prevent other projects from being remembered. */ }
  return false;
}

/** Recent files are metadata and handles only; they never duplicate project contents. */
export function createRecentProjects({ storage = indexedDBStorage(), limit = 10 } = {}) {
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 10;
  let entries = [], loaded = false, canPersist = true, storageError = null, mutations = Promise.resolve();
  const snapshot = () => entries.map(entry => ({ ...entry }));

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = await storage.load();
      const ids = new Set();
      entries = (Array.isArray(saved) ? saved : []).filter(entry => {
        if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name) return false;
        ids.add(entry.id);
        return true;
      }).map(entry => ({
        id: entry.id, name: text(entry.name, 'Untitled.figure.json'),
        projectName: text(entry.projectName, entry.name), handle: fileHandle(entry.handle),
        lastOpened: Number.isFinite(entry.lastOpened) ? entry.lastOpened : 0,
        persistent: entry.persistent !== false,
      })).sort((a, b) => b.lastOpened - a.lastOpened).slice(0, maximum);
    } catch (error) { canPersist = false; storageError = error; }
  }

  async function persist() {
    if (!canPersist) { entries = entries.map(entry => ({ ...entry, persistent: false })); return; }
    const saved = entries.map(entry => ({ ...entry, persistent: true }));
    try {
      await storage.save(saved);
      entries = saved; storageError = null;
    } catch (error) {
      if (error.name === 'DataCloneError' && saved.some(entry => entry.handle)) {
        try {
          // Some browsers cannot clone handles into IndexedDB. Keep those handles
          // usable in this session while retaining a reselectable history on reload.
          const metadata = saved.map(entry => ({ ...entry, handle: null, persistent: !entry.handle }));
          await storage.save(metadata);
          entries = saved.map(entry => ({ ...entry, persistent: !entry.handle }));
          storageError = error;
          return;
        } catch (fallbackError) { error = fallbackError; }
      }
      canPersist = false; storageError = error;
      entries = entries.map(entry => ({ ...entry, persistent: false }));
    }
  }

  function enqueue(change) {
    const operation = mutations.then(async () => {
      await ensureLoaded();
      if (change) { await change(); await persist(); }
      return snapshot();
    });
    mutations = operation.catch(() => {});
    return operation;
  }

  return {
    get entries() { return snapshot(); },
    get storageError() { return storageError; },
    load() { return enqueue(); },
    remember({ handle = null, name, projectName } = {}) {
      handle = fileHandle(handle);
      name = text(name, text(handle?.name, 'Untitled.figure.json'));
      projectName = text(projectName, name);
      return enqueue(async () => {
        let previous;
        for (const entry of entries) {
          if (handle ? entry.handle && await sameFile(handle, entry.handle) : !entry.handle && entry.name === name) { previous = entry; break; }
        }
        const next = { id: previous?.id || uid(), name, projectName, handle, lastOpened: Date.now(), persistent: canPersist };
        entries = [next, ...entries.filter(entry => entry.id !== previous?.id)].slice(0, maximum);
      });
    },
    clear() { return enqueue(() => { entries = []; }); },
    remove(id) { return enqueue(() => { entries = entries.filter(entry => entry.id !== id); }); },
  };
}

/** Call directly from the recent-file click so a permission request keeps user activation. */
export async function openRecentProject(entry) {
  const handle = fileHandle(entry?.handle);
  if (!handle) throw new DOMException('Choose this project file again with Open. This browser did not retain file access.', 'NotSupportedError');
  if (typeof handle.requestPermission === 'function') {
    const denied = () => new DOMException('Read access was not granted. Allow access to this file or choose it again with Open.', 'NotAllowedError');
    let permission;
    try { permission = await handle.requestPermission({ mode: 'read' }); }
    catch (error) { if (error.name === 'NotAllowedError') throw denied(); throw error; }
    if (permission !== 'granted') throw denied();
  }
  const file = await handle.getFile();
  return { project: await readProjectFile(file), handle, name: handle.name || file.name || entry.name };
}
