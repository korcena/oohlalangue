# Ooh La Langue — Chat + Worksheet (client-side) Design

Date: 2026-10-04
Branch: `feature/chat-worksheet-lite` (branched from `main`)
Status: Approved for planning

## 1. Summary

Rework Ooh La Langue into a two-path learner app:

- A landing page offering **Chat** or **Worksheet**.
- **Chat** — the existing AI French tutor, preserved.
- **Worksheet** — the AI generates an A1 practice worksheet; the learner answers it in the
  browser, it is saved in `localStorage`, and can be sent to the teacher for feedback. The
  worksheet includes a **Compréhension orale** (listening) section: the teacher generates an
  original French narration/conversation and the learner answers comprehension questions about
  it.

The only server component is a **minimal key proxy**: it serves the static frontend and
forwards AI requests to **Ollama Cloud** (default) or **OpenAI**, and text-to-speech requests
to **OpenAI TTS**, keeping API keys server-side. There is no database, no authentication, no
Supabase, no Notion, and no background workers. All learner state — including generated audio —
lives in the browser.

## 2. Goals

1. Landing page with a clear **Chat** / **Worksheet** choice.
2. Preserve the existing chatbot behavior, styling, and mobile handling.
3. Generate A1 worksheets on a chosen topic and answer them in the browser.
4. Include a listening (**Compréhension orale**) section with original French audio, plus
   comprehension questions.
5. Persist worksheets, answers, audio, and feedback in the browser, with safe resume and no
   repeat TTS charges.
6. Send a worksheet + answers to the teacher and show feedback **adjacent to each answer**.
7. Keep AI and TTS keys out of the browser; support Ollama Cloud (default) or OpenAI for text,
   and OpenAI for speech.
8. Be honest when a provider is not configured — never fabricate content or audio.

## 3. Non-goals (explicitly dropped)

- Supabase / Postgres / RLS / migrations / row-level ownership.
- Accounts, invitations, roles, admin tools, Google sign-in.
- Notion import and lesson publication.
- Speech-to-text, learner recordings, pronunciation scoring.
- Mock DELF exam mode, timers, four-skill scoring, jobs/worker, `render.yaml` blueprint.
- Multi-device sync, offline guarantees, server-side storage of learner data.

The prior full-platform implementation is preserved (unmerged) on
`feature/french-teacher-platform` at commit `9a42ea0`.

## 4. Architecture

A single small Node/Express process:

1. Serves the static frontend from `public/`.
2. Proxies AI calls to Ollama Cloud or OpenAI based on `TEXT_PROVIDER`.
3. Exposes `/health` reporting which provider is configured (no secret values).

```
Browser (public/, vanilla ESM)
  ├─ views/landing.js      # Chat or Worksheet chooser
  ├─ views/chat.js         # existing tutor UI (ported)
  ├─ views/worksheet.js     # generate / answer / reveal / submit / feedback
  ├─ lib/api.js            # fetch wrapper for /api/*
  └─ lib/storage.js        # versioned localStorage
        │  fetch (no secrets)
        ▼
server.js (Express)
  ├─ static serving of public/
  ├─ POST /api/chat        → provider chat completion
  ├─ POST /api/generate    → structured worksheet JSON (incl. listening script)
  ├─ POST /api/tts         → OpenAI TTS audio for a listening script
  ├─ POST /api/feedback    → structured feedback JSON
  └─ GET  /health          → provider configuration (no secrets)
        │  server-side key
        ▼
Ollama Cloud (default)  |  OpenAI (text)  |  OpenAI TTS (speech)
```

Generated audio is returned to the browser and cached in **IndexedDB** (see §7), so resuming a
saved worksheet replays the same clip without re-billing TTS.

Decision: **S3 + W1** (modular single-page native ESM; structured JSON worksheet output).

## 5. File layout

