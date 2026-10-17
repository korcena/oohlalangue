# Worksheet Weekly Quota (3 new fiches/week) — Focused Implementation Plan

Date: 2026-10-17
Branch: `feature/chat-worksheet-lite`
Status: Ready for execution
Scope: Small, localized feature. Client-side only. No server, no DB, no re-architecture.

This plan is Markdown only. It does not implement code. Each task is written so an
independent agent can execute it.

---

## 1. Objective

Limit each browser/device to **3 successful "Nouvelle fiche" generations per week**.

- Enforcement is **client-side only** via the existing `public/lib/storage.js` wrapper.
- The counter resets at a **fixed weekly boundary: Sunday 00:00 browser-local time**
  (the current week runs from the most recent Sunday 00:00 local to now).
- Only **successful** `api.generate(...)` calls count. Failures/timeouts must not count.
- Resuming/viewing/answering/playing an **existing** saved fiche must keep working when
  the quota is exhausted.
- At the limit, the "Nouvelle fiche" button is **disabled** and a clear **French** message
  names the next reset date (next Sunday), in the app's existing UI tone.
- The quota is independent of the optional `APP_PASSWORD` gate and is per-browser/per-device
  (accepted per product owner).

---

## 2. Relevant Files

| File | Role | Change? |
|---|---|---|
| `public/lib/storage.js` | Versioned localStorage wrapper; `KEYS`, `WORKSHEET_KEYS`, `readJSON`/`writeJSON`, migration | **Edit**: new key, session-key split, `getQuota`/`setQuota` |
| `public/lib/quota.js` | Pure, DOM-free quota logic (new) | **Create** |
| `public/views/worksheet.js` | Generation flow, "Nouvelle fiche" button, resume/render | **Edit**: guard, increment, disabled + message |
| `test/quota.test.js` | `node:test` unit tests for the pure quota module (new) | **Create** |
| `test/storage.test.js` | Existing storage tests | **Edit**: quota key/migration/session-split assertions |
| `test/manual-qa.md` | Manual QA checklist | **Edit**: quota checks |
| `docs/superpowers/specs/2026-10-17-worksheet-weekly-quota-plan.md` | This plan | **Create** |

Files explicitly read for context (no change): `public/lib/api.js` (`generate` wrapper),
`public/app.js` (router/ctx), `public/styles.css` (`.notice`, `.cache-note`, `.btn:disabled`).

---

## 3. Design Decisions

### 3.1 Stored data shape

Store a single object under a new key:

```json
{ "weekStart": 1728777600000, "count": 2 }
```

- `weekStart`: epoch milliseconds of the most recent **Sunday 00:00 local**, computed at write time.
- `count`: integer number of successful generations in that week.

**Why this shape (vs. a list of timestamps):**
- O(1) read/write and bounded size; a timestamp list grows and requires per-read filtering.
- Rollover is a single equality check (`stored.weekStart !== currentWeekStart(now)`), which is
  trivial to unit-test and immune to partial-week arithmetic.
- Survives multiple reloads and clock drift within a week; stale entries are overwritten on next write.
- No schema version needed inside the record: the key lives in the worksheet namespace and is
  discarded by the existing schema-version migration (see Task 1).

### 3.2 Sunday boundary in local time (DST-safe)

Compute the boundary by constructing a local `Date` from calendar components, not by adding/
subtracting `setHours`/`setDate` on a mutable `Date`, and never by subtracting `7 * 86400000` ms.

```
currentWeekStart(now):
  d = new Date(now)
  day = d.getDay()                 // 0 = Sunday, in local time
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime()

nextWeekStart(now):
  d = new Date(now)
  day = d.getDay()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 7, 0, 0, 0, 0).getTime()
```

- The `Date(year, month, day, 0,0,0,0)` constructor interprets arguments in local time and
  normalizes invalid/absent wall-clock times (e.g. regions where DST skips local midnight), so
  the boundary stays correct instead of throwing or landing on the wrong day.
- `getDay()` is evaluated on the local representation, matching the "Sunday local" rule for
  every browser, independent of server time.
- `weekStart + 7 * 86_400_000` is **not** used: across a DST transition that can be off by an
  hour and would misclassify the exact boundary instant.

---

## 4. Quota Module (`public/lib/quota.js`) — pure and unit-testable

No DOM, no direct import of the storage singleton. The pure predicates take raw data; the
side-effecting wrappers take an injected store exposing `getQuota()` / `setQuota(obj)` (i.e. the
object returned by `createStorage`, or a fake in tests).

Exports:

