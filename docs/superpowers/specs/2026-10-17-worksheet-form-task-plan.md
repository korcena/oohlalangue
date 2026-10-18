# Implementation Plan — DELF A1 form task + natural listening scripts

Branch: `feature/chat-worksheet-lite`
Date: 2026-10-17
Drives: UAT follow-ups on the DELF A1 worksheet.

This plan only describes changes. It does not implement them.

---

## 1. Objective

Two focused follow-ups on the DELF A1 worksheet:

1. **Add a DELF A1 “complete the form” production task** (`type: "form"`) to the
   `writing` section, alongside the existing `short_text` message/postcard task.
2. **Tighten the listening (`listening`) script prompt** so generated recordings are
   natural and coherent: no stray speaker prefixes such as `Narratrice:`, no
   nonsensical/non-sequitur lines, and a bounded 2–4 turn / 20–45 word script.

Non-goals:

- Do not change the `Grammaire` (`translation_grammar`) section or its French-only rules.
- Do not change the chat tutor, the feedback JSON keys/enums, the quota, or the score
  history schema.
- Do not add dependencies, a server-side database, or server-side grading secrecy.
- Do not add a DOM test harness. Pure helpers are tested with `node:test`; form rendering
  is covered by manual QA.

---

## 2. Design decision: field-based form (chosen)

Use the field-based form described in the request, not a single “complete the form”
textarea.

Why:

- DELF A1 PE Ex1 is a form-completion exercise; named fields (`Nom`, `Prénom`,
  `Nationalité`, dates) preserve that structure and make feedback specific.
- The labels are short, static, and model-generated in French. They are safe to render
  with `textContent`.
- An answer object `{ [label]: value }` fits the existing flat
  `state.answersByQuestionId` map and the existing JSON localStorage storage without a
  schema migration.
- A single textarea would blur the task into another free-writing prompt and would make
  per-field feedback impossible.

Residual risk: duplicate labels would collapse in the answer object. The prompt asks for
distinct real-life labels, and the validator enforces non-empty labels; this plan does not
add a duplicate-label validator to avoid extra repair churn. If duplicates appear in live
samples, add a uniqueness check as a follow-up.

---

## 3. Target schema and writing composition

### 3.1 Question schema

`QUESTION_TYPES` becomes:

```js
['short_text', 'choice', 'fill_blank', 'translation', 'form']
```

Appending `form` at the end preserves the existing enum order for the other types.

A `form` question shape:

```json
{
  "id": "w1",
  "type": "form",
  "prompt": "Tu arrives à l'hôtel. Complète ta fiche d'inscription.",
  "fields": [
    { "label_fr": "Nom" },
    { "label_fr": "Prénom" },
    { "label_fr": "Nationalité" },
    { "label_fr": "Date d'arrivée" },
    { "label_fr": "Date de départ" }
  ],
  "answer": "Nom : Durand ; Prénom : Marie ; Nationalité : française ; Date d'arrivée : 12 juillet ; Date de départ : 15 juillet.",
  "explanation": "On écrit les informations personnelles et les dates du séjour."
}
```

Rules:

- `fields` is required only on `form` questions and must be a non-empty array.
- Each field is an object with a non-empty string `label_fr`.
- `fields` must be omitted on every non-`form` question.
- `form` is allowed only in the `writing` section.
- `answer` remains a **string**: the model completed form, shown on reveal.
- `options` remains choice-only.
- All labels, prompts, answers, and explanations are French only.

### 3.2 Writing section composition

Regardless of `length`, the `writing` section contains exactly two questions:

1. One `form` question (`w1`) with 5–8 French field labels.
2. One `short_text` question (`w2`) asking for a French reply of environ 40–50 mots.

`lengthToCounts` keeps its existing shape and values for `reading`,
`translation_grammar`, and `listening`. Set `writing: 2` in all three branches
(`short`, `long`, default/medium), because the writing section now always has two
questions. The prompt describes the composition explicitly rather than interpolating
`${counts.writing}` as “production task(s)”.

