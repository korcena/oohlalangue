// Pure, DOM-free weekly generation quota logic.
//
// TRUST MODEL: this is a client-side, per-browser limit only. It is enforced
// through the `storage.js` wrapper so it survives reloads on one device, but it
// can be cleared by the learner and is not a security boundary. When storage is
// unavailable the helpers fail OPEN (generation is allowed): blocking the app
// because a counter cannot be persisted is worse UX than not enforcing.
//
// The week boundary is a fixed local-time instant: the most recent Sunday at
// 00:00 browser-local. It is computed from local calendar components (never by
// adding 7 * 86_400_000 ms, which drifts across DST), so the reset is correct
// for every browser independent of server time.
//
// All functions accept an injectable `now` (epoch ms) and must never throw.

export const WEEKLY_LIMIT = 3;

// Epoch ms of the most recent Sunday 00:00 in browser-local time.
export function currentWeekStart(now = Date.now()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sunday, evaluated in local time
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
}

// Epoch ms of the next Sunday 00:00 in browser-local time (the reset instant).
export function nextWeekStart(now = Date.now()) {
  const d = new Date(now);
  const day = d.getDay();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 7, 0, 0, 0, 0).getTime();
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Coerce arbitrary stored data into a valid quota for the week containing
// `now`, resetting across the boundary and clamping the count to the limit.
export function normalizeQuota(raw, now = Date.now()) {
  const weekStart = currentWeekStart(now);
  if (!isPlainObject(raw)) return { weekStart, count: 0 };
  if (!Number.isFinite(raw.weekStart) || !Number.isFinite(raw.count)) {
    return { weekStart, count: 0 };
  }
  if (raw.weekStart !== weekStart) return { weekStart, count: 0 };
  const count = Math.min(Math.max(0, Math.floor(raw.count)), WEEKLY_LIMIT);
  return { weekStart: raw.weekStart, count };
}

export function remaining(raw, now = Date.now()) {
  return WEEKLY_LIMIT - normalizeQuota(raw, now).count;
}

export function canGenerate(raw, now = Date.now()) {
  return remaining(raw, now) > 0;
}

function safeGetQuota(storage) {
  try {
    if (!storage || typeof storage.getQuota !== 'function') return null;
    return storage.getQuota();
  } catch (_e) {
    return null;
  }
}

function safeSetQuota(storage, quota) {
  try {
    if (!storage || typeof storage.setQuota !== 'function') return false;
    return Boolean(storage.setQuota(quota));
  } catch (_e) {
    return false;
  }
}

// Read and normalize the quota from a store exposing `getQuota()`.
export function readQuota(storage, now = Date.now()) {
  return normalizeQuota(safeGetQuota(storage), now);
}

// Record one successful generation. Returns `{ ok, persisted, quota }`:
// `ok` is false (and nothing is written) once the limit is reached; `persisted`
// reflects whether the write succeeded. Never throws and never exceeds the
// limit.
export function recordGeneration(storage, now = Date.now()) {
  const quota = normalizeQuota(safeGetQuota(storage), now);
  if (quota.count >= WEEKLY_LIMIT) {
    return { ok: false, persisted: false, quota };
  }
  const next = { weekStart: quota.weekStart, count: quota.count + 1 };
  const persisted = safeSetQuota(storage, next);
  return { ok: true, persisted, quota: next };
}
