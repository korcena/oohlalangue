# Worksheet Score Tracking + "Progrès" panel — Focused Implementation Plan

Date: 2026-10-17
Branch: `feature/chat-worksheet-lite`
Status: Ready for execution
Scope: Small, localized, client-side-only feature. Builds directly on the shipped weekly-quota
feature (`public/lib/quota.js`, `WORKSHEET_SESSION_KEYS` split). No server, DB, dependency, or
charting-library change.

This plan is Markdown only. It does not implement code. Each task is written so an independent
agent can execute it.

---

## 1. Objective

Track a **per-fiche score** (percentage of correct answers) for each worksheet that receives
teacher feedback, group scores **by the same fixed weekly boundary as the quota** (most recent
Sunday 00:00 browser-local), and show a minimal **"Progrès"** panel on the landing page.

- The score is computed **client-side from the existing `/api/feedback` payload**:
  `round(correct / total * 100)`, where `alternative` **counts as correct** and `mistake` does
  not. `total` = number of graded answers (answers that received feedback rows/verdicts).
- Recording happens **only when feedback is successfully received** in the
  "Envoyer au professeur" flow. No new AI call, no server change.
- History is kept in **`localStorage`** under a new key, capped at the **last 12 weeks**,
  pruned on read/write. It survives per-fiche clears (`clearCurrentWorksheet()`), exactly like
  the quota counter.
- The landing page renders: **this week's graded fiches** (topic + individual score), the
  **weekly average**, and a **history of up to 12 weeks** (average + fiche count per week, most
  recent first). No charting library — a simple list/trend.
- Empty state: a friendly **French** "noch keine / pas encore" message that does not break the
  landing layout.

---

## 2. Relevant Files

| File | Role | Change? |
|---|---|---|
| `public/lib/storage.js` | Versioned localStorage wrapper; `KEYS`, `WORKSHEET_KEYS`, `WORKSHEET_SESSION_KEYS`, `getQuota`/`setQuota` template | **Edit**: new `SCORE_HISTORY` key + `getScoreHistory`/`setScoreHistory`; add to `WORKSHEET_KEYS`, **not** `WORKSHEET_SESSION_KEYS` |
| `public/lib/scores.js` | Pure, DOM-free score/history logic (new) | **Create** |
| `public/lib/quota.js` | Shipped pure quota module (`currentWeekStart`, `nextWeekStart`, …) | **Read only** — reuse `currentWeekStart`; do not modify |
| `public/views/worksheet.js` | `sendToTeacher()` (feedback receipt, ~line 724) | **Edit**: compute + record the score after `state.feedback = feedback` |
| `public/views/landing.js` | Landing page; "Progrès" panel renders here | **Edit**: read `ctx.storage` history and render the panel |
| `public/styles.css` | Existing `.summary-card`, `.notice`, `.cache-note` | **Read only** — no new CSS required |
| `test/scores.test.js` | `node:test` unit tests for the new pure module (new) | **Create** |
| `test/storage.test.js` | Existing storage tests | **Edit**: score-key round-trip, migration, session-clear assertions |
| `test/manual-qa.md` | Manual QA checklist | **Edit**: add a "Progrès" section |
| `docs/superpowers/specs/2026-10-17-worksheet-score-tracking-plan.md` | This plan | **Create** |

Context read but not changed: `public/app.js` (`ctx` exposes `storage`), `public/lib/api.js`
(`feedback` wrapper), `public/lib/worksheet-render.js` (`feedbackToUi` shows the feedback entry
shape: `{ question_id, verdict, … }` with `verdict ∈ correct|mistake|alternative`).

---

## 3. Design Decisions

### 3.1 Stored data shape