Example writing section:

```json
{
  "id": "writing",
  "topic_fr": "L'hôtel",
  "title_fr": "Expression écrite",
  "instructions_fr": "Complète la fiche et réponds au message.",
  "questions": [
    {
      "id": "w1",
      "type": "form",
      "prompt": "Tu arrives à l'hôtel. Complète ta fiche d'inscription.",
      "fields": [
        { "label_fr": "Nom" },
        { "label_fr": "Prénom" },
        { "label_fr": "Nationalité" },
        { "label_fr": "Date d'arrivée" },
        { "label_fr": "Date de départ" }
      ],
      "answer": "Nom : Durand ; Prénom : Marie ; Nationalité : française ; Date d'arrivée : 12 juillet ; Date de départ : 15 juillet.",
      "explanation": "On écrit les informations personnelles et les dates du séjour."
    },
    {
      "id": "w2",
      "type": "short_text",
      "prompt": "Le réceptionniste te demande si tu veux un petit-déjeuner. Réponds en environ 40–50 mots : dis oui ou non, explique pourquoi et pose une question sur l'heure.",
      "answer": "Oui, je veux bien le petit-déjeuner, merci. J'aime le café et les croissants. Est-ce que le petit-déjeuner est servi à quelle heure ?",
      "explanation": "La réponse accepte ou refuse le petit-déjeuner, donne une raison et pose une question sur l'heure."
    }
  ]
}
```

---

## 4. Exact prompt edits

### 4.1 `WORKSHEET_SYSTEM_PROMPT`

**A. Question shape.** Replace the current question shape with:

```text
      "questions": [
        {
          "id": "unique-string-id",
          "prompt": "La question, en français uniquement — aucune traduction ni glose en anglais",
          "type": "short_text | choice | fill_blank | translation | form",
          "options": ["only for choice questions"],
          "fields": [{ "label_fr": "Libellé du champ, en français uniquement" }],
          "answer": "the expected answer (hidden until the learner reveals it)",
          "explanation": "Explication de la réponse, en français uniquement"
        }
      ]
```

**B. Replace the `COMPRÉHENSION ORALE` and `DIALOGUE FORMAT` bullets with:**

```text
- COMPRÉHENSION ORALE (DELF A1): The listening section is ONE short, natural, coherent A1 recording on the assigned theme: a short station/airport announcement, a realistic voicemail, or a short dialogue between named speakers. It MUST be 2–4 turns and about 20–45 words in total. Use everyday A1 vocabulary and plausible content with a clear communicative purpose. Every line MUST follow logically from the previous one: NO nonsense, NO non sequiturs, and NO irrelevant or random lines. Every listening question MUST be type "choice" with EXACTLY 3 options and ONE correct answer. Listening questions MUST test comprehension or inference (où ? quand ? qui ? pourquoi ? que veut la personne ? que va-t-elle faire ?), NOT verbatim word-matching. Never copy a whole sentence from the script into an option. Every question must be answerable from the audio alone.
- AUDIO SCRIPT FORMAT (important for voicing): For a single-speaker announcement or voicemail, write the message directly as plain French sentences with NO speaker label or prefix (never "Narratrice:", "Narrateur:", "Voix:" or similar), and list exactly ONE speaker. For a dialogue, write one line per turn, each line beginning with the speaker's exact "name" followed by a colon, e.g. "Marie: Bonjour !\nPaul: Salut Marie !". Use only the exact speaker "name" values from "speakers", give each a distinct "voice" value ("male" or "female"), and never add a narrator line or a line spoken by anyone who is not listed in "speakers".
```

**C. Replace the `EXPRESSION ÉCRITE` bullet with:**

