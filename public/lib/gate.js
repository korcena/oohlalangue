// Shared password/name gate.
//
// The shell (`public/index.html`) owns the gate markup and ids, reused verbatim
// from the original single-file app. `views/chat.js` wires it itself; other
// views (e.g. the worksheet) call `ensureAuthenticated` so an optional
// APP_PASSWORD protects EVERY learning view, not just chat. The server remains
// authoritative (each API call also sends `x-app-password`), so this is a UI
// parity guard, not the security boundary.

import { api } from './api.js';
import { storage } from './storage.js';

// Pure decision helper so the logic is unit-testable without a DOM.
export function isGateSatisfied({ required, hasName, hasPassword, passwordOk }) {
  if (!required) return Boolean(hasName);
  return Boolean(hasName && hasPassword && passwordOk);
}

function getEls() {
  const gateEl = document.getElementById('gate');
  if (!gateEl) return null;
  return {
    gateEl,
    gateForm: document.getElementById('gateForm'),
    gateIntro: gateEl.querySelector('p'),
    gateName: document.getElementById('gateName'),
    gatePassword: document.getElementById('gatePassword'),
    gatePasswordField: document.getElementById('gatePassword').closest('.field'),
    gateSubmit: document.getElementById('gateSubmit'),
    gateError: document.getElementById('gateError')
  };
}

async function verifyStoredPassword() {
  const pw = storage.getPassword();
  if (!pw) return false;
  try {
    const res = await api.verifyPassword(pw);
    return Boolean(res && res.ok);
  } catch (_e) {
    return false;
  }
}

/**
 * Resolve once the learner may proceed. If no password is required and a name
 * exists, resolves immediately. Otherwise shows the gate and waits for a valid
 * submission.
 *
 * @returns {Promise<boolean>} true when the learner may proceed
 */
export async function ensureAuthenticated() {
  let required = false;
  try {
    const data = await api.authRequired();
    required = Boolean(data && data.required);
  } catch (_e) {
    // If the server is unreachable, let the view surface its own error.
    return true;
  }

  const satisfied = isGateSatisfied({
    required,
    hasName: Boolean(storage.getName()),
    hasPassword: Boolean(storage.getPassword()),
    passwordOk: required ? await verifyStoredPassword() : false
  });

  const els = getEls();
  if (satisfied) {
    if (els) els.gateEl.classList.add('hidden');
    return true;
  }
  if (!els) return true; // No gate markup (shouldn't happen) — fail open to the server guard.

  if (required) els.gatePasswordField.style.display = '';
  else els.gatePasswordField.style.display = 'none';
  els.gatePassword.required = required;
  els.gateIntro.textContent = required
    ? 'Enter your name and the password to start practicing.'
    : 'What should we call you?';
  els.gateEl.classList.remove('hidden');
  els.gateError.textContent = '';
  els.gatePassword.value = '';
  els.gateName.value = storage.getName();
  setTimeout(() => (els.gateName.value && required ? els.gatePassword : els.gateName).focus(), 50);

  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      e.preventDefault();
      const name = els.gateName.value.trim().slice(0, 40);
      const pw = els.gatePassword.value.trim();
      if (!name) return;
      if (required && !pw) return;
      els.gateSubmit.disabled = true;
      els.gateError.textContent = '';
      try {
        if (required) {
          let ok = false;
          try {
            const res = await api.verifyPassword(pw);
            ok = Boolean(res && res.ok);
          } catch (_err) {
            ok = false;
          }
          if (!ok) {
            els.gateError.textContent = 'Incorrect password';
            return;
          }
          storage.setPassword(pw);
        }
        storage.setName(name);
        els.gateEl.classList.add('hidden');
        els.gateError.textContent = '';
        els.gateForm.removeEventListener('submit', onSubmit);
        resolve(true);
      } catch (err) {
        els.gateError.textContent = 'Network error: ' + (err && err.message ? err.message : err);
      } finally {
        els.gateSubmit.disabled = false;
      }
    };
    els.gateForm.addEventListener('submit', onSubmit);
  });
}

export default { ensureAuthenticated, isGateSatisfied };