New key: **`oohlalangue_score_history`** (constant `KEYS.SCORE_HISTORY`). Value:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "9f2c…",
      "weekStart": 1728777600000,
      "at": 1728840000000,
      "topic": "Au café",
      "correct": 7,
      "total": 9,
      "score": 78
    }
  ]
}
```

- `id`: stable per-worksheet identity used for dedupe (§3.2).
- `weekStart`: epoch ms of the most recent **Sunday 00:00 local**, computed at record time via
  `currentWeekStart(at)` from `quota.js`. This is the grouping key and is stored explicitly so
  grouping never re-derives boundary math and a fiche graded just before Sunday stays in its
  original week on later reads.
- `at`: epoch ms when the score was recorded (injected `now`); used for ordering inside a week.
- `topic`: short human label (`''` when unknown), truncated to 80 chars.
- `correct`: number of graded answers whose verdict is `correct` or `alternative`.
- `total`: number of graded answers.
- `score`: integer `round(correct / total * 100)`; recomputed from `correct`/`total` in
  `normalizeHistory` so a tampered/corrupt `score` cannot disagree with the counts.

**Why a `{ version, entries }` object rather than a bare array:** it mirrors the quota record's
object convention, lets `normalizeHistory` tell "corrupt" from "empty", and leaves room for a
future schema field without a new key. `normalizeHistory` still accepts a bare array (defensive
read of foreign/older data).

**Key list membership (critical):**

- **NOT in `WORKSHEET_SESSION_KEYS`.** `clearCurrentWorksheet()` runs on every successful
  generation and on "Nouvelle fiche"; score history must survive all per-fiche clears, exactly
  like `QUOTA_GENERATIONS`.
- **IN `WORKSHEET_KEYS`** (the migration/discard list), so a future schema-version bump discards
  it with the other worksheet keys, consistent with the quota precedent. Chat keys stay untouched.

### 3.2 Dedupe / idempotency (stable per-worksheet identity)

**Chosen identity: a deterministic content hash (`worksheetIdentity`), with no client-minted id
and no mutation of the server payload.**

`worksheetIdentity(worksheet)` canonicalizes intrinsic worksheet content and hashes it with a
dependency-free string hash (FNV-1a or djb2, 32-bit hex):

```
topic | level | for each section in order:
  section.id | (listening ? audio.cache_key or normalized audio.script : '') |
  for each question in order: q.id | q.prompt
