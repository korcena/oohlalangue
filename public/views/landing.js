// Landing view: choose Chat or Worksheet.

import { buildScoreSeries } from '../lib/chart.js';
import { historyByWeek, readHistory, thisWeek } from '../lib/scores.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function ficheCount(count) {
  return `${count} fiche${count > 1 ? 's' : ''}`;
}

function weekLabel(weekStart) {
  return new Date(weekStart).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

function svgElement(tag, className) {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

// French accessible summary of the trend. Only numbers, week dates and fiche
// counts are added; no learner/model-derived text.
function chartAriaLabel(series) {
  const points = series.points;
  if (!points.length) return 'Évolution du score moyen hebdomadaire.';
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length === 1) {
    return `Score moyen de ${first.average} % pour la semaine du ${weekLabel(first.weekStart)}.`;
  }
  const delta = last.average - first.average;
  const trend = Math.abs(delta) <= 2 ? 'stable' : delta > 2 ? 'en progression' : 'en baisse';
  return (
    `Évolution du score moyen hebdomadaire, ${trend} : ` +
    `de ${first.average} % (semaine du ${weekLabel(first.weekStart)}) ` +
    `à ${last.average} % (semaine du ${weekLabel(last.weekStart)}), ` +
    `sur ${points.length} semaines avec des fiches.`
  );
}

// Inline SVG built exclusively with createElementNS/setAttribute/textContent.
// The exact 12-week list below the chart stays the accessible fallback.
function buildScoreChart(series) {
  const svg = svgElement('svg', 'score-chart');
  svg.setAttribute('viewBox', `0 0 ${series.width} ${series.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', chartAriaLabel(series));
  svg.setAttribute('focusable', 'false');

  const grid = svgElement('g', 'score-chart-grid');
  grid.setAttribute('aria-hidden', 'true');
  const labels = svgElement('g', 'score-chart-labels');
  labels.setAttribute('aria-hidden', 'true');

  for (const gridline of series.gridlines) {
    const line = svgElement('line', 'score-chart-grid-line');
    line.setAttribute('x1', series.plot.left);
    line.setAttribute('x2', series.plot.right);
    line.setAttribute('y1', gridline.y);
    line.setAttribute('y2', gridline.y);
    grid.appendChild(line);

    const label = svgElement('text', 'score-chart-label');
    label.setAttribute('x', series.plot.left - 6);
    label.setAttribute('y', gridline.y);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = String(gridline.value);
    labels.appendChild(label);
  }

  svg.append(grid, labels);

  if (series.polyline) {
    const polyline = svgElement('polyline', 'score-chart-line');
    polyline.setAttribute('points', series.polyline);
    polyline.setAttribute('fill', 'none');
    svg.appendChild(polyline);
  }

  const dots = svgElement('g', 'score-chart-dots');
  for (const point of series.points) {
    const dot = svgElement('circle', 'score-chart-dot');
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    dot.setAttribute('r', '3.5');
    const title = svgElement('title');
    title.textContent = `Semaine du ${weekLabel(point.weekStart)} — ${point.average} % (${ficheCount(
      point.count
    )})`;
    dot.appendChild(title);
    dots.appendChild(dot);
  }
  svg.appendChild(dots);

  return svg;
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

  // One bucket list for both the chart and the exact list below it.
  const buckets = historyByWeek(history, now);
  const series = buildScoreSeries(buckets);
  if (!series.empty) {
    const evolutionHeading = document.createElement('h4');
    evolutionHeading.textContent = 'Évolution';
    panel.append(evolutionHeading, buildScoreChart(series));
  }

  historyHeading.textContent = '12 dernières semaines';
  panel.appendChild(historyHeading);

  const weekList = document.createElement('ul');
  for (const bucket of buckets) {
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
    'Entraîne-toi à parler français avec un tuteur IA bienveillant, ou fais une fiche A1 avec compréhension orale, compréhension écrite, grammaire et expression écrite.';
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
      desc: 'Parle en français et reçois des corrections immédiates, plus une question de suivi.',
      cta: 'Commencer à parler →',
      route: '/chat'
    },
    {
      icon: '📝',
      title: 'Fiche d’exercices',
      desc: 'Génère une fiche A1, réponds aux questions, écoute l’audio et envoie-la au professeur.',
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
        missing.push(`le fournisseur de texte (« ${health.textProvider} ») n’a pas de clé API`);
      } else if (!health.textModelConfigured) {
        missing.push(`le fournisseur de texte (« ${health.textProvider} ») n’a pas de modèle configuré`);
      }
      if (!health.ttsConfigured) {
        missing.push('La synthèse vocale OpenAI n’est pas configurée (audio de compréhension orale indisponible)');
      }
      if (missing.length) {
        notice.hidden = false;
        const strong = document.createElement('strong');
        strong.textContent = 'Attention : ';
        notice.append(
          strong,
          document.createTextNode(
            missing.join('; ') +
              '. L’application ne fabriquera pas de contenu tant que ce n’est pas corrigé (voir README / .env.example).'
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
