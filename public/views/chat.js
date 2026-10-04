// Chat view — ported in Phase II. This Phase 0 stub keeps the route
// resolvable and the shell navigable without pretending the feature exists.

export function mount(container) {
  const wrap = document.createElement('section');
  wrap.className = 'worksheet';

  const head = document.createElement('div');
  head.className = 'worksheet-head';
  const h2 = document.createElement('h2');
  h2.textContent = 'Chat';
  head.appendChild(h2);

  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent =
    'The chat tutor is being ported to this new shell in the next phase. It is not available in this build yet.';

  wrap.append(head, notice);
  container.appendChild(wrap);
}
