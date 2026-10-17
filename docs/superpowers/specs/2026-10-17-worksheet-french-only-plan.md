# Worksheet French-only rework — implementation plan

Date: 2026-10-17
Branch: `feature/chat-worksheet-lite`
Drives: UAT feedback (no English in questions; visible reading passage; French-only instructions;
remove hints; French everywhere).

This plan only describes changes. It does not implement them.

---

## 1. Objective

Make the worksheet fully French for the learner and fix the lost reading passage:

1. Every learner-facing string produced or displayed is French only — question `prompt`,
   section instructions, reading passage, answer `explanation`, all `/api/feedback` output
   (`correction`, `explanation`, summary), and the client-side verdict/error-type labels.
2. `Compréhension écrite` gains a first-class reading passage that the model is required to
   produce and the view always displays above that section's questions.
3. Remove the hint feature end-to-end (schema field, prompt line, render model, "Indice" UI).
4. Rework `translation_grammar` to French-only grammar tasks (no English→French translation).

Non-goal: changing the chat tutor (its English-explanation persona is untouched), the feedback
JSON contract keys/enums, the score history, or the weekly quota.

---

## 2. Relevant files

| File | Why |
| --- | --- |
| `server.js` | `WORKSHEET_SYSTEM_PROMPT` (~668), `buildWorksheetPrompt` (~718), `validateWorksheet` (~748), `normalizeWorksheet` (~847), `buildFeedbackPrompt` (~867), `/api/feedback` system literal (~1190/1201), `buildFeedbackRepairPrompt` (~898) |
| `public/lib/worksheet-render.js` | `buildRenderModel` (~62), `VERDICT_LABELS`/`ERROR_TYPE_LABELS` (~19-29), header comment |
| `public/views/worksheet.js` | `renderSection` (~362), `renderQuestion` hint block (~391-403), `renderFeedback` (~473), remaining English UI strings |
| `public/styles.css` | add a `.reading-passage` block (mirror `.transcript` ~1099) |
| `test/worksheet-render.test.js` | fixtures + assertions for instructions/passage/hint/labels |
| `test/validate.test.js` | validator edge cases + fixtures |
| `test/server.test.js` | `validWorksheet`/`invalidWorksheet`/feedback fixtures, prompt-language assertions |
| `test/storage.test.js` | render-hiding fixture (~216) |
| `test/manual-qa.md` | manual checklist wording |
| `README.md` | published worksheet shape (~188-210) |
| `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` | authoritative contract §6.3/§9 |

Not in scope / already correct: `test/fixtures/system-prompt.golden.json` (chat prompt only — not
touched by this work), `public/lib/scores.js` (`worksheetIdentity` uses `section.id` + `prompt`;
`VERDICTS` uses raw enums), `public/lib/storage.js` (no schema change).

---

## 3. Target data schema

### 3.1 Field-name decisions

- Rename `explanation_en` → **`instructions_fr`**. The field is the section's task
  instruction, not an "explanation"; the `_fr` suffix matches `title_fr` and states the
  required language.
- New reading field **`text_fr`** (not `text`). Justification: consistent `_fr` suffix with
  `title_fr`/`instructions_fr`; signals French-only content; parallels the listening side's
  `audio.script` (content payload for the section). `text` was rejected as ambiguous with the
  question text and because an explicit `_fr` suffix enforces the language rule at the
  contract level.
- Remove question **`hint`** entirely.
- `prompt` and `explanation` keys are unchanged but their content becomes French-only.
- Keep the section id **`translation_grammar`** and every `QUESTION_TYPES` key including
  `translation` (stable enum/data keys). Stop *emitting* `translation` for the reworked
  French-only grammar section (use `fill_blank` and `short_text`); keep it valid so old saved
  fiches still validate/render. See §5.4.

### 3.2 Full updated `/api/generate` JSON shape

