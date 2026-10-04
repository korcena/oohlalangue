# Manual QA checklist

These checks require a real browser and (where noted) live provider credentials, so they are
manual. Unit tests cover provider selection, retries, validation, storage and the audio cache
with mocked dependencies; see `npm test`.

## A. Landing

- [ ] `GET /` shows the `Ooh La Langue` logo/tagline, nav and two cards (Chat / Fiche).
- [ ] Both cards are reachable and activatable with the keyboard (Tab + Enter/Space).
- [ ] With no text provider configured, a configuration notice is shown and is honest
      (no fake content).

## B. Chat parity (against the original app)

- [ ] `#/chat` greets the learner in French.
- [ ] A normal answer produces `✅ GOOD / 🔧 FIX / 💬 CORRECTED` cards rendered as before.
- [ ] An English word triggers the teach-on-translation fix.
- [ ] Voice input (fr-FR) and `🗣️ SAY IT` pronunciation line work where supported; mic hidden when
      unsupported.
- [ ] The 10-answers-per-3-hour pause appears, persists across refresh, and the header counter
      updates.
- [ ] `<note>` profile facts are stripped from the visible reply and persist across sessions.
- [ ] A 401 (session expiry) re-opens the gate.
- [ ] Mobile keyboard: composer stays visible, chat pins to the bottom.

## C. Worksheet journey (requires a text provider key)

- [ ] `#/worksheet` → choose topic/length/listening → Generate renders sections with French titles
      and English explanations.
- [ ] Before reveal, inspect the DOM: no answer text and no listening transcript text nodes.
- [ ] Type answers; the save-state shows **saving → saved** (text label, not colour alone).
- [ ] Refresh: the same worksheet, answers and saved indicator are restored without re-calling
      `/api/generate`.
- [ ] Simulate a quota error (fill localStorage) → answers stay in memory and **failed** is shown.

## D. Listening (requires OPENAI_API_KEY)

- [ ] First play calls `/api/tts`; segments play in order with pauses between speakers.
- [ ] Replay and refresh-play do **not** re-call `/api/tts` (check the network tab; cache hit).
- [ ] Slow playback works.
- [ ] The transcript toggle is absent/disabled until reveal.
- [ ] With `OPENAI_API_KEY` unset, questions still render with an actionable "audio unavailable"
      notice and no fabricated audio.
- [ ] With IndexedDB disabled, audio still plays (re-fetch) and a "caching off" note is shown.

## E. Reveal + feedback

- [ ] "Show answers" reveals the answer key and transcript adjacent to each question; the reveal
      state survives refresh.
- [ ] "Envoyer au professeur" disables while in flight and renders feedback next to each answer:
      original + labelled correction + explanation + error type.
- [ ] The summary card shows strengths, recurring mistakes, priorities and follow-up.
- [ ] Refresh keeps feedback.

## F. Cleanup + security

- [ ] "New worksheet" (with confirmation) clears the worksheet keys and deletes the cached audio;
      a subsequent play re-bills TTS exactly once.
- [ ] A malicious provider string such as `<img src=x onerror=alert(1)>` renders as literal text in
      the worksheet (never executed), because the worksheet renderer uses `textContent`.
- [ ] `/health` returns booleans only and no key values in the response body.
