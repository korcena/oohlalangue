# Implementation Plan — DELF A1 worksheet rework

Branch: `feature/chat-worksheet-lite`
Date: 2026-10-17
Drives: UAT feedback — one topic per section, DELF A1 inference, listening multiple choice.

This plan describes changes only. It does not implement them.

---

## 1. Objective

Rework worksheet generation so a fiche behaves like a small DELF A1 paper:

1. **Different themes per section.** Add a per-section `topic_fr`. On the auto path the server
   assigns a **distinct** A1 curriculum module to each requested section and makes the
   assignment authoritative (the model's value is overwritten after validation). The legacy
   explicit-`topic` path themes the first section with the caller's value (see §4.2).
2. **DELF A1 comprehension.** Listening and reading questions must often require
   understanding/inference (place, time, person, intent, next action), not verbatim copying.
3. **Listening is multiple choice.** Every listening question is `type: "choice"` with
   **exactly three options** and one correct answer.
4. **Writing is production.** The writing prompt presents a short French situation/message
   the learner must understand, then asks for a ~40-word French response (`short_text`).
5. **Backward compatibility.** Old saved fiches without `topic_fr` still render, answer,
   reveal, receive feedback and record scores.

No new dependencies. The worksheet remains French-only for every learner-facing string.
The chat tutor, feedback JSON keys/enums, quota and score storage schema are unchanged.

---

## 2. Relevant files

| File | Why |
| --- | --- |
| `server.js` | `CURRICULUM_MODULES`, new topic helpers, `WORKSHEET_SYSTEM_PROMPT`, `buildWorksheetPrompt`, `validateWorksheet`, `normalizeWorksheet`, `/api/generate`, exports |
| `public/lib/worksheet-render.js` | `buildRenderModel` must expose each section's `topic` |
| `public/views/worksheet.js` | `renderSection` displays the section-theme subtitle |
| `public/styles.css` | small `.section-topic` style |
| `test/topic-assignment.test.js` | **new** pure helper tests (determinism, distinctness, edges) |
| `test/validate.test.js` | new `topic_fr` / listening MCQ / writing rules |
| `test/server.test.js` | fixtures, prompt assertions, `/api/generate` assignment assertions |
| `test/worksheet-render.test.js` | section topic mapping + legacy fallback |
| `test/manual-qa.md` | manual DELF checks and old-fiche regression |
| `README.md` | published worksheet shape and API semantics |
| `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` | authoritative contract §9 (recommended) |

Unchanged on purpose: `test/fixtures/system-prompt.golden.json` (chat prompt only),
`public/lib/scores.js` (identity/score schema), `public/lib/storage.js`,
`test/scores.test.js`, `test/quota.test.js`, `test/audio-cache.test.js`.

---

## 3. Target JSON shape and topic strategy

### 3.1 Full updated `/api/generate` shape

```json
{
  "topic": "Les Fruits · La Famille · Les Métiers · La Nourriture",
  "level": "A1",
  "sections": [
    {
      "id": "listening",
      "topic_fr": "Les Fruits",
      "title_fr": "Compréhension orale",
      "instructions_fr": "Écoute et choisis la bonne réponse.",
      "audio": {
        "script": "Marie: Bonjour ! Tu veux des pommes ?\nPaul: Non merci, je préfère des bananes.",
        "speakers": [
          { "name": "Marie", "voice": "female" },
          { "name": "Paul", "voice": "male" }
        ],
        "cache_key": "server-computed"
      },
      "questions": [
        {
          "id": "l1",
          "prompt": "Où se passe la scène ?",
          "type": "choice",
          "options": ["Au marché", "À la gare", "À l’école"],
          "answer": "Au marché",
          "explanation": "Ils parlent de fruits et de courses, donc ils sont au marché."
        }
      ]
    },
    {
      "id": "reading",
      "topic_fr": "La Famille",
      "title_fr": "Compréhension écrite",
      "instructions_fr": "Lis le message et réponds.",
      "text_fr": "Salut ! Samedi, je fête l’anniversaire de ma sœur...",
      "questions": [
        {
          "id": "r1",
          "prompt": "Pourquoi écrit-elle ?",
          "type": "choice",
          "options": ["Pour inviter", "Pour annuler", "Pour remercier"],
          "answer": "Pour inviter",
          "explanation": "Elle propose une date et demande une réponse."
        },
        {
          "id": "r2",
          "prompt": "Que doit faire la personne qui reçoit le message ?",
          "type": "short_text",
          "answer": "Répondre avant jeudi.",
          "explanation": "Le message demande une réponse avant jeudi."
        }
      ]
    },
    {
      "id": "translation_grammar",
      "topic_fr": "Les Métiers",
      "title_fr": "Grammaire",
      "instructions_fr": "Complète ou transforme les phrases.",
      "questions": [
        {
          "id": "g1",
          "prompt": "Complète : Je ___ (être) professeur.",
          "type": "fill_blank",
          "answer": "suis",
          "explanation": "Avec « je », le verbe être devient « suis »."
        }
      ]
    },
    {
      "id": "writing",
      "topic_fr": "La Nourriture",
      "title_fr": "Expression écrite",
      "instructions_fr": "Réponds au message en environ 40 mots.",
      "questions": [
        {
          "id": "w1",
          "prompt": "Ton ami t’invite à dîner samedi. Il demande ce que tu veux manger. Réponds-lui en environ 40 mots : accepte, dis ce que tu aimes et propose d’apporter quelque chose.",
          "type": "short_text",
          "answer": "Merci pour ton invitation ! Samedi, je viens avec plaisir. J’aime beaucoup les pâtes et les légumes. Je peux apporter un gâteau au chocolat. À samedi !",
          "explanation": "La réponse accepte l’invitation, indique un plat et propose d’apporter un dessert."
        }
      ]
    }
  ]
}
```

Rules:

- `topic_fr` is required on **every** section and is French-only.
- `audio` remains listening-only; `text_fr` remains reading-only.
- Listening questions are always `choice` with exactly 3 options.
- Reading questions mix `choice` (3 options) and `short_text`.
- Writing questions are `short_text` and rendered as textareas.
- `translation_grammar` keeps French-only grammar practice; its `topic_fr` themes the
  sentences, not the grammar point.

### 3.2 Worksheet-level `topic`

Recommendation: **a compact summary of the assigned section themes on the auto path.**

- Auto path: `topic = summarizeWorksheetTopic(returnedSectionTopics)` — computed from the
  sections actually returned (after the server override), so an omitted section never appears
  in the title.
  - Distinct non-empty module names in section order, joined by ` · `.
  - Cap at **60 characters** at a whole-module boundary; append `…` when capped.
  - Fallback when no assignment exists: `Thèmes variés (A1)`.
  - Example: `Les Fruits · La Famille · Les Métiers` (39 chars).
- Explicit legacy `topic`: keep the caller's value exactly as today (see §4.2). This is the
  only compatibility exception; the UI never sends `topic`.

Why this strategy:

- The fiche title (`Fiche : ${topic}`) and the score history (`Progrès`) stay informative
  instead of repeating one misleading theme.
- 60 characters fits the landing card and stays below `scores.js`'s 80-character cap.
- Whole-module truncation avoids mid-word cuts.
- `worksheetIdentity` continues to hash the worksheet-level `topic`; old score entries keep
  their old IDs, new fiches get a summary-based ID. No migration is needed.

---

## 4. Topic assignment helper and `/api/generate` integration

### 4.1 Pure helper in `server.js`

Add and export:

```js
function assignSectionTopics(sectionIds, { rng = Math.random, modules = CURRICULUM_MODULES } = {})
```

Semantics:

- Input `sectionIds` is an ordered array such as
  `['listening', 'reading', 'translation_grammar', 'writing']`.
- Return an array in the **same order**, one entry per section:
  `{ id, module, focus, hint }`, where `module` is the module name string.
- Shuffle a **copy** of `modules` with a local Fisher–Yates pass using `rng()`
  (`j = Math.floor(rng() * (i + 1))`). Never mutate `CURRICULUM_MODULES`.
- Assign one shuffled module per section in order. When
  `sectionIds.length <= modules.length`, every module name is distinct.
- **Fewer modules than sections:** exhaust the shuffled pool, then reshuffle a fresh copy and
  continue. The returned length always equals `sectionIds.length`; duplicates are unavoidable
  and therefore allowed only in this edge case.
- `sectionIds` empty/not an array → `[]`.
- `modules` empty → one entry per section with `module: null`, `focus: ''`, `hint: ''`
  (the prompt then falls back to the worksheet label).
- An injected RNG makes the result deterministic: the same `sectionIds`, `modules` and RNG
  sequence produce a deep-equal result on every call.

Add a second pure helper and export it:

```js
function summarizeWorksheetTopic(assignments, maxLength = 60)
```

It implements §3.2 exactly (dedupe by name, join ` · `, whole-module cap, fallback).

### 4.2 `/api/generate` handler

Replace the current single-module selection with:

1. `const sectionIds = includeListening ? WORKSHEET_SECTION_IDS : WORKSHEET_SECTION_IDS.filter((id) => id !== 'listening');`
2. `const providedTopic = typeof topic === 'string' ? topic.trim() : '';`
3. Build the module pool:
   - auto path: `CURRICULUM_MODULES`;
   - explicit path: `CURRICULUM_MODULES.filter((m) => m.module !== providedTopic)` so the
     caller's theme cannot be assigned twice.
4. `const assignments = assignSectionTopics(sectionIds, { modules: pool });`
5. Explicit compatibility shim: if `providedTopic` is non-empty and `assignments.length`,
   replace **only the first assignment** with the caller's theme:
   `{ ...assignments[0], module: providedTopic, focus: <matching module focus or ''>, hint: <matching hint or ''> }`.
   This keeps the existing API contract (`body.topic === providedTopic`) while the remaining
   sections still get distinct curriculum themes.
6. `const promptTopic = providedTopic || summarizeWorksheetTopic(assignments);` — used as the
   prompt label/fallback only; the response summary is recomputed from the returned sections
   in step 9.
7. Pass `sectionTopics: assignments` and `topic: promptTopic` into
   `buildWorksheetPrompt({..., sectionTopics: assignments})`.
8. Keep the same `userPrompt` for the repair retry.
9. After validation and `normalizeWorksheet(parsed)`:
   - build `assignmentById` from `assignments`;
   - for each returned section, if an assignment exists with a non-null `module`, set
     `section.topic_fr = assignment.module` (server-authoritative);
   - set the response title:
     - explicit path: `normalized.topic = providedTopic`;
     - auto path: `normalized.topic = summarizeWorksheetTopic(normalized.sections.map((s) => ({ module: s.topic_fr })))`
       when at least one returned section has a theme; otherwise use `promptTopic`
       (`Thèmes variés (A1)` fallback);
   - `res.json(normalized)`.

Notes:

- Assignments are computed from the **requested** section list, not from the model's returned
  sections. If the model omits a section, no orphan assignment appears in the payload.
- If the model returns a section id not in the assignment map (validation should prevent it),
  leave the model's `topic_fr` untouched.
- Empty curriculum with no explicit topic: `promptTopic` is the fallback summary; prompt lines
  use the fallback label and the model still has to emit `topic_fr`.

---

## 5. Exact prompt changes

### 5.1 `WORKSHEET_SYSTEM_PROMPT`

Keep the English system instruction and strict-JSON framing, but replace the shape and hard
rules with the following. Exact learner-facing field names are unchanged except the new
`topic_fr`.

Shape:

```json
{
  "topic": "string",
  "level": "A1",
  "sections": [
    {
      "id": "listening | reading | translation_grammar | writing",
      "topic_fr": "Le thème de cette section, en français",
      "title_fr": "Titre de la section, en français",
      "instructions_fr": "Consigne de la section, une phrase courte en français uniquement",
      "text_fr": "Le texte français à lire — uniquement pour la section reading",
      "audio": {
        "script": "The full spoken French script",
        "speakers": [{ "name": "A", "voice": "female" }],
        "cache_key": "leave empty; the server computes it"
      },
      "questions": [
        {
          "id": "unique-string-id",
          "prompt": "La question, en français uniquement — aucune traduction ni glose en anglais",
          "type": "short_text | choice | fill_blank | translation",
          "options": ["only for choice questions"],
          "answer": "the expected answer (hidden until the learner reveals it)",
          "explanation": "Explication de la réponse, en français uniquement"
        }
      ]
    }
  ]
}
```

Replace the HARD RULES block with these exact rules (keep the existing dialogue-format and
answer-key text, shown here for completeness):

```text
HARD RULES:
- Use only these section ids: listening, reading, translation_grammar, writing.
- Every section MUST have a non-empty "topic_fr" written in French. It MUST match the theme
  assigned to that section in the user prompt. Never give two sections the same theme.
- The "audio" block MUST appear ONLY on the "listening" section. Never put it on other sections.
- The "text_fr" field MUST appear ONLY on the "reading" section, and it MUST be a non-empty
  French A1 reading passage that the section's questions are based on. Never put "text_fr" on
  other sections.
- COMPRÉHENSION ORALE (DELF A1): The listening section is a short authentic-style A1 recording
  — 1–2 short messages/announcements or one short dialogue — on the assigned theme. Every
  listening question MUST be type "choice" with EXACTLY 3 options and ONE correct answer.
  Listening questions MUST test comprehension or inference (où ? quand ? qui ? pourquoi ? que
  veut la personne ? que va-t-elle faire ?), NOT verbatim word-matching. Never copy a whole
  sentence from the script into an option. Every question must be answerable from the audio
  alone.
- DIALOGUE FORMAT (important for voicing): if the script has more than one speaker, write it
  as one line per turn, each line beginning with the speaker's name followed by a colon, e.g.
  "Marie: Bonjour !\nPaul: Salut Marie !". Use exactly the speaker "name" values from
  "speakers", and give each a distinct "voice" value ("male" or "female") so the turns are
  voiced separately. For a single-speaker narration, write plain sentences and list one
  speaker.
- COMPRÉHENSION ÉCRITE (DELF A1): "text_fr" is a short authentic-style A1 document (courriel,
  SMS, panneau, annonce, publicité, menu or message) on the assigned theme. Use a mix of
  "choice" questions (EXACTLY 3 options) and "short_text" questions. At least one question
  (preferably two) MUST require inference or deduction from the text; do not make every answer
  a sentence copied verbatim from "text_fr". Every question must be answerable from "text_fr"
  alone.
- GRAMMAIRE: French-only grammar practice on the assigned theme. Use fill-in-the-blank
  (fill_blank), conjugation, singular/plural or masculine/feminine transforms, and
  reformulation of a FRENCH sentence (short_text). NEVER ask the learner to translate from
  English; never emit a "translation" question whose source sentence is English.
- EXPRESSION ÉCRITE (DELF A1): Each writing question MUST be type "short_text". Its "prompt"
  MUST present a short French situation or message that the learner must understand (for
  example an invitation, an SMS, an announcement), then ask the learner to respond in about 40
  words in French. The situation and the task are both written in French only. Never ask for a
  translation.
- Every question MUST have: id, prompt, type, answer, explanation. "options" is REQUIRED when
  type is "choice" and must be omitted otherwise.
- "answer" is the model answer / answer key. It is delivered to the client by design but hidden
  in the UI until reveal.
- Keep vocabulary and grammar at A1 level. Use short sentences.
- EVERY learner-facing string MUST be written in French only: "topic_fr", "title_fr",
  "instructions_fr", "text_fr", "prompt", "options", "answer" and "explanation". Never write
  English — not even in parentheses, not as a translation or gloss.
- Questions and options MUST NOT contain an English translation, gloss or hint (for example,
  never write "(What's your name?)").
- Do not add any keys other than those shown.
```

Keep the opening sentence “You are an experienced A1 (beginner) French teacher writing a
short practice worksheet.” but change “practice worksheet” to “DELF A1-style practice
worksheet”. Keep the single-valid-JSON sentence and the “no markdown fences” rule.

### 5.2 `buildWorksheetPrompt`

New signature:

```js
function buildWorksheetPrompt({
  topic,
  level = 'A1',
  length = 'medium',
  includeListening = true,
  name,
  profile,
  sectionTopics = []
} = {})
```

`sectionTopics` is the assignment array from §4.1. Build a lookup by section id. For each
section, resolve:

- `theme = assignment && assignment.module ? assignment.module : safeTopic`;
- `focus = assignment && assignment.focus ? ` (focus: ${assignment.focus})` : ''`;
- `hint = assignment && assignment.hint ? ` Inspiration (ne pas copier) : "${assignment.hint}".` : ''`.

Exact user-prompt lines:

```text
Create a ${safeLevel} French DELF A1-style practice worksheet. The learner is ${learner}.
Known about the learner: ${facts.join('; ')}.
Worksheet label: "${safeTopic}".
Each section has its OWN theme; use the assigned theme below and do not reuse a theme across sections.

Include these sections, in this order:
- listening (Compréhension orale) — theme: "${theme}"${focus}.${hint} A short authentic-style
  A1 recording (1–2 short messages/announcements or one short dialogue) on this theme, with
  ${counts.listening} multiple-choice questions. Every question MUST be type "choice" with
  exactly 3 options and one correct answer. Test comprehension/inference (où ? quand ? qui ?
  pourquoi ? que veut la personne ? que va-t-elle faire ?), not verbatim word-matching; never
  copy a sentence from the script into an option.
- reading (Compréhension écrite) — theme: "${theme}"${focus}. A short authentic-style A1
  document (courriel, SMS, panneau, annonce, publicité, menu or message) in "text_fr" on this
  theme, with ${counts.reading} questions: a mix of "choice" questions (exactly 3 options) and
  "short_text" questions. At least one question (preferably two) must require inference from
  the text; do not make every answer a verbatim sentence from "text_fr".
- translation_grammar (Grammaire) — theme: "${theme}"${focus}. ${counts.translation_grammar}
  French-only grammar exercises on this theme (fill in the blank, conjugation, singular/plural
  and masculine/feminine transforms, French sentence reformulation). Never English→French
  translation.
- writing (Expression écrite) — theme: "${theme}"${focus}. ${counts.writing} DELF A1
  production task(s). In each question prompt, write a short French situation/message the
  learner must understand (invitation, SMS, announcement, etc.) and ask them to reply in about
  40 words in French. Use type "short_text" and a French-only prompt.

Every section MUST include "topic_fr" set to the theme assigned above.
All learner-facing text (topic_fr, instructions_fr, text_fr, prompts, options, answers,
explanations) must be written in French only, with no English translations or glosses.
Respond with ONLY the JSON object described in the system instructions.
```

Implementation details:

- Omit the listening line when `includeListening` is false, as today.
- Omit `Known about the learner` when the profile is empty, as today.
- Keep the existing `lengthToCounts` values unchanged.
- If `sectionTopics` is empty, every section uses `safeTopic`; this keeps direct callers and
  old tests working.
- The prompt is sent identically to the repair retry; only `buildWorksheetRepairPrompt`'s error
  list changes.

### 5.3 Feedback prompt

No change. `buildFeedbackPrompt` already includes the listening `script` and reading
`text_fr`, which is exactly what inference-based answers need. It does not need `topic_fr`.
`FEEDBACK_SYSTEM_PROMPT` stays French-only.

---

## 6. Validation changes and repair flow

In `validateWorksheet`, inside the section loop:

1. **Every section** (after `instructions_fr`):
   ```js
   if (typeof section.topic_fr !== 'string' || !section.topic_fr.trim()) {
     errors.push(`${where}.topic_fr must be a non-empty string`);
   }
   ```
2. **Listening** (inside the existing `isListening` block, while validating questions):
   - If `q.type !== 'choice'`:
     `${qWhere}.type must be "choice" for the listening section (DELF A1 multiple choice)`
   - If `q.type === 'choice'` and `Array.isArray(q.options)` and `q.options.length !== 3`:
     `${qWhere}.options must contain exactly 3 options for the listening section`
   - Missing/non-array options remain covered by the existing generic choice error
     (`options must be a non-empty array for choice questions`); do not duplicate it.
3. **Writing**:
   - If `section.id === 'writing'` and `q.type !== 'short_text'`:
     `${qWhere}.type must be "short_text" for the writing section`
   - Recommendation: enforce this as a hard rule. It matches DELF A1 production and prevents
     `answerControlKind` from rendering a writing question as radios if the model emits
     `choice`.
4. **Keep unchanged:** unique section ids, unique question ids across the whole worksheet,
   required `prompt`/`answer`/`explanation`, reading `text_fr` required and reading-only,
   listening `audio` required and listening-only, generic choice options validation.
5. Do **not** add a reading-choice length rule (the prompt asks for 3 options, but only
   listening is a hard DELF MCQ guarantee). Do **not** require all four sections to be present;
   that is existing behavior and out of scope. Do **not** require the listening `answer` to be
   byte-identical to one option in this change — that is a quality check the prompt covers, and
   enforcing it would add avoidable repair loops.

Repair flow impact:

- The one-repair retry in `/api/generate` is unchanged.
- `buildWorksheetRepairPrompt(check.errors)` now carries the new actionable error strings, so
  the model sees exactly what to fix (missing `topic_fr`, non-choice listening question,
  wrong option count, non-`short_text` writing).
- If the repaired response is still invalid, the existing 502 French message is returned.
  No other handler change.
- `normalizeWorksheet` passes `topic_fr` through unchanged (it is a normal section field, like
  `title_fr`); the handler overwrites it with the server assignment afterward. No new
  stripping/defaulting is required, but the function must not drop the field.

---

## 7. Render model and view changes

### 7.1 `public/lib/worksheet-render.js`

In `buildRenderModel`, add to each section model:

```js
topic: str(sec.topic_fr),
```

Placement: after `title` (or before `instructions`). It is an input, not a secret, so it is
**not** reveal-gated. Missing/legacy `topic_fr` becomes `''`.

No other render-model change. `answerControlKind` already handles `choice` and writing
`textarea`; validation now guarantees listening is `choice` and writing is `short_text`.

### 7.2 `public/views/worksheet.js`

In `renderSection`, after the `<h3>` title and before instructions:

```js
if (section.topic) card.appendChild(el('p', 'section-topic', section.topic));
```

- Display the subtitle for **every** section that has a non-empty topic. All new fiches will
  have one; old saved fiches will simply show no subtitle.
- Use `textContent` via `el` (never model output in `innerHTML`), consistent with the existing
  security rule.
- Keep the reading passage, listening player and question loop unchanged.
- The worksheet title continues to use `state.worksheet.topic` (`Fiche : …`); it now shows the
  compact summary on the auto path and the caller's label on the explicit path.
- Nothing in `renderQuestion`, feedback rendering or score recording needs to change.

### 7.3 `public/styles.css`

Add a `.section-topic` rule near `.section-card .section-expl`, for example:

```css
.section-card .section-topic {
  margin: -8px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  letter-spacing: 0.02em;
}
```

If the negative margin crowds `.section-expl`, adjust the existing `.section-expl` margin in
the same pass; no layout redesign.

### 7.4 Backward compatibility

- Old saved fiches have no `topic_fr`: render model emits `topic: ''`, the view skips the
  subtitle, and all other behavior is untouched.
- Old fiches may still have the old (single-theme) `topic`; the title, scores and feedback keep
  working.
- New fiches are normalized and overridden server-side, so the browser never has to fill in a
  missing topic.
- No storage version bump is needed; current-worksheet JSON is tolerated as-is.

---

## 8. Testing requirements

Use the existing `node:test` + `node:assert/strict` conventions. No DOM harness; view changes
are covered by the pure render-model tests plus manual QA.

### 8.1 New `test/topic-assignment.test.js`

Import `assignSectionTopics`, `summarizeWorksheetTopic`, `CURRICULUM_MODULES` from
`../server.js`.

- Returns one assignment per section, in input order.
- With `sectionIds` length ≤ modules length, module names are unique.
- Same seeded RNG + same inputs → deep-equal output (determinism).
- Different seeded RNG produces a valid, distinct assignment (do not assert inequality, which
  can flake).
- Does not mutate `CURRICULUM_MODULES` (snapshot names before/after).
- **Fewer modules than sections:** pass 2 fake modules and 4 ids; length is 4, all names come
  from the two modules, and duplicates are allowed only after exhausting a cycle.
- Empty `sectionIds` → `[]`; empty `modules` → one `{ module: null }` entry per section.
- `summarizeWorksheetTopic`: joins distinct names with ` · `; dedupes; caps at 60 characters at
  a whole-module boundary with `…`; fallback `Thèmes variés (A1)` for empty input.

Use a tiny deterministic RNG helper, e.g. a seeded LCG or a scripted number array, inside the
test file. Do not add a dependency.

### 8.2 `test/validate.test.js`

Update fixtures first:

- `worksheet()` reading section: add `topic_fr: 'La Famille'`.
- `listening()` section: add `topic_fr: 'Les Fruits'`; change the existing question to
  `type: 'choice'` with **3** options (the current fixture has 2) and a French explanation.
- Any fixture used for a valid worksheet must satisfy the new rules.

New/updated cases:

- Missing/empty section `topic_fr` fails with
  `/topic_fr must be a non-empty string/`.
- Listening question with `type: 'short_text'` fails with
  `/type must be "choice" for the listening section/`.
- Listening `choice` with 2 options fails with
  `/options must contain exactly 3 options for the listening section/`.
- Listening `choice` with 4 options fails with the same message.
- Listening `choice` with 3 options passes (covered by the valid-listening test).
- Writing question with `type: 'fill_blank'` fails with
  `/type must be "short_text" for the writing section/`.
- Existing tests for script/speakers, `text_fr`, unique ids, answer/explanation, and generic
  choice options continue to pass after fixture updates.

### 8.3 `test/server.test.js`

Update fixtures:

- `validWorksheet`: add `topic_fr` to listening and reading; change the listening question to
  3 options.
- `invalidWorksheet`: add `topic_fr` so the test still fails for the intended missing-options
  reason.
- `noInstructionsWorksheet`: add `topic_fr` so it still fails only for missing
  `instructions_fr`.
- Feedback inline worksheets do not need `topic_fr` (feedback validation does not validate
  worksheet sections), but adding them keeps fixtures consistent.

Update/add tests:

- **Explicit-topic `/api/generate`:** still returns `body.topic === 'Au café'`; the first
  returned section's `topic_fr` is `'Au café'`; the next section's `topic_fr` is a curriculum
  module and is different. The prompt still includes `'Au café'`.
- **Auto-topic `/api/generate`:** response sections all have a non-empty `topic_fr`; the
  listening/reading themes are distinct and are curriculum module names; the prompt includes
  each assigned theme; `body.topic` is non-empty and includes the first section's theme (the
  old assertion that `body.topic` is exactly one module must change).
