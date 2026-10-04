// Promise-based IndexedDB audio cache for listening clips.
//
// Design spec §7/§10:
//  - Database `oohlalangue_audio`, object store `clips`, keyed by a cache-key
//    string. The value is a serializable object (the full ordered segment
//    list for one listening script, plus a `createdAt` stamp).
//  - The whole segment list for a script is stored under one key so a resumed
//    worksheet replays the same conversation without re-billing TTS.
//  - If IndexedDB is missing, blocked, or any operation rejects, every method
//    resolves to null/false and `available` becomes false. Callers can still
//    play audio by re-fetching; the UI just notes that caching is off.
//
// Key canonicalization: `script|voice|speed`, where each part is trimmed and
// internal whitespace is collapsed. `makeAudioKey` computes that locally with
// FNV-1a (32-bit). When `/api/tts` supplies a server-computed `cache_key`, the
// caller should prefer it so client and server agree on the key.

export function canonicalizePart(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

// FNV-1a 32-bit hash, returned as 8-char hex. Stable across reloads/browsers.
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeAudioKey({ script, voice, voices, speed } = {}) {
  const voicePart =
    voice != null ? voice : Array.isArray(voices) ? voices.map((v) => canonicalizePart(v)).join(',') : voices;
  return hashScript(script, voicePart, speed);
}

export function hashScript(script, voice, speed) {
  const canonical = `${canonicalizePart(script)}|${canonicalizePart(voice)}|${canonicalizePart(speed)}`;
  return `tts-${fnv1a(canonical)}`;
}

function openDatabase(idb, dbName, storeName, version) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = idb.open(dbName, version);
    } catch (err) {
      reject(err);
      return;
    }
    if (!request) {
      reject(new Error('indexedDB.open returned no request'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
    request.onblocked = () => reject(new Error('indexedDB.open was blocked'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

export function createAudioCache({
  indexedDB: idb = typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined,
  dbName = 'oohlalangue_audio',
  storeName = 'clips',
  version = 1
} = {}) {
  let dbPromise = null;
  let available = idb ? null : false; // null = not yet determined
  let lastError = null;

  function markUnavailable(err) {
    available = false;
    lastError = err || lastError;
    return null;
  }

  function resetUnavailable() {
    available = false;
  }

  function open() {
    if (available === false) return Promise.resolve(null);
    if (!idb) {
      markUnavailable(new Error('IndexedDB is unavailable'));
      return Promise.resolve(null);
    }
    if (!dbPromise) {
      dbPromise = openDatabase(idb, dbName, storeName, version).then(
        (db) => {
          available = true;
          return db;
        },
        (err) => {
          markUnavailable(err);
          return null;
        }
      );
    }
    return dbPromise;
  }

  function withStore(mode, fn) {
    return open().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = db.transaction(storeName, mode);
        } catch (err) {
          resolve(markUnavailable(err));
          return;
        }
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          resolve(markUnavailable(err));
          return;
        }
        if (result && typeof result.then === 'function') {
          result.then(
            (value) => resolve(value),
            (err) => resolve(markUnavailable(err))
          );
          return;
        }
        resolve(result);
      });
    });
  }

  async function get(key) {
    if (!key) return null;
    return withStore('readonly', (store) => requestToPromise(store.get(key)).catch(() => null));
  }

  async function put(key, value) {
    if (!key) return false;
    const record = Object.assign({ createdAt: Date.now() }, value);
    const ok = await withStore('readwrite', (store) =>
      requestToPromise(store.put(record, key)).then(() => true).catch(() => false)
    );
    return ok === true;
  }

  async function del(key) {
    if (!key) return false;
    const ok = await withStore('readwrite', (store) =>
      requestToPromise(store.delete(key)).then(() => true).catch(() => false)
    );
    return ok === true;
  }

  async function clearAll() {
    const ok = await withStore('readwrite', (store) =>
      requestToPromise(store.clear()).then(() => true).catch(() => false)
    );
    return ok === true;
  }

  async function getSegments(key) {
    const record = await get(key);
    if (!record || !Array.isArray(record.segments)) return null;
    return record;
  }

  async function putSegments(key, segments, extra = {}) {
    if (!Array.isArray(segments)) return false;
    return put(key, Object.assign({ segments }, extra));
  }

  async function isAvailable() {
    if (available == null) await open();
    return available === true;
  }

  return {
    dbName,
    storeName,
    get available() {
      return available;
    },
    get lastError() {
      return lastError;
    },
    open,
    isAvailable,
    get,
    put,
    delete: del,
    clearAll,
    getSegments,
    putSegments,
    // exposed for tests / callers that want to reset a failed lock
    _resetUnavailable: resetUnavailable
  };
}

export default createAudioCache;