```json
{
  "topic": "string",
  "level": "A1",
  "sections": [
    {
      "id": "listening | reading | translation_grammar | writing",
      "title_fr": "Titre de la section, en français",
      "instructions_fr": "Consigne de la section, une phrase courte en français uniquement",
      "text_fr": "Texte français à lire — UNIQUEMENT sur la section reading",
      "audio": {
        "script": "Le script parlé en français (listening uniquement)",
        "speakers": [{ "name": "A", "voice": "female" }],
        "cache_key": "vide ; le serveur le calcule"
      },
      "questions": [
        {
          "id": "unique-string-id",
          "prompt": "La question, en français uniquement — aucune traduction anglaise",
          "type": "short_text | choice | fill_blank | translation",
          "options": ["uniquement pour choice"],
          "answer": "Réponse attendue (cachée jusqu'à la révélation)",
          "explanation": "Explication de la réponse, en français uniquement"
        }
      ]
    }
  ]
}
```

Placement rules:

- `audio` only on `listening` (existing).
- `text_fr` only on `reading` and required non-empty there (new, mirrors `audio`).
- No `hint` key anywhere (removed).

---

## 4. Task 1 — `server.js`: system prompt + user prompt

### 4.1 `WORKSHEET_SYSTEM_PROMPT` (~668) shape edits

In the JSON shape block:

- Change the section line
  `"explanation_en": "One short English sentence explaining the task"`
  → `"instructions_fr": "Consigne de la section, une phrase courte en français uniquement"`.
- Add immediately after it:
  `"text_fr": "Le texte français à lire — uniquement pour la section reading"`.
- Change the prompt line
  `"prompt": "The question in French (with a short English hint if helpful)"`
  → `"prompt": "La question, en français uniquement — aucune traduction ni glose en anglais"`.
- Delete the entire `"hint": "..."` line.
- Change
  `"explanation": "short English explanation of the answer"`
  → `"explanation": "Explication de la réponse, en français uniquement"`.

### 4.2 `WORKSHEET_SYSTEM_PROMPT` hard-rule edits

- After the `audio` placement rule, add:
  `- The "text_fr" field MUST appear ONLY on the "reading" section, and it MUST be a non-empty French A1 reading passage that the section's questions are based on. Never put "text_fr" on other sections.`
- Replace `- Titles in French, explanations in English.` with:
  `- EVERY learner-facing string MUST be written in French only: "title_fr", "instructions_fr", "text_fr", "prompt", "options", "answer" and "explanation". Never write English — not even in parentheses, not as a translation or gloss.`
- Add:
  `- Questions and options MUST NOT contain an English translation, gloss or hint (for example, never write "(What's your name?)").`
- Add a reworked `translation_grammar` rule:
  `- translation_grammar ("Grammaire et traduction"): French-only grammar practice. Use fill-in-the-blank (fill_blank), conjugation, singular/plural or masculine/feminine transforms, and reformulation of a FRENCH sentence (short_text). NEVER ask the learner to translate from English; never emit a "translation" question whose source sentence is English.`
- Keep the existing dialogue-format, required-keys and "Do not add any keys other than those shown" rules unchanged (the last already forbids stray `hint`/`explanation_en`).

### 4.3 `buildWorksheetPrompt` (~718) edits

- Reading line (~733): change to
  `- reading (Compréhension écrite): a short A1 French text in "text_fr" with ${counts.reading} questions that can be answered using that text alone.`
- `translation_grammar` line (~734): change to
  `- translation_grammar (Grammaire): ${counts.translation_grammar} French-only grammar exercises (fill in the blank, conjugation, singular/plural and masculine/feminine transforms, French sentence reformulation). Never English→French translation.`
- Before the final `Respond with ONLY...` line, insert:
  `All learner-facing text (instructions_fr, text_fr, prompts, options, answers, explanations) must be written in French only, with no English translations or glosses.`
- `lengthToCounts` (~711) unchanged.

---

## 5. Task 2 — `server.js`: validation + normalization + feedback

### 5.1 `validateWorksheet` (~748)

- Replace the `explanation_en` requirement (~776-778) with:
  `${where}.instructions_fr must be a non-empty string` (same `typeof ... !== 'string' || !trim()` guard).