- **Whitespace-only topic:** still auto path; sections have assigned themes; `body.topic` is a
  summary, not whitespace.
- **Prompt rules:** import `WORKSHEET_SYSTEM_PROMPT` and `buildWorksheetPrompt`; assert the
  system prompt matches:
  - `/DELF A1/`,
  - `/type "choice"/`,
  - `/EXACTLY 3 options/`,
  - `/inference|inferred/i`,
  - `/topic_fr/`,
  - `/short_text/`.
  Assert the user prompt includes every passed `sectionTopics` module name and the
  `topic_fr` instruction.
- **Repair flow:** existing tests remain; optionally add one where the first response is
  valid except every section lacks `topic_fr`, the repair response is valid, and the endpoint
  returns 200 with server-assigned `topic_fr` (proves repair + override together).
- **`normalizeWorksheet`:** add `topic_fr` to the input and assert it is preserved; existing
  assertions for `level`, cache key, `instructions_fr`, `text_fr`, and stripped `hint` /
  `explanation_en` remain.

### 8.4 `test/worksheet-render.test.js`

- Add `topic_fr` to `sampleWorksheet` sections and assert
  `section.topic === 'Les Fruits'` / `'La Famille'`.
- Assert section topics are present with `reveal: false` (inputs are not secret).
- Extend the legacy fallback test (no `topic_fr`) to assert `model.sections[0].topic === ''`.
- Existing hide/reveal, options, `answerControlKind`, `feedbackToUi` and `deriveUtterances`
  tests remain unchanged.

