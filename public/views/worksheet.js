// Worksheet view — generate, answer, listen, reveal and send to the teacher.
//
// SECURITY: every model-derived string (prompts, options, answers,
// explanations, transcript, feedback) is written with `textContent` /
// `createTextNode`. This file must never import the chat's `mdToHtml` and must
// never assign model output to `innerHTML`.
//
// TRUST MODEL: the raw `/api/generate` payload (including `answer` fields and
// the listening `script`) is held in memory so the learner can reveal it. The
// pure `buildRenderModel` helper strips those values until reveal; the view
// renders from that model.

import {
  buildRenderModel,
  feedbackToUi,
  deriveUtterances,
  isRevealedFromAnswers,
  answerControlKind,
  REVEAL_KEY
} from '../lib/worksheet-render.js';
import {
  canGenerate,
  nextWeekStart,
  recordGeneration,
  WEEKLY_LIMIT
} from '../lib/quota.js';
import { recordScore, scoreFromFeedback, worksheetIdentity } from '../lib/scores.js';

const SAVE_DEBOUNCE_MS = 600;
const SLOW_RATE = 0.75;

// Local-time label for the next weekly reset (next Sunday 00:00), e.g.
// "dimanche 18 octobre". `toLocaleDateString` already includes the weekday.
function quotaResetLabel(now) {
  return new Date(nextWeekStart(now)).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
}

