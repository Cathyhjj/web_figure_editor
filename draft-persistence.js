/** Serialize recovery writes without copying unchanged project bytes for file metadata updates. */
export function sameDraftFile(left, right) {
  return Boolean(left && right && left.handle === right.handle && left.name === right.name
    && left.revision === right.revision && left.dirty === right.dirty);
}

export function createDraftWriter({ validate, write }) {
  const namespace = globalThis.crypto.randomUUID();
  let queue = Promise.resolve(), savedKey = null, savedFile = null, savedProject, savedFileToken = null, fileSequence = 0;
  let pending = 0, lastRequest = null;
  const captures = new Map();

  function save({ epoch, revision, file, capture }) {
    const key = `${epoch}:${revision}`, metadata = { ...file };
    if (lastRequest?.key === key && sameDraftFile(lastRequest.file, metadata)) return lastRequest.promise;
    const tokens = { content: `${namespace}:${key}`, file: sameDraftFile(savedFile, metadata) ? savedFileToken : `${namespace}:file-${++fileSequence}` };
    let content = captures.get(key);
    if (!content) { content = { users: 0, snapshot: undefined, validated: undefined }; captures.set(key, content); }
    // Capture now, before any asynchronous work, so this revision never describes
    // a later edit. Requests queued for the same content share the private copy.
    const needsCapture = savedKey !== key || pending && lastRequest?.key !== key;
    if (needsCapture && content.snapshot === undefined) {
      try { content.snapshot = capture(); }
      catch (error) { if (!content.users) captures.delete(key); return Promise.reject(error); }
    }
    content.users++; pending++;
    const request = { key, file: metadata, promise: null };
    const operation = queue.then(async () => {
      let project = savedProject;
      if (savedKey !== key) {
        if (content.validated === undefined) content.validated = validate(content.snapshot);
        project = content.validated;
      }
      // Even an unchanged request checks ownership inside the storage transaction:
      // another editor tab may have replaced the origin's single recovery draft.
      // Retain only the latest validated snapshot for that rare full-write fallback.
      const result = await write(project, metadata, tokens);
      savedKey = key; savedFile = metadata; savedProject = project; savedFileToken = tokens.file;
      return { epoch, revision, ...result };
    });
    request.promise = operation.finally(() => {
      pending--; content.users--;
      if (!content.users) captures.delete(key);
      if (lastRequest === request) lastRequest = null;
    });
    lastRequest = request;
    // A storage failure does not poison later writes or advance the saved cache.
    queue = request.promise.catch(() => {});
    return request.promise;
  }
  return { save };
}