```
public/
  index.html          # single-page shell (header + nav + view container)
  styles.css          # existing dark/gold/coral design language
  app.js              # hash router + bootstrap
  lib/api.js          # fetch wrapper, JSON + error normalization
  lib/storage.js      # versioned localStorage schema, save/resume
  lib/audio-cache.js  # IndexedDB audio blob cache (listening clips)
  views/landing.js    # Chat / Worksheet chooser
  views/chat.js       # ported chatbot
  views/worksheet.js  # worksheet player + listening + feedback
server.js             # static + /api proxy + /health
.env.example          # secret-free configuration template
package.json
README.md
```

No build step. Views are ES modules swapped by the hash router.

## 6. Flows

### 6.1 Landing

Shows the `Ooh La Langue` logo/tagline and two cards: **Chat** and **Worksheet**. Selecting one
navigates to `#/chat` or `#/worksheet`, so refresh/back returns to the same view.

### 6.2 Chat

Ports the existing UI unchanged in behavior: correction markers
(`✅ GOOD / 🔧 FIX / 💬 CORRECTED / 🗣️ SAY IT`), structured correction cards, the A1 curriculum
modules, learned-profile facts, browser voice I/O, and mobile viewport handling. Calls
`/api/chat` through `lib/api.js`. Provider and model are server-side and never shown.

The existing **10-answers-per-3-hour pause session limit is kept exactly as-is** (persisted).

### 6.3 Worksheet

1. **Generate:** learner picks a topic and length (and optionally includes the listening
   section); the client calls `/api/generate`.
2. **Render:** sections with French labels, French instructions and French-only prompts/options;
   answer fields.
3. **Listening (Compréhension orale):** the worksheet includes an original French
   narration/conversation (script generated server-side, with distinct speaker voices for
   dialogues). The client requests `/api/tts`, plays the audio, and lets the learner replay it
   (and slow it down) before answering comprehension questions. The **transcript is hidden
   until the answers are revealed/submitted.**
4. **Autosave:** answers persist to `localStorage` with saving/saved/failed states; on failure
   the text is retained and the learner is warned (never silently dropped).
5. **Reveal:** a "show answers" reveal (including the listening transcript). Answers are
   generated server-side and stored in the payload but hidden until revealed.
6. **Send to teacher:** "Envoyer au professeur" posts the worksheet + answers to
   `/api/feedback`.
7. **Feedback:** the response renders **adjacent to each answer** — original preserved,
   correction immediately after, with explicit text labels (not colour alone); plus a concise
   summary (strengths, recurring mistakes, 2–3 priorities, one follow-up exercise). Correction,
   explanation and summary are written in French only.
8. **Resume:** reopening the Worksheet view restores the same worksheet, answers, and cached
   audio; "New worksheet" explicitly archives/clears the current one and its cached clips.
9. **Audio cache:** on first play, the clip is fetched from `/api/tts` and stored in IndexedDB
   keyed by a hash of the script + voice settings; on resume it is played from cache with **no
   repeat TTS charge**.

All learner-facing worksheet content (title, instructions, reading passage, prompts, options,
answers, explanations and feedback) is written in French only, with no English translations or
glosses.

## 7. Storage schema (`lib/storage.js`)

Namespaced, versioned keys. Existing chat keys are retained.

| Key | Contents |
|---|---|
| `oohlalangue_name` | learner display name (existing) |
| `oohlalangue_password` | legacy gate value (existing) |
| `oohlalangue_profile` | learned facts (existing) |
| `oohlalangue_answers` | chat answer counter (existing) |
| `oohlalangue_pause_until` | chat pause timestamp (existing) |
| `oohlalangue_worksheet_current` | generated worksheet (sections, questions, hidden answers, rubric) |
| `oohlalangue_worksheet_answers` | in-progress answers + last-saved timestamp |
| `oohlalangue_worksheet_feedback` | last teacher feedback for the current worksheet |
| `oohlalangue_schema_version` | storage schema version for safe migration/discard |

**Audio cache (IndexedDB, `lib/audio-cache.js`):** a separate object store keyed by a hash of
`script + voice + speed`. Values are audio `Blob`s (mime + bytes). It is used because audio is
too large for `localStorage`. Entries are deleted when the corresponding worksheet is cleared.
If IndexedDB is unavailable, playback still works (re-fetch), it simply is not cached; the app
says so rather than failing.

