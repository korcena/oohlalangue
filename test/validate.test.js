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
  WRITING_QUESTION_COUNT,
  RATED_QUESTION_TYPES,
  ratingMaxForQuestion,
  buildRatingMaxMap,
  FEEDBACK_VERDICTS,
  FEEDBACK_ERROR_TYPES
} = require('../server.js');

function readingQuestion(index) {
  return {
    id: `r${index}`,
    prompt: 'Que vend le marchand ?',
    type: 'short_text',
    answer: 'des pommes',
    explanation: 'Il vend des pommes.'
  };
}

function readingQuestions(count = 5) {
  return Array.from({ length: count }, (_, index) => readingQuestion(index + 1));
}

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
          questions: readingQuestions()
        }
      ]
    },
    overrides
  );
}

function listeningQuestion(index) {
  return {
    id: `l${index}`,
    prompt: 'Que demande le client ?',
    type: 'choice',
    options: ['une baguette', 'un café', 'un croissant'],
    answer: 'une baguette',
    explanation: 'Le client demande une baguette.'
  };
}

function listeningQuestions(count = 5) {
  return Array.from({ length: count }, (_, index) => listeningQuestion(index + 1));
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
    questions: listeningQuestions(),
    ...overrides
  };
}

function writingQuestion(index, overrides = {}) {
  return {
    id: `w${index}`,
    prompt: 'Quelle est ta saison préférée ? Réponds en une ou deux phrases complètes.',
    type: 'short_text',
    answer: 'Ma saison préférée est le printemps.',
    explanation: 'On répond avec une ou deux phrases complètes.',
    ...overrides
  };
}

function writingQuestions(count = WRITING_QUESTION_COUNT) {
  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) {
      return writingQuestion(index + 1, {
        prompt: 'Écris un court SMS pour inviter ton ami à dîner (environ 40–50 mots).'
      });
    }
    return writingQuestion(index + 1);
  });
}

function writing(overrides = {}) {
  return {
    id: 'writing',
    title_fr: 'Expression écrite',
    topic_fr: 'La Nourriture',
    instructions_fr:
      'Réponds aux 3 premières questions en une ou deux phrases complètes, puis écris un message de 40 à 50 mots pour la dernière question.',
    questions: writingQuestions(),
    ...overrides
  };
}

