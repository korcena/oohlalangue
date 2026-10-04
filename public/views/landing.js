// Landing view: choose Chat or Worksheet.

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
