// Hash router + bootstrap.
//
// Routes: `#/` landing, `#/chat` chat, `#/worksheet` worksheet.
// Views are ESM modules exporting `{ mount(container, ctx), destroy?() }`.
// `ctx` exposes navigate/api/storage/audioCache/authHeaders.

import { api, authHeaders } from './lib/api.js';
import { storage } from './lib/storage.js';
import { createAudioCache } from './lib/audio-cache.js';
import { ensureAuthenticated } from './lib/gate.js';
import { mount as mountLanding } from './views/landing.js';

// Views behind the optional APP_PASSWORD gate. Chat wires the gate itself for
// historical parity; the worksheet uses the shared guard so every learning
// view is protected consistently.
const routes = {
  '/': { title: 'Accueil', load: async () => ({ mount: mountLanding }) },
  '/chat': { title: 'Chat', load: () => import('./views/chat.js') },
  '/worksheet': {
    title: 'Fiche',
    gated: true,
    load: () => import('./views/worksheet.js')
  }
};

const audioCache = createAudioCache();

let currentView = null;
let currentCleanup = null;
let currentRoute = null;
let mountToken = 0;
let gateAbort = null;

export function normalizeHash(hash) {
  let path = String(hash || '').replace(/^#/, '');
  if (!path || path === '/') return '/';
  if (!path.startsWith('/')) path = '/' + path;
  return path.replace(/\/+$/, '') || '/';
}

export function navigate(path) {
  const target = path && path.startsWith('#') ? path : '#' + (path || '/');
  if (window.location.hash === target) {
    handleRoute();
  } else {
    window.location.hash = target;
  }
}

function makeCtx() {
  return {
    navigate,
    api,
    storage,
    audioCache,
    authHeaders,
    syncViewportHeight
  };
}

const ctx = makeCtx();

// App-wide mobile viewport sync (used by the chat view's pinToBottom too).
export function syncViewportHeight() {
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty('--vvh', h + 'px');
}

function updateNav(path) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('data-route') === path);
  });
}

async function handleRoute() {
  const path = normalizeHash(window.location.hash);
  const route = routes[path];

  if (!route) {
    navigate('/');
    return;
  }
  if (currentRoute === path && currentView) return;

  const token = ++mountToken;
  if (currentView && typeof currentView.destroy === 'function') {
    try {
      currentView.destroy();
    } catch (err) {
      console.error('view destroy failed:', err);
    }
  }
  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (err) {
      console.error('view cleanup failed:', err);
    }
  }
  currentView = null;
  currentCleanup = null;
  currentRoute = path;

  document.title = `Ooh La Langue — ${route.title}`;
  updateNav(path);

  const container = document.getElementById('view');
  container.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Chargement…';
  container.appendChild(loading);

  let mod;
  try {
    mod = await route.load();
  } catch (err) {
    console.error('failed to load view', path, err);
    container.textContent = '';
    const notice = document.createElement('div');
    notice.className = 'notice error';
    notice.textContent = 'Could not load this view: ' + (err && err.message ? err.message : err);
    container.appendChild(notice);
    return;
  }

  // A newer navigation happened while this module was loading.
  if (token !== mountToken) return;

  // Optional APP_PASSWORD gate for gated views (the server is authoritative).
  if (route.gated) {
    if (gateAbort) gateAbort.abort();
    gateAbort = new AbortController();
    const allowed = await ensureAuthenticated(gateAbort.signal);
    if (token !== mountToken) return;
    if (!allowed) return;
  }

  container.textContent = '';
  try {
    currentView = mod;
    const cleanup = await mod.mount(container, ctx);
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (err) {
    console.error('failed to mount view', path, err);
    container.textContent = '';
    const notice = document.createElement('div');
    notice.className = 'notice error';
    notice.textContent = 'Could not start this view: ' + (err && err.message ? err.message : err);
    container.appendChild(notice);
  }
}

function boot() {
  if (!window.location.hash) {
    window.location.replace('#/');
  }
  syncViewportHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
  } else {
    window.addEventListener('resize', syncViewportHeight);
  }
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

export { routes, audioCache, ctx };