```text
- EXPRESSION ÉCRITE (DELF A1): The writing section MUST contain EXACTLY TWO questions, regardless of the requested worksheet length:
  1) ONE "form" question: the "prompt" is a short French situation asking the learner to complete a real-life form (fiche d'inscription à l'hôtel, formulaire d'inscription à un cours, etc.). It MUST have a non-empty "fields" array of 5–8 objects, each with ONLY a non-empty French "label_fr" (for example "Nom", "Prénom", "Nationalité", "Date d'arrivée", "Date de départ"). Its "answer" is a French model of the completed form as one readable string. The prompt, labels, answer and explanation are French only.
  2) ONE "short_text" question: the "prompt" presents a short French situation or message that the learner must understand (invitation, SMS, announcement, etc.), then asks the learner to reply in French in environ 40–50 mots. The situation and the task are both written in French only.
Never ask for a translation. Do not add any other writing question.
```

**D. Replace the generic question-fields bullet with:**

```text
- Every question MUST have: id, prompt, type, answer, explanation. "options" is REQUIRED when type is "choice" and MUST be omitted otherwise. "fields" is REQUIRED when type is "form" and MUST be omitted otherwise.
- The "fields" array MUST appear ONLY on a "form" question, and "form" is allowed ONLY in the writing section.
```

Keep every other system rule unchanged, including the French-only learner-facing string
rule, the reading `text_fr` rule, the listening MCQ rules, and the grammar rules.

### 4.2 `buildWorksheetPrompt` (user prompt)

Replace the listening line with (keep the existing `themeFor`/`focusFor`/`hintFor`
interpolation and `${counts.listening}`):

```text
- listening (Compréhension orale) — theme: "${themeFor('listening')}"${focusFor('listening')}.${hintFor('listening')} A short, natural, coherent A1 recording on this theme: a station/airport announcement, a realistic voicemail, or a short dialogue between named speakers. It MUST be 2–4 turns and about 20–45 words in total. Use everyday A1 vocabulary and plausible content with a clear communicative purpose; every line MUST follow logically from the previous one — no nonsense, no non sequiturs, no irrelevant lines. For a single speaker, write the message directly with no "Narratrice:"/"Narrateur:" prefix and list exactly one speaker; for a dialogue, use "Name: ..." lines with the exact speaker names. With ${counts.listening} multiple-choice questions. Every question MUST be type "choice" with exactly 3 options and one correct answer. Test comprehension/inference (où ? quand ? qui ? pourquoi ? que veut la personne ? que va-t-elle faire ?), not verbatim word-matching; never copy a sentence from the script into an option.
```

Replace the writing line with (keep the existing theme/focus/hint interpolation):

```text
- writing (Expression écrite) — theme: "${themeFor('writing')}"${focusFor('writing')}. Exactly TWO DELF A1 production questions, regardless of worksheet length:
  1) ONE type "form" question: a short French prompt asking the learner to complete an authentic form (fiche d'inscription à l'hôtel, formulaire d'inscription à un cours, etc.). Provide 5–8 "fields", each an object with a non-empty French "label_fr" (for example "Nom", "Prénom", "Nationalité", "Date d'arrivée", "Date de départ"). The "answer" is a French model of the completed form as one readable string.
  2) ONE type "short_text" question: a short French situation/message the learner must understand (invitation, SMS, announcement, etc.), asking for a reply in French in environ 40–50 mots.
Both prompts, field labels, answers and explanations are French only. Never ask for a translation. Omit "fields" on the short_text question.
```

Keep the existing final lines about `topic_fr`, French-only strings, and “Respond with
ONLY the JSON object”.

---

## 5. Validation changes (`validateWorksheet`)

### 5.1 Rules

In `QUESTION_TYPES`, append `form` (see §3.1).

In the per-question loop:

1. Keep the existing `QUESTION_TYPES` membership check.
2. Add: a `form` type is only allowed in `writing`.
3. Replace the writing type rule:
   - Old: every writing question must be `short_text`.
   - New: every writing question must be `short_text` or `form`.
4. Add form-field validation:
   - `fields` must be a non-empty array on `form`.
   - Each field must be an object.
   - Each field must have a non-empty string `label_fr`.
   - `fields` must be omitted on non-`form` questions.
