'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// `public/lib/quota.js` and `public/lib/storage.js` are browser-native ES
// modules. Load them dynamically from this CommonJS test file, caching the
// promise so both are evaluated once.
let modsPromise = null;
function loadModules() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const [quota, storage] = await Promise.all([
        import('../public/lib/quota.js'),
        import('../public/lib/storage.js')
      ]);
      return { quota, storage };
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

test('no quota yet: readQuota returns an empty current-week quota', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });

  const current = quota.readQuota(s, NOW);
  assert.deepEqual(current, { weekStart: quota.currentWeekStart(NOW), count: 0 });
  assert.equal(quota.remaining(s.getQuota(), NOW), 3);
  assert.equal(quota.canGenerate(s.getQuota(), NOW), true);
});

test('1 used leaves 2 remaining', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  s.setQuota({ weekStart: quota.currentWeekStart(NOW), count: 1 });
  assert.equal(quota.remaining(s.getQuota(), NOW), 2);
});

test('2 used leaves 1 remaining', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  s.setQuota({ weekStart: quota.currentWeekStart(NOW), count: 2 });
  assert.equal(quota.remaining(s.getQuota(), NOW), 1);
});

test('3 used leaves 0 remaining and blocks generation', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  s.setQuota({ weekStart: quota.currentWeekStart(NOW), count: 3 });
  assert.equal(quota.remaining(s.getQuota(), NOW), 0);
  assert.equal(quota.canGenerate(s.getQuota(), NOW), false);
});

test('4th generation is blocked and the stored count stays at the limit', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  s.setQuota({ weekStart: quota.currentWeekStart(NOW), count: 3 });

  const result = quota.recordGeneration(s, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.persisted, false);
  assert.equal(s.getQuota().count, 3);
});

test('successful generations persist and stop at the weekly limit', async () => {
  const { quota, storage } = await loadModules();
  const backend = fakeBackend();
  const s = storage.createStorage(backend, { autoMigrate: false });

  const first = quota.recordGeneration(s, NOW);
  assert.equal(first.ok, true);
  assert.equal(s.getQuota().count, 1);

  quota.recordGeneration(s, NOW);
  assert.equal(s.getQuota().count, 2);

  const third = quota.recordGeneration(s, NOW);
  assert.equal(third.ok, true);
  assert.equal(s.getQuota().count, 3);

  const fourth = quota.recordGeneration(s, NOW);
  assert.equal(fourth.ok, false);
  assert.equal(s.getQuota().count, 3);
});

test('a stale previous-week quota resets on read', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(fakeBackend(), { autoMigrate: false });
  const thisWeek = new Date(quota.currentWeekStart(NOW));
  const lastWeek = new Date(
    thisWeek.getFullYear(),
    thisWeek.getMonth(),
    thisWeek.getDate() - 7,
    0,
    0,
    0,
    0
  ).getTime();
  s.setQuota({ weekStart: lastWeek, count: 3 });

  const current = quota.readQuota(s, NOW);
  assert.equal(current.count, 0);
  assert.equal(quota.remaining(s.getQuota(), NOW), 3);
});

test('the quota rolls over exactly at Sunday 00:00 local', async () => {
  const { quota } = await loadModules();
  const sunday = quota.currentWeekStart(NOW);
  const justBefore = sunday - 1000; // Saturday 23:59:59

  assert.notEqual(quota.currentWeekStart(justBefore), quota.currentWeekStart(sunday));

  const raw = { weekStart: quota.currentWeekStart(justBefore), count: 3 };
  assert.equal(quota.normalizeQuota(raw, justBefore).count, 3);
  assert.equal(quota.normalizeQuota(raw, sunday).count, 0);
  assert.equal(quota.remaining(raw, sunday), 3);
});

test('currentWeekStart/nextWeekStart are Sunday-00:00 local and stable within a week', async () => {
  const { quota } = await loadModules();
  const start = quota.currentWeekStart(NOW);

  const startDate = new Date(start);
  assert.equal(startDate.getDay(), 0);
  assert.equal(startDate.getHours(), 0);
  assert.equal(startDate.getMinutes(), 0);
  assert.equal(startDate.getSeconds(), 0);
  assert.equal(startDate.getMilliseconds(), 0);

  // Any instant in the same week maps back to the same boundary.
  assert.equal(quota.currentWeekStart(start), start);
  assert.equal(quota.currentWeekStart(start + 60 * 60 * 1000), start);
  assert.equal(quota.currentWeekStart(addLocalDays(start, 1)), start);

  // nextWeekStart is exactly a week later in local calendar days, not ms math.
  const next = new Date(quota.nextWeekStart(NOW));
  const expectedNext = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate() + 7,
    0,
    0,
    0,
    0
  ).getTime();
  assert.equal(quota.nextWeekStart(NOW), expectedNext);
  assert.equal(next.getDay(), 0);
  assert.equal(next.getHours(), 0);
  assert.equal(next.getMinutes(), 0);
});

test('normalizeQuota coerces and clamps malformed data', async () => {
  const { quota } = await loadModules();
  const current = quota.currentWeekStart(NOW);

  assert.equal(quota.normalizeQuota(null, NOW).count, 0);
  assert.equal(quota.normalizeQuota('garbage', NOW).count, 0);
  assert.equal(quota.normalizeQuota({}, NOW).count, 0);
  assert.equal(quota.normalizeQuota({ weekStart: 'x', count: 2 }, NOW).count, 0);
  assert.equal(quota.normalizeQuota({ weekStart: current, count: -5 }, NOW).count, 0);
  assert.equal(quota.normalizeQuota({ weekStart: current, count: 99 }, NOW).count, quota.WEEKLY_LIMIT);

  const normal = quota.normalizeQuota({ weekStart: current, count: 2 }, NOW);
  assert.deepEqual(normal, { weekStart: current, count: 2 });
});

test('recordGeneration reports a failed write without throwing', async () => {
  const { quota } = await loadModules();
  const failingStore = {
    getQuota: () => ({ weekStart: quota.currentWeekStart(NOW), count: 0 }),
    setQuota: () => false
  };
  const result = quota.recordGeneration(failingStore, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.equal(result.quota.count, 1);
});

test('recordGeneration fails open and never throws without a backend', async () => {
  const { quota, storage } = await loadModules();
  const s = storage.createStorage(null, { autoMigrate: false });
  assert.doesNotThrow(() => quota.recordGeneration(s, NOW));
  const result = quota.recordGeneration(s, NOW);
  assert.equal(result.persisted, false);
  assert.equal(s.getQuota(), null);
});
