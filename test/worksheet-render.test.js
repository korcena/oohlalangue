'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let modPromise = null;
function loadHelpers() {
  if (!modPromise) modPromise = import('../public/lib/worksheet-render.js');
  return modPromise;
}

const sampleWorksheet = () => ({
  topic: 'Au café',
  level: 'A1',
  sections: [
    {
      id: 'listening',
      title_fr: 'Compréhension orale',
      topic_fr: 'Les Fruits',
      instructions_fr: 'Écoute le dialogue.',
      audio: {
        script: 'SECRET TRANSCRIPT',
        speakers: [{ name: 'A', voice: 'alloy' }],
        cache_key: 'cache-key-1'
      },
      questions: [
        {
          id: 'l1',
          prompt: 'Que veut A ?',
          type: 'choice',
          options: ['un café', 'un thé', 'un jus'],
          answer: 'SECRET ANSWER',
          explanation: 'SECRET EXPLANATION'
        }
      ]
    },
    {
      id: 'reading',
      title_fr: 'Compréhension écrite',
      topic_fr: 'La Famille',
      instructions_fr: 'Lis le texte.',
      text_fr: 'TEXTE DE LECTURE',
      questions: [
        { id: 'r1', prompt: 'Vrai ou faux ?', type: 'choice', options: ['Vrai', 'Faux'], answer: 'Vrai', explanation: 'C’est vrai.' }
      ]
    }
  ]
});

test('buildRenderModel hides answers, explanations and the transcript but keeps instructions and passage', async () => {
  const { buildRenderModel } = await loadHelpers();
  const model = buildRenderModel(sampleWorksheet(), { reveal: false });
  const initial = JSON.stringify(model);
  assert.ok(!initial.includes('SECRET ANSWER'));
  assert.ok(!initial.includes('SECRET EXPLANATION'));
  assert.ok(!initial.includes('SECRET TRANSCRIPT'));
  assert.ok(!initial.includes('hint'), 'the render model must not emit a hint field');
  assert.ok(!initial.includes('explanation_en'), 'the legacy English field must not be emitted');
  assert.ok(initial.includes('Compréhension orale'));
  assert.ok(initial.includes('Que veut A ?'));

  const listening = model.sections.find((s) => s.id === 'listening');
  assert.equal(listening.topic, 'Les Fruits');
  assert.equal(listening.instructions, 'Écoute le dialogue.');
  assert.ok(!('hint' in listening.questions[0]), 'the question model must not carry a hint key');

  const reading = model.sections.find((s) => s.id === 'reading');
  assert.equal(reading.topic, 'La Famille');
  assert.equal(reading.instructions, 'Lis le texte.');
  assert.equal(reading.passage, 'TEXTE DE LECTURE');

  // The passage is an input, not reveal-gated: it must be present both before
  // and after reveal (regression test for the missing reading text).
  const revealedModel = buildRenderModel(sampleWorksheet(), { reveal: true });
  const revealedReading = revealedModel.sections.find((s) => s.id === 'reading');
  assert.equal(revealedReading.passage, 'TEXTE DE LECTURE');

  const revealed = JSON.stringify(revealedModel);
  assert.ok(revealed.includes('SECRET ANSWER'));
  assert.ok(revealed.includes('SECRET EXPLANATION'));
  assert.ok(revealed.includes('SECRET TRANSCRIPT'));
});

test('buildRenderModel falls back to explanation_en and an empty passage for legacy fiches', async () => {
  const { buildRenderModel } = await loadHelpers();
  const legacy = {
    topic: 'x',
    sections: [
      {
        id: 'reading',
        title_fr: 'Lecture',
        explanation_en: 'Ancienne consigne.',
        hint: 'ancien indice',
        questions: [
          { id: 'q1', prompt: 'p', type: 'short_text', hint: 'q hint', answer: 'a', explanation: 'e' }
        ]
      }
    ]
  };
  const model = buildRenderModel(legacy, { reveal: false });
  assert.equal(model.sections[0].instructions, 'Ancienne consigne.');
  assert.equal(model.sections[0].passage, '');
  assert.equal(model.sections[0].topic, '');
  assert.ok(!('hint' in model.sections[0].questions[0]));
});