5. Keep `answer` and `explanation` required non-empty strings for every question,
   including `form`.
6. Keep the existing choice-options rules.

After the question loop, for the `writing` section only, require the composition:

- exactly one `form` question;
- at least one `short_text` question.

This means a writing section with only a message is now invalid, matching the new
contract. It is still valid to have extra `short_text` questions, though the prompt asks
for exactly two total.

### 5.2 Exact error strings

Use these strings so repair messages stay clear and testable:

```text
${qWhere}.type must be "short_text" or "form" for the writing section
${qWhere}.type "form" is only allowed in the writing section
${qWhere}.fields must be a non-empty array for form questions
${qWhere}.fields[${fi}] must be an object
${qWhere}.fields[${fi}].label_fr must be a non-empty string
${qWhere}.fields must only appear on form questions
${where}.questions must contain exactly one "form" question and at least one "short_text" question for the writing section
```

Notes:

- The validator does **not** enforce the prompt’s 5–8 field count; it enforces a
  non-empty array, as requested. The prompt is responsible for 5–8.
- The validator does not add duplicate-label detection in this change (see §2 risk).
- `normalizeWorksheet` needs no schema change: its `Object.assign` copies `fields`
  through unchanged. Continue stripping the legacy `hint` only.

### 5.3 Repair-flow impact

- `buildWorksheetRepairPrompt` is unchanged.
- New validation errors are appended to `check.errors` and already flow into the generic
  repair prompt in `/api/generate`.
- A model that omits the form, emits fields on a non-form question, or returns only a
  message will be repaired once; if it still fails, the existing 502 path applies.
- Old saved fiches are **not** re-validated by `/api/feedback` or the client, so they keep
  rendering and grading.

---

## 6. Render model and view changes

### 6.1 `answerControlKind` (`public/lib/worksheet-render.js`)

Add a `form` check before the existing writing fallback:

```text
if (type === 'choice' && options.length) return 'choice';
if (type === 'form') return 'form';
if (sectionId === 'writing') return 'textarea';
if (type === 'fill_blank' || type === 'short_text') return 'input';
return 'textarea';
```

The form check must precede the writing check, otherwise a form in `writing` would fall
through to `textarea`.

### 6.2 `buildRenderModel`

For each question, include a normalized, non-secret `fields` array:

```text
fields: type === 'form'
  ? (Array.isArray(q.fields)
      ? q.fields.map((field) => ({ label: str(field && field.label_fr) })).filter((field) => field.label)
      : [])
  : []
```

- Labels are inputs, not secrets, so they are present before reveal.
- Never put `answer` into `fields`.
- Missing `fields` on a legacy/malformed question becomes `[]`.
- `answer` and `explanation` remain reveal-gated exactly as today.

### 6.3 `renderQuestion` (`public/views/worksheet.js`)

Add a `controlKind === 'form'` branch between `choice` and `input`:

- Create a wrapper (`form-fields`) and, for each field in `question.fields`:
  - a `<label class="form-field">` wrapper (wrapping the input also labels it);
  - a `<span class="form-field-label">` whose text is set with `textContent`/`el()`;
  - a single-line `<input type="text" class="answer-input">` with an `aria-label` that
    includes the field label and question id.
- Use `<input type="text">` for all fields. DELF A1 form labels are short; no textarea
  heuristic is needed. If a future field is long, the existing `.answer-input` textarea
  styling can be reused without changing the schema.
- If `question.fields` is empty (legacy/malformed `form`), fall back to a single
  `textarea` storing a string, so the question is never unanswerable. New validated
  forms always have fields.

Saved-value restore:

- `const savedValue = state.answersByQuestionId[answerKey]`.
- For a form, treat the saved value as an object only when it is a non-array object;
  otherwise use `{}`.
