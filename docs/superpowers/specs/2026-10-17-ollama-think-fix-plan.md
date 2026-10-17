# Ollama "thinking" model fix — implementation plan

Branch: `feature/chat-worksheet-lite`
Date: 2026-10-17

## 1. Objective

Stop `/api/generate`, `/api/feedback`, and `/api/chat` from failing with
`Ollama returned an empty response.` on Ollama Cloud thinking models. Thinking
models put reasoning in `message.thinking`; when reasoning exhausts `num_predict`,
`message.content` is empty and `extractOllamaText` (server.js:465) returns `''`.
Sending `think: false` in the `/api/chat` body makes these models return clean
content within existing token budgets. Scope: the Ollama provider only.

## 2. Relevant files

- `server.js` — `makeProviders` → `ollama.chatCompletion` (body at line 576; empty guard 581-584); `extractOllamaText` (465); `extractJson` (955, already strips `` ```json `` fences).
- `test/server.test.js` — `makeProviders`/`makeFetchMock` provider tests (lines 123-142) and retry/error tests (208-241).
- `.env.example` (lines 9-14) and `README.md` (lines 58-61) — only if `OLLAMA_THINK` is configurable.

## 3. Implementation tasks

**Task 1 — Make `think` configurable, default OFF (recommended).**
In `ollama.chatCompletion` (server.js:558), add `think` to the request body
object at line 576, sibling to `model`/`stream`/`messages`/`options`:
`body: { model: ..., stream: false, think: <thinkFlag>, messages: ..., options: { num_predict: maxTokens } }`.
Compute `<thinkFlag>` once near the top of the method (or at `makeProviders`
scope) as: `true` only when `String(env.OLLAMA_THINK || '').trim().toLowerCase() === 'true'`,
otherwise `false`. Exact env name: `OLLAMA_THINK`. Default: `false`. Parse
rule: case-insensitive literal `true`; any other value (unset, empty, `false`,
`0`, junk) → `false`. Rationale for default OFF: the app needs direct,
strict-JSON answers, not visible reasoning. Do not alter `num_predict`/budget logic.

**Task 2 — Document the knob (only because Task 1 is configurable).**
Add a commented `# OLLAMA_THINK=false` line (and a one-line explanation: "set
true only to surface model reasoning; leave false for strict JSON answers")
to `.env.example` under the Ollama block (after line 14). Add an
`OLLAMA_THINK` row to the README env table (after line 61): "Optional; default
`false`. Set `true` to let thinking models emit reasoning (not recommended —
answers are not JSON)."

**Task 3 — Tests** (see section 4).

**Task 4 — Verify.** Run `npm test` (`node --test`) — all green.

## 4. Testing requirements (`test/server.test.js`, existing mock harness)

Use `makeProviders({ httpRequest: makeFetchMock(...), env: {...} })` exactly as
in the existing provider test (lines 123-142); assert on `fetchImpl.calls[0].body`.

1. Extend the existing "ollama provider builds the expected ..." test (line 123)
   to assert `call.body.think === false` when `OLLAMA_THINK` is unset.
2. New test: with `env.OLLAMA_THINK = 'true'`, assert `call.body.think === true`
   (proves opt-in wiring; keep the mock returning `{ message: { content: 'ok' } }`).
3. New test: empty-content fallback still errors. Mock returns
   `jsonResponse(200, { message: { content: '' } })`; `assert.rejects` the
   `chatCompletion` call matching the `ProviderError` with
   `/Ollama returned an empty response/` and `status === 502`, and assert no
   change to retry count (1 call for a 200 empty body).
4. Confirm the OpenAI provider test (line 144) is untouched and asserts no
   `think` field — OpenAI needs no change.

## 5. Potential risks

- **Non-thinking models**: `think: false` is verified accepted by
  `mistral-large-3:675b` and `gpt-oss:20b`, so no regression expected; Task 3.1
  keeps the request contract asserted.
- **`clef:27b`**: remains unusable (rejects `/api/chat`) — explicitly out of
  scope; no code path change affects it.
- **Empty guard**: keep the `!text` `ProviderError` (server.js:582-584) as the
  genuine fallback for real empty upstream responses; do not remove it.
- **Env parse**: malformed `OLLAMA_THINK` values must degrade to `false` (strict
  literal-`true` rule) so an unrecognized value cannot silently enable reasoning.
- **No dependency changes**; do not touch token budgets, retry semantics, or the
  OpenAI provider.

## 6. Files to change, in order

1. `server.js` — add `think` to the Ollama `/api/chat` body, env-gated, default `false`.
2. `.env.example` — add commented `OLLAMA_THINK=false`.
3. `README.md` — add `OLLAMA_THINK` env-table row.
4. `test/server.test.js` — assert default `think: false`, opt-in `think: true`, and preserved empty-response error.