// French explanation shown wherever a generation affordance is disabled.
function quotaMessage(now = Date.now()) {
  return (
    `Limite de ${WEEKLY_LIMIT} nouvelles fiches par semaine atteinte. ` +
    `De nouvelles fiches seront disponibles le ${quotaResetLabel(now)} à 00:00.`
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mount(container, ctx) {
  const { api, storage, audioCache } = ctx;

  // -- View state -----------------------------------------------------------
  const state = {
    worksheet: null,
    answersByQuestionId: {},
    revealed: false,
    feedback: null,
    segments: null,
    slow: false,
    playing: false,
    destroyed: false
  };

  let saveTimer = null;
  let currentAudio = null;
  let audioToken = 0;
  // Synchronous guard against Enter/rapid double-submit; `submit.disabled` is
  // set too late to cover a keypress that lands before the first `await`.
  let isGenerating = false;

  // -- Shell ----------------------------------------------------------------
  const wrap = el('section', 'worksheet');
  const head = el('div', 'worksheet-head');
  const title = el('h2', null, 'Fiche d’exercices');
  const meta = el('div', 'worksheet-meta');
  const actions = el('div', 'worksheet-actions');
  const saveState = el('div', 'save-state');
  saveState.setAttribute('aria-live', 'polite');
  saveState.hidden = true;
  actions.append(saveState);
  head.append(title, meta, actions);

  const body = el('div');
  body.style.display = 'contents';

  const actionsBottom = el('div', 'worksheet-actions worksheet-actions-bottom');
  actionsBottom.hidden = true;

  wrap.append(head, body, actionsBottom);
  container.appendChild(wrap);

  const generation = buildGenerationForm();

  // -- Persistence helpers ---------------------------------------------------
  function setSaveState(kind, message) {
    saveState.hidden = !message;
    saveState.className = 'save-state' + (kind ? ' ' + kind : '');
    saveState.textContent = message;
  }

  function scheduleSave() {
    if (!state.worksheet) return;
    setSaveState('saving', 'Enregistrement…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!state.worksheet) return;
    const ok = storage.setWorksheetAnswers(state.answersByQuestionId);
    setSaveState(ok ? 'saved' : 'failed', ok ? 'Enregistré' : 'Échec de l’enregistrement — réessayez');
  }

  // -- Generation flow -------------------------------------------------------
  function buildGenerationForm() {
    const form = el('form', 'gen-grid');

    const lengthField = el('div', 'field');
    const lengthLabel = el('label', null, 'Longueur');
    lengthLabel.setAttribute('for', 'wsLength');
    const lengthSelect = el('select');
    lengthSelect.id = 'wsLength';
    for (const [value, label] of [
      ['short', 'Courte'],
      ['medium', 'Moyenne'],
      ['long', 'Longue']
    ]) {
      const option = el('option', null, label);
      option.value = value;
      lengthSelect.appendChild(option);
    }
    lengthSelect.value = 'medium';
    lengthField.append(lengthLabel, lengthSelect);

    const listeningLabel = el('label', 'gen-check');
    const listeningInput = el('input');
    listeningInput.type = 'checkbox';
    listeningInput.id = 'wsListening';
    listeningInput.checked = true;
    listeningLabel.append(listeningInput, document.createTextNode('Inclure la compréhension orale'));

    const levelField = el('div', 'field');
    const levelLabel = el('label', null, 'Niveau');
    const levelValue = el('div', null, 'A1 · Débutant');
    levelValue.style.color = 'var(--muted)';
    levelField.append(levelLabel, levelValue);

    const submit = el('button', 'btn btn-primary', 'Générer la fiche');
    submit.type = 'submit';

    form.append(lengthField, levelField, listeningLabel, submit);

    const status = el('div');
    status.hidden = true;
    form.appendChild(status);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await generate();
    });

    async function generate() {
      if (isGenerating) return;
      const now = Date.now();
      if (!canGenerate(storage.getQuota(), now)) {
        showStatus('limit', quotaMessage(now));
        return;
      }
      isGenerating = true;
      submit.disabled = true;
      showStatus('loading', 'Génération de la fiche en cours…');
      try {
        const worksheet = await api.generate({
          level: 'A1',
          length: lengthSelect.value,
          includeListening: listeningInput.checked,
          name: storage.getName(),
          profile: storage.getProfile()
        });
        // `onAccepted` fires only after the payload is validated, and before the
        // render that recomputes `canStartNew`. Incrementing here (not after the
        // render) means the "Nouvelle fiche" button and the quota notice already
        // reflect the post-generation state on the very generation that reaches
        // the limit — no reload needed. A failed/invalid generation never fires
        // it, so nothing is counted.
        startWorksheet(worksheet, {
          deleteOldAudio: true,
          onAccepted: () => recordGeneration(storage, now)
        });
      } catch (err) {
        showStatus(
          'error',
          (err && err.message ? err.message : String(err)) +
            ' — l’application ne fabrique pas de contenu ; configure un fournisseur de texte (voir le README).'
        );
      } finally {
        isGenerating = false;
        submit.disabled = !canGenerate(storage.getQuota(), Date.now());
      }
    }

    function showStatus(kind, message) {
      status.hidden = false;
      status.className = 'notice' + (kind === 'error' ? ' error' : '');
      status.textContent = message;
    }

    function resetStatus() {
      status.hidden = true;
      status.textContent = '';
      status.className = '';
    }

    function setDisabled(value) {
      submit.disabled = Boolean(value);
    }

    return { form, showStatus, resetStatus, setDisabled };
  }

  function startWorksheet(worksheet, { deleteOldAudio = false, onAccepted = null } = {}) {
    if (!worksheet || !Array.isArray(worksheet.sections)) {
      renderGeneration('Le serveur a renvoyé une fiche inattendue. Réessaie.');
      return false;
    }

    // Run the accepted hook (quota increment) BEFORE any render, so a render
    // that reads the quota sees the post-generation state.
    if (typeof onAccepted === 'function') onAccepted();

    const oldKeys = collectCacheKeys(state.worksheet);
    if (deleteOldAudio) {
      for (const key of oldKeys) audioCache.delete(key).catch(() => {});
    }

    clearTimeout(saveTimer);
    saveTimer = null;
    state.worksheet = worksheet;
    state.answersByQuestionId = {};
    state.revealed = false;
    state.feedback = null;
    state.segments = null;

    storage.clearCurrentWorksheet();
    const storedOk = storage.setCurrentWorksheet(worksheet);
    if (!storedOk) {
      // Keep the worksheet in memory; warn honestly on the save state.
      setSaveState('failed', 'Fiche générée, mais impossible de l’enregistrer (stockage indisponible).');
    } else {
      setSaveState('', '');
    }
    renderWorksheet();
    return true;
  }

  function collectCacheKeys(worksheet) {
    const keys = [];
    const sections = worksheet && Array.isArray(worksheet.sections) ? worksheet.sections : [];
    for (const section of sections) {
      if (section && section.audio && section.audio.cache_key) keys.push(section.audio.cache_key);
    }
    return keys;
  }

  function renderGeneration(errorMessage) {
    body.textContent = '';
    // Reset both action containers: no worksheet is loaded, so drop the
    // per-worksheet buttons and quota note from any previous worksheet.
    actions.querySelectorAll('.btn-ws-action').forEach((n) => n.remove());
    actions.querySelectorAll('.worksheet-quota-note').forEach((n) => n.remove());
    actionsBottom.querySelectorAll('.btn-ws-action').forEach((n) => n.remove());
    actionsBottom.textContent = '';
    actionsBottom.hidden = true;
    title.textContent = 'Fiche d’exercices';
    meta.textContent = '';
    if (errorMessage) {
      body.appendChild(el('div', 'notice error', errorMessage));
    }
    const intro = el(
      'p',
      'section-expl',
      'Choisis une longueur et (au besoin) la compréhension orale. La fiche est générée par le professeur IA. Le sujet est choisi automatiquement.'
    );
    generation.resetStatus();
    const now = Date.now();
    const allowed = canGenerate(storage.getQuota(), now);
    generation.setDisabled(!allowed);
    body.append(intro, generation.form);
    if (!allowed) {
      body.appendChild(el('div', 'notice', quotaMessage(now)));
    }
  }

  // -- Worksheet rendering ---------------------------------------------------
  function renderWorksheet() {
    body.textContent = '';
    if (!state.worksheet || !Array.isArray(state.worksheet.sections)) {
      state.worksheet = null;
      renderGeneration();
      return;
    }

    title.textContent = state.worksheet.topic ? `Fiche : ${state.worksheet.topic}` : 'Fiche d’exercices';
    meta.textContent = `${state.worksheet.level || 'A1'} · ${state.worksheet.sections.length} sections`;

    // Header actions: new worksheet. The reveal toggle and send button live in
    // the bottom action bar, after all worksheet content.
    actions.querySelectorAll('.btn-ws-action').forEach((n) => n.remove());
    actions.querySelectorAll('.worksheet-quota-note').forEach((n) => n.remove());
    actionsBottom.querySelectorAll('.btn-ws-action').forEach((n) => n.remove());
    const quotaNow = Date.now();
    const canStartNew = canGenerate(storage.getQuota(), quotaNow);

    const revealBtn = el('button', 'btn btn-ghost btn-ws-action', state.revealed ? 'Cacher les réponses' : 'Vérifier / Voir les réponses');
    revealBtn.type = 'button';
    revealBtn.addEventListener('click', () => {
      state.revealed = !state.revealed;
      state.answersByQuestionId[REVEAL_KEY] = state.revealed;
      // Reveal is a discrete action and must survive an immediate refresh, so
      // persist synchronously rather than via the input debounce.
      flushSave();
      renderWorksheet();
    });

    const sendBtn = el('button', 'btn btn-primary btn-ws-action', 'Envoyer au professeur');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', () => sendToTeacher(sendBtn));

    const newBtn = el('button', 'btn btn-ghost btn-ws-action', 'Nouvelle fiche');
    newBtn.type = 'button';
    // An existing worksheet stays fully usable (answer/listen/reveal/feedback)
    // while exhausted; only creating a NEW one is blocked.
    newBtn.disabled = !canStartNew;
    newBtn.addEventListener('click', () => newWorksheet());

    actions.append(newBtn);
    if (!canStartNew) {
      actions.appendChild(el('div', 'notice worksheet-quota-note', quotaMessage(quotaNow)));
    }
    actionsBottom.append(revealBtn, sendBtn);
    actionsBottom.hidden = false;

    const model = buildRenderModel(state.worksheet, { reveal: state.revealed });
    const feedbackRows = state.feedback ? feedbackToUi(state.feedback, state.worksheet) : [];
    const feedbackById = new Map(feedbackRows.map((row) => [row.question_id, row]));
    for (const section of model.sections) {
      body.appendChild(renderSection(section, feedbackById));
    }

    if (state.revealed) {
      body.appendChild(el('div', 'cache-note', 'Les réponses et la transcription sont maintenant visibles (auto-correction).'));
    }

    if (state.feedback) {
      body.appendChild(renderSummary(state.feedback));
    }
  }

  function renderSection(section, feedbackById) {
    const card = el('section', 'section-card');
    card.appendChild(el('h3', null, section.title));
    if (section.instructions) card.appendChild(el('p', 'section-expl', section.instructions));

    // The reading passage is an input (not a secret): always visible, above
    // that section's questions, and written with textContent only.
    if (section.id === 'reading' && section.passage) {
      const box = el('div', 'reading-passage');
      box.appendChild(el('span', 'label', 'Texte à lire'));
      box.appendChild(document.createTextNode(section.passage));
      card.appendChild(box);
    }

    if (section.id === 'listening' && section.audio) {
      // The render model strips `script` until reveal (security), but the TTS
      // request needs it. Pull it from the in-memory worksheet, never the DOM.
      const raw = (state.worksheet.sections || []).find((s) => s && s.id === 'listening');
      const rawAudio = raw && raw.audio ? raw.audio : null;
      card.appendChild(renderListening(section, rawAudio));
    }

    for (const question of section.questions) {
      card.appendChild(renderQuestion(question, feedbackById, section.id));
    }
    return card;
  }

  function renderQuestion(question, feedbackById, sectionId) {
    const block = el('div', 'question-block');

    const idEl = el('div', 'question-id', `Question ${question.id}`);
    const promptEl = el('div', 'question-prompt', question.prompt);
    block.append(idEl, promptEl);

    const answerKey = question.id;
    const savedValue = state.answersByQuestionId[answerKey];
    const controlKind = answerControlKind(sectionId, question);

    if (controlKind === 'choice') {
      const list = el('div', 'choice-list');
      const groupName = `choice-${answerKey}`;
      for (const optionText of question.options) {
        const label = el('label', 'choice-option');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = groupName;
        radio.value = optionText;
        radio.setAttribute('aria-label', optionText);
        if (savedValue === optionText) radio.checked = true;
        radio.addEventListener('change', () => {
          state.answersByQuestionId[answerKey] = optionText;
          scheduleSave();
        });
        label.append(radio, document.createTextNode(optionText));
        list.appendChild(label);
      }
      block.appendChild(list);
    } else if (controlKind === 'input') {
      const input = el('input', 'answer-input');
      input.type = 'text';
      input.value = savedValue == null ? '' : String(savedValue);
      input.setAttribute('aria-label', `Réponse à la question ${answerKey}`);
      input.addEventListener('input', () => {
        state.answersByQuestionId[answerKey] = input.value;
        scheduleSave();
      });
      block.appendChild(input);
    } else {
      const textarea = el('textarea', 'answer-input');
      textarea.value = savedValue == null ? '' : String(savedValue);
      textarea.rows = sectionId === 'writing' ? 5 : 2;
      textarea.setAttribute('aria-label', `Réponse à la question ${answerKey}`);
      textarea.addEventListener('input', () => {
        state.answersByQuestionId[answerKey] = textarea.value;
        scheduleSave();
      });
      block.appendChild(textarea);
    }

    // Feedback renders immediately after the learner's answer.
    const feedbackRow = feedbackById ? feedbackById.get(answerKey) : null;
    if (feedbackRow && feedbackRow.hasFeedback) {
      block.appendChild(renderFeedback(feedbackRow));
    }

    // Revealed answer + explanation, adjacent to the question.
    if (state.revealed && (question.answer || question.explanation)) {
      block.appendChild(renderReveal(question));
    }

    return block;
  }

  function renderReveal(question) {
    const box = el('div', 'reveal-answer');
    if (question.answer) {
      box.appendChild(el('span', 'label', 'Réponse attendue'));
      box.appendChild(el('div', null, question.answer));
    }
    if (question.explanation) {
      box.appendChild(el('span', 'label', 'Explication'));
      box.appendChild(el('div', null, question.explanation));
    }
    return box;
  }

  function renderFeedback(row) {
    const card = el('div', 'feedback ' + (row.verdict || ''));
    const headRow = el('div', 'fb-head');
    headRow.appendChild(el('span', 'fb-label', 'Ta réponse'));
    headRow.appendChild(el('span', null, row.original));
    card.appendChild(headRow);

    const verdictRow = el('div', 'fb-head');
    verdictRow.appendChild(el('span', 'verdict', row.verdictLabel || row.verdict));
    verdictRow.appendChild(
      el('span', 'error-type', row.errorTypeLabel ? `Type : ${row.errorTypeLabel}` : '')
    );
    card.appendChild(verdictRow);

    const correctionBox = el('div', 'correction');
    correctionBox.appendChild(el('span', 'fb-label', 'Correction'));
    correctionBox.appendChild(el('div', null, row.correction));
    card.appendChild(correctionBox);

    if (row.explanation) {
      const expl = el('div');
      expl.appendChild(el('span', 'fb-label', 'Explication'));
      expl.appendChild(el('div', null, row.explanation));
      card.appendChild(expl);
    }
    return card;
  }

  function renderSummary(feedback) {
    const summary = feedback && feedback.summary ? feedback.summary : null;
    const card = el('section', 'summary-card');
    card.appendChild(el('h3', null, 'Bilan du professeur'));
    if (!summary) return card;

    const lists = [
      ['Points forts', summary.strengths],
      ['Erreurs récurrentes', summary.recurring_mistakes],
      ['Priorités', summary.priorities]
    ];
    for (const [label, items] of lists) {
      if (!Array.isArray(items) || !items.length) continue;
      card.appendChild(el('h4', null, label));
      const ul = el('ul');
      for (const item of items) ul.appendChild(el('li', null, String(item)));
      card.appendChild(ul);
    }
    if (summary.follow_up) {
      card.appendChild(el('h4', null, 'Exercice de suivi'));
      card.appendChild(el('p', null, summary.follow_up));
    }
    return card;
  }

  // -- Listening player ------------------------------------------------------
  // `section` is the sanitised render model (no script until reveal);
  // `rawAudio` is the in-memory audio block used for TTS and the transcript.
  function renderListening(section, rawAudio) {
    const wrapEl = el('div');
    wrapEl.style.display = 'flex';
    wrapEl.style.flexDirection = 'column';
    wrapEl.style.gap = '10px';

    const controls = el('div', 'audio-controls');
    const playBtn = el('button', 'btn btn-primary', '▶ Écouter');
    playBtn.type = 'button';
    const replayBtn = el('button', 'btn btn-ghost', '↻ Rejouer');
    replayBtn.type = 'button';
    replayBtn.disabled = true;
    const slowBtn = el('button', 'btn btn-ghost', state.slow ? '🐢 Lent : activé' : '🐢 Lent');
    slowBtn.type = 'button';
    const status = el('span', 'cache-note', '');
    controls.append(playBtn, replayBtn, slowBtn, status);
    wrapEl.appendChild(controls);

    const notice = el('div');
    notice.hidden = true;
    wrapEl.appendChild(notice);

    function setNotice(kind, message) {
      notice.hidden = !message;
      notice.className = kind === 'error' ? 'audio-unavailable' : 'cache-note';
      notice.textContent = message || '';
    }

    function reportAudioError(err) {
      setNotice(
        'error',
        (err && err.message ? err.message : String(err)) +
          ' — audio indisponible ; l’application ne joue pas d’audio fabriqué.'
      );
    }

    playBtn.addEventListener('click', async () => {
      playBtn.disabled = true;
      setNotice('', '');
      try {
        await ensureSegments(section, rawAudio, status, setNotice);
        replayBtn.disabled = !state.segments;
        await play({ slow: state.slow });
      } catch (err) {
        reportAudioError(err);
      } finally {
        playBtn.disabled = false;
      }
    });

    replayBtn.addEventListener('click', () => {
      if (state.segments) play({ slow: state.slow }).catch(reportAudioError);
    });

    slowBtn.addEventListener('click', async () => {
      state.slow = !state.slow;
      slowBtn.textContent = state.slow ? '🐢 Lent : activé' : '🐢 Lent';
      if (state.playing && state.segments) {
        try {
          await play({ slow: state.slow });
        } catch (err) {
          reportAudioError(err);
        }
      }
    });

    // Restore transcript on reveal; transcript text is only created then.
    if (state.revealed && rawAudio && rawAudio.script) {
      const transcript = el('div', 'transcript');
      transcript.appendChild(el('span', 'label', 'Transcription'));
      transcript.appendChild(document.createTextNode(rawAudio.script));
      wrapEl.appendChild(transcript);
    }

    // Surface cache status on mount (resume) without auto-playing. Loading the
    // cached segments here means the first play/replay is served from cache and
    // never re-bills TTS.
    if (section.audio.cacheKey) {
      audioCache
        .getSegments(section.audio.cacheKey)
        .then((record) => {
          if (state.destroyed) return;
          if (record && Array.isArray(record.segments) && record.segments.length) {
            state.segments = record.segments;
            status.textContent = 'Audio en cache — relecture sans nouveau coût.';
            replayBtn.disabled = false;
          }
        })
        .catch(() => {});
    }

    return wrapEl;
  }

  async function ensureSegments(section, rawAudio, statusEl, setNotice) {
    if (state.segments && state.segments.length) return state.segments;
    const cacheKey = section.audio.cacheKey || '';

    if (cacheKey) {
      const record = await audioCache.getSegments(cacheKey);
      if (record && Array.isArray(record.segments) && record.segments.length) {
        state.segments = record.segments;
        statusEl.textContent = 'Audio en cache — relecture sans nouveau coût.';
        return state.segments;
      }
    }

    const utterances = deriveUtterances(rawAudio || {});
    if (!utterances.length) {
      throw new Error('Le script audio est vide.');
    }
    statusEl.textContent = 'Synthèse audio en cours…';
    const response = await api.tts({
      utterances,
      speakers: (rawAudio && rawAudio.speakers) || section.audio.speakers,
      cache_key: cacheKey
    });
    if (!response || !Array.isArray(response.segments) || !response.segments.length) {
      throw new Error('Le service audio n’a renvoyé aucun segment.');
    }
    state.segments = response.segments;
    if (cacheKey) {
      const cached = await audioCache.putSegments(cacheKey, state.segments);
      if (!cached) {
        setNotice('', 'Lecture possible, mais la mise en cache est désactivée (IndexedDB indisponible).');
      }
    }
    statusEl.textContent = '';
    return state.segments;
  }

  function stopAudio() {
    audioToken += 1;
    state.playing = false;
    if (currentAudio) {
      try {
        currentAudio.pause();
      } catch (_e) {
        /* ignore */
      }
      currentAudio = null;
    }
  }

  async function playOne(segment, token) {
    return new Promise((resolve, reject) => {
      if (token !== audioToken) {
        resolve(false);
        return;
      }
      const audio = new Audio(`data:${segment.mime || 'audio/mpeg'};base64,${segment.base64}`);
      currentAudio = audio;
      audio.playbackRate = state.slow ? SLOW_RATE : 1;
      audio.onended = () => resolve(true);
      audio.onerror = () => reject(new Error('La lecture audio a échoué.'));
      audio.play().catch(reject);
    });
  }

  async function play({ slow } = {}) {
    if (!Array.isArray(state.segments) || !state.segments.length) return;
    stopAudio();
    const token = audioToken;
    state.playing = true;
    state.slow = Boolean(slow);
    try {
      for (const segment of state.segments) {
        if (token !== audioToken || state.destroyed) break;
        const ok = await playOne(segment, token);
        if (!ok) break;
        const pause = Number(segment.pause_after_ms) || 0;
        if (pause) await sleep(pause);
      }
    } finally {
      if (token === audioToken) {
        state.playing = false;
        currentAudio = null;
      }
    }
  }

  // -- Send to teacher -------------------------------------------------------
  async function sendToTeacher(button) {
    if (!state.worksheet) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Envoi…';
    const answers = Object.assign({}, state.answersByQuestionId);
    delete answers[REVEAL_KEY];
    try {
      const feedback = await api.feedback({ worksheet: state.worksheet, answers });
      state.feedback = feedback;
      const ok = storage.setFeedback(feedback);
      if (!ok) {
        setSaveState('failed', 'Corrections reçues mais non enregistrées — réessayez de les conserver.');
      }
      // Record the per-fiche score from the received verdicts. `recordScore` is
      // fail-open and never throws, so a storage failure here must not be
      // reported as a feedback failure.
      const score = scoreFromFeedback(feedback);
      if (score.total > 0) {
        const recorded = recordScore(
          storage,
          {
            id: worksheetIdentity(state.worksheet),
            topic: state.worksheet && state.worksheet.topic,
            correct: score.correct,
            total: score.total
          },
          Date.now()
        );
        if (!recorded.persisted) {
          // Feedback itself succeeded; only the progress write was lost. Make
          // the silent loss visible without failing the send.
          console.warn('Score non enregistré — progression potentiellement perdue.');
        }
      }
      renderWorksheet();
    } catch (err) {
      const box = el(
        'div',
        'notice error',
        (err && err.message ? err.message : String(err)) +
          ' — le professeur n’a pas pu corriger la fiche. Réessaie plus tard.'
      );
      body.appendChild(box);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  // -- New worksheet ---------------------------------------------------------
  function newWorksheet() {
    if (!state.worksheet) return;
    // Defensive: the button is disabled once the weekly limit is reached, but
    // never clear a fiche the learner can no longer replace.
    if (!canGenerate(storage.getQuota(), Date.now())) return;
    const confirmed =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('Effacer la fiche actuelle, ses réponses, le bilan et l’audio en cache ?')
        : true;
    if (!confirmed) return;

    const keys = collectCacheKeys(state.worksheet);
    for (const key of keys) audioCache.delete(key).catch(() => {});
    state.worksheet = null;
    state.answersByQuestionId = {};
    state.revealed = false;
    state.feedback = null;
    state.segments = null;
    stopAudio();
    storage.clearCurrentWorksheet();
    setSaveState('', '');
    renderGeneration();
  }

  // -- Resume ----------------------------------------------------------------
  function resume() {
    const worksheet = storage.getCurrentWorksheet();
    if (!worksheet) {
      renderGeneration();
      return;
    }
    const saved = storage.getWorksheetAnswers();
    state.worksheet = worksheet;
    state.answersByQuestionId = saved ? Object.assign({}, saved.answersByQuestionId) : {};
    state.revealed = isRevealedFromAnswers(saved);
    state.feedback = storage.getFeedback();
    const when = saved && saved.lastSavedAt ? new Date(saved.lastSavedAt).toLocaleString() : null;
    renderWorksheet();
    if (when) setSaveState('saved', `Enregistré · ${when}`);
  }

  resume();

  function destroy() {
    state.destroyed = true;
    // Flush any pending autosave so leaving the view never drops in-progress
    // answers (the debounce timer may still be running).
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (state.worksheet) storage.setWorksheetAnswers(state.answersByQuestionId);
    }
    stopAudio();
  }

  // The router treats a returned function as the view cleanup.
  return destroy;
}

export default mount;
