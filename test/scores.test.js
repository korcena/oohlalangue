'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// `public/lib/*.js` are browser-native ES modules. Load them dynamically from
// this CommonJS test file, caching the promise so they are evaluated once.
let modsPromise = null;
function loadModules() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const [scores, storage, quota] = await Promise.all([
        import('../public/lib/scores.js'),
        import('../public/lib/storage.js'),
        import('../public/lib/quota.js')
      ]);
      return { scores, storage, quota };
    })();
  }
  return modsPromise;
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

function feedback(list) {
  return { answers: list };
}

// A fixed mid-week instant (Wednesday 2026-10-14, 12:00 local) keeps the
// boundary math deterministic without depending on the wall clock.
const NOW = new Date(2026, 9, 14, 12, 0, 0, 0).getTime();

// DST-independent local-calendar day arithmetic. Fixed `days * 86400000`
// offsets drift across DST transitions; constructing from local calendar
// components (as the product code does) keeps fixtures on the intended local
// day in every timezone.
function addLocalDays(epochMs, days) {
  const d = new Date(epochMs);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  ).getTime();
}

// -- 1-6: scoreFromFeedback -------------------------------------------------

test('scoreFromFeedback: all correct scores 100', async () => {
  const { scores } = await loadModules();
  assert.deepEqual(
    scores.scoreFromFeedback(
      feedback([
        { question_id: 'q1', verdict: 'correct', original: 'un café' },
        { question_id: 'q2', verdict: 'correct', original: 'à Paris' },
        { question_id: 'q3', verdict: 'correct', original: 'trois' }
      ])
    ),
    { correct: 3, total: 3, score: 100 }
  );
});

test('scoreFromFeedback: all mistake scores 0', async () => {
  const { scores } = await loadModules();
  const list = ['q1', 'q2', 'q3'].map((q) => ({
    question_id: q,
    verdict: 'mistake',
    original: 'mauvaise réponse'
  }));
  assert.deepEqual(scores.scoreFromFeedback(feedback(list)), { correct: 0, total: 3, score: 0 });
});

test('scoreFromFeedback: alternative counts as correct', async () => {
  const { scores } = await loadModules();
  const list = [
    { question_id: 'q1', verdict: 'correct', original: 'un café' },
    { question_id: 'q2', verdict: 'alternative', original: 'un thé' },
    { question_id: 'q3', verdict: 'mistake', original: 'du lait' }
  ];
  assert.deepEqual(scores.scoreFromFeedback(feedback(list)), { correct: 2, total: 3, score: 67 });
});

test('scoreFromFeedback: rounds to the nearest integer', async () => {
  const { scores } = await loadModules();
  const mk = (correct, total) =>
    Array.from({ length: total }, (_, i) => ({
      question_id: `q${i}`,
      verdict: i < correct ? 'correct' : 'mistake',
      original: 'réponse'
    }));

  assert.equal(scores.scoreFromFeedback(feedback(mk(2, 3))).score, 67);
  assert.equal(scores.scoreFromFeedback(feedback(mk(1, 3))).score, 33);
  assert.equal(scores.scoreFromFeedback(feedback(mk(5, 6))).score, 83);
});

test('scoreFromFeedback: zero graded answers is a zero score', async () => {
  const { scores } = await loadModules();
  const empty = { correct: 0, total: 0, score: 0 };
  assert.deepEqual(scores.scoreFromFeedback(null), empty);
  assert.deepEqual(scores.scoreFromFeedback(undefined), empty);
  assert.deepEqual(scores.scoreFromFeedback({}), empty);
  assert.deepEqual(scores.scoreFromFeedback({ answers: [] }), empty);
  assert.deepEqual(scores.scoreFromFeedback({ answers: 'nope' }), empty);
});

test('scoreFromFeedback: unknown verdicts and missing question_id are ignored', async () => {
  const { scores } = await loadModules();
  const list = [
    { question_id: 'q1', verdict: 'bogus', original: 'réponse' },
    { question_id: '', verdict: 'correct', original: 'réponse' },
    { verdict: 'correct', original: 'réponse' },
    { question_id: 'q2', verdict: 'correct', original: 'réponse' }
  ];
  assert.deepEqual(scores.scoreFromFeedback(feedback(list)), { correct: 1, total: 1, score: 100 });
});

test('scoreFromFeedback: a blank original is not a graded answer', async () => {
  const { scores } = await loadModules();
  const list = [
    { question_id: 'q1', verdict: 'correct', original: 'un café' },
    { question_id: 'q2', verdict: 'mistake', original: '   ' },
    { question_id: 'q3', verdict: 'mistake' },
    { question_id: 'q4', verdict: 'mistake', original: '' }
  ];
  assert.deepEqual(scores.scoreFromFeedback(feedback(list)), { correct: 1, total: 1, score: 100 });
});

