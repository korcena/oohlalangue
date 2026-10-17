# Ooh La Langue

A small web app for practicing French. It has two paths:

- **Chat** — a warm AI tutor. You write in French; it replies with a per-turn correction block
  (`✅ GOOD`, `🔧 FIX`, `💬 CORRECTED`) and an A1-level follow-up question drawn from a structured
  curriculum. Voice input/output uses the browser's built-in speech APIs.
- **Worksheet (Fiche d'exercices)** — the app generates an A1 worksheet (listening, reading,
  translation/grammar, writing), you answer it in the browser, it autosaves to `localStorage`,
  the listening section is voiced with OpenAI TTS and cached in IndexedDB, and you can send it to
  the teacher for feedback rendered next to each answer.

The server is a **minimal key proxy**: it serves the static frontend and forwards AI requests to
**Ollama Cloud** (default) or **OpenAI** for text, and **OpenAI TTS** for speech. API keys stay
server-side and are never sent to the browser. There is no database, no accounts, and no
background workers.

---

## Quickstart

```bash
git clone https://github.com/korcena/oohlalangue.git
cd oohlalangue
npm install
cp .env.example .env     # fill in a text provider (and OpenAI for audio)
npm start
```

Then open <http://localhost:3000>.

### Requirements

- **Node.js ≥ 18**.
- A text provider key: **Ollama Cloud** (`OLLAMA_API_KEY` + `OLLAMA_MODEL`) or **OpenAI**
  (`OPENAI_API_KEY` + `OPENAI_MODEL`).
- **`OPENAI_API_KEY`** as well if you want the worksheet's listening audio (`/api/tts`). Without
  it the worksheet still generates and renders; the listening section shows an honest
  "audio unavailable" notice and never plays fabricated audio.

### Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the server (`node server.js`). |
| `npm run dev` | Same as start (no build step). |
| `npm test` | Unit tests (`node --test`). No API keys required; providers are mocked. |
| `npm run lint` | ESLint (flat config). |

---

## Environment variables

See `.env.example` for the secret-free template.

| Variable | Purpose |
| --- | --- |
| `TEXT_PROVIDER` | `ollama` (default) or `openai`. |
| `OLLAMA_BASE_URL` | Ollama Cloud base URL (default `https://ollama.com/api/chat`). |
| `OLLAMA_API_KEY` | Ollama Cloud API key. |
| `OLLAMA_MODEL` | Ollama Cloud model name. **No hardcoded default** — set the model available to your account. |
| `OLLAMA_THINK` | Optional; default `false`. Set `true` to surface model reasoning (not recommended — reasoning can exhaust the token budget and leave the reply empty). |
| `OPENAI_API_KEY` | OpenAI key (text provider `openai` and/or TTS). |
| `OPENAI_MODEL` | OpenAI text model name. |
| `OPENAI_TTS_MODEL` | OpenAI TTS model (e.g. `gpt-4o-mini-tts`). |
| `OPENAI_TTS_VOICE` | Default TTS voice for narration (e.g. `alloy`). |
| `OPENAI_TTS_VOICE_MALE` | Voice used when a worksheet speaker is labelled `male` (default `onyx`). |
| `OPENAI_TTS_VOICE_FEMALE` | Voice used when a worksheet speaker is labelled `female` (default `nova`). |
| `PORT` | HTTP port (default `3000`). |
| `APP_PASSWORD` | Optional; if set, visitors must enter it before using Chat or the Worksheet. |

The chat session limit (10 answers, then a 3-hour pause) is a hardcoded client behavior preserved
from the original app; it is intentionally not configurable.

Optional advanced overrides (built-in defaults in parentheses): `AI_TIMEOUT_MS` (30000),
`TTS_TIMEOUT_MS` (45000), `WORKSHEET_MAX_TOKENS` (3000), `FEEDBACK_MAX_TOKENS` (3000).

`GET /health` reports which providers are configured **as booleans only** — it never returns a
key. The model name is never hardcoded into prompts.

> **Open items (verify against your account, not code blockers):** the exact `OLLAMA_MODEL` name
> and the OpenAI TTS model/voice names are account-dependent. Set them in `.env`.

---

## Architecture

```
Browser (public/, vanilla ESM)
  ├─ views/landing.js      Chat / Worksheet chooser
  ├─ views/chat.js         A1 tutor (ported from the original app)
  ├─ views/worksheet.js    generate / answer / reveal / listen / submit / feedback
  ├─ lib/api.js            fetch wrapper for /api/*
  ├─ lib/storage.js        versioned localStorage
  └─ lib/audio-cache.js    IndexedDB audio cache
        │  fetch (no secrets)
        ▼
server.js (Express)
  ├─ static serving of public/
  ├─ POST /api/chat        → provider chat completion (unchanged contract)
  ├─ POST /api/generate    → structured worksheet JSON (incl. listening script)
  ├─ POST /api/tts         → OpenAI TTS audio segments
  ├─ POST /api/feedback    → structured feedback JSON
  └─ GET  /health          → provider configuration (no secrets)
        │  server-side key
        ▼
Ollama Cloud (default) | OpenAI (text) | OpenAI TTS (speech)

Browser storage
  ├─ localStorage          worksheet/answers/feedback + chat keys
  └─ IndexedDB             listening audio, keyed by script+voice+speed
```

No build step. Views are ES modules swapped by a small hash router (`#/`, `#/chat`,
`#/worksheet`).

---

## Trust model (please read)

This is a **personal practice tool, not a secure exam**.

- The `/api/generate` payload contains each question's `answer` and the listening `script`
  **by design**, because the browser must be able to reveal them after self-practice. There is
  **no server-side grading secrecy**; a curious learner can read them in DevTools.
