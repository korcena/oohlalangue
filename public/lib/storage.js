// Versioned, defensive localStorage wrapper.
//
// Rules (design spec §7):
//  - Reads never throw: parse failures fall back to empty/default and are
//    reported via the optional `onIssue` callback.
//  - Writes report success/failure to the caller instead of swallowing errors.
//  - Existing chat keys are preserved byte-for-byte in behaviour.
//  - A schema-version bump may migrate or discard worksheet keys, but never
//    touches chat keys and never crashes.

export const KEYS = Object.freeze({
  NAME: 'oohlalangue_name',
  PASSWORD: 'oohlalangue_password',
  PROFILE: 'oohlalangue_profile',
  ANSWERS: 'oohlalangue_answers',
  PAUSE_UNTIL: 'oohlalangue_pause_until',
  WORKSHEET_CURRENT: 'oohlalangue_worksheet_current',
  WORKSHEET_ANSWERS: 'oohlalangue_worksheet_answers',
  WORKSHEET_FEEDBACK: 'oohlalangue_worksheet_feedback',
  QUOTA_GENERATIONS: 'oohlalangue_quota_generations',
  SCORE_HISTORY: 'oohlalangue_score_history',
  SCHEMA_VERSION: 'oohlalangue_schema_version'
});

export const CURRENT_SCHEMA_VERSION = 1;

// Keys that belong to the chat and must survive any worksheet migration.
export const CHAT_KEYS = [KEYS.NAME, KEYS.PASSWORD, KEYS.PROFILE, KEYS.ANSWERS, KEYS.PAUSE_UNTIL];

// Keys that a version bump is allowed to discard.
export const WORKSHEET_KEYS = [
  KEYS.WORKSHEET_CURRENT,
  KEYS.WORKSHEET_ANSWERS,
  KEYS.WORKSHEET_FEEDBACK,
  KEYS.QUOTA_GENERATIONS,
  KEYS.SCORE_HISTORY
];

// Session keys wiped when the current worksheet is cleared (generation and
// "Nouvelle fiche"). The quota counter and the score history are deliberately
// NOT here: generation must never reset them. They stay in WORKSHEET_KEYS so a
// schema bump can still discard them.
export const WORKSHEET_SESSION_KEYS = [
  KEYS.WORKSHEET_CURRENT,
  KEYS.WORKSHEET_ANSWERS,
  KEYS.WORKSHEET_FEEDBACK
];

function defaultBackend() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch (_e) {
    /* access to localStorage can throw in sandboxed iframes */
  }
  return null;
}