- After the existing listening/audio block (~780-802), add a symmetric reading block:
  - If `section.id === 'reading'`: require `typeof section.text_fr === 'string' && section.text_fr.trim()`,
    error `${where}.text_fr must be a non-empty string for the reading section`.
  - Else if `section.text_fr != null`: error `${where}.text_fr must only appear on the reading section`.
  Use the same `!= null` semantics as the `audio` rule so an explicit `null` is tolerated.
- Question rules (~808-832) unchanged (`hint` was never validated).
- Note: `validateWorksheet` does not reject unknown keys, so legacy `hint`/`explanation_en` on
  model output is not an error; §5.2 strips them. The existing one-shot repair flow in
  `/api/generate` (~1129-1150) already re-asks on these new errors; no change needed.

### 5.2 `normalizeWorksheet` (~847)

`Object.assign` copies new fields verbatim, so `instructions_fr`/`text_fr` already survive. Add
explicit cleanup so English never persists in a newly generated fiche:

- When mapping questions: build `const next = Object.assign({}, q); delete next.hint; return next;`.
- On each section: `delete sec.hint;` and `delete sec.explanation_en;` (defensive at both levels).
- Do NOT delete `text_fr`/`instructions_fr`; they must pass through untouched.
- Keep the `worksheetAudioKey` recompute for listening unchanged.

### 5.3 `buildFeedbackPrompt` (~867)

- Add a reading-text line mirroring the listening-script line:
  `if (section.id === 'reading' && section.text_fr) lines.push('Reading text (use it to judge the reading answers): ' + section.text_fr);`
  (This is required so the teacher can judge reading answers; today the passage is absent.)
- Change the final rule line (~894) to:
  `Rules: verdict must be one of correct|mistake|alternative. error_type must be one of error|style|alternative. Copy each learner answer into "original" exactly as given. Write every correction, explanation and summary item in French only — never English. Be encouraging and concise.`
- Keep enum values and the JSON shape byte-for-byte otherwise.

### 5.4 `/api/feedback` system prompt (~1190/1201)

- Introduce one constant (e.g. `FEEDBACK_SYSTEM_PROMPT`) and use it in BOTH the first call and the
  repair call, replacing the duplicated literal:
  `'You are a warm A1 French teacher giving concise, encouraging corrections on a practice worksheet. Write every correction, explanation and summary in French only. Reply with strict JSON only.'`
- `buildFeedbackRepairPrompt` (~898): append
  `Écris toutes les corrections, explications et le bilan en français.`
- `validateFeedback` (~905) and the enum constants (`FEEDBACK_VERDICTS`, `FEEDBACK_ERROR_TYPES`)
  are unchanged — enums stay stable data keys.

---

## 6. Task 3 — `public/lib/worksheet-render.js`

### 6.1 `buildRenderModel` (~62) field changes

- Section `explanation: str(sec.explanation_en)` → `instructions: str(sec.instructions_fr) || str(sec.explanation_en)`.
  The `||` is the legacy fallback for old saved fiches that only have `explanation_en`.
- Add section `passage: str(sec.text_fr)` on every section (empty string when absent). It is the
  reading *input*, so it is intentionally NOT inside the `if (reveal)` gate — it must be visible
  before reveal. The view renders it only when `id === 'reading'`.
- Question model: delete `hint: str(q.hint)` outright.
- Keep `answer`/`explanation` reveal-gated and the `audio.script` reveal gate unchanged.
- Update the file header comment (~6-10) to say instructions/passage are mapped and that only
  answers, question explanations and the listening transcript are withheld.

### 6.2 Label translations

- `VERDICT_LABELS` (~19): `mistake: 'Mistake'` → `'Erreur'`. `correct`/`alternative` already
  French-compatible (`'Correct'`, `'Alternative'`) — leave.
- `ERROR_TYPE_LABELS` (~25): `error: 'Error'` → `'Erreur'`. `style`/`alternative` unchanged.
- `SECTION_LABELS` already French. Recommended: change `translation_grammar` label from
  `'Grammaire et traduction'` to `'Grammaire'` because the section no longer translates to/from
  English. This is a display-only label; the id stays `translation_grammar`. Mark as recommended,
  low-risk.