- Each input starts at `saved[label] == null ? '' : String(saved[label])`.
- Ignore a legacy string saved for a form question (there are no legacy form questions);
  the fallback textarea path handles a form with no fields.

Input/autosave:

- On each input event, build a new form object from the current object plus the changed
  label/value (use a computed property/spread; do not use `Object.assign` with untrusted
  keys if avoiding prototype concerns).
- Assign it to `state.answersByQuestionId[answerKey]`, then call `scheduleSave()` exactly
  like other controls.
- Keep empty strings in the object; the server decides whether the form is blank.
- No change to `storage.setWorksheetAnswers`: `storage.js` already JSON-serializes the
  whole `answersByQuestionId` map, so nested objects persist and restore.
- No change to `sendToTeacher`: the existing shallow copy of the answers map still
  carries the form object; `api.feedback` JSON-serializes it. `delete answers[REVEAL_KEY]`
  remains.

Reveal and feedback:

- `renderReveal(question)` continues to show `question.answer` as a string via
  `el()`/`textContent`. No form-specific reveal markup is needed.
- `feedbackToUi` and `renderFeedback` continue to consume the server-provided
  `original` string. The server serializes form objects before replying (§7), so the UI
  shows `Nom : … ; Prénom : …`, never `[object Object]`.
- All model-derived strings (prompts, labels, values, answers, explanations, feedback)
  must continue to use `textContent`/`createTextNode`; no `innerHTML`.

### 6.4 Optional CSS

Add a minimal `.form-fields` / `.form-field` layout in `public/styles.css` using existing
tokens (`display: flex`, column gap, label font size/colour). Reuse `.answer-input` for
the inputs. This is presentation only.

---

## 7. Server feedback serialization

### 7.1 New helper

Add a server-side helper, e.g. `formatAnswerForPrompt(question, value)`:

- If `value` is a non-array object:
  - Prefer the question’s `fields` order. For each field with a non-empty `label_fr`,
    read `value[label_fr]`.
  - If the question has no usable fields (legacy/malformed), fall back to
    `Object.entries(value)`.
  - Include only entries whose value is non-empty after trimming; collapse internal
    whitespace/newlines to single spaces.
  - Join entries with `" ; "` and format each as `"Label : value"`.
  - Return `""` when no field is filled. This is what makes an all-empty form blank.
- Otherwise return `String(value == null ? '' : value)`.

Example outputs:

```text
Nom : Durand ; Prénom : Marie ; Nationalité : française
```

```text
(empty string — all fields blank)
```

### 7.2 `normalizeAnswers`

Preserve plain-object form answers instead of coercing them to `"[object Object]"`:

- Map form: for each `[k, v]`, keep `v` when it is a non-array object; otherwise keep the
  existing `String(v == null ? '' : v)` behavior.
- Array form: apply the same rule to `item.answer`.
- This is an internal shape change only; scalar answers are unchanged.

### 7.3 `buildFeedbackPrompt`

For each question:

- Read the raw answer with the existing `hasOwnProperty` check.
- Format it with `formatAnswerForPrompt(q, raw)`.
- Use the formatted string in the `learner answer:` line.

The `expected answer:` line stays `q.answer` (a string). The listening script and reading
text lines are unchanged. Add one feedback-prompt rule sentence if desired:

```text
For a form question, the learner answer is already formatted as "Label : valeur ; Label : valeur".
```

### 7.4 `/api/feedback` response rewrite

The route currently replaces each model-provided `original` with the learner’s raw answer
to prevent the model rewriting it. Keep that behavior, but format through the same helper:

- Build a `Map` of question id → question from `worksheet.sections`.
- For each entry whose id exists in `answersMap`, set
  `original: formatAnswerForPrompt(questionById.get(a.question_id), answersMap[a.question_id])`.
- This guarantees `original` is always a string, exactly as the feedback contract and
  `scoreFromFeedback` expect.

### 7.5 `validateFeedback`

No change. It already requires `original` to be a string; an all-empty form produces
`""`, which is valid feedback and is then excluded from scoring by the non-empty rule.