- Hiding is a **UI concern**: the worksheet view does not render answers or the transcript into
  the DOM until the learner reveals/submits them. The transcript toggle is not built with the
  text inline.
- Feedback is generated by an AI teacher, not an invigilator.
- If a future release wants genuine answer secrecy, grading must move server-side. That is out
  of scope for this release.

---

## Credential-blocked behavior (honest failure)

No external credentials are bundled. With nothing configured:

- `GET /health` returns `textProvider: "ollama"`, `textProviderConfigured: false`,
  `textModelConfigured: false`, `ttsConfigured: false`.
- `POST /api/chat`, `/api/generate`, and `/api/feedback` return HTTP 500 with an actionable
  message naming the missing env var.
- `POST /api/tts` returns HTTP 500 with a message naming `OPENAI_API_KEY`.

The app **never fabricates** generated content or audio. The landing view shows a configuration
notice when a provider is unset. IndexedDB being unavailable only disables caching; playback
still works by re-fetching, with a "caching off" note.

---

## Storage keys

`localStorage` (existing chat keys are retained unchanged):

| Key | Contents |
| --- | --- |
| `oohlalangue_name` | learner display name |
| `oohlalangue_password` | legacy gate value |
| `oohlalangue_profile` | learned facts |
| `oohlalangue_answers` | chat answer counter |
| `oohlalangue_pause_until` | chat pause timestamp |
| `oohlalangue_worksheet_current` | current generated worksheet |
| `oohlalangue_worksheet_answers` | in-progress answers + last-saved timestamp |
| `oohlalangue_worksheet_feedback` | last teacher feedback |
| `oohlalangue_schema_version` | schema version for migration/discard |

Reads are defensive (corrupt JSON falls back to empty); writes report success/failure. A schema
version bump migrates, or discards worksheet keys only — never chat keys, and it never crashes.

**IndexedDB** (`oohlalangue_audio` → `clips`): the ordered audio segment list for a listening
script, keyed by a hash of `script + voice + speed`. Entries are deleted when the worksheet is
cleared, so resuming never re-bills TTS.

---

## API

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/chat` | `{ messages, name, profile, skipQuestion, voiceMode }` | `{ text, raw }` |
| `POST /api/generate` | `{ topic? (auto-selected from the A1 curriculum when omitted), level='A1', length, includeListening, name?, profile? }` | worksheet JSON (see below) |
| `POST /api/tts` | `{ utterances:[{speaker,text}], speakers:[{name,voice}], cache_key }` | `{ segments:[{speaker,mime,base64,pause_after_ms}] }` |
| `POST /api/feedback` | `{ worksheet, answers }` | `{ answers:[…], summary:{…} }` |
| `GET /health` | — | provider/config booleans (no secrets) |
| `GET /api/auth` | — | `{ required }` |
| `POST /api/auth` | password header/body | `{ ok }` or 401 |

Structured worksheet shape (see `docs/superpowers/specs/` for the full contract):

```json
{
  "topic": "string",
  "level": "A1",
  "sections": [
    {
      "id": "listening | reading | translation_grammar | writing",
      "title_fr": "string",
      "explanation_en": "string",
      "audio": { "script": "…", "speakers": [{ "name": "A", "voice": "alloy" }], "cache_key": "…" },
      "questions": [
        { "id": "string", "prompt": "string", "type": "short_text|choice|fill_blank|translation",
          "options": ["…"], "answer": "string", "explanation": "string" }
      ]
    }
  ]
}
```

The `audio` block appears **only** on the `listening` section. Provider output is validated
server-side; invalid JSON gets one repair retry, then a clear `502` (never partial content).

---

## Chat behavior

The chat is ported with **no behavior change**: the correction markers, structured correction
cards, A1 curriculum modules, learned-profile facts, browser voice I/O, the 10-answers-per-3-hour
pause, the header counter, and mobile keyboard handling all behave as before. The original chat
`localStorage` keys are respected, so existing sessions carry over.

---

## Customization

### Add or edit curriculum modules

Each module in `server.js` is an object with a `module`, a `focus` line, and a short `hint`. Add
entries to the `CURRICULUM_MODULES` array and optionally extend `CURRICULUM_SUMMARY`.

### Change the tutor's persona or correction format

The system prompt is built in `buildSystemPrompt()` (`server.js`). The marker emoji drive the
client parser; if you change them, update `parseTeacherReply()` in `public/views/chat.js`. A
golden test (`test/server.test.js`) pins the prompt output — update
`test/fixtures/system-prompt.golden.json` deliberately if you change it.

---

## Deploying

It is a single Node process serving static files plus `/api/*`:

- **Render / Railway / Fly.io:** point the service at `npm start`, set the env vars.
- **VPS:** `pm2 start server.js --name oohlalangue`, put Nginx in front for TLS.
- **Shared link:** set `APP_PASSWORD` so visitors must enter it before any requests hit your
  provider keys.

---

## Project layout

```
.
├── server.js            # static + /api proxy + /health
├── public/
│   ├── index.html       # single-page shell
│   ├── styles.css       # dark/gold/coral design language
│   ├── app.js           # hash router + bootstrap
│   ├── lib/             # api, storage, audio-cache, worksheet-render (pure helpers)
│   └── views/           # landing, chat (ported), worksheet
├── test/                # node:test suites (providers, storage, validation, audio cache,
│                        #   worksheet-render pure helpers)
├── eslint.config.js
├── .env.example
└── README.md
```

The original single-file `index.html` is preserved and served at `/legacy` (with its own inline
styles/script) so the ported chat can be compared side by side during manual parity QA.

---

## License

`UNLICENSED` — this is a personal project. All rights reserved. Feel free to read the code for
learning purposes.