- `export const WEEKLY_LIMIT = 3;`
- `export function currentWeekStart(now = Date.now())` — as §3.2.
- `export function nextWeekStart(now = Date.now())` — as §3.2.
- `export function normalizeQuota(raw, now = Date.now())` — **pure**.
  - If `raw` is not a plain object, or `raw.weekStart` is not a finite number, or `raw.count` is
    not finite → `{ weekStart: currentWeekStart(now), count: 0 }`.
  - If `raw.weekStart !== currentWeekStart(now)` → reset to `{ weekStart: currentWeekStart(now), count: 0 }`.
  - Otherwise clamp `count = min(max(0, floor(raw.count)), WEEKLY_LIMIT)` and return
    `{ weekStart: raw.weekStart, count }`.
- `export function remaining(raw, now = Date.now())` — `WEEKLY_LIMIT - normalizeQuota(raw, now).count`.
- `export function canGenerate(raw, now = Date.now())` — `remaining(raw, now) > 0`.
- `export function readQuota(storage, now = Date.now())` — `normalizeQuota(storage.getQuota(), now)`.
- `export function recordGeneration(storage, now = Date.now())` — reads, and if below limit writes
  `{ weekStart, count: count + 1 }`:
  - `count >= WEEKLY_LIMIT` → `{ ok: false, persisted: false, quota }` (defensive; the view also guards).
  - else `persisted = storage.setQuota(next)` → `{ ok: true, persisted, quota: next }`.
  - Never throws; never exceeds `WEEKLY_LIMIT`.

`now` is injected everywhere so tests are deterministic and clock-independent.

---

## 5. Implementation Tasks

### Task 1 — `public/lib/storage.js`: add quota key without coupling it to session clearing

1. Add `QUOTA_GENERATIONS: 'oohlalangue_quota_generations'` to `KEYS`.
2. **Critical:** split the worksheet key lists so the quota is *not* wiped by
   `clearCurrentWorksheet()`:
   - `WORKSHEET_SESSION_KEYS = [WORKSHEET_CURRENT, WORKSHEET_ANSWERS, WORKSHEET_FEEDBACK]`
   - `WORKSHEET_KEYS = [...WORKSHEET_SESSION_KEYS, QUOTA_GENERATIONS]`
     (kept as the **migration/discard** list, per the requirement that a schema bump may discard it).
   - Change `clearCurrentWorksheet()` to iterate `WORKSHEET_SESSION_KEYS`.
   - Leave `migrate()` iterating `WORKSHEET_KEYS` unchanged, so a newer/unknown schema version
     discards the quota too, while chat keys are untouched.
3. Add `getQuota()` → `readJSON(KEYS.QUOTA_GENERATIONS, null)`.
4. Add `setQuota(quota)` → `writeJSON(KEYS.QUOTA_GENERATIONS, quota)` (returns boolean; existing
   write-failure reporting applies).
5. Export both in the returned object. Do **not** add quota to `CHAT_KEYS`.

> Why: `clearCurrentWorksheet()` runs on every successful generation and on `newWorksheet()`.
> If the quota key stayed in that clear-list, the counter would reset on every generation and the
> feature would silently never engage.

### Task 2 — `public/lib/quota.js`: pure quota module

Create the module with the exports and semantics defined in §3–§4. Keep it dependency-free and
DOM-free (mirrors `worksheet-render.js` / `gate.js` style: focused module, pure helpers, JSDoc
comment stating the client-side-only trust model).

### Task 3 — `public/views/worksheet.js`: enforce, increment, and render limit state

1. Add `import { canGenerate, remaining, readQuota, recordGeneration, nextWeekStart, WEEKLY_LIMIT } from '../lib/quota.js';`
   (view keeps receiving `storage` from `ctx`).
2. Add a small French message helper inside the view, e.g.:
   `quotaMessage(now)` → `Limite de ${WEEKLY_LIMIT} nouvelles fiches par semaine atteinte. De nouvelles fiches seront disponibles le dimanche <date> à 00:00.`
   where `<date>` = `new Date(nextWeekStart(now)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })`.
   Reuse existing class names (`.notice` / `.notice.error` / `.cache-note`); no new CSS required.
3. In `buildGenerationForm().generate()`:
   - Add a module-scoped (view-scoped) `let isGenerating = false;` guard. At the very top of
     `generate()`, `if (isGenerating) return;` then set it after the topic check. This closes the
     keyboard/Enter/rapid double-submit race that `submit.disabled` alone does not fully cover
     (the flag is set synchronously before the first `await`).
   - Capture `const now = Date.now()` once and use it for both the guard and the increment.
   - Before calling `api.generate`, check `canGenerate(storage.getQuota(), now)`; if false,
     show the limit message and return **without** calling the API.
   - The existing `submit.disabled = true`/`finally { submit.disabled = false }` stays, but the
     `finally` must set it to `!canGenerate(storage.getQuota(), Date.now())` so it stays disabled
     once the limit is reached.
   - Increment **only on success**: have `startWorksheet()` return a boolean (`true` when
     `worksheet.sections` is a valid array, `false` on the "unexpected worksheet" branch), and call
     `recordGeneration(storage, now)` only when it returns `true`. Failed/timed-out generations
     never increment.
