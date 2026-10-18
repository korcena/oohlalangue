// Pure, DOM-free per-fiche score history logic.
//
// TRUST MODEL: this is a client-side convenience only. History lives in
// `localStorage` through the `storage.js` wrapper, can be cleared by the
// learner, and is not a security boundary. Every helper is fail-open: corrupt
// or foreign data normalizes to an empty history and no call ever throws, so a
// bad value can never break the worksheet feedback flow or the landing page.
//
// The week boundary is the SAME fixed local-time instant as the quota (most
// recent Sunday 00:00 browser-local). It is reused verbatim from `quota.js`
// via `currentWeekStart`; this module never re-implements the boundary math.
//
// All functions accept an injectable `now` (epoch ms) and must never throw.

import { currentWeekStart } from './quota.js';

export const SCORE_HISTORY_VERSION = 1;
export const MAX_WEEKS = 12;
export const MAX_ENTRIES = 60;

const VERDICTS = new Set(['correct', 'mistake', 'alternative']);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Whitespace-collapse a value for stable hashing.
function collapse(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// Dependency-free FNV-1a 32-bit hash rendered as 8 hex chars.
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Compute a score from an `/api/feedback` payload. `correct` and `alternative`
// count as correct; `mistake` does not. The server is asked to grade every
// question, so an unanswered fiche still comes back full of `mistake` rows;
// only entries whose `original` holds a non-empty, non-whitespace string count,
// so a blank answer is never mistaken for a graded response. Unknown verdicts
// and entries without a non-empty string `question_id` are ignored (fail-safe).
export function scoreFromFeedback(feedback) {
  try {
    const answers = feedback && Array.isArray(feedback.answers) ? feedback.answers : [];
    let correct = 0;
    let total = 0;
    for (const entry of answers) {
      if (!isPlainObject(entry)) continue;
      const questionId = typeof entry.question_id === 'string' ? entry.question_id : '';
      if (!questionId) continue;
      if (!VERDICTS.has(entry.verdict)) continue;
      if (typeof entry.original !== 'string' || !entry.original.trim()) continue;
      total += 1;
      if (entry.verdict === 'correct' || entry.verdict === 'alternative') correct += 1;
    }
    return { correct, total, score: total > 0 ? Math.round((correct / total) * 100) : 0 };
  } catch (_e) {
    return { correct: 0, total: 0, score: 0 };
  }
}

// Deterministic content hash used to dedupe a worksheet across re-send/resume.
// Canonical content, in order: topic | level | for each section:
//   id | (listening ? audio.cache_key or audio.script : '') | for each question:
//   id | prompt | (only when question.type is "form" and it has a non-empty
//   fields array: `form-fields:` followed by each whitespace-collapsed label_fr
//   length-prefixed as `<len>:<label>` and joined).
// Each part is length-prefixed (`<len>:<part>`) before hashing so a prompt that
// itself contains the `|` separator cannot make two different worksheets encode
// to the same string. A missing/empty fields array adds no part, so legacy
// identities are unchanged. Never throws; a non-object worksheet hashes ''.
export function worksheetIdentity(worksheet) {
  try {
    if (!isPlainObject(worksheet)) return fnv1a('');
    const parts = [collapse(worksheet.topic), collapse(worksheet.level)];
    const sections = Array.isArray(worksheet.sections) ? worksheet.sections : [];
    for (const section of sections) {
      if (!isPlainObject(section)) {
        parts.push('');
        continue;
      }
      parts.push(collapse(section.id));
      const audio = isPlainObject(section.audio) ? section.audio : null;
      const isListening = section.id === 'listening' || audio != null;
      parts.push(isListening && audio ? collapse(audio.cache_key) || collapse(audio.script) : '');
      const questions = Array.isArray(section.questions) ? section.questions : [];
      for (const question of questions) {
        if (!isPlainObject(question)) {
          parts.push('', '');
          continue;
        }
        parts.push(collapse(question.id), collapse(question.prompt));
        const fields = question.type === 'form' && Array.isArray(question.fields) ? question.fields : [];
        if (fields.length) {
          const labels = fields.map((field) => {
            const label = collapse(field && field.label_fr);
            return `${label.length}:${label}`;
          });
          parts.push(`form-fields:${labels.join('|')}`);
        }
      }
    }
    return fnv1a(parts.map((part) => `${part.length}:${part}`).join('|'));
  } catch (_e) {
    return fnv1a('');
  }
}

// Mean of the finite numbers in `list`, rounded. Empty/all-non-finite → 0.
export function average(list) {
  try {
    if (!Array.isArray(list)) return 0;
    const nums = list.filter((n) => Number.isFinite(n));
    if (!nums.length) return 0;
    return Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);
  } catch (_e) {
    return 0;
  }
}