test('buildRenderModel keeps choice options and never emits an audio script on non-listening sections', async () => {
  const { buildRenderModel } = await loadHelpers();
  const model = buildRenderModel(sampleWorksheet(), { reveal: false });
  const reading = model.sections.find((s) => s.id === 'reading');
  assert.deepEqual(reading.questions[0].options, ['Vrai', 'Faux']);
  assert.equal(reading.audio, undefined);
});

test('isRevealedFromAnswers reads the persisted reveal marker safely', async () => {
  const { isRevealedFromAnswers, REVEAL_KEY } = await loadHelpers();
  assert.equal(isRevealedFromAnswers(null), false);
  assert.equal(isRevealedFromAnswers({ answersByQuestionId: {} }), false);
  assert.equal(isRevealedFromAnswers({ answersByQuestionId: { [REVEAL_KEY]: true } }), true);
  assert.equal(isRevealedFromAnswers({ revealed: true }), true);
});

test('answerControlKind picks the right control per section and question type', async () => {
  const { answerControlKind } = await loadHelpers();
  assert.equal(
    answerControlKind('reading', { type: 'choice', options: ['Vrai', 'Faux'] }),
    'choice'
  );
  assert.equal(answerControlKind('writing', { type: 'short_text' }), 'textarea');
  assert.equal(answerControlKind('reading', { type: 'short_text' }), 'input');
  assert.equal(answerControlKind('translation_grammar', { type: 'fill_blank' }), 'input');
  assert.equal(answerControlKind('translation_grammar', { type: 'translation' }), 'textarea');
});

test('answerControlKind returns form for a writing form before the textarea fallback', async () => {
  const { answerControlKind } = await loadHelpers();
  assert.equal(
    answerControlKind('writing', { type: 'form', fields: [{ label_fr: 'Nom' }] }),
    'form'
  );
  assert.equal(answerControlKind('writing', { type: 'form' }), 'form');
});

test('answerControlKind is defensive about missing sections, questions and types', async () => {
  const { answerControlKind } = await loadHelpers();
  assert.equal(answerControlKind(undefined, undefined), 'textarea');
  assert.equal(answerControlKind('writing', null), 'textarea');
  assert.equal(answerControlKind('reading', {}), 'textarea');
  assert.equal(answerControlKind('reading', { type: 'mystery' }), 'textarea');
  assert.equal(answerControlKind(undefined, { type: 'short_text' }), 'input');
});

test('buildRenderModel maps form field labels before reveal without leaking the answer', async () => {
  const { buildRenderModel } = await loadHelpers();
  const worksheet = {
    topic: 'À l’hôtel',
    sections: [
      {
        id: 'writing',
        title_fr: 'Expression écrite',
        instructions_fr: 'Complète la fiche.',
        questions: [
          {
            id: 'w1',
            prompt: 'Complète ta fiche.',
            type: 'form',
            fields: [
              { label_fr: 'Nom' },
              { label_fr: 'Prénom' },
              { label_fr: '' },
              { nope: true }
            ],
            answer: 'SECRET FORM ANSWER',
            explanation: 'SECRET FORM EXPLANATION'
          },
          {
            id: 'w2',
            prompt: 'Message',
            type: 'short_text',
            fields: [{ label_fr: 'STRAY LABEL' }],
            answer: 'SECRET MESSAGE ANSWER',
            explanation: 'SECRET MESSAGE EXPLANATION'
          }
        ]
      }
    ]
  };

  const model = buildRenderModel(worksheet, { reveal: false });
  const [form, message] = model.sections[0].questions;
  assert.deepEqual(form.fields, [{ label: 'Nom' }, { label: 'Prénom' }]);
  assert.deepEqual(message.fields, [], 'a non-form question never gains labels');

  const serialized = JSON.stringify(model);
  assert.ok(serialized.includes('Nom'));
  assert.ok(!serialized.includes('SECRET FORM ANSWER'));
  assert.ok(!serialized.includes('SECRET FORM EXPLANATION'));
  assert.ok(!serialized.includes('SECRET MESSAGE ANSWER'));
  assert.ok(!serialized.includes('STRAY LABEL'));
});