```

- Content is whitespace-collapsed before hashing. The listening `cache_key` is already a
  sha256 of script+speakers, so it strongly discriminates worksheets.
- **Rule:** `recordScore` looks up the entry by `id`. If found, it **replaces/updates that entry
  in place** (same `id`, refreshed `at`/`weekStart`/`score`); otherwise it appends. Re-sending the
  same worksheet (after resume or a re-send) therefore never double-counts.
- **Why not an explicit minted id:** the identity is pure and deterministic, needs **no**
  payload mutation, works automatically for **legacy/resumed worksheets** already stored in
  `WORKSHEET_CURRENT` (no minting site, no migration, no re-persist from `sendToTeacher`), and is
  trivially unit-testable. It also avoids the "where is the id minted?" question entirely.
- **Accepted tradeoff:** regenerating a byte-identical worksheet (same topic, same section and
  question ids, same prompts, same listening script) collapses onto the same entry. With the
  section/question ids, prompts *and* audio `cache_key` included, two independently generated
  fiches being identical is extremely unlikely; if they are identical, treating them as the same
  fiche is defensible. Documented as an accepted limitation.

### 3.3 Weekly boundary

Reuse `currentWeekStart(now)` / `nextWeekStart(now)` from `quota.js` for all grouping and for the
landing recency label. Do **not** re-implement the Sunday-boundary math. Retention/pruning
operates on the **already-stored `weekStart` values** (each computed via `currentWeekStart` at
record time), so no additional boundary arithmetic is introduced:

- Pruning = keep the **`maxWeeks` (12) most recent distinct `weekStart` buckets**; drop the rest.
- Foreign/future buckets are dropped when `weekStart > currentWeekStart(now)`.
- An entry recorded just before Sunday keeps its old `weekStart` on later reads (it is grouped by
  the stored value, never re-bucketed into the current week).

---

## 4. Score Module (`public/lib/scores.js`) — pure, DOM-free, injectable `now`

Mirror `quota.js` style: focused module, pure helpers, injectable `now`, **never throws**, JSDoc
trust-model comment (client-side only, fail-open, not a security boundary). No import of the
storage singleton; side-effecting wrappers take an injected store exposing
`getScoreHistory()` / `setScoreHistory(obj)`.

Exports:

- `export const SCORE_HISTORY_VERSION = 1;`
- `export const MAX_WEEKS = 12;`
- `export function scoreFromFeedback(feedback)` — **pure**.
  - `answers = feedback && Array.isArray(feedback.answers) ? feedback.answers : []`.
  - For each entry with a non-empty string `question_id` and a known verdict
    (`correct|mistake|alternative`): `total += 1`; `correct += (verdict === 'correct' ||
    verdict === 'alternative') ? 1 : 0`. Unknown verdicts are ignored (fail-safe).
  - Return `{ correct, total, score: total > 0 ? Math.round((correct / total) * 100) : 0 }`.
  - `null` / non-array / zero graded answers → `{ correct: 0, total: 0, score: 0 }`.
- `export function worksheetIdentity(worksheet)` — **pure, deterministic**; per §3.2. Never
  throws; non-object worksheet → hash of `''`.
- `export function average(list)` — **pure**; mean of finite numbers in `list`, rounded; empty or
  all-non-finite → `0`.
- `export function normalizeHistory(raw, now = Date.now(), { maxWeeks = MAX_WEEKS } = {})` —
  **pure**. Accepts a bare array or `{ version, entries }`. For each item that is a plain object:
  - require a non-empty `id` string, else skip;
  - `at = Number.isFinite(item.at) ? item.at : null`;
  - `weekStart = Number.isFinite(item.weekStart) ? item.weekStart : (at != null ? currentWeekStart(at) : null)`;
  - skip when `weekStart == null` or `weekStart > currentWeekStart(now)` (foreign/future);
  - `total = Number.isFinite(item.total) ? Math.floor(item.total) : 0`; skip when `total <= 0`;
  - `correct = Math.min(Math.max(0, Math.floor(item.correct || 0)), total)`;
  - `score = Math.round((correct / total) * 100)` (recomputed);
  - `topic = String(item.topic || '').trim().slice(0, 80)`.
  - Dedupe by `id` (keep the entry with the greatest `at`), re-sort ascending by `at`.
  - Prune to the `maxWeeks` most recent distinct `weekStart` buckets.
  - Return `{ version: SCORE_HISTORY_VERSION, entries }`. Corrupt/foreign/non-object input →
    `{ version: SCORE_HISTORY_VERSION, entries: [] }`.
- `export function readHistory(storage, now = Date.now())` — `normalizeHistory(safeGet(storage), now)`.
- `export function recordScore(storage, entry, now = Date.now())` — upsert + persist:
  - `entry` = `{ id, topic?, correct, total }`; if `id` missing/empty or `total <= 0` →
    `{ ok: false, persisted: false, entries: <normalized>, reason: 'invalid-entry' }`.
  - derive `at = now`, `weekStart = currentWeekStart(now)`,
    `score = Math.round(clamp(correct,0,total) / total * 100)`.
  - normalize the stored history, replace the matching `id` (or append), re-sort, prune.
  - `persisted = safeSet(storage, { version, entries })`.
  - Return `{ ok: true, persisted, entries }`. Never throws; on a failed write the in-memory
    `entries` still reflect the update but `persisted` is `false`.
- `export function historyByWeek(raw, now = Date.now(), weeks = MAX_WEEKS)` — **pure**. Group the
  normalized entries by `weekStart`; return buckets sorted **most recent first**:
  `[ { weekStart, entries: [ascending by at], count, average: average(scores) } ]`, capped at
  `weeks`. Empty history → `[]`.
- `export function thisWeek(raw, now = Date.now())` — **pure**. Return the bucket whose
  `weekStart === currentWeekStart(now)`, or `{ weekStart, entries: [], count: 0, average: 0 }`
  when there are none this week.

`safeGet`/`safeSet` wrap `storage.getScoreHistory()` / `storage.setScoreHistory(obj)` in
`try/catch` and return `null` / `false` (same pattern as `quota.js`).

---

## 5. Implementation Tasks

### Task 1 — `public/lib/storage.js`: add the score-history key without session coupling

1. Add `SCORE_HISTORY: 'oohlalangue_score_history'` to `KEYS`.
2. Add it to `WORKSHEET_KEYS` (migration/discard list). **Do not** add it to
   `WORKSHEET_SESSION_KEYS` (per-fiche clear list) and **do not** add it to `CHAT_KEYS`.
3. Add `getScoreHistory()` → `readJSON(KEYS.SCORE_HISTORY, null)`.
4. Add `setScoreHistory(history)` → `writeJSON(KEYS.SCORE_HISTORY, history)` (returns boolean;
   existing write-failure reporting applies).
5. Export both in the returned object. Leave `clearCurrentWorksheet()` and `migrate()` unchanged
   (they already iterate `WORKSHEET_SESSION_KEYS` / `WORKSHEET_KEYS`).

> Why: `clearCurrentWorksheet()` runs on every generation and on "Nouvelle fiche". If the history
> key were in that list, the panel would wipe itself on every new fiche. Keeping it in
> `WORKSHEET_KEYS` preserves the schema-bump discard rule.

### Task 2 — `public/lib/scores.js`: pure score/history module

Create the module with the exports and semantics in §3–§4. Dependency-free, DOM-free, injectable
`now`, never throws. Import only `currentWeekStart` from `./quota.js`. JSDoc trust-model comment.

### Task 3 — `public/views/worksheet.js`: record the score on feedback receipt

1. Add `import { scoreFromFeedback, recordScore, worksheetIdentity } from '../lib/scores.js';`.
2. In `sendToTeacher()` (~line 724), immediately after
   `state.feedback = feedback;` and `storage.setFeedback(feedback)`, and **before**
   `renderWorksheet()`:
   - compute `const score = scoreFromFeedback(feedback);`
   - if `score.total > 0`, call
     `recordScore(storage, { id: worksheetIdentity(state.worksheet), topic: state.worksheet.topic, correct: score.correct, total: score.total }, Date.now());`
   - do nothing when `score.total === 0` (no graded answers → no entry).
   - Do **not** let a failure surface as feedback failure: `recordScore` never throws and
     fail-open; ignore its return value (or log via `console.warn`). The existing
     `storage.setFeedback` failure message is unchanged.
3. No change to `resume()`, `newWorksheet()`, `startWorksheet()`, or the render paths.

> Why: feedback is the only point where verdicts are known; recording there gives one entry per
> fiche and is idempotent by `worksheetIdentity` on re-send/resume. Guarding on `total > 0`
> implements "feedback with zero graded answers records nothing".

### Task 4 — `public/views/landing.js`: render the "Progrès" panel

1. In `mount(container, ctx)`, read the history once at mount:
   `const history = readHistory(ctx.storage, Date.now());` (import `readHistory`, `historyByWeek`,
   `thisWeek` from `../lib/scores.js`; `ctx.storage` is the storage singleton from `app.js`).
2. Build a `<section class="summary-card">` titled `Progrès`, appended after the
   `landing-cards` grid. Set inline `style.maxWidth = '640px'`, `style.width = '100%'`,
   `style.textAlign = 'left'` to match the landing width and keep the list readable. Use only
   existing classes: `.summary-card`, `.notice`, `.cache-note` (no new CSS).
3. Empty state (`history.entries.length === 0`): render a friendly French message, e.g.
   `Pas encore de score — envoie une fiche au professeur pour voir ta progression ici.`
   (class `cache-note`), and stop.
4. Otherwise render, in order:
   - **Cette semaine** (`h4`): from `thisWeek(...)`. If `count > 0`, show
     `Moyenne : {average} % ({count} fiche[s])` and a `<ul>` of this week's entries
     (`{topic || 'Fiche'} — {score} %`), most recent first. If `count === 0`, show
     `Pas encore de fiche corrigée cette semaine.` instead.
   - **12 dernières semaines** (`h4`): for each `historyByWeek(...)` bucket, a `<li>` with
     `Semaine du {new Date(weekStart).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} — {average} % ({count} fiche[s])`, most recent first.
   - Never write model output with `innerHTML`; use `textContent` / the existing `el`-style
     helpers (landing.js currently builds nodes directly — keep that pattern).
5. Refresh behaviour: the router remounts the landing view on each navigation (container is
   cleared in `handleRoute`), so reading the history at mount is sufficient. Confirm after
   sending feedback on `#/worksheet` then navigating to `#/`, the panel shows the new score.
   (No live subscription is needed; nothing changes scores while the landing view is mounted.)