export function createStorage(backend = defaultBackend(), { onIssue = null, autoMigrate = true } = {}) {
  const report = (kind, key, err) => {
    if (typeof onIssue === 'function') onIssue({ kind, key, error: err });
  };

  function readRaw(key) {
    if (!backend) return null;
    try {
      return backend.getItem(key);
    } catch (err) {
      report('read', key, err);
      return null;
    }
  }

  // Returns true on success, false on failure (quota, disabled storage, …).
  function writeRaw(key, value) {
    if (!backend) {
      report('write', key, new Error('localStorage is unavailable'));
      return false;
    }
    try {
      backend.setItem(key, value);
      return true;
    } catch (err) {
      report('write', key, err);
      return false;
    }
  }

  function removeRaw(key) {
    if (!backend) return false;
    try {
      backend.removeItem(key);
      return true;
    } catch (err) {
      report('remove', key, err);
      return false;
    }
  }

  function readJSON(key, fallback) {
    const raw = readRaw(key);
    if (raw == null || raw === '') return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      report('parse', key, err);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    return writeRaw(key, JSON.stringify(value));
  }

  // ---- Schema version / migration ----------------------------------------

  function getSchemaVersion() {
    const raw = readRaw(KEYS.SCHEMA_VERSION);
    if (raw == null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  function migrate() {
    const version = getSchemaVersion();
    if (version === CURRENT_SCHEMA_VERSION) return { migrated: false, discarded: false, version };

    // Unknown/newer-than-supported version: discard only worksheet keys and
    // keep all chat keys, then stamp the current version.
    if (version != null && version > CURRENT_SCHEMA_VERSION) {
      for (const key of WORKSHEET_KEYS) removeRaw(key);
      writeRaw(KEYS.SCHEMA_VERSION, String(CURRENT_SCHEMA_VERSION));
      return { migrated: false, discarded: true, version: CURRENT_SCHEMA_VERSION };
    }

    // Missing or older version: run ordered migrations. There is currently
    // only v1, so this simply stamps the version while preserving chat keys.
    // Future migrations slot in here in ascending order.
    // if (version < 2) { ... }
    writeRaw(KEYS.SCHEMA_VERSION, String(CURRENT_SCHEMA_VERSION));
    return { migrated: true, discarded: false, version: CURRENT_SCHEMA_VERSION };
  }

  // ---- Chat keys (behaviour must match the original inline code) ----------

  function getName() {
    return readRaw(KEYS.NAME) || '';
  }
  function setName(value) {
    const v = value == null ? '' : String(value);
    return v ? writeRaw(KEYS.NAME, v) : removeRaw(KEYS.NAME);
  }

  function getPassword() {
    return readRaw(KEYS.PASSWORD) || '';
  }
  function setPassword(value) {
    const v = value == null ? '' : String(value);
    return v ? writeRaw(KEYS.PASSWORD, v) : removeRaw(KEYS.PASSWORD);
  }

  function getProfile() {
    const parsed = readJSON(KEYS.PROFILE, []);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  }
  function setProfile(list) {
    const arr = Array.isArray(list) ? list.slice(0, 40) : [];
    return writeJSON(KEYS.PROFILE, arr);
  }
  function addProfileFacts(newFacts) {
    if (!newFacts || !newFacts.length) return true;
    const existing = getProfile();
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    for (const f of newFacts) {
      const clean = String(f).replace(/[`<>{}\[\]"]/g, '').trim().slice(0, 120);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(clean);
    }
    return setProfile(existing.slice(-40));
  }

  function getAnswers() {
    return parseInt(readRaw(KEYS.ANSWERS) || '0', 10) || 0;
  }
  function setAnswers(n) {
    return writeRaw(KEYS.ANSWERS, String(n));
  }

  function getPauseUntil() {
    return parseInt(readRaw(KEYS.PAUSE_UNTIL) || '0', 10) || 0;
  }
  function setPauseUntil(ts) {
    if (ts) return writeRaw(KEYS.PAUSE_UNTIL, String(ts));
    return removeRaw(KEYS.PAUSE_UNTIL);
  }

  // ---- Worksheet keys ----------------------------------------------------

  function getCurrentWorksheet() {
    return readJSON(KEYS.WORKSHEET_CURRENT, null);
  }
  function setCurrentWorksheet(worksheet) {
    return writeJSON(KEYS.WORKSHEET_CURRENT, worksheet);
  }

  function getWorksheetAnswers() {
    const parsed = readJSON(KEYS.WORKSHEET_ANSWERS, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const answersByQuestionId =
      parsed.answersByQuestionId && typeof parsed.answersByQuestionId === 'object'
        ? parsed.answersByQuestionId
        : {};
    return {
      answersByQuestionId,
      lastSavedAt: Number.isFinite(parsed.lastSavedAt) ? parsed.lastSavedAt : null
    };
  }
  function setWorksheetAnswers(answersByQuestionId, lastSavedAt = Date.now()) {
    const payload = {
      answersByQuestionId: answersByQuestionId && typeof answersByQuestionId === 'object' ? answersByQuestionId : {},
      lastSavedAt
    };
    return writeJSON(KEYS.WORKSHEET_ANSWERS, payload);
  }

  function getFeedback() {
    return readJSON(KEYS.WORKSHEET_FEEDBACK, null);
  }
  function setFeedback(feedback) {
    return writeJSON(KEYS.WORKSHEET_FEEDBACK, feedback);
  }

  // Weekly generation quota ({ weekStart, count }). Reads never throw; a
  // missing/corrupt value yields null so callers fail open (allow generation).
  function getQuota() {
    return readJSON(KEYS.QUOTA_GENERATIONS, null);
  }
  function setQuota(quota) {
    return writeJSON(KEYS.QUOTA_GENERATIONS, quota);
  }

  // Per-fiche score history ({ version, entries }). Reads never throw; a
  // missing/corrupt value yields null so callers fail open (empty history).
  function getScoreHistory() {
    return readJSON(KEYS.SCORE_HISTORY, null);
  }
  function setScoreHistory(history) {
    return writeJSON(KEYS.SCORE_HISTORY, history);
  }

  function clearCurrentWorksheet() {
    let ok = true;
    for (const key of WORKSHEET_SESSION_KEYS) ok = removeRaw(key) && ok;
    return ok;
  }

  if (autoMigrate) migrate();

  return {
    KEYS,
    CURRENT_SCHEMA_VERSION,
    backend,
    migrate,
    getSchemaVersion,
    getName,
    setName,
    getPassword,
    setPassword,
    getProfile,
    setProfile,
    addProfileFacts,
    getAnswers,
    setAnswers,
    getPauseUntil,
    setPauseUntil,
    getCurrentWorksheet,
    setCurrentWorksheet,
    getWorksheetAnswers,
    setWorksheetAnswers,
    getFeedback,
    setFeedback,
    getQuota,
    setQuota,
    getScoreHistory,
    setScoreHistory,
    clearCurrentWorksheet
  };
}

export const storage = createStorage();
export default storage;
