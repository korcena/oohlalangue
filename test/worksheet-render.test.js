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
      explanation_en: 'Listen to the dialogue.',
      audio: {
        script: 'SECRET TRANSCRIPT',
        speakers: [{ name: 'A', voice: 'alloy' }],
        cache_key: 'cache-key-1'
      },
      questions: [
        {
          id: 'l1',
          prompt: 'Que veut A ?',
          type: 'short_text',
          answer: 'SECRET ANSWER',
          explanation: 'SECRET EXPLANATION'
        }
      ]
    },
    {
      id: 'reading',
      title_fr: 'Compréhension écrite',
      explanation_en: 'Read the text.',
      questions: [
        { id: 'r1', prompt: 'Vrai ou faux ?', type: 'choice', options: ['Vrai', 'Faux'], answer: 'Vrai', explanation: 'It is true.' }
      ]
    }
  ]
});

test('buildRenderModel hides answers, explanations and the transcript until reveal', async () => {
  const { buildRenderModel } = await loadHelpers();
  const initial = JSON.stringify(buildRenderModel(sampleWorksheet(), { reveal: false }));
  assert.ok(!initial.includes('SECRET ANSWER'));
  assert.ok(!initial.includes('SECRET EXPLANATION'));
  assert.ok(!initial.includes('SECRET TRANSCRIPT'));
  assert.ok(initial.includes('Compréhension orale'));
  assert.ok(initial.includes('Que veut A ?'));

  const revealed = JSON.stringify(buildRenderModel(sampleWorksheet(), { reveal: true }));
  assert.ok(revealed.includes('SECRET ANSWER'));
  assert.ok(revealed.includes('SECRET EXPLANATION'));
  assert.ok(revealed.includes('SECRET TRANSCRIPT'));
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
  assert.equal(l1.hasFeedback, true);

  const r1 = rows[1];
  assert.equal(r1.original, 'Faux');
  assert.equal(r1.verdictLabel, 'Mistake');
  assert.equal(r1.correction, 'Vrai');
  assert.equal(r1.errorTypeLabel, 'Error');
});

test('feedbackToUi returns unanswered questions as empty rows with feedback absent', async () => {
  const { feedbackToUi } = await loadHelpers();
  const rows = feedbackToUi({ answers: [] }, sampleWorksheet());
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.hasFeedback === false && r.original === ''));
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