4. In `renderGeneration(errorMessage)`:
   - Query `canGenerate(storage.getQuota(), Date.now())`.
   - Set the form submit button `disabled` accordingly (expose a `setDisabled(bool)`/`setSubmit`
     accessor from `buildGenerationForm`, or keep a reference to `submit`).
   - When exhausted, append the `quotaMessage` notice (visible, French) so the state is explained
     even on a cold load with no current worksheet.
5. In `renderWorksheet()` (the "Nouvelle fiche" button, ~line 287):
   - Set `newBtn.disabled = !canGenerate(storage.getQuota(), Date.now())`.
   - When exhausted, append the `quotaMessage` next to the actions (`.notice`/`.cache-note`) so the
     disabled state is explained and the reset date is named.
   - Existing reveal/answer/listen/feedback rendering is unchanged → an existing fiche remains
     fully usable while the quota is exhausted.
6. `newWorksheet()` (already only reachable via the button):
   - No quota check needed to clear the current fiche; because the button is disabled at the limit
     it will not fire. Keep it as-is except it now flows into `renderGeneration()`, which shows the
     disabled submit + message if somehow reached while exhausted.
7. `resume()` is unchanged: it never consults the quota. Resuming an existing fiche while exhausted
   must continue to work.

### Task 4 — `test/quota.test.js` (new) and `test/storage.test.js` (edit)

Write tests in the existing `node:test` CommonJS style (`'use strict'`, `require('node:test')`,
`require('node:assert/strict')`, dynamic `import('../public/lib/quota.js')` cached in a promise).
Full list in §7. Add the storage assertions to `test/storage.test.js`.

### Task 5 — `test/manual-qa.md`

Add a short quota section: fresh browser shows 3 remaining; generate 3; 4th is blocked with the
French reset-date message; reload keeps the count; an existing fiche can still be answered/listened
to while exhausted; simulate a failed generation and confirm the count is unchanged; verify the
message names the next Sunday.

---

## 6. Edge Cases and Required Behaviour

| Case | Behaviour |
|---|---|
| No quota yet | `readQuota` → `{ weekStart: currentSunday, count: 0 }`; 3 remaining; generation allowed |
| Exactly 3 used | `remaining = 0`, `canGenerate = false`; 4th blocked; buttons disabled; message shown |
| Just before Sunday 00:00 local | Still counts toward the old week |
| At/after Sunday 00:00 local | `weekStart` changes → count resets to 0 automatically on next read |
| DST transition | Boundary constructed from local calendar components; never `+7 * 86400000` |
| Clock set backwards within a week | Count persists (same `weekStart`); accepted client-side limitation |
| Clock moved to a previous week | Count resets; accepted limitation of client-side-only enforcement |
| Generation error / timeout / invalid payload | No increment (`startWorksheet` returns false; `api.generate` throws) |
| Corrupt/foreign quota JSON | `normalizeQuota` → count 0; parse issue reported via existing `onIssue` |
| `localStorage` unavailable | `getQuota()` → null → count 0; generation allowed (fail-open). `setQuota` returns false; `recordGeneration` returns `persisted: false` and does not throw. Blocking generation because storage is unavailable is worse UX than not enforcing; documented as accepted degradation |
| Write quota-exceeded mid-week | Same fail-open path; existing write-failure reporting surfaces the issue |
| Resuming an existing fiche while exhausted | `resume()`/`renderWorksheet()` unaffected; reveal/answer/listen/feedback all work; only new-generation affordances disabled |
| Double-click / Enter spam | Synchronous `isGenerating` flag plus `submit.disabled`; quota is checked before `api.generate` |
| Two tabs at count 2 | Both may generate → last write wins (overshoot accepted per product owner) |
| Schema version bump | Quota discarded with the other `WORKSHEET_KEYS`; chat keys untouched |

---

## 7. Concrete Test List

### `test/quota.test.js` (new)

Use `createStorage(fakeBackend(...), { autoMigrate: false })` from `storage.js` (with a local
`fakeBackend` copy matching `storage.test.js`) to exercise the real read/write path, plus in-memory
fakes for pure helpers.