6. The panel construction must run defensively (normalized history is always a valid shape), so a
   corrupt/missing key still renders the empty state and never breaks the landing layout.

### Task 5 — `test/scores.test.js` (new) and `test/storage.test.js` (edit)

Match the existing `node:test` CommonJS style: `'use strict'`, `require('node:test')`,
`require('node:assert/strict')`, dynamic `import('../public/lib/scores.js')` cached in a promise,
and the local `fakeBackend` copy from `storage.test.js`. Full list in §6. Extend
`test/storage.test.js` with the score-key assertions.

### Task 6 — `test/manual-qa.md`

Add a "H. Progrès / suivi des scores" section: send a fiche to the teacher → landing shows the
score this week and the weekly average; send a second fiche → both listed and the average
updates; re-send the same fiche → no double entry; a 0-answer fiche records nothing; empty state
before any feedback; the landing layout is intact with no history; after a week rollover the old
entry stays in its week.

---

## 6. Concrete Test List

### `test/scores.test.js` (new)

Fixed mid-week instant (Wednesday 2026-10-14, 12:00 local) as `NOW`, matching `quota.test.js`.

1. **`scoreFromFeedback` all correct** → `{ correct: 3, total: 3, score: 100 }`.
2. **all mistake** → `{ correct: 0, total: 3, score: 0 }`.
3. **`alternative` counts as correct** — 1 `correct` + 1 `alternative` + 1 `mistake` →
   `correct: 2, total: 3, score: 67`.