### 6.3 Complete field-name change list

| Old model field | New model field | Source |
| --- | --- | --- |
| `section.explanation` | `section.instructions` | `instructions_fr` (fallback `explanation_en`) |
| (none) | `section.passage` | `text_fr`, always present, not reveal-gated |
| `question.hint` | removed | — |
| `VERDICT_LABELS.mistake` | `'Erreur'` | label |
| `ERROR_TYPE_LABELS.error` | `'Erreur'` | label |

`feedbackToUi`, `deriveUtterances`, `isRevealedFromAnswers`, `REVEAL_KEY` are unchanged (they use
raw verdict/error enums and question ids, all stable).

---

## 7. Task 4 — `public/views/worksheet.js`

- `renderSection` (~362):
  - Line ~365: render `section.instructions` (was `section.explanation`) into `.section-expl`.
  - Immediately after instructions and before the listening player / questions loop, add the
    reading passage block (always visible, `textContent` only):
    ```
    if (section.id === 'reading' && section.passage) {
      const box = el('div', 'reading-passage');
      box.appendChild(el('span', 'label', 'Texte à lire'));
      box.appendChild(document.createTextNode(section.passage));
      card.appendChild(box);
    }
    ```
- `renderQuestion`: delete the whole `if (question.hint) { ... }` block (~391-403), including the
  "Indice"/"Cacher l'indice" button and the `.cache-note` hint text.
- `renderReveal` labels (`Réponse attendue`, `Explication`) already French — no change; the
  question `explanation` content is now French from the prompt.
- `renderFeedback` (~476): change the label `'Original'` → `'Ta réponse'` for unambiguous French.
  `Correction`, `Explication`, `Type :` are already French.
- `renderSummary` labels already French (`Bilan du professeur`, `Points forts`, `Erreurs
  récurrentes`, `Priorités`, `Exercice de suivi`) — no change.
- French-only sweep for remaining user-visible English strings (recommended, to honor
  "French everywhere"): translate the messages at ~204 (`— the app does not fake worksheet
  content…`), ~233 (`The server returned an unexpected worksheet…`), ~561 (`— audio
  unavailable; the app does not play fabricated audio.`), ~638 (`The listening script is
  empty.`), ~647 (`The audio service returned no segments.`). Also remove English parentheticals
  from the generation-form labels at ~129/134-136/150 (`Longueur (length)`, `Courte (short)`,
  `Moyenne (medium)`, `Longue (long)`, `Inclure la compréhension orale (listening)`). Bounded,
  optional-but-recommended; do not change the DOM structure or element ids.

### 7.1 `public/styles.css`

- Add a `.reading-passage` block (place next to `.transcript` ~1099) styling a clearly-styled,
  always-visible passage: subtle panel background, solid border (not dashed), rounded corners,
  `padding: 14px 16px`, `line-height: 1.6`, `white-space: pre-wrap` so paragraph breaks survive.
- Reuse the existing `.transcript .label` styling convention for the "Texte à lire" label
  (add `.reading-passage .label` alongside it).

---

## 8. Backward compatibility

- Old saved worksheets in `localStorage` (`oohlalangue_worksheet_current`) keep the shape
  `{ explanation_en, hint, no text_fr }`. `buildRenderModel` handles them without crashing:
  - `instructions` falls back to `explanation_en`;
  - `passage` is `''`, so a reading section simply renders no passage block;
  - `hint` is ignored (render model no longer emits it, view no longer reads it).
- Old saved feedback may contain English text; it renders verbatim. It cannot be retroactively
  translated — acceptable and documented.
- `feedbackToUi` maps by `question_id`, so old and new fiches both work.
- **No storage schema bump.** `CURRENT_SCHEMA_VERSION` stays `1`. Rationale: the new shape is
  additive and forward-compatible; the renderer tolerates both shapes; a bump would discard
  learner worksheets, answers, feedback, quota and score history for no benefit. `storage.js`
  reads are already defensive.
- `scores.js` `worksheetIdentity` hashes `section.id` + `question.prompt`; renamed section fields
  do not affect it, so old scores keep deduping correctly across a re-send.

