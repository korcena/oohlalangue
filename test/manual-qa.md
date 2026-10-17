# Manual QA checklist

These checks require a real browser and (where noted) live provider credentials, so they are
manual. Unit tests cover provider selection, retries, validation, storage and the audio cache
with mocked dependencies; see `npm test`.

## A. Landing

- [ ] `GET /` shows the `Ooh La Langue` logo/tagline, nav and two cards (Chat / Fiche).
- [ ] Both cards are reachable and activatable with the keyboard (Tab + Enter/Space).
- [ ] With no text provider configured, a configuration notice is shown and is honest
      (no fake content).

## A2. Password gate (only when `APP_PASSWORD` is set)

- [ ] Visiting `#/worksheet` directly (without going through chat) shows the name/password gate
      and does NOT mount the worksheet until a correct password is entered.
- [ ] After entering a correct password once, both `#/chat` and `#/worksheet` open without
      re-prompting (the stored password is verified).
- [ ] An incorrect stored password re-shows the gate rather than opening the worksheet.
- [ ] When `APP_PASSWORD` is unset, a name alone is enough and both views open.

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

- [ ] Landing → Worksheet card and the deep link `#/worksheet` both open the generation form.
- [ ] Choose length/listening (the subject is auto-selected) → Generate shows a loading state,
      then renders sections with French titles and English explanations.
- [ ] With no manual topic input, the rendered fiche title is drawn from the A1 curriculum and
      matches the auto-selected subject. Each generation is judged independently; repeated picks
      across generations are allowed.
- [ ] With no text provider configured, Generate shows the server's actionable error and renders
      no worksheet (never fabricated content).
- [ ] Before reveal, inspect the DOM (not just the visual): no answer text and no listening
      transcript text nodes are present anywhere.
- [ ] Type answers; the save-state shows **Enregistrement… → Enregistré** (text label, not colour
      alone).
- [ ] Refresh: the same worksheet, answers and saved indicator are restored without re-calling
      `/api/generate`; the deep link still points at `#/worksheet`.
- [ ] Simulate a quota error (fill localStorage) → answers stay in memory and **Échec …** is shown;
      text is never silently dropped.
- [ ] Leave the view (`#/chat` then back) with a pending debounce → answers were flushed, not lost.

## D. Listening (requires OPENAI_API_KEY)

- [ ] First play calls `/api/tts`; segments play in order with pauses between distinct speakers.
- [ ] Replay and refresh-play do **not** re-call `/api/tts` (check the network tab; cache hit).
- [ ] Slow playback works and toggles the button label to **activé**.
- [ ] The transcript is absent from the DOM until reveal; after reveal it appears under the
      listening section.
- [ ] With `OPENAI_API_KEY` unset, questions still render with an actionable "audio unavailable"
      notice and no fabricated audio.
- [ ] With IndexedDB disabled, audio still plays (re-fetch) and a "caching off" note is shown.

## E. Reveal + feedback

- [ ] "Vérifier / Voir les réponses" reveals the answer key (and transcript) adjacent to each
      question; the reveal state survives refresh.
- [ ] "Envoyer au professeur" disables while in flight and renders feedback next to each answer:
      original + explicit **Correct / Mistake / Alternative** label + correction + explanation +
      error type (meaning never depends on colour alone).
- [ ] The summary card shows strengths (Points forts), recurring mistakes (Erreurs récurrentes),
      priorities (Priorités) and follow-up (Exercice de suivi).
- [ ] Refresh keeps feedback.

## F. Cleanup + security

- [ ] "Nouvelle fiche" asks for confirmation, clears the worksheet keys and deletes the cached
      audio; a subsequent play re-bills TTS exactly once.
- [ ] A malicious provider string such as `<img src=x onerror=alert(1)>` in a prompt, option, answer,
      explanation, transcript or feedback renders as literal text (never executed), because the
      worksheet renderer uses `textContent` only.
- [ ] The chat's escaped markdown renderer is the only `innerHTML` use under `public/`; worksheet
      output never uses it.
- [ ] `/health` returns booleans only and no key values in the response body.
- [ ] `/legacy` still serves the original single-file chat (200).

## G. Weekly quota (3 new fiches/week, requires a text provider key)

- [ ] In a fresh browser profile (empty `localStorage`), the generation form is enabled and the
      quota record is absent; the app allows generation.
- [ ] Generate 3 successful fiches. After the 3rd, the "Générer la fiche" and "Nouvelle fiche"
      buttons are disabled.
- [ ] Attempting a 4th generation does not call `/api/generate` (check the network tab) and shows
      the French message naming the next Sunday at 00:00.
- [ ] Reload the page: the count is preserved (still exhausted) and the message/disabled state
      remain. Clearing the worksheet via an existing fiche does not reset the count.
- [ ] With the quota exhausted, an existing saved fiche can still be opened, answered, listened to,
      revealed and sent to the teacher (only new-generation affordances are disabled).
- [ ] Simulate a failed generation (e.g. no text provider configured): an error is shown and the
      stored count is unchanged (failures/timeouts never consume quota).
- [ ] Inspect the message: it names the next Sunday's date in French and says 00:00.

## H. Progrès / suivi des scores (requires a text provider key)

- [ ] Before any feedback, the landing page `#/` shows a friendly French "Pas encore de score"
      message (`.cache-note`) inside the "Progrès" card; the layout is intact.
- [ ] Send a fiche to the teacher from `#/worksheet`, then navigate to `#/`: the "Progrès" card
      lists this week's fiche (topic or "Fiche" + score %) and the weekly average.
- [ ] Send a second (different) fiche: both appear under "Cette semaine", and the average updates
      to the mean of the two scores.
- [ ] Re-send the same fiche (reopen it, send again): no duplicate appears — the existing entry is
      updated in place and the average does not double-count.
- [ ] A fiche with zero graded answers records nothing (no new list item, unchanged average).
- [ ] "12 dernières semaines" shows one line per week, most recent first, with the week's average
      and fiche count.
- [ ] Reload the page: the "Progrès" card is unchanged (persisted in `localStorage`); it is **not**
      wiped by generating a new fiche or by "Nouvelle fiche".
- [ ] Simulate a week rollover (or set the system clock past Sunday 00:00): an entry recorded
      before the boundary stays grouped in its original week; a fiche recorded at/after Sunday
      00:00 lands in the new week.
- [ ] Clear the score-history key manually: the landing page falls back to the empty state and the
      layout is intact (no error).