### 8.5 `test/storage.test.js`

No required change. Its render fixture may remain legacy-shaped; that is useful coverage for
old saved fiches. If it asserts the full model shape, add `topic: ''` expectations only.

### 8.6 Manual QA (`test/manual-qa.md`)

Add/update:

- §C: after generation, each section card shows a small French theme subtitle under the title;
  the four section themes are different.
- §C: the fiche title is a short summary of the themes (auto path).
- §C/§D: every listening question is multiple choice with exactly three options; at least some
  questions require inference (place/time/person/intent/next action) rather than copying the
  script.
- §C: reading mixes MCQ and short answers, and at least one answer is not explicitly stated.
- §C/§E: writing shows a short French situation/message and asks for a ~40-word reply rendered
  as a textarea.
- §C: old-fiche regression — load a fiche saved before this change (no `topic_fr`); it renders
  with no section subtitles and no errors, and can still be answered/revealed/sent.
- §H: the new fiche appears in `Progrès` using the summary topic.
- §C: explicit legacy API `topic` still returns that label and themes the first section
  (optional if API compatibility is tested only by unit tests).

### 8.7 Commands

- `npm test` — all tests, including the new helper file.
- `npm run lint` — no unused imports/variables after adding helpers and fields.
- Manual QA requires a provider key; audio checks require `OPENAI_API_KEY`.