---

## 9. Testing requirements

Conventions: `node:test` + `node:assert/strict`; server helpers imported from `../server.js`;
render helpers dynamically imported from `../public/lib/worksheet-render.js`.

### 9.1 `test/validate.test.js` (server validator — primary home)

- Update fixtures: `worksheet()` reading section gets `instructions_fr` (was `explanation_en`)
  and a non-empty `text_fr`; `listening()` gets `instructions_fr`.
- Keep `WORKSHEET_SECTION_IDS` / `QUESTION_TYPES` assertion unchanged
  (`['short_text','choice','fill_blank','translation']`).
- New tests:
  - `validateWorksheet` rejects a section missing `instructions_fr`
    (assert `/instructions_fr must be a non-empty string/`).
  - `validateWorksheet` rejects a `reading` section with empty/absent `text_fr`
    (assert `/text_fr must be a non-empty string for the reading section/`).
  - `validateWorksheet` rejects `text_fr` on a non-reading section
    (assert `/text_fr must only appear on the reading section/`), mirroring the audio test.
  - A valid reading section with `text_fr` passes.
- Existing audio/choice/question/feedback tests remain valid after the fixture rename.

### 9.2 `test/server.test.js`

- Update fixtures: `validWorksheet` (listening + reading) — `explanation_en` → `instructions_fr`,
  add `text_fr` to the reading section; `invalidWorksheet` — rename to `instructions_fr`
  (stays invalid via the choice question missing `options`); the `/api/feedback` inline worksheet
  fixture (~544) — rename to `instructions_fr`.
- New tests:
  - `/api/generate` rejects (after one repair) a worksheet whose section lacks `instructions_fr`
    — reuse the repair-mock pattern; assert 502 and 2 calls.
  - `/api/feedback` asks for French: inspect `fetchImpl.calls[0].body.messages[0].content`
    (system) and assert it matches `/français/i` (or `/French only/`).
  - `buildFeedbackPrompt` (already exported) includes the reading `text_fr` for a reading section
    and includes the listening `script` for a listening section.
  - `normalizeWorksheet` strips `hint` and `explanation_en` from sections/questions and preserves
    `instructions_fr` and `text_fr` (deep-equal or property assertions).

### 9.3 `test/worksheet-render.test.js`

- Update `sampleWorksheet()`: `explanation_en` → `instructions_fr`; add a distinct non-secret
  reading `text_fr` (e.g. `'TEXTE DE LECTURE'`).
- Update the hide/reveal test:
  - assert `model.sections[0].instructions === <instructions>`.
  - assert the reading `passage` is present with `reveal:false` AND `reveal:true` (input is not
    reveal-gated) — this is the regression test for the missing reading text.
  - assert `JSON.stringify(model)` contains neither `hint` nor `explanation_en`, and that the
    question model has no `hint` key.
- New test: legacy fallback — a section with only `explanation_en` yields
  `instructions === explanation_en`; a section with no `text_fr` yields `passage === ''`.
- Update `feedbackToUi` label assertions: `r1.verdictLabel` `'Mistake'` → `'Erreur'`;
  `r1.errorTypeLabel` `'Error'` → `'Erreur'`; `l1` stays `'Correct'` / `'Style'`.
- Add an assertion that `VERDICT_LABELS`/`ERROR_TYPE_LABELS` contain no English words
  (e.g. `mistake` → `'Erreur'`, `error` → `'Erreur'`).

### 9.4 `test/storage.test.js`

- The render-hiding test (~207-231) uses the real `buildRenderModel`: rename its
  `explanation_en` to `instructions_fr` so it matches the current shape (legacy tolerance is
  covered by the new worksheet-render fallback test).

### 9.5 Explicit fixture/test change list

Must change: `test/validate.test.js` (`worksheet`, `listening`), `test/server.test.js`
(`validWorksheet`, `invalidWorksheet`, feedback inline worksheet), `test/worksheet-render.test.js`
(`sampleWorksheet`, hide/reveal test, `feedbackToUi` labels), `test/storage.test.js` (render
fixture). Unchanged: `system-prompt.golden.json`, `scores.test.js`, `quota.test.js`,
`audio-cache.test.js`, `gate.test.js`.