4. **rounding** — 2/3 → 67; 1/3 → 33; 5/6 → 83.
5. **zero graded answers** — `null`, `{}`, `{ answers: [] }`, non-array `answers` →
   `{ correct: 0, total: 0, score: 0 }`.
6. **unknown verdict ignored** — an unknown/missing `verdict` does not count toward `total`;
   an entry with no `question_id` is ignored.
7. **`worksheetIdentity` explicit/deterministic** — same worksheet → identical string; different
   `topic` → different; different question id/prompt → different; including the listening
   `audio.cache_key` changes the id; whitespace-only differences collapse to the same id.
8. **`worksheetIdentity` is legacy-safe** — a worksheet with no ids/missing sections → still
   returns a stable string and never throws.
9. **`normalizeHistory` corrupt/foreign** — `null`, `'garbage'`, `{ entries: 'x' }` →
   `{ version: 1, entries: [] }`; a bare array of valid entries is accepted; entries lacking a
   string `id` or with `total <= 0` are dropped; a foreign/future `weekStart` is dropped.
10. **`normalizeHistory` recomputes and clamps** — a stored `score: 999` is replaced by the
    value derived from `correct`/`total`; `correct > total` is clamped to `total`.
11. **`recordScore` append then update-in-place (dedupe)** — record `{id:'a',correct:2,total:4}`
    then the same id with `{correct:4,total:4}`; `entries.length` stays 1 and the entry reflects
    the latest values/`score: 100`.
12. **`recordScore` derives week bucket + score** — sets `weekStart === currentWeekStart(now)`,
    `at === now`, and `score === round(correct/total*100)`.
13. **`recordScore` rejects zero/`total`-less and missing id** — returns `ok: false`, writes
    nothing, does not throw.
14. **week grouping and ordering** — entries in two different weeks group into two
    `historyByWeek` buckets, most recent first, with the correct per-week `average` and `count`.
15. **Sunday boundary** — record at `Sat 23:59:59` (old week) and at `Sun 00:00:00` (new week);
    buckets land in their respective weeks; reading the history later (a following Monday) still
    places the pre-boundary entry in the **old** week.
16. **12-week pruning** — seed 13 distinct `weekStart` buckets (each via `currentWeekStart` of a
    date N weeks earlier) → `entries` retains exactly 12 buckets and the oldest is gone.
17. **empty history** — `readHistory` / `historyByWeek` on a fresh store → `{ version: 1,
    entries: [] }` / `[]`; `thisWeek` → empty bucket.
18. **`average`** — `[]` → 0; `[100, 0]` → 50; `[67, 67, 68]` → 67; non-finite ignored.
19. **persistence failure** — a store whose `setScoreHistory` returns `false`: `recordScore`
    returns `{ ok: true, persisted: false }`, does not throw, and still returns the updated
    in-memory `entries`.
20. **no backend / corrupt stored JSON** — `createStorage(null, { autoMigrate:false })` and a
    backend seeded with `'{not json'` for `KEYS.SCORE_HISTORY`: `readHistory` → empty,
    `recordScore` does not throw.

### `test/storage.test.js` (edit)

21. **Round-trip** — `setScoreHistory({ version: 1, entries: [...] })` then `getScoreHistory()`
    deep-equals the object; the raw key equals its JSON.
22. **Key registered for migration, excluded from session clearing** —
    `WORKSHEET_KEYS.includes(KEYS.SCORE_HISTORY)` is true and
    `WORKSHEET_SESSION_KEYS.includes(KEYS.SCORE_HISTORY)` is false.