---

## 9. Docs to update

1. `test/manual-qa.md` — the checks in §8.6.
2. `README.md`:
   - Published worksheet shape: add `"topic_fr": "string"` to every section.
   - Explain: each section gets a distinct curriculum theme; worksheet `topic` is a compact
     summary on the auto path (explicit `topic` remains a legacy label).
   - Document listening MCQ (3 options), reading mix/inference, writing situation-response.
   - Update the `/api/generate` request row to say `topic?` is a legacy label; the UI
     auto-assigns per-section themes.
3. `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` (recommended):
   - §9 JSON shape: add `topic_fr`; note listening is MCQ with exactly 3 options; reading is a
     mix of MCQ/short answer; writing is DELF A1 production.
   - Add a sentence that the server assigns distinct section themes and overwrites `topic_fr`.

Do not rewrite historical plan documents; this new plan is the current reference.

---

## 10. Files to change, in order

1. `server.js` — add `assignSectionTopics` / `summarizeWorksheetTopic`, rewrite worksheet system/user prompts, add `topic_fr` and DELF validation, integrate assignments and server-authoritative overrides in `/api/generate`, export helpers and the prompt.
2. `public/lib/worksheet-render.js` — expose `topic` from `topic_fr` in the render model.
3. `public/views/worksheet.js` — render the section-topic subtitle in `renderSection`.
4. `public/styles.css` — add `.section-topic` styling.
5. `test/topic-assignment.test.js` — new helper tests (determinism, distinctness, edge cases, summary cap).
6. `test/validate.test.js` — fixture updates plus missing `topic_fr`, listening MCQ/3-options, and writing `short_text` failures.
7. `test/server.test.js` — fixture updates, prompt-rule assertions, auto/explicit assignment assertions, normalize `topic_fr` preservation, optional repair test.
8. `test/worksheet-render.test.js` — section topic exposure and legacy empty-topic fallback.
9. `test/manual-qa.md` — DELF and old-fiche manual checks.
10. `README.md` — published shape and API/behavior notes.
11. `docs/superpowers/specs/2026-10-04-chat-worksheet-lite-design.md` — update the authoritative contract.

