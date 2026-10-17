// Pure worksheet rendering helpers.
//
// These functions contain no DOM access so the answer/transcript hiding logic
// and the feedback-to-UI mapping can be unit-tested with `node:test`.
//
// TRUST MODEL (design spec §1/§9): the generated answers and the listening
// transcript are present in the `/api/generate` payload by design. Hiding is a
// UI concern. `buildRenderModel(worksheet, { reveal: false })` deliberately
// drops each question's `answer`, its `explanation`, and the listening `script`
// so the view cannot accidentally render them before the learner reveals them.
// Section instructions and the reading passage are inputs, not secrets, so they
// are always mapped (the passage is NOT reveal-gated).

export const SECTION_LABELS = Object.freeze({
  listening: 'Compréhension orale',
  reading: 'Compréhension écrite',
  translation_grammar: 'Grammaire',
  writing: 'Expression écrite'
});

export const VERDICT_LABELS = Object.freeze({
  correct: 'Correct',
  mistake: 'Erreur',
  alternative: 'Alternative'
});

export const ERROR_TYPE_LABELS = Object.freeze({
  error: 'Erreur',
  style: 'Style',
  alternative: 'Alternative'
});

// Reserved key stored alongside answers so the reveal state survives a refresh.
// It is not a real question id, so the feedback server ignores it.
export const REVEAL_KEY = '__revealed';

function str(value) {
  return value == null ? '' : String(value);
}

export function sectionLabel(id) {
  return SECTION_LABELS[id] || str(id);
}

export function verdictLabel(verdict) {
  return VERDICT_LABELS[verdict] || '';
}

export function errorTypeLabel(errorType) {
  return ERROR_TYPE_LABELS[errorType] || '';
}

// Returns true when the persisted answers payload marks the worksheet as
// revealed (either directly or under the reserved key).
export function isRevealedFromAnswers(answersPayload) {
  if (!answersPayload) return false;
  if (answersPayload.revealed === true) return true;
  const map = answersPayload.answersByQuestionId;
  return Boolean(map && map[REVEAL_KEY] === true);
}

// Build the render model. When `reveal` is false, no answer, question
// explanation, or listening transcript is present anywhere in the structure.
export function buildRenderModel(worksheet, { reveal = false } = {}) {
  const src = worksheet && typeof worksheet === 'object' ? worksheet : {};
  const sections = Array.isArray(src.sections) ? src.sections : [];
  return {
    topic: str(src.topic),
    level: str(src.level) || 'A1',
    sections: sections.map((section) => {
      const sec = section && typeof section === 'object' ? section : {};
      const model = {
        id: str(sec.id),
        title: str(sec.title_fr) || sectionLabel(sec.id),
        instructions: str(sec.instructions_fr) || str(sec.explanation_en),
        passage: str(sec.text_fr),
        questions: (Array.isArray(sec.questions) ? sec.questions : []).map((question) => {
          const q = question && typeof question === 'object' ? question : {};
          const model_q = {
            id: str(q.id),
            prompt: str(q.prompt),
            type: str(q.type) || 'short_text',
            options: Array.isArray(q.options) ? q.options.map(str) : []
          };
          if (reveal) {
            model_q.answer = str(q.answer);
            model_q.explanation = str(q.explanation);
          }
          return model_q;
        })
      };
      if (sec.id === 'listening' && sec.audio && typeof sec.audio === 'object') {
        model.audio = {
          speakers: Array.isArray(sec.audio.speakers)
            ? sec.audio.speakers.map((speaker) => ({
                name: str(speaker && speaker.name),
                voice: str(speaker && speaker.voice)
              }))
            : [],
          cacheKey: str(sec.audio.cache_key)
        };
        if (reveal) model.audio.script = str(sec.audio.script);
      }
      return model;
    })
  };
}

// Map feedback onto the worksheet's question order so the view can render the
// original answer immediately followed by its correction (adjacent ordering).
export function feedbackToUi(feedback, worksheet) {
  const list = feedback && Array.isArray(feedback.answers) ? feedback.answers : [];
  const byId = new Map();
  for (const entry of list) {
    if (entry && typeof entry.question_id === 'string') byId.set(entry.question_id, entry);
  }

  const rows = [];
  const sections = worksheet && Array.isArray(worksheet.sections) ? worksheet.sections : [];
  for (const section of sections) {
    const questions = section && Array.isArray(section.questions) ? section.questions : [];
    for (const question of questions) {
      const q = question && typeof question === 'object' ? question : {};
      const id = str(q.id);
      const entry = byId.get(id) || null;
      rows.push({
        question_id: id,
        prompt: str(q.prompt),
        original: entry ? str(entry.original) : '',
        verdict: entry ? str(entry.verdict) : '',
        verdictLabel: entry ? verdictLabel(entry.verdict) : '',
        correction: entry ? str(entry.correction) : '',
        explanation: entry ? str(entry.explanation) : '',
        errorType: entry ? str(entry.error_type) : '',
        errorTypeLabel: entry ? errorTypeLabel(entry.error_type) : '',
        hasFeedback: Boolean(entry)
      });
    }
  }
  return rows;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Derive an ordered utterance list from a listening script. Dialogues are
// recognised either as named lines (`A: Bonjour`, `Marie: Salut`) or as
// dash-prefixed turns (`- Bonjour`, `— Salut`); dash turns are assigned to the
// listed speakers round-robin so distinct speakers stay distinct. A plain
// narration becomes one utterance voiced by the first speaker. Server-side
// generation does not currently return an explicit utterances array, so this
// keeps the contract unambiguous without inventing content.
export function deriveUtterances(audio) {
  if (!audio || typeof audio !== 'object') return [];
  const speakers = Array.isArray(audio.speakers) ? audio.speakers : [];
  const names = speakers.map((speaker) => str(speaker && speaker.name)).filter(Boolean);
  const script = str(audio.script);
  if (!script.trim()) return [];

  const lines = script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const utterances = [];
  let dashTurn = 0;
  for (const line of lines) {
    let matchedSpeaker = null;
    let text = '';
    for (const name of names) {
      const match = line.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*[:：-]\\s*(.*)$`, 'i'));
      if (match) {
        matchedSpeaker = name;
        text = match[1].trim();
        break;
      }
    }

    // Dash-prefixed dialogue turn (an em/en dash or hyphen at the start).
    if (!matchedSpeaker && names.length > 1) {
      const dash = line.match(/^[—–-]\s*(.+)$/);
      if (dash) {
        matchedSpeaker = names[dashTurn % names.length];
        dashTurn += 1;
        text = dash[1].trim();
      }
    }

    if (matchedSpeaker) {
      utterances.push({ speaker: matchedSpeaker, text });
    } else if (utterances.length) {
      // Continuation of the previous speaker's line.
      utterances[utterances.length - 1].text =
        `${utterances[utterances.length - 1].text} ${line}`.trim();
    } else {
      utterances.push({ speaker: names[0] || 'A', text: line });
    }
  }

  if (!utterances.length) utterances.push({ speaker: names[0] || 'A', text: script.trim() });
  return utterances;
}

export default {
  SECTION_LABELS,
  VERDICT_LABELS,
  ERROR_TYPE_LABELS,
  REVEAL_KEY,
  sectionLabel,
  verdictLabel,
  errorTypeLabel,
  isRevealedFromAnswers,
  buildRenderModel,
  feedbackToUi,
  deriveUtterances
};