---

## 10. Docs to update

- `test/manual-qa.md`:
  - §C line ~40: "French titles and English explanations" → French instructions throughout;
    add a check that every prompt/option is French with no English gloss.
  - §C: add a check that the `Compréhension écrite` passage is visible **before** reveal, above
    the questions.
  - §E lines ~72-75: verdict label expectation `Correct / Mistake / Alternative` → French
    `Correct / Erreur / Alternative`; state that feedback/correction/explanation/summary are in
    French.
  - Add: no "Indice" control exists anywhere in the worksheet DOM.
- `README.md` (~188-210): update the published worksheet shape to `instructions_fr`, add
  `text_fr` (reading only), and note French-only content. Do NOT touch the unrelated curriculum
  "hint" wording at ~227.
- `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md`: update the authoritative
  contract — §6.3 item 5 (remove the optional-hint mention) and §9 JSON shape
  (`explanation_en` → `instructions_fr`, add `text_fr`, remove implicit hint), plus a line that
  all learner-facing content is French-only. (The historical
  `2026-10-04-chat-worksheet-lite-plan.md` mentions of `explanation_en`/hint may be left as
  history or annotated; optional.)

---

## 11. Potential risks

- **Model drift / residual English.** The model may still emit English, `explanation_en`, `hint`
  or omit `text_fr`. Mitigation: the validator now requires `instructions_fr` and reading
  `text_fr`, the repair flow re-asks once, and `normalizeWorksheet` strips legacy keys. The
  validator cannot reliably reject English *content*, so manual QA (§10) remains the backstop.
  Consider a follow-up heuristic check, but do not add one in this focused change.
- **`text_fr` placement rule causing repair loops.** Models often over-attach fields. The prompt
  must state the restriction explicitly (done in §4.2) and the error must be actionable; the
  single repair retry bounds the cost.
- **Label change ripple.** Translating `VERDICT_LABELS`/`ERROR_TYPE_LABELS` affects only display;
  CSS classes use the raw `verdict` value (`.feedback.mistake`), so styling is unaffected.
  Update the two test assertions that pin the English labels.
- **Feedback token growth.** Including the reading `text_fr` in `buildFeedbackPrompt` increases
  prompt size modestly; `FEEDBACK_MAX_TOKENS` only bounds the response, so no timeout risk beyond
  the existing `AI_TIMEOUT_MS`.
- **Optional `translation_grammar` label rename.** Changing the label to `'Grammaire'` is
  display-only, but if any snapshot/manual QA text references the old label, update it in the
  same change. The id remains `translation_grammar`.
- **`translation` enum retained but unused.** Old saved fiches using it still render as a
  textarea (the view's `else` branch); new fiches will not emit it. This is intentional to keep
  data keys stable.

---

## 12. Files to change, in order (one line each)

1. `server.js` — French-only system/user prompts, `instructions_fr` + reading `text_fr` validation, `hint`/`explanation_en` stripping in `normalizeWorksheet`, French feedback prompt and system constant.
2. `public/lib/worksheet-render.js` — map `instructions` (legacy fallback), expose un-gated `passage`, drop `hint`, French verdict/error labels.
3. `public/views/worksheet.js` — wire `instructions`, render the reading passage, remove the Indice block, French-only UI strings.
4. `public/styles.css` — add `.reading-passage` (+ label) styling.
5. `test/validate.test.js` — fixture rename + new `instructions_fr`/`text_fr` validation tests.
6. `test/server.test.js` — fixture rename, French feedback-prompt assertion, normalize-strips test, generate rejection test.
7. `test/worksheet-render.test.js` — instructions/passage/non-gated/hint-gone/French-label tests + legacy fallback.
8. `test/storage.test.js` — update the render-hiding fixture to the new shape.
9. `test/manual-qa.md` — French-only, visible reading text, no Indices, French feedback labels.
10. `README.md` — update the published worksheet shape.
11. `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` — update the authoritative contract (§6.3/§9).