1. **No quota yet** — `readQuota` → `{ weekStart: currentWeekStart(now), count: 0 }`; `remaining = 3`; `canGenerate = true`.
2. **1 used** — count 1 → `remaining = 2`.
3. **2 used** — count 2 → `remaining = 1`.
4. **3 used** — count 3 → `remaining = 0`; `canGenerate = false`.
5. **4th blocked** — `recordGeneration` when count is 3 returns `ok: false`, stored count stays 3.
6. **Increment persists** — `recordGeneration` on empty → count 1 in backend; again → 2; again → 3; `ok: true` each time.
7. **Reset at Sunday boundary** — store `{ weekStart: currentWeekStart(now) - 7 local days, count: 3 }`; `readQuota(now)` → count 0, `remaining = 3`.
8. **Just-before / just-after Sunday** — construct `Sun 00:00:00` local as `now`: previous instant `Sat 23:59:59` is the old week; exactly `Sun 00:00:00` is the new week (different `weekStart`, count rolls over exactly once).
9. **`currentWeekStart` invariants** — result is a `Sunday` (`getDay() === 0`) with local hours/min/sec/ms all 0; same value for any instant within the same week; `nextWeekStart === currentWeekStart + 7 local calendar days` and is also Sunday 00:00.
10. **`normalizeQuota` robustness** — `null`, `'garbage'`, `{}`, `{ weekStart:'x', count:2 }`, `{ weekStart: current, count:-5 }` → count 0/normalized; `{ weekStart: current, count:99 }` → clamped to `WEEKLY_LIMIT`.
11. **Persistence failure** — a store whose `setQuota` returns `false`: `recordGeneration` returns `{ ok: true, persisted: false }` and does not throw.
12. **No-throw with no backend** — `recordGeneration(createStorage(null, { autoMigrate:false }), now)` returns without throwing.

### `test/storage.test.js` (edit)

13. **Round-trip** — `setQuota({ weekStart, count: 2 })` then `getQuota()` deep-equals the object.
14. **Key registered for migration** — `WORKSHEET_KEYS` includes `KEYS.QUOTA_GENERATIONS`.
15. **Schema bump discards quota, keeps chat keys** — with `SCHEMA_VERSION: '999'` and a stored quota, `migrate()` removes the quota and keeps `NAME`/`PROFILE` (extend the existing newer-version test).
16. **`clearCurrentWorksheet()` must NOT remove the quota** — seed current/answers/feedback + quota; clear; assert the three session keys are `null` while the quota key is intact (extends the existing clear test).

---

## 8. Files to Change (in order)

1. `public/lib/storage.js` — add `QUOTA_GENERATIONS` key + `getQuota`/`setQuota`; split `WORKSHEET_SESSION_KEYS` (cleared) from `WORKSHEET_KEYS` (migration/discard) so generation never wipes the counter.
2. `public/lib/quota.js` — **new** pure, injectable-`now` quota module (`currentWeekStart`, `nextWeekStart`, `normalizeQuota`, `remaining`, `canGenerate`, `readQuota`, `recordGeneration`, `WEEKLY_LIMIT`).
3. `public/views/worksheet.js` — guard `generate()` before `api.generate`, increment only after `startWorksheet()` succeeds, disable "Générer la fiche"/"Nouvelle fiche" and show the French reset-date notice at the limit; resume path untouched.
4. `test/quota.test.js` — **new** `node:test` unit suite (§7 items 1–12).
5. `test/storage.test.js` — extend with quota round-trip, migration, and session-clear assertions (§7 items 13–16).
6. `test/manual-qa.md` — add the manual quota checklist (§5 Task 5).

No server, DB, or CSS changes are required (existing `.notice`, `.cache-note`, `.btn:disabled` cover the styling).

---

## 9. Potential Risks

1. **`clearCurrentWorksheet()` wiping the quota (highest risk).** It iterates `WORKSHEET_KEYS` and runs on every successful generation. Adding the quota to that list without the `WORKSHEET_SESSION_KEYS` split would reset the counter each generation. The split in Task 1 is mandatory.
2. **Double-submit race.** `submit.disabled` is set after the topic check and does not cover an Enter keypress before the handler runs. The synchronous `isGenerating` flag and the pre-`api.generate` quota check close this.
3. **Boundary/DST correctness.** Using `+7 * 86400000` or mutating `setHours`/`setDate` can misplace the exact Sunday 00:00 instant. Use the local calendar-component constructor per §3.2 and test just-before/just-after.
4. **Counting on failure vs. success.** Increment must happen only after `startWorksheet()` accepts a valid worksheet. Incrementing right after `api.generate` would count malformed/empty payloads.
5. **`now` drift across the check/increment.** If the clock crosses Sunday between the guard and the increment, `weekStart` changes. Capture `now` once in `generate()` and pass it to both calls.
6. **Fail-open when storage is unavailable.** The limit cannot be enforced without persistence; the plan chooses to allow generation and surface the write issue rather than block the app. Confirm this is intended before shipping.
7. **Multi-tab overshoot.** Two tabs can both read `count: 2` and each increment. Accepted per the per-device/client-side constraint; call it out in the README/QA notes if desired.
8. **Message wording/tone.** The reset date must be French and name the next Sunday at 00:00. Use `toLocaleDateString('fr-FR', …)` and keep the string in one helper so both render sites stay consistent.