// Coerce arbitrary stored data into a valid, deduped, pruned history. Accepts a
// bare array or a `{ version, entries }` object. Corrupt/foreign input → empty
// history. Recomputes `score` from the counts so a tampered value cannot
// disagree. Dedupes by `id` (greatest `at` wins), keeps the `maxWeeks` most
// recent distinct `weekStart` buckets, and finally keeps at most `maxEntries`
// entries (most recent by `at`) so stored history can never grow unbounded.
export function normalizeHistory(raw, now = Date.now(), { maxWeeks = MAX_WEEKS, maxEntries = MAX_ENTRIES } = {}) {
  try {
    const items = Array.isArray(raw)
      ? raw
      : isPlainObject(raw) && Array.isArray(raw.entries)
        ? raw.entries
        : [];
    const currentStart = currentWeekStart(now);
    const byId = new Map();
    for (const item of items) {
      if (!isPlainObject(item)) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const at = Number.isFinite(item.at) ? item.at : null;
      const weekStart = Number.isFinite(item.weekStart)
        ? item.weekStart
        : at != null
          ? currentWeekStart(at)
          : null;
      if (weekStart == null || weekStart > currentStart) continue;
      const total = Number.isFinite(item.total) ? Math.floor(item.total) : 0;
      if (total <= 0) continue;
      const correct = Math.min(Math.max(0, Math.floor(item.correct || 0)), total);
      const score = Math.round((correct / total) * 100);
      const topic = String(item.topic || '').trim().slice(0, 80);
      const entry = { id, weekStart, at: at == null ? 0 : at, topic, correct, total, score };
      const existing = byId.get(id);
      if (!existing || entry.at > existing.at) byId.set(id, entry);
    }

    const sorted = Array.from(byId.values()).sort((a, b) => a.at - b.at);
    const weeks = Array.from(new Set(sorted.map((e) => e.weekStart))).sort((a, b) => b - a);
    const kept = new Set(weeks.slice(0, Math.max(0, maxWeeks)));
    const entries = sorted
      .filter((e) => kept.has(e.weekStart))
      .slice(-Math.max(0, maxEntries));
    return { version: SCORE_HISTORY_VERSION, entries };
  } catch (_e) {
    return { version: SCORE_HISTORY_VERSION, entries: [] };
  }
}

function safeGet(storage) {
  try {
    if (!storage || typeof storage.getScoreHistory !== 'function') return null;
    return storage.getScoreHistory();
  } catch (_e) {
    return null;
  }
}

function safeSet(storage, history) {
  try {
    if (!storage || typeof storage.setScoreHistory !== 'function') return false;
    return Boolean(storage.setScoreHistory(history));
  } catch (_e) {
    return false;
  }
}

// Greatest `at` among the entries of a raw stored history (bare array or
// `{ entries }` object); `-Infinity` when there are none. Used so normalization
// never treats already-stored weeks as "future" after a clock rewind.
function latestStoredAt(raw) {
  const items = Array.isArray(raw)
    ? raw
    : isPlainObject(raw) && Array.isArray(raw.entries)
      ? raw.entries
      : [];
  let latest = -Infinity;
  for (const item of items) {
    if (isPlainObject(item) && Number.isFinite(item.at) && item.at > latest) latest = item.at;
  }
  return latest;
}