Rules: reads are defensive (parse failures fall back to empty); writes report failure to the
caller; a schema-version bump may migrate or discard, never crash.

## 8. AI provider configuration

Selected server-side by env; the browser never receives keys.

| Variable | Purpose |
|---|---|
| `TEXT_PROVIDER` | `ollama` (default) or `openai` |
| `OLLAMA_BASE_URL` | Ollama Cloud base URL |
| `OLLAMA_API_KEY` | Ollama Cloud API key |
| `OLLAMA_MODEL` | model name (env-driven; default is a documented placeholder to verify against the account) |
| `OPENAI_API_KEY` | OpenAI API key (also used for TTS) |
| `OPENAI_MODEL` | OpenAI text model name |
| `OPENAI_TTS_MODEL` | OpenAI TTS model (e.g. `gpt-4o-mini-tts`) |
| `OPENAI_TTS_VOICE` | default TTS voice for narration |
| `PORT` | HTTP port (existing) |
| `APP_PASSWORD` | optional legacy gate (existing) |
| `CHAT_ANSWERS_PER_WINDOW` | chat session limit (existing behavior; default 10) |
| `CHAT_PAUSE_HOURS` | chat pause duration (existing behavior; default 3) |

The model name is never hardcoded into prompts; `/health` reports which provider is configured.
`TEXT_PROVIDER` must be verified for availability rather than assuming a model exists.

## 9. Structured output contract

`/api/generate` returns worksheet JSON:

```json
{
  "topic": "string",
  "level": "A1",
  "sections": [
    {
      "id": "listening|reading|translation_grammar|writing",
      "topic_fr": "string (French theme for this section; required, distinct per section)",
      "title_fr": "string",
      "instructions_fr": "string",
      "text_fr": "string (French reading passage — reading section only, required there)",
      "audio": {
        "script": "string (hidden until reveal)",
        "speakers": [{ "name": "string", "voice": "string" }],
        "cache_key": "string (hash of script+voices)"
      },
      "questions": [
        {
          "id": "string",
          "prompt": "string",
          "type": "short_text|choice|fill_blank|translation|form",
          "options": ["..."],
          "fields": [{ "label_fr": "string (French field label — form only)" }],
          "answer": "string (hidden until reveal)",
          "explanation": "string"
        }
      ]
    }
  ]
}
```

The `audio` block is present only on the `listening` section. The `text_fr` passage is present
only on the `reading` section and is required (non-empty) there. Its `script` and each question's
`answer` are hidden from the rendered worksheet until the learner reveals/submits. The
questions must be answerable **solely** from the audio, and the script, questions, and answer
key are generated and validated together. Distinct `speakers` use distinct TTS voices.

The worksheet follows DELF A1 format. The server assigns a **distinct A1 curriculum module** to
each requested section and overwrites the model's `topic_fr` after validation; on the auto path
the worksheet-level `topic` is a compact summary of the returned section themes (an explicit
request `topic` is a legacy label kept verbatim and used for the first section). **Compréhension
orale** is one short, natural, coherent A1 recording on the assigned theme: a station/airport
announcement, a realistic voicemail, or a short dialogue between named speakers. It is 2–4 turns
and about 20–45 words in total, with everyday vocabulary, a clear purpose and no nonsense,
non-sequiturs or irrelevant lines. Its questions are always `choice` with exactly 3 options and
test comprehension/inference rather than verbatim matching. A single-speaker message is written
directly with no `Narratrice:`/`Narrateur:` prefix and lists exactly one speaker; a dialogue uses
`Name: …` lines with the exact speaker names. **Compréhension écrite** uses a short authentic
document with a mix of `choice` (3 options) and `short_text` questions, including inference.
**Grammaire** remains French-only grammar practice (no English→French translation). **Expression
écrite** contains exactly two `short_text`/`form` production questions: one `form` (a real-life
fiche with 5–8 non-empty French `fields`, each `{ "label_fr": "…" }`) and one `short_text` reply
of environ 40–50 mots to a short French situation/message. `fields` may appear only on `form`
questions, and `form` only in the writing section. The client stores form answers as an object
keyed by field label; the server serializes that object to a readable
`Label : valeur ; Label : valeur` string for the feedback prompt and for `original` in the
`/api/feedback` response (an all-empty form becomes `""`). Every learner-facing string
(`topic_fr`, `title_fr`, `instructions_fr`, `text_fr`, prompts, options, field labels, answers
and explanations) is written in French only.