No new dependencies.

---

## 11. Potential risks

- **Repair loops from strict listening MCQ.** The model may emit `short_text`, 2 options, or
  4 options. The prompt states the rule three times (shape, hard rule, user prompt), and the
  repair prompt carries the exact error. There is still only one repair retry; if failures
  are common in practice, the next lever is a stronger few-shot example, not relaxing the
  contract.
- **Writing over-constraint.** Enforcing `short_text` may cause a repair when the model emits
  `fill_blank` or `choice`. This is intentional: DELF A1 writing is production. The prompt
  explicitly says `short_text`.
- **Theme/model mismatch.** A random module may be awkward for a writing or grammar section
  (e.g. “Les Nombres”). The existing `focus`/`hint` are passed per section so the model can
  adapt. Do not hard-code safer pairings in this change.
- **Model omits a section.** Validation does not require all four sections; assignments are
  computed for the request and only returned sections get `topic_fr`. The prompt asks for all
  requested sections. If the model frequently drops sections, that is a separate contract
  change.
- **Explicit-topic compatibility shim.** The first section's theme is the caller's topic, and
  remaining sections are curriculum modules. This preserves the old response label while
  satisfying per-section variety. Tests must pin both behaviors so a future refactor does not
  silently revert the UI path to one theme.
- **Long fiche titles.** The 60-character summary is below `scores.js`'s 80-character storage
  cap and the title should wrap. If it does not, adjust CSS only, not the summary length.
- **Old saved fiches.** They have no `topic_fr`; the render model must emit `''` and the view
  must skip the subtitle. Never run `validateWorksheet` on resumed fiches. The legacy fallback
  test is the guard.
- **Score identity.** New auto-generated fiches hash a summary `topic` rather than a single
  module; old entries keep their old IDs. Do not migrate/rename score entries. Re-sending an
  old fiche still uses its stored topic and remains deduped.
- **French-only enforcement.** Validation can only check non-emptiness, not language. The
  prompt and manual QA remain the backstop for English leakage in `topic_fr`/options.
- **No new dependency / no DOM harness.** Helper and render-model behavior are unit-tested;
  visual subtitle placement and textContent safety are covered by manual QA and code review.
```