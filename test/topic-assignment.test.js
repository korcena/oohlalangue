'use strict';

// Pure helpers for DELF A1 per-section themes. No provider calls and no DOM.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assignSectionTopics,
  summarizeWorksheetTopic,
  CURRICULUM_MODULES
} = require('../server.js');

// Tiny deterministic LCG so the tests never depend on Math.random.
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('assignSectionTopics returns one assignment per section, in input order', () => {
  const ids = ['listening', 'reading', 'translation_grammar', 'writing'];
  const assignments = assignSectionTopics(ids, { rng: seededRng(1) });
  assert.deepEqual(
    assignments.map((a) => a.id),
    ids
  );
  assert.ok(assignments.every((a) => typeof a.module === 'string' && a.module.length > 0));
  assert.ok(assignments.every((a) => typeof a.focus === 'string' && typeof a.hint === 'string'));
});

test('assignSectionTopics picks distinct modules when there are enough', () => {
  const ids = ['listening', 'reading', 'translation_grammar', 'writing'];
  const assignments = assignSectionTopics(ids, { rng: seededRng(42) });
  const names = assignments.map((a) => a.module);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.ok(CURRICULUM_MODULES.some((m) => m.module === name), `${name} must come from the curriculum`);
  }
});

test('assignSectionTopics is deterministic with an injected RNG', () => {
  const ids = ['reading', 'writing'];
  const first = assignSectionTopics(ids, { rng: seededRng(7) });
  const second = assignSectionTopics(ids, { rng: seededRng(7) });
  assert.deepEqual(first, second);
});

test('assignSectionTopics clamps an injected RNG that returns exactly 1', () => {
  const ids = ['listening', 'reading', 'translation_grammar', 'writing'];
  const assignments = assignSectionTopics(ids, { rng: () => 1 });
  assert.equal(assignments.length, ids.length);
  assert.ok(assignments.every((a) => typeof a.module === 'string' && a.module.length > 0));
  assert.equal(new Set(assignments.map((a) => a.module)).size, ids.length);
});

test('assignSectionTopics stays valid with a different RNG sequence', () => {
  const ids = ['listening', 'reading', 'translation_grammar', 'writing'];
  const assignments = assignSectionTopics(ids, { rng: seededRng(99) });
  assert.equal(assignments.length, ids.length);
  assert.equal(new Set(assignments.map((a) => a.module)).size, ids.length);
});

test('assignSectionTopics never mutates the curriculum array', () => {
  const before = JSON.stringify(CURRICULUM_MODULES);
  assignSectionTopics(['listening', 'reading', 'translation_grammar', 'writing'], {
    rng: seededRng(3)
  });
  assert.equal(JSON.stringify(CURRICULUM_MODULES), before);
});

test('assignSectionTopics reshuffles when there are fewer modules than sections', () => {
  const modules = [
    { module: 'Module Un', focus: 'un', hint: 'hint un' },
    { module: 'Module Deux', focus: 'deux', hint: 'hint deux' }
  ];
  const assignments = assignSectionTopics(['a', 'b', 'c', 'd'], {
    rng: seededRng(5),
    modules
  });
  assert.equal(assignments.length, 4);
  for (const assignment of assignments) {
    assert.ok(['Module Un', 'Module Deux'].includes(assignment.module));
  }
  // Each complete cycle exhausts the pool exactly once before duplicates.
  assert.equal(new Set(assignments.slice(0, 2).map((a) => a.module)).size, 2);
  assert.equal(new Set(assignments.slice(2, 4).map((a) => a.module)).size, 2);
});

test('assignSectionTopics handles empty sectionIds and empty modules', () => {
  assert.deepEqual(assignSectionTopics([], { rng: seededRng(1) }), []);
  assert.deepEqual(assignSectionTopics(null, { rng: seededRng(1) }), []);

  const assignments = assignSectionTopics(['listening', 'reading'], {
    rng: seededRng(1),
    modules: []
  });
  assert.deepEqual(assignments, [
    { id: 'listening', module: null, focus: '', hint: '' },
    { id: 'reading', module: null, focus: '', hint: '' }
  ]);
});

test('summarizeWorksheetTopic joins distinct module names with a middle dot', () => {
  assert.equal(
    summarizeWorksheetTopic([{ module: 'Les Fruits' }, { module: 'La Famille' }]),
    'Les Fruits · La Famille'
  );
  assert.equal(
    summarizeWorksheetTopic([
      { module: 'Les Fruits' },
      { module: 'La Famille' },
      { module: 'Les Fruits' }
    ]),
    'Les Fruits · La Famille'
  );
});

test('summarizeWorksheetTopic caps at a whole-module boundary with an ellipsis', () => {
  const summary = summarizeWorksheetTopic(
    [{ module: 'Les Salutations' }, { module: 'Les Jours et Les Mois' }, { module: 'Les Verbes Réfléchis' }]
  );
  assert.ok(summary.length <= 60, `${summary} must fit in 60 characters`);
  assert.equal(summary, 'Les Salutations · Les Jours et Les Mois…');

  assert.equal(
    summarizeWorksheetTopic([{ module: 'Alpha' }, { module: 'Bravo' }, { module: 'Charlie' }], 12),
    'Alpha…'
  );
});

test('summarizeWorksheetTopic keeps an over-long single module whole', () => {
  const longName = 'T'.repeat(80);
  const summary = summarizeWorksheetTopic([{ module: longName }]);
  assert.equal(summary, longName, 'a single over-long module must not be sliced mid-word');
  assert.ok(!summary.endsWith('…'));
});

test('summarizeWorksheetTopic falls back for empty input', () => {
  assert.equal(summarizeWorksheetTopic([]), 'Thèmes variés (A1)');
  assert.equal(summarizeWorksheetTopic(undefined), 'Thèmes variés (A1)');
  assert.equal(summarizeWorksheetTopic([{ module: null }, { module: '  ' }]), 'Thèmes variés (A1)');
});
