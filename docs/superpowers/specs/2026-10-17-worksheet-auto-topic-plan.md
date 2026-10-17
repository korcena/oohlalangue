# Implementation Plan — Worksheet auto-selected topic

Branch: `feature/chat-worksheet-lite`
Date: 2026-10-17

## 1. Objective

On the worksheet ("Fiche d'exercices") generation form, remove the manual **Sujet** input.
When no topic is supplied, the server auto-selects a random module from the existing A1
curriculum (`CURRICULUM_MODULES`) for each generation, and the returned worksheet's
`topic` deterministically reflects that module so the fiche title shows the auto-selected
subject. The user keeps **Longueur** and **Inclure la compréhension orale**.
Backward compatible: an explicitly provided non-empty `topic` is still honored (existing
tests and API callers unaffected).

## 2. Relevant files

- `server.js` — `POST /api/generate` (~1088), `buildWorksheetPrompt` (~715),
  `normalizeWorksheet` (~844), `pickRandom` (~241), `CURRICULUM_MODULES` (~40, exported).
- `public/views/worksheet.js` — `buildGenerationForm()` (~125), `generate()` (~182),
  intro text in `renderGeneration()` (~306).
- `test/server.test.js` — `/api/generate` tests (~361-431); imports `CURRICULUM_MODULES`.
- `test/manual-qa.md` — Worksheet journey checks (~36-43).

## 3. Implementation tasks

### Task 1 — Server: auto-select topic in `POST /api/generate`
File: `server.js`, handler `POST /api/generate` (~1100-1101).

- After destructuring `req.body`, compute the effective topic:
  - `const providedTopic = typeof topic === 'string' ? topic.trim() : '';`
  - If `providedTopic` is non-empty → use it unchanged (backward compatible path).
  - Else auto-select: `const mod = Array.isArray(CURRICULUM_MODULES) && CURRICULUM_MODULES.length ? pickRandom(CURRICULUM_MODULES) : null;`
- Define the exact string passed to the prompt:
  - Auto path: pass `mod.module` (e.g. `"La Famille"`) as `topic` to
    `buildWorksheetPrompt({ topic: mod.module, ... })`.
  - Empty-curriculum fallback: pass `undefined` so `buildWorksheetPrompt`'s existing
    default (`'daily life at A1 level'`) applies; do not throw.
  - Explicit path: pass `providedTopic` as today.
- Compute the prompt once from this resolved `promptTopic` and use the same string for the
  repair call (already the case — both use `userPrompt`).

### Task 2 — Server: make the returned worksheet `topic` deterministic
File: `server.js`, `POST /api/generate` (~1138, `res.json(normalizeWorksheet(parsed))`).

- Reason: `normalizeWorksheet` copies the model's own `topic`, which may vary or differ
  from the auto-selected module; the fiche title must reflect the chosen subject.
- When the topic was auto-selected (`mod` truthy): after normalization, set the outgoing
  `topic` to the chosen module name:
  - `const normalized = normalizeWorksheet(parsed);`
  - `if (autoSelected && mod) normalized.topic = mod.module;`
  - then `res.json(normalized);`
- When the topic was explicitly provided: leave `normalized.topic` untouched (preserve
  current behavior; do NOT override with the caller's raw topic — existing tests assert
  the model-validated topic survives).

### Task 3 — Client: remove the Sujet field and its logic
File: `public/views/worksheet.js`.

- In `buildGenerationForm()` remove `topicField`/`topicLabel`/`topicInput` construction
  (~128-136) and change the append to
  `form.append(lengthField, levelField, listeningLabel, submit);` (~171).
- In `generate()` remove `const topic = topicInput.value.trim();` and the
  `if (!topic) { showStatus(...); topicInput.focus(); return; }` block (~184-189).
- Remove `topic,` from the `api.generate({ ... })` payload (~200); keep `level`, `length`,
  `includeListening`, `name`, `profile`.
- Update the intro copy in `renderGeneration()` (~306) to drop "un sujet", e.g.
  "Choisis une longueur et (au besoin) la compréhension orale. La fiche est générée par le
  professeur IA. Le sujet est choisi automatiquement."
- `renderWorksheet()` line ~327 (`Fiche : ${state.worksheet.topic}`) already works with the
  server-provided auto topic — no change.

### Task 4 — Layout check (no CSS change expected)
File: `public/styles.css` (read only).

- `.gen-grid` is a single-column flex/grid container with `gap`; removing one `.field`
  child leaves `lengthField`/`levelField` (both `.field`) plus the `.gen-check` label and
  submit. No CSS tweak is required. Only revisit `.gen-grid input[type='text']` (~907/919)
  if a text input is ever re-added; it is now unused by this form but harmless to keep.

### Task 5 — Tests
File: `test/server.test.js`.

- Add `CURRICULUM_MODULES` to the existing import from `../server.js` (line ~8-20).
- New test: `POST /api/generate` with NO `topic` (body `{}` or `{ length: 'medium' }`)
  returns 200, and `body.topic` is a non-empty string that equals one of
  `CURRICULUM_MODULES.map((m) => m.module)`. Use the existing `validWorksheet` fixture,
  which returns a *different* model topic (`'Au café'`) — assert the response topic is the
  curriculum module, proving the server override.
- New/keep test: explicit `topic: 'Au café'` still returns 200 and is unaffected
  (existing test at ~386 already covers this; keep passing unchanged).
- Optional: assert a whitespace-only `topic` (`'   '`) is treated as absent and still
  returns a curriculum module.
- No DOM harness exists for `public/views/worksheet.js`; client removal is verified by
  reading + manual QA (Task 6). Do not add a jsdom harness.

### Task 6 — Manual QA
File: `test/manual-qa.md`.

- Update line ~39: "Choose topic/length/listening" → "Choose length/listening" and note
  the subject is auto-selected.
- Add a check that two consecutive generations show different (random) fiche titles drawn
  from the A1 curriculum, and that the title matches the auto-selected subject.

## 4. Testing requirements

- `npm test` — all existing tests pass unchanged, including the explicit-topic
  `/api/generate` tests (~386, ~415) and `validate.test.js` / `worksheet-render.test.js`.
- New server test proves: no-topic request succeeds; response `topic` is non-empty and in
  `CURRICULUM_MODULES`.
- `npm run lint` — no unused variables left in `worksheet.js`.
- Manual: generation form shows only Longueur + listening checkbox; a generated fiche title
  displays an A1 module subject; repeated generations vary.

## 5. Potential risks

- **Model topic override scope:** override `worksheet.topic` only on the auto-selected
  path; overriding on the explicit path would break existing tests and caller expectations.
- **Curriculum empty/deprecated:** guard `pickRandom(CURRICULUM_MODULES)` with a length
  check so it never dereferences `undefined`; fall back to `undefined` topic (prompt
  default) rather than throwing.
- **Blank vs missing topic:** treat `null`/`undefined`/whitespace-only as "absent"; test
  the whitespace case explicitly.
- **Client/server contract:** client stops sending `topic`; server must tolerate a missing
  field (it will, via the default). No API shape change for existing callers.
- **Duplicate random picks:** `pickRandom` may return the same module on consecutive
  generations; this is acceptable per the request ("random each time"), do not add
  de-duplication.