test('scoreFromFeedback: an all-blank payload records nothing', async () => {
  const { scores } = await loadModules();
  const list = ['q1', 'q2', 'q3'].map((q) => ({
    question_id: q,
    verdict: 'mistake',
    original: '  \t '
  }));
  assert.deepEqual(scores.scoreFromFeedback(feedback(list)), { correct: 0, total: 0, score: 0 });
});

// -- 7-8: worksheetIdentity -------------------------------------------------

function baseWorksheet() {
  return {
    topic: 'Au café',
    level: 'A1',
    sections: [
      {
        id: 'listening',
        audio: { script: 'Bonjour, un café svp.', cache_key: 'key-1' },
        questions: [{ id: 'l1', prompt: 'Que veut-il ?' }]
      },
      {
        id: 'reading',
        questions: [{ id: 'r1', prompt: 'Où est le café ?' }]
      }
    ]
  };
}

test('worksheetIdentity: deterministic and content-sensitive', async () => {
  const { scores } = await loadModules();
  const base = baseWorksheet();
  const id = scores.worksheetIdentity(base);
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.equal(scores.worksheetIdentity(baseWorksheet()), id);

  const otherTopic = baseWorksheet();
  otherTopic.topic = 'À la boulangerie';
  assert.notEqual(scores.worksheetIdentity(otherTopic), id);

  const otherQuestion = baseWorksheet();
  otherQuestion.sections[1].questions[0].id = 'r2';
  assert.notEqual(scores.worksheetIdentity(otherQuestion), id);

  const otherPrompt = baseWorksheet();
  otherPrompt.sections[1].questions[0].prompt = 'Quel est le prix ?';
  assert.notEqual(scores.worksheetIdentity(otherPrompt), id);

  const otherCacheKey = baseWorksheet();
  otherCacheKey.sections[0].audio.cache_key = 'key-2';
  assert.notEqual(scores.worksheetIdentity(otherCacheKey), id);

  const spaced = baseWorksheet();
  spaced.topic = '  Au   café ';
  spaced.sections[1].questions[0].prompt = 'Où est le  café ?';
  const spacedRef = baseWorksheet();
  spacedRef.sections[1].questions[0].prompt = 'Où est le café ?';
  assert.equal(scores.worksheetIdentity(spaced), scores.worksheetIdentity(spacedRef));
});

test('worksheetIdentity: legacy-safe and never throws', async () => {
  const { scores } = await loadModules();
  for (const value of [null, undefined, 42, 'text', [], {}, { topic: 'x' }, { sections: [{}] }, { sections: [{ questions: [{}] }] }]) {
    assert.equal(typeof scores.worksheetIdentity(value), 'string');
  }
  assert.equal(scores.worksheetIdentity(null), scores.worksheetIdentity(42));
  assert.equal(
    scores.worksheetIdentity({ topic: 'x' }),
    scores.worksheetIdentity({ topic: 'x' })
  );
});

test('worksheetIdentity: a prompt containing the old separator does not collide', async () => {
  const { scores } = await loadModules();
  // Two questions in one section...
  const twoQuestions = {
    topic: 'T',
    level: 'A1',
    sections: [
      {
        id: 's',
        questions: [
          { id: 'q1', prompt: 'a' },
          { id: 'q2', prompt: 'b' }
        ]
      }
    ]
  };
  // ...versus one question whose prompt contains the old `|` separator. With a
  // bare `parts.join('|')` both encode to the same string, so the length prefix
  // is what keeps the encoding unambiguous.
  const oneQuestion = {
    topic: 'T',
    level: 'A1',
    sections: [
      {
        id: 's',
        questions: [{ id: 'q1', prompt: 'a|q2|b' }]
      }
    ]
  };
  assert.notEqual(
    scores.worksheetIdentity(twoQuestions),
    scores.worksheetIdentity(oneQuestion)
  );
});

// -- 9-10: normalizeHistory -------------------------------------------------

test('normalizeHistory: corrupt and foreign input falls back to empty', async () => {
  const { scores } = await loadModules();
  const empty = { version: scores.SCORE_HISTORY_VERSION, entries: [] };
  assert.deepEqual(scores.normalizeHistory(null, NOW), empty);
  assert.deepEqual(scores.normalizeHistory('garbage', NOW), empty);
  assert.deepEqual(scores.normalizeHistory({ entries: 'x' }, NOW), empty);
  assert.deepEqual(scores.normalizeHistory(42, NOW), empty);
});

