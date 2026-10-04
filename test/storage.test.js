'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// `public/lib/storage.js` is a browser-native ES module. Load it dynamically
// from this CommonJS test file.
let storagePromise = null;
function loadStorage() {
  if (!storagePromise) storagePromise = import('../public/lib/storage.js');
  return storagePromise;
}

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    }
  };
}

function throwingBackend() {
  return {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
    removeItem() {
      throw new Error('storage disabled');
    }
  };
}

test('chat keys round-trip unchanged and a resumed session restores them', async () => {
  const { createStorage } = await loadStorage();
  const backend = fakeBackend();
  const a = createStorage(backend, { autoMigrate: false });

  assert.equal(a.setName('Kate'), true);
  assert.equal(a.setPassword('pw'), true);
  assert.equal(a.addProfileFacts(['loves coffee']), true);
  assert.equal(a.setAnswers(3), true);
  assert.equal(a.setPauseUntil(123456), true);

  const b = createStorage(backend, { autoMigrate: false });
  assert.equal(b.getName(), 'Kate');
  assert.equal(b.getPassword(), 'pw');
  assert.deepEqual(b.getProfile(), ['loves coffee']);
  assert.equal(b.getAnswers(), 3);
  assert.equal(b.getPauseUntil(), 123456);
});

test('worksheet keys save and resume including the last-saved timestamp', async () => {
  const { createStorage } = await loadStorage();
  const backend = fakeBackend();
  const s = createStorage(backend, { autoMigrate: false });
  assert.equal(s.setCurrentWorksheet({ topic: 'Au café', sections: [] }), true);
  assert.equal(s.setWorksheetAnswers({ q1: 'un café' }, 999), true);
  assert.equal(s.setFeedback({ answers: [] }), true);

  const r = createStorage(backend, { autoMigrate: false });
  assert.equal(r.getCurrentWorksheet().topic, 'Au café');
  assert.deepEqual(r.getWorksheetAnswers(), { answersByQuestionId: { q1: 'un café' }, lastSavedAt: 999 });
  assert.deepEqual(r.getFeedback(), { answers: [] });
});

test('corrupt JSON falls back safely and does not throw', async () => {
  const { createStorage, KEYS } = await loadStorage();
  const backend = fakeBackend({
    [KEYS.PROFILE]: '{not json',
    [KEYS.WORKSHEET_ANSWERS]: 'also bad'
  });
  const issues = [];
  const s = createStorage(backend, { autoMigrate: false, onIssue: (i) => issues.push(i) });
  assert.deepEqual(s.getProfile(), []);
  assert.equal(s.getWorksheetAnswers(), null);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.kind === 'parse'));
});

test('write failure is reported to the caller, not swallowed', async () => {
  const { createStorage } = await loadStorage();
  const issues = [];
  const s = createStorage(throwingBackend(), { autoMigrate: false, onIssue: (i) => issues.push(i) });
  assert.equal(s.setName('Kate'), false);
  assert.equal(s.setWorksheetAnswers({ q: 'a' }), false);
  assert.ok(issues.some((i) => i.kind === 'write'));
  assert.equal(s.getName(), '');
  assert.deepEqual(s.getProfile(), []);
});

test('missing schema version migrates and stamps the current version, keeping chat keys', async () => {
  const { createStorage, KEYS, CURRENT_SCHEMA_VERSION } = await loadStorage();
  const backend = fakeBackend({ [KEYS.NAME]: 'Kate' });
  const result = createStorage(backend, { autoMigrate: false }).migrate();
  assert.equal(result.migrated, true);
  assert.equal(backend.getItem(KEYS.SCHEMA_VERSION), String(CURRENT_SCHEMA_VERSION));
  assert.equal(backend.getItem(KEYS.NAME), 'Kate');
});

test('newer/unknown schema version discards worksheet keys only and keeps chat keys', async () => {
  const { createStorage, KEYS, CURRENT_SCHEMA_VERSION } = await loadStorage();
  const backend = fakeBackend({
    [KEYS.SCHEMA_VERSION]: '999',
    [KEYS.NAME]: 'Kate',
    [KEYS.PROFILE]: JSON.stringify(['likes tea']),
    [KEYS.WORKSHEET_CURRENT]: JSON.stringify({ topic: 'old' }),
    [KEYS.WORKSHEET_ANSWERS]: JSON.stringify({ answersByQuestionId: {} }),
    [KEYS.WORKSHEET_FEEDBACK]: JSON.stringify({ answers: [] })
  });
  const s = createStorage(backend, { autoMigrate: false });
  const result = s.migrate();
  assert.equal(result.discarded, true);
  assert.equal(backend.getItem(KEYS.NAME), 'Kate');
  assert.equal(backend.getItem(KEYS.PROFILE), JSON.stringify(['likes tea']));
  assert.equal(backend.getItem(KEYS.WORKSHEET_CURRENT), null);
  assert.equal(backend.getItem(KEYS.WORKSHEET_ANSWERS), null);
  assert.equal(backend.getItem(KEYS.WORKSHEET_FEEDBACK), null);
  assert.equal(backend.getItem(KEYS.SCHEMA_VERSION), String(CURRENT_SCHEMA_VERSION));
});

test('clearCurrentWorksheet removes all worksheet keys and nothing else', async () => {
  const { createStorage, KEYS } = await loadStorage();
  const backend = fakeBackend({ [KEYS.NAME]: 'Kate' });
  const s = createStorage(backend, { autoMigrate: false });
  s.setCurrentWorksheet({ topic: 'x' });
  s.setWorksheetAnswers({ q: 'a' });
  s.setFeedback({ answers: [] });
  assert.equal(s.clearCurrentWorksheet(), true);
  assert.equal(backend.getItem(KEYS.WORKSHEET_CURRENT), null);
  assert.equal(backend.getItem(KEYS.WORKSHEET_ANSWERS), null);
  assert.equal(backend.getItem(KEYS.WORKSHEET_FEEDBACK), null);
  assert.equal(backend.getItem(KEYS.NAME), 'Kate');
});

test('no localStorage backend never throws', async () => {
  const { createStorage } = await loadStorage();
  const s = createStorage(null, { autoMigrate: false });
  assert.equal(s.getName(), '');
  assert.equal(s.setName('x'), false);
  assert.deepEqual(s.getProfile(), []);
  assert.equal(s.getCurrentWorksheet(), null);
});

test('initial render model contains no answers or listening transcript; reveal does', async () => {
  // Exercises the REAL render helper, not a local JSON replacer.
  const { buildRenderModel } = await import('../public/lib/worksheet-render.js');
  const worksheet = {
    topic: 'Au café',
    sections: [
      {
        id: 'listening',
        title_fr: 'Compréhension orale',
        explanation_en: 'Listen.',
        audio: { script: 'SECRET TRANSCRIPT', speakers: [{ name: 'A', voice: 'alloy' }], cache_key: 'k' },
        questions: [{ id: 'l1', prompt: 'Que veut-il ?', type: 'short_text', answer: 'SECRET ANSWER', explanation: 'hidden' }]
      }
    ]
  };

  const initial = JSON.stringify(buildRenderModel(worksheet, { reveal: false }));
  assert.ok(!initial.includes('SECRET ANSWER'));
  assert.ok(!initial.includes('SECRET TRANSCRIPT'));
  assert.ok(initial.includes('Que veut-il ?'));

  const revealed = JSON.stringify(buildRenderModel(worksheet, { reveal: true }));
  assert.ok(revealed.includes('SECRET ANSWER'));
  assert.ok(revealed.includes('SECRET TRANSCRIPT'));
});
