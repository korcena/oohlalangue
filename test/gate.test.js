'use strict';

// Unit tests for the shared gate decision helper. The DOM wiring is manual-QA,
// but the gating DECISION (which determines whether any view is blocked) is
// pure and tested here.

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadGate() {
  return import('../public/lib/gate.js');
}

test('no password required: a name alone is enough', async () => {
  const { isGateSatisfied } = await loadGate();
  assert.equal(isGateSatisfied({ required: false, hasName: true, hasPassword: false, passwordOk: false }), true);
  assert.equal(isGateSatisfied({ required: false, hasName: false, hasPassword: false, passwordOk: false }), false);
});

test('password required: name + password + successful verify are all needed', async () => {
  const { isGateSatisfied } = await loadGate();
  assert.equal(isGateSatisfied({ required: true, hasName: true, hasPassword: true, passwordOk: true }), true);
  assert.equal(isGateSatisfied({ required: true, hasName: true, hasPassword: true, passwordOk: false }), false);
  assert.equal(isGateSatisfied({ required: true, hasName: true, hasPassword: false, passwordOk: false }), false);
  assert.equal(isGateSatisfied({ required: true, hasName: false, hasPassword: true, passwordOk: true }), false);
});

test('a stored-but-unverified password does not satisfy a required gate', async () => {
  const { isGateSatisfied } = await loadGate();
  // Simulates a stale/incorrect stored password on a direct #/worksheet visit.
  assert.equal(isGateSatisfied({ required: true, hasName: true, hasPassword: true, passwordOk: false }), false);
});