test('normalizeHistory: accepts a bare array and drops invalid entries', async () => {
  const { scores, quota } = await loadModules();
  const weekStart = quota.currentWeekStart(NOW);
  const future = addLocalDays(weekStart, 7);
  const bare = [
    { id: 'good', weekStart, at: NOW, correct: 1, total: 2, score: 50 },
    { id: '', weekStart, at: NOW, correct: 1, total: 2 },
    { id: 'zero', weekStart, at: NOW, correct: 0, total: 0 },
    { id: 'foreign', weekStart: future, at: NOW, correct: 1, total: 2 }
  ];
  const normal = scores.normalizeHistory(bare, NOW);
  assert.equal(normal.entries.length, 1);
  assert.equal(normal.entries[0].id, 'good');
});

test('normalizeHistory: recomputes score and clamps correct to total', async () => {
  const { scores, quota } = await loadModules();
  const weekStart = quota.currentWeekStart(NOW);
  const raw = {
    version: 1,
    entries: [
      { id: 'a', weekStart, at: NOW, correct: 1, total: 2, score: 999 },
      { id: 'b', weekStart, at: NOW + 1, correct: 5, total: 3, score: 0 }
    ]
  };
  const normal = scores.normalizeHistory(raw, NOW);
  const a = normal.entries.find((e) => e.id === 'a');
  const b = normal.entries.find((e) => e.id === 'b');
  assert.equal(a.score, 50);
  assert.equal(b.correct, 3);
  assert.equal(b.score, 100);
});

// -- 11-13: recordScore -----------------------------------------------------

test('recordScore: appends then updates in place by id (no double counting)', async () => {
  const { scores, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });

  const first = scores.recordScore(s, { id: 'a', correct: 2, total: 4 }, NOW);
  assert.equal(first.ok, true);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].score, 50);

  const second = scores.recordScore(s, { id: 'a', correct: 4, total: 4 }, NOW + 1000);
  assert.equal(second.entries.length, 1);
  assert.equal(scores.readHistory(s, NOW).entries.length, 1);
  assert.equal(scores.readHistory(s, NOW).entries[0].score, 100);
});

test('recordScore: derives the week bucket, timestamp and score', async () => {
  const { scores, storage, quota } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  const result = scores.recordScore(s, { id: 'a', topic: 'Au café', correct: 2, total: 3 }, NOW);
  const entry = result.entries[0];
  assert.equal(entry.weekStart, quota.currentWeekStart(NOW));
  assert.equal(entry.at, NOW);
  assert.equal(entry.score, 67);
});

test('recordScore: rejects missing id and non-positive total without throwing', async () => {
  const { scores, storage } = await loadModules();
  const backend = fakeBackend();
  const s = storage.createStorage(backend, { autoMigrate: false });

  for (const bad of [{ correct: 1, total: 2 }, { id: '', correct: 1, total: 2 }, { id: 'a', correct: 0, total: 0 }, null]) {
    let result;
    assert.doesNotThrow(() => {
      result = scores.recordScore(s, bad, NOW);
    });
    assert.equal(result.ok, false);
    assert.equal(result.persisted, false);
  }
  assert.equal(backend.map.has(s.KEYS.SCORE_HISTORY), false);
});

test('recordScore: an earlier now does not delete newer stored weeks', async () => {
  const { scores, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });

  // Two entries recorded at a later instant (and a later week than the third).
  const later1 = addLocalDays(NOW, 7);
  const later2 = addLocalDays(NOW, 10);
  scores.recordScore(s, { id: 'a', correct: 1, total: 2 }, later1);
  scores.recordScore(s, { id: 'b', correct: 2, total: 2 }, later2);

  // System clock rewinds: record a third entry with an earlier `now`. The two
  // newer weeks must survive normalization.
  scores.recordScore(s, { id: 'c', correct: 1, total: 2 }, NOW);

  const read = scores.readHistory(s, later2);
  assert.ok(read.entries.some((e) => e.id === 'a'));
  assert.ok(read.entries.some((e) => e.id === 'b'));
  assert.ok(read.entries.some((e) => e.id === 'c'));
});

// -- 14-17: grouping, boundary, pruning, empty ------------------------------

test('historyByWeek: groups two weeks most recent first with per-week averages', async () => {
  const { scores, storage, quota } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  const lastWeekNow = addLocalDays(quota.currentWeekStart(NOW), -3);

  scores.recordScore(s, { id: 'a', correct: 1, total: 2 }, lastWeekNow);
  scores.recordScore(s, { id: 'b', correct: 3, total: 3 }, NOW);

  const buckets = scores.historyByWeek(s.getScoreHistory(), NOW);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].weekStart, quota.currentWeekStart(NOW));
  assert.equal(buckets[0].count, 1);
  assert.equal(buckets[0].average, 100);
  assert.equal(buckets[1].weekStart, quota.currentWeekStart(lastWeekNow));
  assert.equal(buckets[1].count, 1);
  assert.equal(buckets[1].average, 50);
});