test('buildRenderModel trims form labels and drops whitespace-only labels', async () => {
  const { buildRenderModel } = await loadHelpers();
  const model = buildRenderModel(
    {
      topic: 'À l’hôtel',
      sections: [
        {
          id: 'writing',
          questions: [
            {
              id: 'w1',
              prompt: 'Complète ta fiche.',
              type: 'form',
              fields: [
                { label_fr: '  Nom  ' },
                { label_fr: '   ' },
                { label_fr: '\tPrénom\n' }
              ],
              answer: 'a',
              explanation: 'e'
            }
          ]
        }
      ]
    },
    { reveal: false }
  );
  assert.deepEqual(model.sections[0].questions[0].fields, [
    { label: 'Nom' },
    { label: 'Prénom' }
  ]);
});

test('buildRenderModel yields empty fields for a legacy question without fields', async () => {
  const { buildRenderModel } = await loadHelpers();
  const model = buildRenderModel(
    {
      topic: 'x',
      sections: [
        {
          id: 'writing',
          questions: [{ id: 'w1', prompt: 'p', type: 'form', answer: 'a', explanation: 'e' }]
        }
      ]
    },
    { reveal: false }
  );
  assert.deepEqual(model.sections[0].questions[0].fields, []);
});

test('feedbackToUi preserves worksheet question order and keeps original adjacent to correction', async () => {
  const { feedbackToUi } = await loadHelpers();
  const feedback = {
    answers: [
      {
        question_id: 'r1',
        original: 'Faux',
        verdict: 'mistake',
        correction: 'Vrai',
        explanation: 'The text says true.',
        error_type: 'error'
      },
      {
        question_id: 'l1',
        original: 'un café',
        verdict: 'correct',
        correction: 'un café',
        explanation: 'Correct.',
        error_type: 'style'
      }
    ],
    summary: { strengths: [], recurring_mistakes: [], priorities: [], follow_up: 'x' }
  };

  const rows = feedbackToUi(feedback, sampleWorksheet());
  // Worksheet order: listening l1 first, then reading r1.
  assert.deepEqual(
    rows.map((r) => r.question_id),
    ['l1', 'r1']
  );

  // Each row carries the original plus its labelled correction fields, so the
  // view can render them immediately after one another.
  const l1 = rows[0];
  assert.equal(l1.original, 'un café');
  assert.equal(l1.verdictLabel, 'Correct');
  assert.equal(l1.correction, 'un café');
  assert.equal(l1.explanation, 'Correct.');
  assert.equal(l1.errorTypeLabel, 'Style');
  assert.equal(l1.score, null, 'choice questions carry no rating');
  assert.equal(l1.maxScore, null);
  assert.equal(l1.hasFeedback, true);

  const r1 = rows[1];
  assert.equal(r1.original, 'Faux');
  assert.equal(r1.verdictLabel, 'Erreur');
  assert.equal(r1.correction, 'Vrai');
  assert.equal(r1.errorTypeLabel, 'Erreur');
  assert.equal(r1.score, null);
  assert.equal(r1.maxScore, null);
});

test('verdict and error-type labels are French only', async () => {
  const { VERDICT_LABELS, ERROR_TYPE_LABELS } = await loadHelpers();
  assert.equal(VERDICT_LABELS.mistake, 'Erreur');
  assert.equal(ERROR_TYPE_LABELS.error, 'Erreur');
  const labels = [...Object.values(VERDICT_LABELS), ...Object.values(ERROR_TYPE_LABELS)].join(' ');
  assert.ok(!/mistake/i.test(labels), 'no English "Mistake" label must remain');
  assert.ok(!/error/i.test(labels), 'no English "Error" label must remain');
});

test('feedbackToUi returns unanswered questions as empty rows with feedback absent', async () => {
  const { feedbackToUi } = await loadHelpers();
  const rows = feedbackToUi({ answers: [] }, sampleWorksheet());
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.hasFeedback === false && r.original === ''));
});