23. **Schema bump discards score history, keeps chat keys** — extend the existing newer-version
    test: seed `KEYS.SCORE_HISTORY`, run `migrate()`, assert it is removed while `NAME`/`PROFILE`
    remain.
24. **`clearCurrentWorksheet()` preserves score history** — extend the existing clear test:
    seed current/answers/feedback + quota + score history; clear; assert the three session keys
    are `null` while the quota **and** score history keys are intact.

---

## 7. Edge Cases and Required Behaviour

| Case | Behaviour |
|---|---|
| Feedback with zero graded answers | `scoreFromFeedback.total === 0` → nothing recorded |
| All correct | score 100 |
| All mistake | score 0 |
| `alternative` verdict | counts as correct |
| Unknown/missing verdict / no `question_id` | ignored, not counted in `total` |
| Re-send / resume the same worksheet | `worksheetIdentity` matches → entry updated in place, never appended |
| Fiche graded just before Sunday | stays in the old `weekStart` on later reads |
| Recorded exactly at Sunday 00:00 | belongs to the new week |
| Entries older than the 12-week cap | oldest distinct week buckets pruned on normalize/write |
| Foreign/future `weekStart` | dropped |
| Corrupt/foreign JSON | `normalizeHistory` → empty history; parse issue reported by the existing `onIssue` |
| `localStorage` unavailable | `readHistory` → empty; `recordScore` fail-open (`persisted:false`), never throws |
| Write failure (quota exceeded) | `recordScore` returns `persisted:false`, in-memory entries still updated, no crash |
| Landing rendered with no history | friendly French empty message, layout intact |

---

## 8. Files to Change (in order)

1. `public/lib/storage.js` — add `SCORE_HISTORY` + `getScoreHistory`/`setScoreHistory`; add to `WORKSHEET_KEYS` only (not `WORKSHEET_SESSION_KEYS`).
2. `public/lib/scores.js` — **new** pure, injectable-`now` module (`scoreFromFeedback`, `worksheetIdentity`, `normalizeHistory`, `readHistory`, `recordScore`, `historyByWeek`, `thisWeek`, `average`, `MAX_WEEKS`, `SCORE_HISTORY_VERSION`).
3. `public/views/worksheet.js` — record the score in `sendToTeacher()` after feedback is received and stored (guard `total > 0`).
4. `public/views/landing.js` — render the "Progrès" panel from `ctx.storage` history (this week + 12-week list + empty state).
5. `test/scores.test.js` — **new** `node:test` suite (§6 items 1–20).
6. `test/storage.test.js` — extend with score-key round-trip, migration, and session-clear assertions (§6 items 21–24).
7. `test/manual-qa.md` — add the manual "Progrès" checklist (§5 Task 6).

No server, DB, dependency, or CSS changes are required. `public/lib/quota.js` is read-only.

---

## 9. Potential Risks

1. **Wiping history on per-fiche clear (highest risk).** If `SCORE_HISTORY` were added to
   `WORKSHEET_SESSION_KEYS`, every generation/"Nouvelle fiche" would erase the panel. Keep it in
   `WORKSHEET_KEYS` only (Task 1).
2. **Double counting on re-send/resume.** `recordScore` must upsert by `id`, not append; and
   `worksheetIdentity` must include enough content (ids + prompts + listening `cache_key`) to be
   stable per fiche. Test the update-in-place path explicitly.
3. **Identity collision.** Two genuinely different fiches could hash equal only if topic, level,
   section/question ids, prompts and listening script all match; treated as the same fiche by
   design (accepted limitation).
4. **Week semantics on re-record after rollover.** Re-sending after Sunday updates the entry's
   `weekStart` to the current week (last-write-wins). This is intentional; a stored pre-boundary
   entry left untouched keeps its old week.
5. **Landing freshness.** The panel is read at mount; because the router remounts the view on
   navigation, sending feedback then returning to `#/` shows the update. No live subscription is
   needed while the landing view is open.
6. **Fail-open storage.** When `localStorage` is unavailable or full, history is lost/rejected
   but nothing crashes. Accepted client-side degradation, consistent with the quota feature.
7. **`textContent` only.** The panel must never use `innerHTML`; `topic` is learner/model-derived
   and must be inserted as text (same rule as the worksheet renderer).
