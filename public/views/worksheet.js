// Worksheet view — built in Phase III. This Phase 0 stub keeps the route
// resolvable and the shell navigable without fabricating a worksheet.

export function mount(container) {
  const wrap = document.createElement('section');
  wrap.className = 'worksheet';

  const head = document.createElement('div');
  head.className = 'worksheet-head';
  const h2 = document.createElement('h2');
  h2.textContent = 'Fiche d’exercices';
  head.appendChild(h2);

  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent =
    'The worksheet player (generation, listening audio, autosave and feedback) is built in a later phase. It is not available in this build yet.';

  wrap.append(head, notice);
  container.appendChild(wrap);
}