test('feedbackToUi maps integer score and max_score, and null otherwise', async () => {
  const { feedbackToUi } = await loadHelpers();
  const worksheet = {
    sections: [
      {
        id: 'writing',
        questions: [
          { id: 'w4', prompt: 'Message' },
          { id: 'w1', prompt: 'Question' },
          { id: 'w2', prompt: 'Malformed' },
          { id: 'w3', prompt: 'Missing' },
          { id: 'w5', prompt: 'Invalid max' }
        ]
      }
    ]
  };
  const feedback = {
    answers: [
      { question_id: 'w4', original: 'x', verdict: 'correct', correction: 'x', explanation: 'e', error_type: 'style', score: 8, max_score: 10 },
      { question_id: 'w1', original: 'x', verdict: 'correct', correction: 'x', explanation: 'e', error_type: 'style' },
      { question_id: 'w2', original: 'x', verdict: 'correct', correction: 'x', explanation: 'e', error_type: 'style', score: '8', max_score: 10.5 },
      { question_id: 'w3', original: 'x', verdict: 'correct', correction: 'x', explanation: 'e', error_type: 'style' },
      { question_id: 'w5', original: 'x', verdict: 'correct', correction: 'x', explanation: 'e', error_type: 'style', score: 4, max_score: 7 }
    ]
  };
  const rows = feedbackToUi(feedback, worksheet);
  assert.equal(rows[0].score, 8);
  assert.equal(rows[0].maxScore, 10);
  assert.equal(rows[1].score, null);
  assert.equal(rows[1].maxScore, null);
  assert.equal(rows[2].score, null);
  assert.equal(rows[2].maxScore, null);
  assert.equal(rows[3].score, null);
  assert.equal(rows[3].maxScore, null);
  assert.equal(rows[4].score, null, 'max_score 7 is not a valid scale');
  assert.equal(rows[4].maxScore, null);
});

test('feedbackToUi never exposes ratings for choice questions', async () => {
  const { feedbackToUi } = await loadHelpers();
  const worksheet = {
    sections: [
      {
        id: 'reading',
        questions: [{ id: 'q1', prompt: 'Choix', type: 'choice', options: ['a', 'b'] }]
      }
    ]
  };
  const feedback = {
    answers: [
      {
        question_id: 'q1',
        original: 'a',
        verdict: 'correct',
        correction: 'a',
        explanation: 'e',
        error_type: 'style',
        score: 5,
        max_score: 5
      }
    ]
  };
  const [row] = feedbackToUi(feedback, worksheet);
  assert.equal(row.score, null);
  assert.equal(row.maxScore, null);
});

// -- diffWords ---------------------------------------------------------------

test('diffWords returns no runs for an empty original and a deletion for an empty correction', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('', 'Bonjour'), []);
  assert.deepEqual(diffWords('   ', 'Bonjour'), []);
  assert.deepEqual(diffWords('Bonjour', ''), [{ type: 'del', text: 'Bonjour' }]);
});

test('diffWords collapses whitespace and returns one same run when identical', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('  Bonjour   le   monde  ', 'Bonjour le monde'), [
    { type: 'same', text: 'Bonjour le monde' }
  ]);
});

test('diffWords marks a word substitution as a deletion then an insertion', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('Je vais au cafe', 'Je vais au café'), [
    { type: 'same', text: 'Je vais au' },
    { type: 'del', text: 'cafe' },
    { type: 'ins', text: 'café' }
  ]);
});

test('diffWords handles insertions and deletions', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('Je mange une pomme', 'Je mange une belle pomme'), [
    { type: 'same', text: 'Je mange une' },
    { type: 'ins', text: 'belle' },
    { type: 'same', text: 'pomme' }
  ]);
  assert.deepEqual(diffWords('Je mange une belle pomme', 'Je mange une pomme'), [
    { type: 'same', text: 'Je mange une' },
    { type: 'del', text: 'belle' },
    { type: 'same', text: 'pomme' }
  ]);
});

test('diffWords keeps punctuation attached to its word', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('Bonjour, monde.', 'Bonjour, le monde.'), [
    { type: 'same', text: 'Bonjour,' },
    { type: 'ins', text: 'le' },
    { type: 'same', text: 'monde.' }
  ]);
});

test('diffWords compares case and accents exactly', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('Bonjour', 'bonjour'), [
    { type: 'del', text: 'Bonjour' },
    { type: 'ins', text: 'bonjour' }
  ]);
  assert.deepEqual(diffWords('eleve', 'élève'), [
    { type: 'del', text: 'eleve' },
    { type: 'ins', text: 'élève' }
  ]);
});

