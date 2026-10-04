// Fetch wrapper for `/api/*`.
//
// - Attaches `x-app-password` from the storage module when present.
// - Always returns/throws a normalized, human-readable error message.
// - No provider key is ever read from or written to the DOM.

import { storage } from './storage.js';

export class ApiError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function normalizeErrorMessage(data, fallback = 'Request failed') {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  const err = data.error;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  if (typeof data.message === 'string') return data.message;
  return fallback;
}

export function authHeaders() {
  const pw = storage.getPassword();
  return pw ? { 'x-app-password': pw } : {};
}

// Pure-ish core so it can be unit-tested with an injected fetch.
export async function request(path, options = {}, deps = {}) {
  const { method = 'POST', body, headers = {}, auth = true } = options;
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) throw new ApiError('This browser does not support fetch()', { status: 0 });

  const finalHeaders = Object.assign(
    { 'Content-Type': 'application/json' },
    auth ? authHeaders() : {},
    headers
  );

  let res;
  try {
    res = await fetchImpl(path, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new ApiError('Network error: ' + (err && err.message ? err.message : String(err)), { status: 0 });
  }

  let data = null;
  const raw = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (_e) {
      data = { error: { message: raw } };
    }
  }

  if (!res.ok) {
    throw new ApiError(normalizeErrorMessage(data, `Request failed (${res.status})`), {
      status: res.status,
      data
    });
  }
  return data;
}

function makeApi(deps = {}) {
  return {
    request: (path, options) => request(path, options, deps),
    chat: (payload) => request('/api/chat', { body: payload }, deps),
    generate: (payload) => request('/api/generate', { body: payload }, deps),
    tts: (payload) => request('/api/tts', { body: payload }, deps),
    feedback: (payload) => request('/api/feedback', { body: payload }, deps),
    health: () => request('/health', { method: 'GET' }, deps),
    authRequired: () => request('/api/auth', { method: 'GET' }, deps),
    verifyPassword: (pw) =>
      request('/api/auth', { body: {}, headers: pw ? { 'x-app-password': pw } : {} }, deps),
    authHeaders
  };
}

export const api = makeApi();
export default api;