test('section id set and generated question types are exactly the allowed values', () => {
  assert.deepEqual(WORKSHEET_SECTION_IDS, ['listening', 'reading', 'translation_grammar', 'writing']);
  assert.deepEqual(QUESTION_TYPES, ['short_text', 'choice', 'fill_blank', 'translation']);
  assert.deepEqual(RATED_QUESTION_TYPES, ['short_text', 'fill_blank', 'translation', 'form']);
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

test('reading requires exactly 5 questions', () => {
  for (const count of [4, 6]) {
    const section = { ...worksheet().sections[0], questions: readingQuestions(count) };
    const result = validateWorksheet(worksheet({ sections: [section] }));
    assert.equal(result.ok, false, `${count} reading questions must fail`);
    assert.ok(
      result.errors.some((e) => /questions must contain exactly 5 questions for the reading section/.test(e)),
      JSON.stringify(result.errors)
    );
  }

  const five = validateWorksheet(worksheet());
  assert.equal(five.ok, true, JSON.stringify(five.errors));
});

test('listening requires exactly 5 questions', () => {
  for (const count of [4, 6]) {
    const result = validateWorksheet(worksheet({ sections: [listening({ questions: listeningQuestions(count) })] }));
    assert.equal(result.ok, false, `${count} listening questions must fail`);
    assert.ok(
      result.errors.some((e) => /questions must contain exactly 5 questions for the listening section/.test(e)),
      JSON.stringify(result.errors)
    );
  }

  const five = validateWorksheet(worksheet({ sections: [listening()] }));
  assert.equal(five.ok, true, JSON.stringify(five.errors));
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

test('a valid writing section with exactly 4 short_text questions passes', () => {
  const result = validateWorksheet(worksheet({ sections: [writing()] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('writing requires exactly 4 questions', () => {
  for (const count of [3, 5]) {
    const section = writing({ questions: writingQuestions(count) });
    const result = validateWorksheet(worksheet({ sections: [section] }));
    assert.equal(result.ok, false, `${count} writing questions must fail`);
    assert.ok(
      result.errors.some((e) =>
        /questions must contain exactly 4 questions for the writing section/.test(e)
      ),
      JSON.stringify(result.errors)
    );
  }
});

test('every writing question must be short_text', () => {
  const bad = writing();
  bad.questions[0].type = 'fill_blank';
  const result = validateWorksheet(worksheet({ sections: [bad] }));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /type must be "short_text" for the writing section/.test(e))
  );
});

test('a generated form question is rejected', () => {
  const bad = writing();
  bad.questions[0] = {
    id: 'w1',
    prompt: 'Complète ta fiche d’inscription.',
    type: 'form',
    answer: 'Nom : Durand.',
    explanation: 'On écrit son nom.'
  };
  const result = validateWorksheet(worksheet({ sections: [bad] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /type must be one of/.test(e)));
  assert.ok(result.errors.some((e) => /type must be "short_text" for the writing section/.test(e)));
});

test('a fields property is rejected on any question, including a form', () => {
  const writingWithFields = writing();
  writingWithFields.questions[0].fields = [{ label_fr: 'Nom' }];
  const writingResult = validateWorksheet(worksheet({ sections: [writingWithFields] }));
  assert.equal(writingResult.ok, false);
  assert.ok(
    writingResult.errors.some((e) => /fields is not allowed; writing answers are free text/.test(e))
  );

  const readingWithFields = worksheet();
  readingWithFields.sections[0].questions[0].fields = [];
  const readingResult = validateWorksheet(readingWithFields);
  assert.equal(readingResult.ok, false);
  assert.ok(
    readingResult.errors.some((e) => /fields is not allowed; writing answers are free text/.test(e))
  );

  const formWithFields = writing();
  formWithFields.questions[0] = {
    id: 'w1',
    prompt: 'Complète ta fiche.',
    type: 'form',
    fields: [{ label_fr: 'Nom' }],
    answer: 'Nom : Durand.',
    explanation: 'On écrit son nom.'
  };
  const formResult = validateWorksheet(worksheet({ sections: [formWithFields] }));
  assert.equal(formResult.ok, false);
  assert.ok(
    formResult.errors.some((e) => /fields is not allowed; writing answers are free text/.test(e))
  );
});

test('writing questions still require a non-empty answer and explanation', () => {
  const bad = writing();
  delete bad.questions[0].answer;
  bad.questions[0].explanation = '   ';
  const result = validateWorksheet(worksheet({ sections: [bad] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /\.answer must be a non-empty string/.test(e)));
  assert.ok(result.errors.some((e) => /\.explanation must be a non-empty string/.test(e)));
});

test('ratingMaxForQuestion rates free responses and leaves choice unrated', () => {
  const writingSection = { id: 'writing' };
  assert.equal(ratingMaxForQuestion(writingSection, { type: 'choice' }, 0, 4), null);
  assert.equal(ratingMaxForQuestion(writingSection, { type: 'short_text' }, 0, 4), 5);
  assert.equal(ratingMaxForQuestion(writingSection, { type: 'short_text' }, 3, 4), 10);
  assert.equal(
    ratingMaxForQuestion({ id: 'reading' }, { type: 'short_text' }, 4, 5),
    5
  );
  assert.equal(
    ratingMaxForQuestion({ id: 'translation_grammar' }, { type: 'fill_blank' }, 0, 4),
    5
  );
  assert.equal(
    ratingMaxForQuestion({ id: 'translation_grammar' }, { type: 'translation' }, 0, 4),
    5
  );
  // Legacy form questions stay out of 5 even when last in the writing section.
  assert.equal(ratingMaxForQuestion(writingSection, { type: 'form' }, 3, 4), 5);
});

test('ratingMaxForQuestion is safe for malformed input', () => {
  for (const question of [null, undefined, 42, 'form', [], {}]) {
    assert.equal(ratingMaxForQuestion({ id: 'writing' }, question, 0, 4), null);
  }
  assert.equal(ratingMaxForQuestion({ id: 'writing' }, { type: 'mystery' }, 0, 4), null);
  assert.equal(ratingMaxForQuestion({}, { type: 'short_text' }, 0, 4), 5);
});

test('buildRatingMaxMap maps every string id, including null for choice', () => {
  const map = buildRatingMaxMap({
    sections: [
      {
        id: 'writing',
        questions: [
          { id: 'w1', type: 'short_text' },
          { id: 'w2', type: 'short_text' },
          { id: 'w3', type: 'short_text' },
          { id: 'w4', type: 'short_text' }
        ]
      },
      {
        id: 'reading',
        questions: [
          { id: 'r1', type: 'choice' },
          { id: 'r2', type: 'short_text' },
          { type: 'short_text' }
        ]
      },
      {
        id: 'writing',
        questions: [{ id: 'legacy', type: 'form' }]
      }
    ]
  });
  assert.equal(map.get('w1'), 5);
  assert.equal(map.get('w4'), 10);
  assert.equal(map.get('r1'), null);
  assert.equal(map.get('r2'), 5);
  assert.equal(map.get('legacy'), 5);
  assert.equal(map.size, 7, 'a question without a string id is ignored');
});

test('buildRatingMaxMap tolerates malformed worksheets', () => {
  for (const value of [null, undefined, 42, 'x', [], {}]) {
    const map = buildRatingMaxMap(value);
    assert.equal(map instanceof Map, true);
    assert.equal(map.size, 0);
  }
  const map = buildRatingMaxMap({ sections: [null, 3, { questions: null }, { id: 'writing', questions: [null, { id: 'w1', type: 'short_text' }] }] });
  assert.equal(map.get('w1'), 10);
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
      {
        question_id: 'r1',
        original: 'x',
        verdict: 'correct',
        correction: 'x',
        explanation: 'y',
        error_type: 'style',
        score: 5,
        max_score: 5
      }
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

function feedbackAnswer(overrides = {}) {
  return {
    question_id: 'w1',
    original: 'Ma réponse.',
    verdict: 'correct',
    correction: 'Ma réponse.',
    explanation: 'Bonne réponse.',
    error_type: 'style',
    ...overrides
  };
}

function feedbackWith(answer) {
  return {
    answers: [answer],
    summary: { strengths: [], recurring_mistakes: [], priorities: [], follow_up: 'next' }
  };
}

function ratingWorksheet() {
  return {
    topic: 'x',
    sections: [
      {
        id: 'writing',
        questions: [
          { id: 'w1', type: 'short_text' },
          { id: 'w2', type: 'short_text' },
          { id: 'w3', type: 'short_text' },
          { id: 'w4', type: 'short_text' }
        ]
      },
      {
        id: 'reading',
        questions: [
          { id: 'r1', type: 'choice' },
          { id: 'r2', type: 'short_text' }
        ]
      }
    ]
  };
}

test('validateFeedback accepts a valid generic score pair', () => {
  assert.equal(validateFeedback(feedbackWith(feedbackAnswer({ score: 4, max_score: 5 }))).ok, true);
  assert.equal(validateFeedback(feedbackWith(feedbackAnswer({ score: 9, max_score: 10 }))).ok, true);
});

test('validateFeedback requires score and max_score together', () => {
  const onlyScore = validateFeedback(feedbackWith(feedbackAnswer({ score: 4 })));
  assert.equal(onlyScore.ok, false);
  assert.ok(onlyScore.errors.some((e) => /provided together/.test(e)));

  const onlyMax = validateFeedback(feedbackWith(feedbackAnswer({ max_score: 5 })));
  assert.equal(onlyMax.ok, false);
  assert.ok(onlyMax.errors.some((e) => /provided together/.test(e)));
});

test('validateFeedback rejects non-integer or out-of-range ratings', () => {
  for (const answer of [
    feedbackAnswer({ score: 4.5, max_score: 5 }),
    feedbackAnswer({ score: 4, max_score: 5.5 }),
    feedbackAnswer({ score: 4, max_score: 7 }),
    feedbackAnswer({ score: 0, max_score: 5 }),
    feedbackAnswer({ score: 6, max_score: 5 })
  ]) {
    assert.equal(validateFeedback(feedbackWith(answer)).ok, false, JSON.stringify(answer));
  }
});

function ratingFeedback(patches = {}) {
  const defaults = {
    w1: { score: 5, max_score: 5 },
    w2: { score: 4, max_score: 5 },
    w3: { score: 3, max_score: 5 },
    w4: { score: 8, max_score: 10 },
    r1: {},
    r2: { score: 5, max_score: 5 }
  };
  return {
    answers: Object.entries(defaults).map(([question_id, rating]) =>
      feedbackAnswer({ question_id, ...rating, ...(patches[question_id] || {}) })
    ),
    summary: { strengths: [], recurring_mistakes: [], priorities: [], follow_up: 'next' }
  };
}

test('validateFeedback accepts a complete worksheet-aware answer set', () => {
  const map = buildRatingMaxMap(ratingWorksheet());
  assert.equal(
    validateFeedback(ratingFeedback(), { ratingMaxByQuestionId: map }).ok,
    true
  );
});

test('validateFeedback rejects unknown, duplicate and missing question ids', () => {
  const map = buildRatingMaxMap(ratingWorksheet());

  const unknown = ratingFeedback();
  unknown.answers.push(feedbackAnswer({ question_id: 'unknown', score: 4, max_score: 5 }));
  const unknownResult = validateFeedback(unknown, { ratingMaxByQuestionId: map });
  assert.equal(unknownResult.ok, false);
  assert.ok(unknownResult.errors.some((e) => /not present in the worksheet/.test(e)));

  const duplicate = ratingFeedback();
  duplicate.answers.push(feedbackAnswer({ question_id: 'w1', score: 4, max_score: 5 }));
  const duplicateResult = validateFeedback(duplicate, { ratingMaxByQuestionId: map });
  assert.equal(duplicateResult.ok, false);
  assert.ok(duplicateResult.errors.some((e) => /duplicates another answer/.test(e)));

  const missing = ratingFeedback();
  missing.answers = missing.answers.filter((answer) => answer.question_id !== 'w2');
  const missingResult = validateFeedback(missing, { ratingMaxByQuestionId: map });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => /missing: w2/.test(e)));
});

test('validateFeedback trims question_id for worksheet lookups', () => {
  const map = buildRatingMaxMap(ratingWorksheet());
  const feedback = ratingFeedback();
  feedback.answers[0].question_id = '  w1  ';
  assert.equal(validateFeedback(feedback, { ratingMaxByQuestionId: map }).ok, true);
});

test('validateFeedback ignores choice scores when the rating map is supplied', () => {
  const map = buildRatingMaxMap(ratingWorksheet());
  const result = validateFeedback(ratingFeedback({ r1: { score: 5, max_score: 5 } }), {
    ratingMaxByQuestionId: map
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validateFeedback rejects missing or out-of-range ratings for rated questions', () => {
  const map = buildRatingMaxMap(ratingWorksheet());

  const missingRatedScore = ratingFeedback();
  const w1 = missingRatedScore.answers.find((answer) => answer.question_id === 'w1');
  delete w1.score;
  delete w1.max_score;
  const missingResult = validateFeedback(missingRatedScore, { ratingMaxByQuestionId: map });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => /required for a rated question/.test(e)));

  const wrongMax = validateFeedback(ratingFeedback({ w4: { score: 5, max_score: 5 } }), {
    ratingMaxByQuestionId: map
  });
  assert.equal(wrongMax.ok, false);
  assert.ok(wrongMax.errors.some((e) => /max_score must be 10/.test(e)));

  const scoreTooHigh = validateFeedback(ratingFeedback({ w4: { score: 11, max_score: 10 } }), {
    ratingMaxByQuestionId: map
  });
  assert.equal(scoreTooHigh.ok, false);
  assert.ok(scoreTooHigh.errors.some((e) => /between 1 and 10/.test(e)));
});

test('validateFeedback rates a legacy form question out of 5', () => {
  const map = buildRatingMaxMap({
    sections: [{ id: 'writing', questions: [{ id: 'legacy', type: 'form' }] }]
  });
  assert.equal(map.get('legacy'), 5);
  assert.equal(
    validateFeedback(feedbackWith(feedbackAnswer({ question_id: 'legacy', score: 4, max_score: 5 })), {
      ratingMaxByQuestionId: map
    }).ok,
    true
  );
  assert.equal(
    validateFeedback(feedbackWith(feedbackAnswer({ question_id: 'legacy', score: 4, max_score: 10 })), {
      ratingMaxByQuestionId: map
    }).ok,
    false
  );
});

test('writing prompts are rejected when they ask for identity or contact details', () => {
  const rejected = [
    'Quel est ton nom ?',
    'Quelle est ta nationalité ?',
    "Comment t'appelles-tu ?",
    "Tu t'appelles comment ?",
    'Quel est ton numéro de téléphone ?'
  ];
  for (const prompt of rejected) {
    const bad = writing();
    bad.questions[0].prompt = prompt;
    const result = validateWorksheet(worksheet({ sections: [bad] }));
    assert.equal(result.ok, false, prompt);
    assert.ok(
      result.errors.some((e) =>
        /prompt must not ask for identity or contact details \(Nom, Prénom, Nationalité, date de naissance, adresse, téléphone, e-mail\)/.test(
          e
        )
      ),
      JSON.stringify(result.errors)
    );
  }

  const accepted = [
    'Quel est ton plat préféré ?',
    'Décris ton week-end.',
    'Décris une personne célèbre : son prénom et sa nationalité.',
    'Quel est le nom de ton animal ?'
  ];
  for (const prompt of accepted) {
    const good = writing();
    good.questions[0].prompt = prompt;
    const result = validateWorksheet(worksheet({ sections: [good] }));
    assert.equal(result.ok, true, `${prompt} → ${JSON.stringify(result.errors)}`);
  }
});