Export `formatAnswerForPrompt` from `server.js` only if tests want to exercise it
directly; otherwise test it through `buildFeedbackPrompt` and the route.

---

## 8. Score implications

### 8.1 `scoreFromFeedback`

No code change is required:

- It counts one verdict per feedback entry whose `original` is a non-empty string.
- A form with at least one filled field produces a non-empty formatted `original`, so it
  counts as one graded question.
- An all-empty form produces `""`, so it is excluded, consistent with the existing
  blank-answer rule.
- The server response rewrite (§7.4) guarantees the object never reaches the client as
  `[object Object]`.

Add tests for both cases.

### 8.2 `worksheetIdentity`

Add form field labels to the canonical content hash so two forms with the same prompt but
different fields are distinct:

- After the question’s `id` and `prompt` parts, if the question has a non-empty `fields`
  array, push one extra part:

```text
`form-fields:${labels.join('\u0001')}`
```

where `labels` are the whitespace-collapsed `label_fr` values in field order.
- If `fields` is missing, not an array, or empty, push nothing. This preserves the
  existing identity for all non-form and legacy worksheets, so historical score entries
  are not invalidated.
- Do not include learner values or the model answer in the identity; only the worksheet’s
  intrinsic field labels.
- Update the canonicalization comment above `worksheetIdentity`.

---

## 9. Backward compatibility

- **Old saved fiches:** no `type: "form"` questions and no `fields`. `buildRenderModel`
  emits `fields: []`; `answerControlKind` only returns `form` for `type === "form"`, so old
  fiches render exactly as before. `formatAnswerForPrompt` handles scalar answers.
- **Old saved answers:** scalar strings remain valid. A form question with no fields falls
  back to a textarea in the view, so a malformed new fiche is still answerable. There are no
  legacy form answer objects.
- **Old feedback:** unaffected; `original` remains a string and `validateFeedback` is
  unchanged.
- **Score history:** `worksheetIdentity` is unchanged for worksheets without form fields,
  so historical score ids still match on resume/re-send. New form fiches get a new identity
  including their labels.
- **`/api/generate`:** old clients that do not understand `form` still receive valid JSON;
  they simply would not render the new control. The current client is updated in the same
  change.
- **Grammar section:** untouched. The `translation` type and all French-only grammar rules
  remain valid.

---

## 10. Testing requirements (`node:test`, no DOM harness)

### `test/validate.test.js`

Update fixtures:

- Update the exact `QUESTION_TYPES` assertion to
  `['short_text', 'choice', 'fill_blank', 'translation', 'form']`.
- Change the `writing()` fixture from one `short_text` to a valid composition:
  one `form` (with 5 fields) plus one `short_text`.
- Add a separate `formQuestion()` / `formWriting()` helper where useful.

Add tests:

- A valid writing section with one `form` + one `short_text` passes.
- A writing section with only `short_text` fails with the composition error.
- A writing section with a non-`short_text`/non-`form` type fails with the allowed-type
  error.
- A `form` outside `writing` fails with the “only allowed in the writing section” error.
- A `form` with missing/empty `fields` fails with the non-empty-array error.
- A `form` field that is not an object fails.
- A `form` field with a missing/blank `label_fr` fails.
- A non-form question with `fields` fails with the only-on-form error.
- A `form` still requires non-empty `answer` and `explanation`.
- Existing listening/reading/grammar validation tests remain green.

### `test/worksheet-render.test.js`

- `answerControlKind('writing', { type: 'form', fields: [...] })` returns `'form'`
  (regression: form check must precede the writing textarea fallback).
- `answerControlKind('writing', { type: 'form' })` still returns `'form'`; the view’s
  fallback handles missing fields.
- `buildRenderModel` maps `fields` to `[{ label: 'Nom' }, ...]` before reveal.
- The pre-reveal serialized model contains labels but not the form `answer`/`explanation`.
- A legacy question without `fields` yields `fields: []` and does not throw.
- A non-form question does not gain labels even if it has a stray `fields` key (defensive).