`/api/tts` accepts `{ utterances, speakers, cache_key }`, where `utterances` is an ordered list
of `{ speaker, text }` lines. Because OpenAI TTS produces a single voice per call, dialogues
are synthesized **per utterance with each speaker's voice**, and the endpoint returns a list of
audio segments with leading/trailing pause durations:

```json
{ "segments": [ { "speaker": "A", "mime": "audio/mpeg", "base64": "...", "pause_after_ms": 600 } ] }
```

The client plays them in order (with pauses) so distinct speakers stay distinct. The whole
segment list is cached in IndexedDB under `cache_key`, so a resumed worksheet replays the same
conversation without re-billing TTS. If a single-voice narration is requested, the response has
one segment.

`/api/feedback` returns per-answer feedback keyed by question id:

```json
{
  "answers": [
    {
      "question_id": "string",
      "original": "string",
      "verdict": "correct|mistake|alternative",
      "correction": "string",
      "explanation": "string",
      "error_type": "error|style|alternative"
    }
  ],
  "summary": {
    "strengths": ["..."],
    "recurring_mistakes": ["..."],
    "priorities": ["..."],
    "follow_up": "string"
  }
}
```

Responses are parsed and validated before rendering. The renderer writes text via
`textContent`; model output is never injected as HTML. Sections for this release are
**listening / reading / translation-grammar / writing**, consistent with the chosen
light-worksheet scope.

## 10. Error handling

- Missing/failed provider → clear JSON error from `/api/*`; the UI shows an actionable setup or
  error message and never fake generated content or audio.
- Transient provider failure → one bounded retry, then surface the error.
- Provider request timeout is enforced.
- Save failure → retained in memory + visible "failed" state.
- TTS failure or missing `OPENAI_API_KEY` → the listening section renders the questions but
  shows an actionable "audio unavailable" message; it never plays silent/fabricated audio.
- IndexedDB unavailable → playback still works (re-fetch) with a note that caching is off.

## 11. Testing

Lightweight, no heavy framework:

- Unit: provider selection and provider error/timeout paths (mocked fetch); storage
  save/resume/version-migration; structured-output validation; answer-hiding logic
  (answers and listening script absent from the rendered/hidden payload); audio cache
  keying/collision behavior (fake IndexedDB).
- Integration (manual or scripted): `/health`; `/api/chat`, `/api/generate`, `/api/tts`,
  `/api/feedback` happy paths against a stub provider; missing-key error paths.
- Manual checklist: landing → chat and landing → worksheet journeys; listening replay/slow;
  autosave/resume across refresh (same worksheet, answers, audio); feedback adjacency; mobile
  keyboard handling; no repeat TTS charge on resume.

## 12. Migration / back-compat

- Existing chat localStorage keys are respected unchanged.
- Existing optional `APP_PASSWORD` behavior is retained.
- The original single-file `index.html` is replaced by `public/`; its chat features are ported
  to `views/chat.js` rather than removed.
- `npm start`/`npm run dev` continue to start the server.

## 13. Open items

- `OLLAMA_MODEL` default: use an env-driven placeholder documented in `.env.example`; confirm
  the exact Ollama Cloud model name against the account before release. Not a code blocker.
- OpenAI TTS model/voice names: env-driven defaults (`OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`);
  verify against the account's available models before release. Not a code blocker.
- Listening clips are TTS-synthesized from server-generated scripts, so they cost per character.
  Caching (§7) avoids repeat charges on resume; "New worksheet" discards the cached clip.
