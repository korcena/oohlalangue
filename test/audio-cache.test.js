'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let cachePromise = null;
function loadAudioCache() {
  if (!cachePromise) cachePromise = import('../public/lib/audio-cache.js');
  return cachePromise;
}

// ---------------------------------------------------------------------------
// Minimal in-memory fake IndexedDB sufficient for the audio-cache wrapper.
// ---------------------------------------------------------------------------

function makeFakeIndexedDB() {
  const databases = new Map();

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.onblocked = null;
      this.result = undefined;
      this.error = null;
    }
    fireSuccess(value) {
      this.result = value;
      if (typeof this.onsuccess === 'function') this.onsuccess({ target: this });
    }
    fireError(err) {
      this.error = err;
      if (typeof this.onerror === 'function') this.onerror({ target: this });
    }
  }

  function makeObjectStore(map) {
    return {
      get(key) {
        const req = new FakeRequest();
        queueMicrotask(() => req.fireSuccess(map.get(key)));
        return req;
      },
      put(value, key) {
        const req = new FakeRequest();
        queueMicrotask(() => {
          map.set(key, value);
          req.fireSuccess(key);
        });
        return req;
      },
      delete(key) {
        const req = new FakeRequest();
        queueMicrotask(() => {
          map.delete(key);
          req.fireSuccess(true);
        });
        return req;
      },
      clear() {
        const req = new FakeRequest();
        queueMicrotask(() => {
          map.clear();
          req.fireSuccess(true);
        });
        return req;
      }
    };
  }

  function makeDb(storeMap) {
    return {
      objectStoreNames: { contains: (name) => storeMap.has(name) },
      createObjectStore(name) {
        storeMap.set(name, new Map());
      },
      transaction() {
        return {
          objectStore(name) {
            if (!storeMap.has(name)) throw new Error('missing store ' + name);
            return makeObjectStore(storeMap.get(name));
          }
        };
      }
    };
  }

  return {
    open(name) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        if (!databases.has(name)) databases.set(name, new Map());
        const storeMap = databases.get(name);
        const db = makeDb(storeMap);
        // Real IndexedDB sets request.result before onupgradeneeded fires.
        req.result = db;
        if (!storeMap.has('clips')) {
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        }
        req.fireSuccess(db);
      });
      return req;
    }
  };
}

test('audio cache put/get round-trips segments and createdAt', async () => {
  const { createAudioCache } = await loadAudioCache();
  const cache = createAudioCache({ indexedDB: makeFakeIndexedDB() });
  const segments = [{ speaker: 'A', mime: 'audio/mpeg', base64: 'AAA', pause_after_ms: 0 }];
  assert.equal(await cache.putSegments('key1', segments), true);
  const record = await cache.getSegments('key1');
  assert.ok(record);
  assert.deepEqual(record.segments, segments);
  assert.equal(typeof record.createdAt, 'number');
  assert.equal(await cache.isAvailable(), true);
});

test('makeAudioKey / hashScript are stable for identical inputs', async () => {
  const { makeAudioKey, hashScript } = await loadAudioCache();
  const a = makeAudioKey({ script: 'Bonjour  le monde', voice: 'alloy', speed: 1 });
  const b = hashScript('Bonjour le monde', 'alloy', 1);
  assert.equal(a, b);
  assert.equal(a, makeAudioKey({ script: '  Bonjour le monde  ', voice: 'alloy', speed: 1 }));
});

test('distinct script/voice/speed produce distinct keys (no collisions)', async () => {
  const { makeAudioKey } = await loadAudioCache();
  const base = makeAudioKey({ script: 'Bonjour', voice: 'alloy', speed: 1 });
  assert.notEqual(base, makeAudioKey({ script: 'Bonsoir', voice: 'alloy', speed: 1 }));
  assert.notEqual(base, makeAudioKey({ script: 'Bonjour', voice: 'verse', speed: 1 }));
  assert.notEqual(base, makeAudioKey({ script: 'Bonjour', voice: 'alloy', speed: 0.75 }));
});

test('delete and clearAll remove cached clips', async () => {
  const { createAudioCache } = await loadAudioCache();
  const cache = createAudioCache({ indexedDB: makeFakeIndexedDB() });
  await cache.putSegments('a', [{ speaker: 'A' }]);
  await cache.putSegments('b', [{ speaker: 'B' }]);
  assert.equal(await cache.delete('a'), true);
  assert.equal(await cache.getSegments('a'), null);
  assert.equal(await cache.clearAll(), true);
  assert.equal(await cache.getSegments('b'), null);
});

test('unavailable IndexedDB falls back to null/false without throwing', async () => {
  const { createAudioCache } = await loadAudioCache();
  const cache = createAudioCache({ indexedDB: undefined });
  assert.equal(await cache.isAvailable(), false);
  assert.equal(cache.available, false);
  assert.equal(await cache.getSegments('x'), null);
  assert.equal(await cache.putSegments('x', [{ speaker: 'A' }]), false);
  assert.equal(await cache.delete('x'), false);
  assert.equal(await cache.clearAll(), false);
});

test('an IndexedDB whose open throws is treated as unavailable', async () => {
  const { createAudioCache } = await loadAudioCache();
  const broken = {
    open() {
      throw new Error('blocked by policy');
    }
  };
  const cache = createAudioCache({ indexedDB: broken });
  assert.equal(await cache.isAvailable(), false);
  assert.equal(await cache.getSegments('x'), null);
  assert.equal(await cache.putSegments('x', []), false);
});