// Read and normalize the history from a store exposing `getScoreHistory()`.
export function readHistory(storage, now = Date.now()) {
  return normalizeHistory(safeGet(storage), now);
}

// Upsert one score entry and persist the history. `entry` is
// `{ id, topic?, correct, total }`. Returns `{ ok, persisted, entries, reason? }`.
// Never throws; on a failed write the in-memory `entries` still reflect the
// update but `persisted` is false.
export function recordScore(storage, entry, now = Date.now()) {
  const raw = safeGet(storage);
  // Normalize with an effective `now` that is never earlier than the newest
  // stored entry, so a backwards clock jump cannot make the future-drop rule
  // delete weeks that are already stored. The NEW entry is still stamped from
  // the actual `now` below.
  const latest = latestStoredAt(raw);
  const effectiveNow = Number.isFinite(latest) ? Math.max(now, latest) : now;
  const current = normalizeHistory(raw, effectiveNow);
  try {
    const source = isPlainObject(entry) ? entry : {};
    const id = typeof source.id === 'string' ? source.id.trim() : '';
    const total = Number.isFinite(source.total) ? Math.floor(source.total) : 0;
    if (!id || total <= 0) {
      return { ok: false, persisted: false, entries: current.entries, reason: 'invalid-entry' };
    }
    const correct = Math.min(Math.max(0, Math.floor(source.correct || 0)), total);
    const at = now;
    const weekStart = currentWeekStart(now);
    const topic = String(source.topic || '').trim().slice(0, 80);
    const score = Math.round((correct / total) * 100);
    const next = current.entries.filter((e) => e.id !== id);
    next.push({ id, weekStart, at, topic, correct, total, score });
    const normalized = normalizeHistory({ version: SCORE_HISTORY_VERSION, entries: next }, effectiveNow);
    const payload = { version: SCORE_HISTORY_VERSION, entries: normalized.entries };
    const persisted = safeSet(storage, payload);
    return { ok: true, persisted, entries: normalized.entries };
  } catch (_e) {
    return { ok: false, persisted: false, entries: current.entries, reason: 'invalid-entry' };
  }
}

// Group normalized entries into per-week buckets, most recent first.
// Each bucket: `{ weekStart, entries (ascending by at), count, average }`.
export function historyByWeek(raw, now = Date.now(), weeks = MAX_WEEKS) {
  try {
    const normalized = normalizeHistory(raw, now);
    const buckets = new Map();
    for (const entry of normalized.entries) {
      if (!buckets.has(entry.weekStart)) buckets.set(entry.weekStart, []);
      buckets.get(entry.weekStart).push(entry);
    }
    return Array.from(buckets.entries())
      .map(([weekStart, entries]) => {
        const sorted = entries.slice().sort((a, b) => a.at - b.at);
        return {
          weekStart,
          entries: sorted,
          count: sorted.length,
          average: average(sorted.map((e) => e.score))
        };
      })
      .sort((a, b) => b.weekStart - a.weekStart)
      .slice(0, Math.max(0, weeks));
  } catch (_e) {
    return [];
  }
}

// This week's bucket (most recent entry first), or an empty bucket when there
// are no entries in the current week.
export function thisWeek(raw, now = Date.now()) {
  const weekStart = currentWeekStart(now);
  try {
    const entries = normalizeHistory(raw, now)
      .entries.filter((e) => e.weekStart === weekStart)
      .sort((a, b) => b.at - a.at);
    return {
      weekStart,
      entries,
      count: entries.length,
      average: average(entries.map((e) => e.score))
    };
  } catch (_e) {
    return { weekStart, entries: [], count: 0, average: 0 };
  }
}
