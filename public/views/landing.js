// Landing view: choose Chat or Worksheet.

import { historyByWeek, readHistory, thisWeek } from '../lib/scores.js';

function ficheCount(count) {
  return `${count} fiche${count > 1 ? 's' : ''}`;
}

function weekLabel(weekStart) {
  return new Date(weekStart).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

// Build the "Progrès" panel from the score history. Never uses innerHTML:
// every learner/model-derived string (topic) is inserted as text. `now` is
// captured once at mount and reused for both week groupings so they cannot
// straddle a Sunday boundary.
function buildProgressPanel(history, now) {
  const panel = document.createElement('section');
  panel.className = 'summary-card';
  panel.style.maxWidth = '640px';
  panel.style.width = '100%';
  panel.style.textAlign = 'left';

  const title = document.createElement('h3');
  title.textContent = 'Progrès';
  panel.appendChild(title);

  if (!history.entries.length) {
    const empty = document.createElement('p');
    empty.className = 'cache-note';
    empty.textContent =
      'Pas encore de score — envoie une fiche au professeur pour voir ta progression ici.';
    panel.appendChild(empty);
    return panel;
  }

  const current = thisWeek(history, now);
  const thisHeading = document.createElement('h4');
  thisHeading.textContent = 'Cette semaine';
  panel.appendChild(thisHeading);

  if (current.count > 0) {
    const line = document.createElement('p');
    line.textContent = `Moyenne : ${current.average} % (${ficheCount(current.count)})`;
    panel.appendChild(line);

    const list = document.createElement('ul');
    for (const entry of current.entries) {
      const item = document.createElement('li');
      item.textContent = `${entry.topic || 'Fiche'} — ${entry.score} %`;
      list.appendChild(item);
    }
    panel.appendChild(list);
  } else {
    const line = document.createElement('p');
    line.className = 'cache-note';
    line.textContent = 'Pas encore de fiche corrigée cette semaine.';
    panel.appendChild(line);
  }

  const historyHeading = document.createElement('h4');
  historyHeading.textContent = '12 dernières semaines';
  panel.appendChild(historyHeading);

  const weekList = document.createElement('ul');
  for (const bucket of historyByWeek(history, now)) {
    const item = document.createElement('li');
    item.textContent = `Semaine du ${weekLabel(bucket.weekStart)} — ${bucket.average} % (${ficheCount(
      bucket.count
    )})`;
    weekList.appendChild(item);
  }
  panel.appendChild(weekList);

  return panel;
}

export function mount(container, ctx) {
  const landing = document.createElement('section');
  landing.className = 'landing';

  const heading = document.createElement('h2');
  heading.textContent = 'Qu’est-ce qu’on fait aujourd’hui ?';
  landing.appendChild(heading);

  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent =
    'Practice French with a warm AI tutor, or work through an A1 worksheet with listening, reading, grammar and writing.';
  landing.appendChild(lead);

  const notice = document.createElement('div');
  notice.className = 'config-notice';
  notice.hidden = true;
  landing.appendChild(notice);

  const cards = document.createElement('div');
  cards.className = 'landing-cards';

  const choices = [
    {
      icon: '💬',
      title: 'Chat',
      desc: 'Talk in French and get instant corrections plus a follow-up question.',
      cta: 'Commencer à parler →',
      route: '/chat'
    },
    {
      icon: '📝',
      title: 'Fiche d’exercices',
      desc: 'Generate an A1 worksheet, answer it, listen to the audio, and send it to the teacher.',
      cta: 'Créer une fiche →',
      route: '/worksheet'
    }
  ];

  for (const choice of choices) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'landing-card';

    const icon = document.createElement('span');
    icon.className = 'card-icon';
    icon.textContent = choice.icon;

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = choice.title;

    const desc = document.createElement('span');
    desc.className = 'card-desc';
    desc.textContent = choice.desc;

    const cta = document.createElement('span');
    cta.className = 'card-cta';
    cta.textContent = choice.cta;

    card.append(icon, title, desc, cta);
    card.addEventListener('click', () => ctx.navigate(choice.route));
    cards.appendChild(card);
  }

  landing.appendChild(cards);

  // Score history is read once at mount; the router remounts this view on each
  // navigation, so returning to `#/` after sending a fiche shows the update.
  // `now` is captured once and shared by both week groupings below.
  const now = Date.now();
  landing.appendChild(buildProgressPanel(readHistory(ctx.storage, now), now));

  container.appendChild(landing);

  // Honest configuration notice from /health. Never fabricates content.
  let cancelled = false;
  ctx.api
    .health()
    .then((health) => {
      if (cancelled || !health) return;
      const missing = [];
      if (!health.textProviderConfigured) {
        missing.push(`the text provider ("${health.textProvider}") has no API key`);
      } else if (!health.textModelConfigured) {
        missing.push(`the text provider ("${health.textProvider}") has no model configured`);
      }
      if (!health.ttsConfigured) missing.push('OpenAI TTS is not configured (listening audio unavailable)');
      if (missing.length) {
        notice.hidden = false;
        const strong = document.createElement('strong');
        strong.textContent = 'Heads up: ';
        notice.append(
          strong,
          document.createTextNode(
            missing.join('; ') + '. The app will not fabricate content until this is fixed (see README / .env.example).'
          )
        );
      }
    })
    .catch(() => {
      // If /health is unreachable, the views will surface their own errors.
    });

  container.focus?.();

  return () => {
    cancelled = true;
  };
}