test('diffWords merges adjacent runs of the same type', async () => {
  const { diffWords } = await loadHelpers();
  assert.deepEqual(diffWords('a b c d', 'a x y d'), [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b c' },
    { type: 'ins', text: 'x y' },
    { type: 'same', text: 'd' }
  ]);
});

test('diffWords is deterministic on ties', async () => {
  const { diffWords } = await loadHelpers();
  const first = diffWords('chat', 'chien');
  assert.deepEqual(first, [
    { type: 'del', text: 'chat' },
    { type: 'ins', text: 'chien' }
  ]);
  assert.deepEqual(diffWords('chat', 'chien'), first);
});

test('diffWords compares normalized Unicode accents as identical', async () => {
  const { diffWords } = await loadHelpers();
  const nfc = 'élève déjà vu';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.deepEqual(diffWords(nfd, nfc), [{ type: 'same', text: nfc }]);
  assert.deepEqual(diffWords(nfc, nfd), [{ type: 'same', text: nfc }]);
});

test('diffWords returns null when either side exceeds 300 words, even if identical', async () => {
  const { diffWords } = await loadHelpers();
  const long = Array.from({ length: 301 }, (_, i) => `mot${i}`).join(' ');
  const other = Array.from({ length: 301 }, (_, i) => `autre${i}`).join(' ');
  assert.equal(diffWords(long, long), null, 'identical inputs over 300 words must return null');
  assert.equal(diffWords(long, other), null);
  assert.equal(diffWords('court', long), null);
  assert.equal(diffWords(long, 'court'), null);
});

test('diffWords processes exactly 300 differing words', async () => {
  const { diffWords } = await loadHelpers();
  const left = Array.from({ length: 300 }, (_, i) => `mot${i}`).join(' ');
  const right = Array.from({ length: 300 }, (_, i) => (i === 299 ? 'autre' : `mot${i}`)).join(' ');
  const runs = diffWords(left, right);
  assert.ok(Array.isArray(runs), 'exactly 300 words must still be diffed');
  assert.ok(runs.some((run) => run.type === 'del' && run.text === 'mot299'));
  assert.ok(runs.some((run) => run.type === 'ins' && run.text === 'autre'));
});

test('deriveUtterances splits dialogue lines by speaker and keeps order', async () => {
  const { deriveUtterances } = await loadHelpers();
  const utterances = deriveUtterances({
    speakers: [
      { name: 'A', voice: 'alloy' },
      { name: 'B', voice: 'verse' }
    ],
    script: 'A: Bonjour !\nB: Salut, ça va ?\nA: Oui, merci.'
  });
  assert.deepEqual(utterances, [
    { speaker: 'A', text: 'Bonjour !' },
    { speaker: 'B', text: 'Salut, ça va ?' },
    { speaker: 'A', text: 'Oui, merci.' }
  ]);
});

test('deriveUtterances assigns dash-prefixed dialogue turns to distinct speakers', async () => {
  const { deriveUtterances } = await loadHelpers();
  const utterances = deriveUtterances({
    speakers: [
      { name: 'Marie', voice: 'alloy' },
      { name: 'Paul', voice: 'verse' }
    ],
    script: '- Bonjour Paul !\n— Salut Marie, ça va ?'
  });
  assert.deepEqual(utterances, [
    { speaker: 'Marie', text: 'Bonjour Paul !' },
    { speaker: 'Paul', text: 'Salut Marie, ça va ?' }
  ]);
});

test('deriveUtterances treats a plain narration as one utterance by the first speaker', async () => {
  const { deriveUtterances } = await loadHelpers();
  const utterances = deriveUtterances({
    speakers: [{ name: 'Narrateur', voice: 'alloy' }],
    script: "Aujourd'hui, il fait beau à Paris."
  });
  assert.deepEqual(utterances, [{ speaker: 'Narrateur', text: "Aujourd'hui, il fait beau à Paris." }]);
});

test('deriveUtterances never loses text and falls back to the raw script', async () => {
  const { deriveUtterances } = await loadHelpers();
  assert.deepEqual(deriveUtterances({ speakers: [{ name: 'A' }], script: '' }), []);
  assert.deepEqual(deriveUtterances(null), []);
  const fallback = deriveUtterances({ speakers: [], script: 'Bonjour le monde' });
  assert.deepEqual(fallback, [{ speaker: 'A', text: 'Bonjour le monde' }]);
});
