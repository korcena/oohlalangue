'use strict';

// Focused tests for the structured-output contract (design spec §9).
// The server's validators are the single source of truth; these exercise
// edge cases around section ids, question types, audio placement and the
// feedback enums.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateWorksheet,
  validateFeedback,
  worksheetAudioKey,
  WORKSHEET_SECTION_IDS,
  QUESTION_TYPES,
  FEEDBACK_VERDICTS,
  FEEDBACK_ERROR_TYPES
} = require('../server.js');

function worksheet(overrides = {}) {
  return Object.assign(
    {
      topic: 'Au marché',
      level: 'A1',
      sections: [
        {
          id: 'reading',
          title_fr: 'Compréhension écrite',
          instructions_fr: 'Lis le texte et réponds.',
          text_fr: 'Le marchand vend des pommes au marché.',
          questions: [
            {
              id: 'r1',
              prompt: 'Que vend le marchand ?',
              type: 'short_text',
              answer: 'des pommes',
              explanation: 'Il vend des pommes.'
            }
          ]
        }
      ]
    },
    overrides
  );
}

function listening(overrides = {}) {
  return {
    id: 'listening',
    title_fr: 'Compréhension orale',
    instructions_fr: 'Écoute et réponds.',
    audio: {
      script: 'Bonjour ! Une baguette, s’il vous plaît.',
      speakers: [{ name: 'Client', voice: 'alloy' }],
      cache_key: ''
    },
    questions: [
      { id: 'l1', prompt: 'Que demande le client ?', type: 'choice', options: ['une baguette', 'un café'], answer: 'une baguette', explanation: 'He asks for a baguette.' }
    ],
    ...overrides
  };
}

test('section id set is exactly the four allowed values', () => {
  assert.deepEqual(WORKSHEET_SECTION_IDS, ['listening', 'reading', 'translation_grammar', 'writing']);
  assert.deepEqual(QUESTION_TYPES, ['short_text', 'choice', 'fill_blank', 'translation']);
});

test('validateWorksheet rejects a non-object', () => {
  assert.equal(validateWorksheet(null).ok, false);
  assert.equal(validateWorksheet([]).ok, false);
  assert.equal(validateWorksheet('nope').ok, false);
});

test('validateWorksheet rejects an unknown section id and reports the reason', () => {
  const bad = worksheet();
  bad.sections[0].id = 'spelling';
  const result = validateWorksheet(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /id must be one of/.test(e)));
});

test('audio is only allowed on the listening section', () => {
  const withAudioOnReading = worksheet();
  withAudioOnReading.sections[0].audio = { script: 'x', speakers: [{ name: 'A', voice: 'a' }] };
  const result = validateWorksheet(withAudioOnReading);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /audio must only appear on the listening section/.test(e)));
});

test('a section missing instructions_fr is rejected', () => {
  const bad = worksheet();
  delete bad.sections[0].instructions_fr;
  const result = validateWorksheet(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /instructions_fr must be a non-empty string/.test(e)));
});

test('text_fr is required and non-empty on the reading section', () => {
  const missing = worksheet();
  delete missing.sections[0].text_fr;
  const missingResult = validateWorksheet(missing);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => /text_fr must be a non-empty string for the reading section/.test(e)));

  const empty = worksheet();
  empty.sections[0].text_fr = '   ';
  const emptyResult = validateWorksheet(empty);
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.errors.some((e) => /text_fr must be a non-empty string for the reading section/.test(e)));
});

test('text_fr is only allowed on the reading section', () => {
  const sec = listening();
  sec.text_fr = 'Du texte interdit ici.';
  const result = validateWorksheet(worksheet({ sections: [sec] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /text_fr must only appear on the reading section/.test(e)));
});

test('a valid reading section with a non-empty text_fr passes', () => {
  const result = validateWorksheet(worksheet());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('listening requires a non-empty script and at least one speaker', () => {
  const sec = listening();
  sec.audio.script = '   ';
  sec.audio.speakers = [];
  const result = validateWorksheet(worksheet({ sections: [sec] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /audio\.script must be a non-empty string/.test(e)));
  assert.ok(result.errors.some((e) => /audio\.speakers must be a non-empty array/.test(e)));
});

test('choice questions require a non-empty options array', () => {
  const sec = listening();
  delete sec.questions[0].options;
  const result = validateWorksheet(worksheet({ sections: [sec] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /options must be a non-empty array for choice/.test(e)));
});

test('every question requires id, prompt, answer and explanation', () => {
  const bad = worksheet();
  bad.sections[0].questions[0] = { id: '', prompt: 'p', type: 'short_text' };
  const result = validateWorksheet(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /\.id must be a non-empty string/.test(e)));
  assert.ok(result.errors.some((e) => /\.answer must be a non-empty string/.test(e)));
  assert.ok(result.errors.some((e) => /\.explanation must be a non-empty string/.test(e)));
});

test('a valid worksheet with a listening section passes', () => {
  const result = validateWorksheet(worksheet({ sections: [listening(), ...worksheet().sections] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('worksheetAudioKey ignores whitespace but distinguishes voice/script', () => {
  const a = worksheetAudioKey('Bonjour  le monde', [{ name: 'A', voice: 'alloy' }]);
  const b = worksheetAudioKey('Bonjour le monde', [{ name: 'A', voice: 'alloy' }]);
  assert.equal(a, b);
  assert.notEqual(a, worksheetAudioKey('Bonjour le monde', [{ name: 'A', voice: 'verse' }]));
});

test('feedback enums are exactly the spec values', () => {
  assert.deepEqual(FEEDBACK_VERDICTS, ['correct', 'mistake', 'alternative']);
  assert.deepEqual(FEEDBACK_ERROR_TYPES, ['error', 'style', 'alternative']);
});

test('validateFeedback rejects an unknown verdict and missing summary fields', () => {
  const feedback = {
    answers: [
      { question_id: 'r1', original: 'x', verdict: 'correct', correction: 'x', explanation: 'y', error_type: 'style' }
    ],
    summary: { strengths: [], recurring_mistakes: [], priorities: [], follow_up: 'next' }
  };
  assert.equal(validateFeedback(feedback).ok, true);

  const badVerdict = JSON.parse(JSON.stringify(feedback));
  badVerdict.answers[0].verdict = 'maybe';
  assert.equal(validateFeedback(badVerdict).ok, false);

  const badType = JSON.parse(JSON.stringify(feedback));
  badType.answers[0].error_type = 'typo';
  assert.equal(validateFeedback(badType).ok, false);

  const badSummary = JSON.parse(JSON.stringify(feedback));
  delete badSummary.summary.follow_up;
  assert.equal(validateFeedback(badSummary).ok, false);
});