### `test/server.test.js`

Prompt assertions:

- `WORKSHEET_SYSTEM_PROMPT` matches `form`, `fields`, `label_fr`, `5–8`, `Exactly TWO`,
  `Narratrice`, `non sequiturs`, `2–4 turns`, and `20–45 words`.
- `buildWorksheetPrompt` output matches the new `form`/`fields`/`5–8` writing wording and
  the natural listening wording.
- Keep the existing DELF assertions (`DELF A1`, `type "choice"`, `exactly 3 options`,
  `inference`, `short_text`, French-only).

Feedback/normalization tests:

- `normalizeAnswers({ w1: { Nom: 'Durand', Prénom: 'Marie' } })` preserves the object.
- `normalizeAnswers([{ question_id: 'w1', answer: { Nom: 'Durand' } }])` preserves the
  object.
- Scalar map/array normalization remains unchanged.
- `buildFeedbackPrompt` with a form and a partially filled object contains
  `Nom : Durand ; Prénom : Marie` (labels in field order) and an empty field is omitted.
- `buildFeedbackPrompt` with an all-empty form object emits an empty `learner answer:`
  value.
- `POST /api/feedback` with a form answer object preserves the formatted `original`
  string (not `"[object Object]"`).
- `validateFeedback` continues to accept `original: ""` for an all-empty form.

Fixture note: `validWorksheet` in `test/server.test.js` currently has no writing section;
no change is strictly required there. If a writing section is added for realism, include
both the form and message questions. `test/fixtures/system-prompt.golden.json` is the chat
system prompt only and must not change.

### `test/scores.test.js`

- `scoreFromFeedback` counts a form entry whose `original` is
  `"Nom : Durand ; Prénom : Marie"` (one verdict, not one per field).
- `scoreFromFeedback` ignores an all-empty form entry with `original: ''`.
- `worksheetIdentity` differs for two forms with the same id/prompt but different
  `fields` labels.
- `worksheetIdentity` differs when field labels are reordered.
- `worksheetIdentity` is unchanged when `fields` is missing or `[]` on a non-form
  worksheet (legacy-safe).
- Existing identity determinism/legacy tests remain green.

### Optional `test/storage.test.js`

- Add a nested-object round-trip assertion:
  `setWorksheetAnswers({ w1: { Nom: 'Durand' } })` → `getWorksheetAnswers()` returns the
  same object. This verifies autosave/restore of form answers, though `storage.js` already
  serializes generic JSON.

### Manual QA (`test/manual-qa.md`), no DOM harness

- Writing section shows a form with 5–8 visible French labels and one message textarea.
- Labels are rendered as text (inspect the DOM: no HTML injection; `textContent`).
- Type into several form fields; save-state shows `Enregistrement… → Enregistré`.
- Refresh: every field value restores; the message textarea restores; no `/api/generate`
  call.
- Leave/re-enter the view with a pending debounce: form values are flushed.
- Reveal shows the model form answer string after the form and the message.
- Send to teacher: feedback shows a readable `Nom : … ; Prénom : …` original, not
  `[object Object]`.
- Submit an all-empty form with other answers filled: the form does not count in the score.
- Fill at least one form field: the form counts as one graded question.
- Listening: single-speaker scripts have no `Narratrice:`/`Narrateur:` prefix; dialogues
  use `Name:` lines with the listed speaker names; content is coherent and 2–4
  turns/20–45 words.
- Old-fiche regression: load a pre-change fiche (no `fields`, no `form`); it renders,
  autosaves, reveals, sends feedback and records a score without errors.

---

## 11. Docs to update

