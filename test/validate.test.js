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
          topic_fr: 'La Famille',
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
    topic_fr: 'Les Fruits',
    instructions_fr: 'Écoute et réponds.',
    audio: {
      script: 'Bonjour ! Une baguette, s’il vous plaît.',
      speakers: [{ name: 'Client', voice: 'alloy' }],
      cache_key: ''
    },
    questions: [
      {
        id: 'l1',
        prompt: 'Que demande le client ?',
        type: 'choice',
        options: ['une baguette', 'un café', 'un croissant'],
        answer: 'une baguette',
        explanation: 'Le client demande une baguette.'
      }
    ],
    ...overrides
  };
}

function formQuestion(overrides = {}) {
  return {
    id: 'w1',
    prompt: 'Tu arrives à l’hôtel. Complète ta fiche d’inscription.',
    type: 'form',
    fields: [
      { label_fr: 'Nom' },
      { label_fr: 'Prénom' },
      { label_fr: 'Nationalité' },
      { label_fr: 'Date d’arrivée' },
      { label_fr: 'Date de départ' }
    ],
    answer: 'Nom : Durand ; Prénom : Marie ; Nationalité : française.',
    explanation: 'On écrit les informations personnelles et les dates du séjour.',
    ...overrides
  };
}

function writing(overrides = {}) {
  return {
    id: 'writing',
    title_fr: 'Expression écrite',
    topic_fr: 'La Nourriture',
    instructions_fr: 'Complète la fiche et réponds au message.',
    questions: [
      formQuestion(),
      {
        id: 'w2',
        prompt: 'Ton ami t’invite à dîner. Réponds en environ 40–50 mots.',
        type: 'short_text',
        answer: 'Merci pour ton invitation ! Je viens avec plaisir.',
        explanation: 'La réponse accepte l’invitation.'
      }
    ],
    ...overrides
  };
}

test('section id set is exactly the four allowed values', () => {
  assert.deepEqual(WORKSHEET_SECTION_IDS, ['listening', 'reading', 'translation_grammar', 'writing']);
  assert.deepEqual(QUESTION_TYPES, ['short_text', 'choice', 'fill_blank', 'translation', 'form']);
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

test('every section requires a non-empty French topic_fr', () => {
  const missing = worksheet();
  delete missing.sections[0].topic_fr;
  const missingResult = validateWorksheet(missing);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => /topic_fr must be a non-empty string/.test(e)));

  const empty = worksheet();
  empty.sections[0].topic_fr = '   ';
  const emptyResult = validateWorksheet(empty);
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.errors.some((e) => /topic_fr must be a non-empty string/.test(e)));
});

test('listening questions must be multiple choice', () => {
  const sec = listening();
  sec.questions[0].type = 'short_text';
  const result = validateWorksheet(worksheet({ sections: [sec] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /type must be "choice" for the listening section/.test(e)));
});

test('listening choice questions require exactly 3 options', () => {
  const two = listening();
  two.questions[0].options = ['une baguette', 'un café'];
  const twoResult = validateWorksheet(worksheet({ sections: [two] }));
  assert.equal(twoResult.ok, false);
  assert.ok(
    twoResult.errors.some((e) => /options must contain exactly 3 options for the listening section/.test(e))
  );

  const four = listening();
  four.questions[0].options = ['une baguette', 'un café', 'un croissant', 'un jus'];
  const fourResult = validateWorksheet(worksheet({ sections: [four] }));
  assert.equal(fourResult.ok, false);
  assert.ok(
    fourResult.errors.some((e) => /options must contain exactly 3 options for the listening section/.test(e))
  );
});

test('a valid writing section with one form and one short_text passes', () => {
  const result = validateWorksheet(worksheet({ sections: [writing()] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('a writing section with only short_text fails the composition rule', () => {
  const onlyMessage = writing({
    questions: [
      {
        id: 'w1',
        prompt: 'Réponds au message.',
        type: 'short_text',
        answer: 'Merci !',
        explanation: 'On répond au message.'
      }
    ]
  });
  const result = validateWorksheet(worksheet({ sections: [onlyMessage] }));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      /must contain exactly one "form" question and at least one "short_text" question/.test(e)
    )
  );
});

test('writing questions must be short_text or form', () => {
  const bad = writing();
  bad.questions[0].type = 'fill_blank';
  const result = validateWorksheet(worksheet({ sections: [bad] }));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /type must be "short_text" or "form" for the writing section/.test(e))
  );
});

test('a form question outside the writing section is rejected', () => {
  const bad = worksheet();
  bad.sections[0].questions = [formQuestion()];
  const result = validateWorksheet(bad);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /type "form" is only allowed in the writing section/.test(e))
  );
});

test('form questions require a non-empty fields array', () => {
  const missing = writing();
  delete missing.questions[0].fields;
  const missingResult = validateWorksheet(worksheet({ sections: [missing] }));
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.errors.some((e) => /fields must be a non-empty array for form questions/.test(e))
  );

  const empty = writing();
  empty.questions[0].fields = [];
  const emptyResult = validateWorksheet(worksheet({ sections: [empty] }));
  assert.equal(emptyResult.ok, false);
  assert.ok(
    emptyResult.errors.some((e) => /fields must be a non-empty array for form questions/.test(e))
  );
});

test('form fields must be objects with a non-empty label_fr', () => {
  const notObject = writing();
  notObject.questions[0].fields = [null];
  const notObjectResult = validateWorksheet(worksheet({ sections: [notObject] }));
  assert.equal(notObjectResult.ok, false);
  assert.ok(
    notObjectResult.errors.some((e) => /\.fields\[0\] must be an object/.test(e))
  );

  const blankLabel = writing();
  blankLabel.questions[0].fields = [{ label_fr: '   ' }];
  const blankResult = validateWorksheet(worksheet({ sections: [blankLabel] }));
  assert.equal(blankResult.ok, false);
  assert.ok(
    blankResult.errors.some((e) => /\.fields\[0\]\.label_fr must be a non-empty string/.test(e))
  );

  const missingLabel = writing();
  missingLabel.questions[0].fields = [{ other: 'Nom' }];
  const missingResult = validateWorksheet(worksheet({ sections: [missingLabel] }));
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.errors.some((e) => /\.fields\[0\]\.label_fr must be a non-empty string/.test(e))
  );
});

test('fields are only allowed on form questions', () => {
  const bad = worksheet();
  bad.sections[0].questions[0].fields = [{ label_fr: 'Nom' }];
  const result = validateWorksheet(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /fields must only appear on form questions/.test(e)));

  const nullFields = worksheet();
  nullFields.sections[0].questions[0].fields = null;
  const nullResult = validateWorksheet(nullFields);
  assert.equal(nullResult.ok, false);
  assert.ok(
    nullResult.errors.some((e) => /fields must only appear on form questions/.test(e))
  );
});

test('form questions still require a non-empty answer and explanation', () => {
  const bad = writing();
  delete bad.questions[0].answer;
  bad.questions[0].explanation = '   ';
  const result = validateWorksheet(worksheet({ sections: [bad] }));
  assert.equal(result.ok, false);
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