test('Sunday boundary: entries keep the week they were recorded in', async () => {
  const { scores, storage, quota } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  const sunday = quota.currentWeekStart(NOW);
  const justBefore = sunday - 1000; // Saturday 23:59:59
  const mondayAfter = new Date(sunday);
  mondayAfter.setDate(mondayAfter.getDate() + 1);
  const later = mondayAfter.getTime();

  scores.recordScore(s, { id: 'old', correct: 1, total: 2 }, justBefore);
  scores.recordScore(s, { id: 'new', correct: 2, total: 2 }, sunday);

  const read = scores.readHistory(s, later);
  const old = read.entries.find((e) => e.id === 'old');
  const fresh = read.entries.find((e) => e.id === 'new');
  assert.equal(old.weekStart, quota.currentWeekStart(justBefore));
  assert.equal(fresh.weekStart, sunday);
  assert.notEqual(old.weekStart, fresh.weekStart);
});

test('normalizeHistory: prunes to the 12 most recent distinct weeks', async () => {
  const { scores, quota } = await loadModules();
  const seed = [];
  for (let i = 0; i < 13; i += 1) {
    const weekStart = addLocalDays(quota.currentWeekStart(NOW), -7 * i);
    seed.push({ id: `w${i}`, weekStart, at: weekStart + 60 * 60 * 1000, correct: 1, total: 2 });
  }
  const normal = scores.normalizeHistory(seed, NOW);
  const distinct = new Set(normal.entries.map((e) => e.weekStart));
  assert.equal(distinct.size, 12);
  assert.equal(normal.entries.some((e) => e.id === 'w12'), false);
});

test('normalizeHistory: caps entries to the 60 most recent by at', async () => {
  const { scores, quota } = await loadModules();
  const weekStart = quota.currentWeekStart(NOW);
  const seed = [];
  for (let i = 0; i < 70; i += 1) {
    seed.push({
      id: `e${i}`,
      weekStart,
      at: NOW - (69 - i) * 1000,
      correct: 1,
      total: 2
    });
  }
  const normal = scores.normalizeHistory(seed, NOW);
  assert.equal(normal.entries.length, scores.MAX_ENTRIES);
  assert.equal(normal.entries.some((e) => e.id === 'e0'), false);
  assert.equal(normal.entries.some((e) => e.id === 'e69'), true);
});

test('empty history: readHistory, historyByWeek and thisWeek', async () => {
  const { scores, storage, quota } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  assert.deepEqual(scores.readHistory(s, NOW), {
    version: scores.SCORE_HISTORY_VERSION,
    entries: []
  });
  assert.deepEqual(scores.historyByWeek(s.getScoreHistory(), NOW), []);
  assert.deepEqual(scores.thisWeek(s.getScoreHistory(), NOW), {
    weekStart: quota.currentWeekStart(NOW),
    entries: [],
    count: 0,
    average: 0
  });
});

// -- 18-20: average, persistence failure, no backend ------------------------

test('average: mean of finite numbers, rounded; empty or non-finite is 0', async () => {
  const { scores } = await loadModules();
  assert.equal(scores.average([]), 0);
  assert.equal(scores.average([100, 0]), 50);
  assert.equal(scores.average([67, 67, 68]), 67);
  assert.equal(scores.average([100, 'x', null, NaN, Infinity, 0]), 50);
  assert.equal(scores.average(null), 0);
});

test('recordScore: a failed write is fail-open and keeps the in-memory entries', async () => {
  const { scores, quota } = await loadModules();
  const failingStore = {
    getScoreHistory: () => null,
    setScoreHistory: () => false
  };
  let result;
  assert.doesNotThrow(() => {
    result = scores.recordScore(failingStore, { id: 'a', correct: 2, total: 4 }, NOW);
  });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].weekStart, quota.currentWeekStart(NOW));
});

test('no backend or corrupt stored JSON never throws', async () => {
  const { scores, storage } = await loadModules();

  const noBackend = storage.createStorage(null, { autoMigrate: false });
  assert.deepEqual(scores.readHistory(noBackend, NOW).entries, []);
  assert.doesNotThrow(() => scores.recordScore(noBackend, { id: 'a', correct: 1, total: 2 }, NOW));

  const corrupt = storage.createStorage(
    fakeBackend({ [storage.KEYS.SCORE_HISTORY]: '{not json' }),
    { autoMigrate: false }
  );
  assert.deepEqual(scores.readHistory(corrupt, NOW).entries, []);
  assert.doesNotThrow(() => scores.recordScore(corrupt, { id: 'a', correct: 1, total: 2 }, NOW));
});