- `README.md`
  - Structured worksheet shape: add `"form"` to the `type` union and document
    `"fields": [{ "label_fr": "…" }]`.
  - DELF section: describe the writing section as **one form task + one message task**;
    note the form answer is stored as an object on the client and serialized for feedback.
  - `/api/feedback` note: form answers may be objects keyed by field label; the server
    returns a readable string in `original`.
  - Listening bullet: mention natural 2–4 turn / 20–45 word scripts and the no-prefix rule
    for single-speaker messages.
- `test/manual-qa.md`: add the form and natural-listening checks listed above.
- `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` §9: update the
  canonical JSON shape and the DELF writing/listening contract.
- This plan file.
- Historical plans are not rewritten.

---

## 12. Files to change, in order

1. `server.js` — add `form` to `QUESTION_TYPES`; update system/user prompts; set writing counts to 2; add form validation/composition errors; add form answer formatting, object-preserving `normalizeAnswers`, and feedback response rewrite.
2. `public/lib/worksheet-render.js` — return `form` from `answerControlKind`; map form `fields` labels in `buildRenderModel`.
3. `public/views/worksheet.js` — render labeled form inputs, restore/save the answer object, fall back to a textarea when fields are missing.
4. `public/styles.css` — add minimal `.form-fields`/`.form-field` layout using existing tokens.
5. `public/lib/scores.js` — include form field labels in `worksheetIdentity` and update its comment.
6. `test/validate.test.js` — update `QUESTION_TYPES`/writing fixtures; add form validation and writing-composition tests.
7. `test/worksheet-render.test.js` — add `answerControlKind` form and render-model fields tests.
8. `test/server.test.js` — add prompt, `normalizeAnswers`, `buildFeedbackPrompt` serialization, and `/api/feedback` original-preservation tests.
9. `test/scores.test.js` — add partial/blank form scoring and form-label identity tests.
10. `test/storage.test.js` — optional nested form-answer round-trip test.
11. `test/manual-qa.md` — add form, restore, reveal, feedback, score, natural-listening, and old-fiche checks.
12. `README.md` — document the form type, writing composition, feedback serialization, and listening script rules.
13. `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` — update the authoritative §9 contract.
14. `docs/superpowers/specs/2026-10-17-worksheet-form-task-plan.md` — this plan.

No new dependencies.

---

## 13. Potential risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Model omits the form, returns fields on a non-form question, or returns only a message. | Strong prompt wording **and** validator composition/type errors; existing one-shot repair path handles it; otherwise 502 as today. |
| Model emits fewer/more than 5–8 labels. | Prompt asks 5–8; validator requires non-empty only to avoid repair churn. If live output is consistently outside the range, add a count check later. |
| Duplicate field labels collapse in the answer object. | Prompt asks for real, distinct labels; validation requires non-empty labels. Follow up with a uniqueness check if observed. |
| Form answer object becomes `[object Object]` in feedback. | `normalizeAnswers` preserves objects and `formatAnswerForPrompt` serializes them in both `buildFeedbackPrompt` and the response rewrite. Tested. |
| All-empty form counts as a graded question. | Formatter returns `""` when no field has a value; `scoreFromFeedback` already ignores empty `original` strings. Tested. |
| Form answers are lost on refresh. | Existing localStorage JSON serialization already handles nested objects; test round-trip and manual refresh QA. |
| `worksheetIdentity` change invalidates old score entries. | Append the fields part only when a non-empty `fields` array exists, so all non-form/legacy worksheets keep their previous identity. |
| `answerControlKind` returns `textarea` for forms because of the writing fallback. | Put the `form` check before the writing check; test it. |
| XSS through model-generated labels/values. | Labels and values are rendered with `textContent`/`createTextNode` only; the worksheet view must never use `innerHTML`. |
| Old saved fiche has no `fields` and the model is not re-validated. | `buildRenderModel` emits `fields: []`; the view falls back to a textarea for a malformed form; scalar answers and feedback remain unchanged. |
| Prompt change breaks existing golden/chat tests. | `test/fixtures/system-prompt.golden.json` covers the chat prompt only; do not regenerate it. Update only worksheet prompt assertions. |
