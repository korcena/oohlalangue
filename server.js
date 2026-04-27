require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

// Constant-time string compare to avoid leaking password length via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkPassword(req) {
  if (!APP_PASSWORD) return true; // gate disabled
  const supplied = req.get('x-app-password') || (req.body && req.body.password) || '';
  return supplied && safeEqual(supplied, APP_PASSWORD);
}

// Keep the student's name safe for a system-prompt interpolation: trim,
// drop control characters, strip anything that looks like prompt-injection
// markup, and cap the length.
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  name = name.replace(/[`<>{}\[\]"]/g, '');
  if (name.length > 40) name = name.slice(0, 40).trim();
  return name;
}

// A1 curriculum modules. Each session the server picks ONE at random and
// tells the teacher to focus the conversation around it — the student
// practices concrete grammar/vocab that actually appear in the lessons,
// instead of generic "how was your day" chatter every time.
const CURRICULUM_MODULES = [
  {
    module: 'Les Salutations',
    focus: 'formal vs informal greetings and "comment ça va"',
    hint: 'Salut / Bonjour, Ça va ? / Comment allez-vous ?'
  },
  {
    module: 'Les Nombres',
    focus: 'numbers 0–100 (age, phone, quantities)',
    hint: 'Quel âge as-tu ? Tu as combien de frères ?'
  },
  {
    module: 'Les Jours et Les Mois',
    focus: 'days of the week (lowercase!) and months',
    hint: 'Quel jour on est aujourd\'hui ? En quel mois tu es né(e) ?'
  },
  {
    module: 'Les Fruits',
    focus: 'fruits with correct gender (le/la/un/une)',
    hint: 'Quel est ton fruit préféré ? Tu manges une pomme ou une banane ?'
  },
  {
    module: 'La Famille',
    focus: 'family vocabulary + possessives (mon/ma/mes)',
    hint: 'Tu as des frères et sœurs ? Comment s\'appelle ta mère ?'
  },
  {
    module: 'Le Verbe ÊTRE',
    focus: 'être in present ("je suis…"); optionally c\'est / c\'était',
    hint: 'Tu es de quelle nationalité ? C\'est comment chez toi ?'
  },
  {
    module: 'Les Verbes Réfléchis',
    focus: 'SE verbs: se lever, s\'appeler, se promener',
    hint: 'À quelle heure tu te lèves ? Comment tu t\'appelles ?'
  },
  {
    module: 'Les Verbes Communs',
    focus: 'irregular verbs (aller, avoir, faire, prendre, vouloir) — conjugate after "je", NOT the infinitive',
    hint: 'Où tu vas ce week-end ? Qu\'est-ce que tu prends au café ?'
  },
  {
    module: 'Les Pays',
    focus: 'countries with en / au / aux',
    hint: 'Tu habites en France ? Tu voudrais aller au Japon ?'
  },
  {
    module: 'Les Articles',
    focus: 'partitive articles du / de la / de l\' (food and drinks); "de" after negation',
    hint: 'Tu bois du café le matin ? Tu manges de la salade ?'
  },
  {
    module: 'La Position',
    focus: 'prepositions of place: dans, sur, sous, devant, derrière, à côté de, près de, chez',
    hint: 'Où est ton téléphone ? Tu habites près de la gare ?'
  },
  {
    module: 'Le Temps',
    focus: 'time expressions: depuis, il y a, avant, après, pendant',
    hint: 'Depuis quand tu apprends le français ?'
  },
  {
    module: 'La Direction',
    focus: 'directional prepositions à / au / aux / de / vers; contractions à+le=au, de+le=du',
    hint: 'Comment tu vas au travail le matin ?'
  },
  {
    module: 'Poser une Question',
    focus: 'question words qui / quoi / quand / où / comment / pourquoi / combien',
    hint: 'Answer short questions, then invite them to ask ONE back.'
  },
  {
    module: 'Les Loisirs',
    focus: 'hobbies with jouer à (sports) vs jouer de (instruments)',
    hint: 'Tu joues au foot ? Tu joues de la guitare ?'
  },
  {
    module: 'Les Possessifs',
    focus: 'mon/ma/mes, ton/ta/tes, son/sa/ses',
    hint: 'Comment s\'appelle ton meilleur ami ? Où est ta maison ?'
  },
  {
    module: 'Les Lieux',
    focus: 'places in the city (boulangerie, poste, supermarché) + prepositions',
    hint: 'Tu vas souvent à la boulangerie ?'
  },
  {
    module: 'Les Adjectifs',
    focus: 'adjective agreement (m/f) and the BAGS rule (beau, âge, bon, grand before noun)',
    hint: 'Décris ta maison en trois mots. Comment est ton meilleur ami ?'
  },
  {
    module: 'IL Y A',
    focus: 'il y a (there is/are), il n\'y a pas de, il y a + time (ago)',
    hint: 'Qu\'est-ce qu\'il y a dans ton sac ?'
  },
  {
    module: 'La Vie Quotidienne',
    focus: 'café / restaurant vocabulary and drinks',
    hint: 'Qu\'est-ce que tu prends au café ? Tu préfères le thé ou le café ?'
  },
  {
    module: 'Les Métiers',
    focus: 'jobs — no article after être ("je suis professeur"); chez + person',
    hint: 'Qu\'est-ce que tu fais dans la vie ? Tu vas souvent chez le médecin ?'
  },
  {
    module: 'La Météo',
    focus: 'weather always with il: il fait, il pleut, il neige, il y a du vent',
    hint: 'Quel temps fait-il aujourd\'hui chez toi ?'
  },
  {
    module: 'La Fréquence',
    focus: 'frequency: toujours, souvent, parfois, rarement, ne…jamais; aussi goes AFTER the verb',
    hint: 'Tu fais souvent du sport ? Tu manges toujours à la maison ?'
  },
  {
    module: 'Les Nombres Ordinaux',
    focus: 'ordinals and floors (premier, deuxième…; rez-de-chaussée)',
    hint: 'Tu habites à quel étage ?'
  },
  {
    module: 'Le Passé Composé',
    focus: 'passé composé — avoir for most, être for DR MRS VANDERTRAMP verbs + all SE verbs; feminine adds -e',
    hint: 'Qu\'est-ce que tu as fait hier ? Tu es allé(e) où ce week-end ?'
  },
  {
    module: 'Le Fonctionnement',
    focus: 'intensity adverbs: très, trop, assez, vraiment, beaucoup, un peu',
    hint: 'Tu aimes beaucoup le chocolat ? Le film était très long ?'
  },
  {
    module: 'Les Voies',
    focus: 'streets & waterways: rue, avenue, boulevard, pont, quai, place, impasse',
    hint: 'Tu habites dans quelle rue ? Il y a une belle place près de chez toi ?'
  },
  {
    module: 'Les Parties de la Ville',
    focus: 'city parts: centre-ville, banlieue, quartier résidentiel / commercial, zone piétonne',
    hint: 'Tu habites en centre-ville ou en banlieue ?'
  },
  {
    module: 'Les Lieux et les Monuments',
    focus: 'public buildings (mairie, gare, commissariat, banque) and monuments',
    hint: 'Il y a une mairie dans ton quartier ? Tu as visité un monument récemment ?'
  },
  {
    module: 'Le Transport',
    focus: 'vehicles (scooter, vélo, trottinette, bus, tram, métro, voiture, avion, bateau) + movement verbs (se déplacer, monter, marcher) + navigation (tourner à droite/gauche, aller tout droit, au bout de la rue)',
    hint: 'Comment tu te déplaces pour aller au travail ? Tu prends le bus ou le métro ?'
  },
  {
    module: 'Les Distances et le Covoiturage',
    focus: 'which transport for which distance (1 km → marche, 2 km → vélo, 30+ km → voiture/bus); un trajet, un itinéraire, un arrêt, un quai; économiser, le covoiturage, une appli',
    hint: 'C\'est loin, ton travail ? Tu fais du covoiturage ?'
  },
  {
    module: 'L\'Impératif',
    focus: 'imperative for TU/VOUS/NOUS (no subject pronoun, TU form drops -s for -ER verbs); irregulars: sois/soyez, aie/ayez, va/allez; connectors: pour, parce que, mais, avec, sans, ne…que, pendant',
    hint: 'Va tout droit ! Soyez patients ! Allons au café !'
  },
  {
    module: 'Les Pas et Les Étapes',
    focus: 'step distinctions: les pas (walking steps), une étape (process step), une marche (stair step)',
    hint: 'Combien de pas tu fais par jour ? Quelles sont les étapes pour faire un gâteau ?'
  },
  {
    module: 'La Nourriture',
    focus: 'meals (le petit-déjeuner, un petit repas) + vegetables/fruits with gender: le poireau, la poire, la citrouille, le haricot (rouge/vert/blanc/noir), le maïs, l\'ail, le piment, la pastèque, le pamplemousse',
    hint: 'Qu\'est-ce que tu manges au petit-déjeuner ? Tu aimes la pastèque ?'
  },
  {
    module: 'La Routine et les Descriptions',
    focus: 'reflexive verbs for daily routine (se lever, se dépêcher, se marier); descriptors: retraité(e), bruyant, court/long, droitier/gaucher/ambidextre',
    hint: 'À quelle heure tu te lèves le matin ? Tu es droitier ou gaucher ?'
  },
  {
    module: 'La Météo Avancée',
    focus: 'weather + nature: la pluie / il pleut, le tonnerre / il y a de l\'orage, le soleil; para- words: parachute, parapente, parasol, paratonnerre; un cerveau',
    hint: 'Il y a de l\'orage aujourd\'hui ? Tu as déjà fait du parapente ?'
  },
  {
    module: 'Les Verbes Clés',
    focus: 'prendre (full conjugation: je prends, tu prends, il prend, nous prenons, vous prenez, ils prennent), devoir, apporter, économiser, voyager',
    hint: 'Qu\'est-ce que tu prends le matin ? Tu dois travailler demain ?'
  },
  {
    module: 'Les Expressions Idiomatiques',
    focus: 'idioms: peu m\'importe, je suis au bord du gouffre, c\'est la fin des haricots, tu as besoin d\'un verre, tu sens bon; use in context',
    hint: 'Peu m\'importe ! C\'est la fin des haricots !'
  }
];

// Full curriculum summary — included once in the system prompt so Claude
// has awareness of what the student is learning and can pull follow-ups
// from neighboring modules when natural. Kept short to control tokens.
const CURRICULUM_SUMMARY =
  'A1 curriculum covers: salutations, alphabet/accents, subject+reflexive pronouns, nombres 0–100, jours (lowercase)/mois, fruits w/ gender, être (present/PC/imparfait), famille+possessifs, verbes réfléchis (SE), verbes communs (aller, avoir, faire, prendre…), pays+en/au/aux, articles (le/un/du), prépositions de position (dans, sur, chez…), expressions de temps (depuis, il y a, avant, après), direction (à/au/aux, de/du), poser une question, loisirs (jouer à/de), possessifs (mon/ma/mes), lieux en ville, adjectifs+BAGS, il y a, café/restaurant, métiers (être + profession sans article; chez + personne), météo (il fait…, il pleut, orage, tonnerre, para- words), fréquence (toujours, souvent, jamais; aussi après le verbe), nombres ordinaux, passé composé (avoir/être, DR MRS VANDERTRAMP, accord féminin), adverbes d\'intensité (très, trop, assez), voies (rue/avenue/boulevard/pont/quai), parties de la ville, monuments et bâtiments publics, transport (vélo/bus/métro/voiture/avion, se déplacer, trajet, itinéraire, arrêt, quai, monter, marcher, tourner, tout droit), distances+covoiturage+économiser, l\'impératif (TU/VOUS/NOUS sans pronom, -ER perd le -s; sois/aie/va; pour/parce que/mais/avec/sans/ne…que/pendant), pas/étape/marche, nourriture (petit-déjeuner, poireau, poire, citrouille, haricots, maïs, ail, piment, pastèque, pamplemousse), routine+descriptions (se lever/se dépêcher/se marier, retraité, bruyant, court/long, droitier/gaucher/ambidextre), verbes clés (prendre conjugué, devoir, apporter, économiser, voyager), expressions idiomatiques (peu m\'importe, au bord du gouffre, la fin des haricots, tu sens bon).';

const GREETINGS = ['Bonjour', 'Salut', 'Coucou', 'Hé'];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Sanitize a single known-fact string from the client-side profile before
// interpolating it into the system prompt. Same hygiene as the name.
function sanitizeFact(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  s = s.replace(/[`<>{}\[\]"]/g, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

function sanitizeProfile(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const clean = sanitizeFact(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 40) break;
  }
  return out;
}

// `isOpening` is true when this is the very first turn of a new session.
// `skipQuestion` is true on the final answer before a scheduled pause — the
// teacher corrects the answer but does NOT ask a new question that the
// student would be locked out of for 3 hours.
function buildSystemPrompt(rawName, isOpening, profile, skipQuestion) {
  const name = sanitizeName(rawName) || 'the student';
  const mod = pickRandom(CURRICULUM_MODULES);
  const greeting = pickRandom(GREETINGS);

  let openingBlock;
  if (skipQuestion) {
    openingBlock = `THIS IS THE FINAL ANSWER OF THE CURRENT SESSION. After your correction block, do NOT ask a new question. Instead add ONE short warm English line telling ${name} they've reached the 5-answer session limit and can come back in a bit — invite them to review the corrections above while they wait.`;
  } else if (isOpening) {
    openingBlock = `FIRST TURN: Greet ${name} in French with "${greeting} ${name} !" (or a similar warm variation) and ask ONE short A1 question that exercises "${mod.module}" — ${mod.focus}. Inspiration (do NOT copy verbatim): "${mod.hint}". 1–2 sentences total.`;
  } else {
    openingBlock = `Today's focus module is "${mod.module}" (${mod.focus}). When picking the next question, prefer one that exercises this area, but stay natural — drift to neighbouring modules if the conversation calls for it.`;
  }

  const facts = sanitizeProfile(profile);
  const profileBlock = facts.length
    ? `KNOWN ABOUT ${name.toUpperCase()} (use these to personalize questions; reference them naturally):\n- ${facts.join('\n- ')}`
    : `KNOWN ABOUT ${name.toUpperCase()}: (nothing yet — ask light questions to get to know them)`;

  const questionStep = skipQuestion
    ? `3. Do NOT ask a new question this turn.`
    : `3. Ask ONE new simple A1 question — personalize it with what you know about ${name} when relevant.`;

  return `You are a warm, playful French teacher helping ${name}, an A1 beginner, practice French. Address ${name} by name naturally.

EACH TURN (after the first):
1. React briefly in English (one short line).
2. Then use these exact markers on their own lines:
✅ GOOD: [what was right]
🔧 FIX: [mistake] → [correct form] — [simple English explanation]
💬 CORRECTED: [full corrected sentence]
${questionStep}

RULES:
- A1 vocabulary only.
- Max 2 FIX lines per turn. If the reply is fully correct, celebrate and skip FIX.
- Watch: elision (j'), je + conjugated verb (not infinitive), ne…pas, gender (le/la/un/une), lowercase days/months, "aussi" after the verb, en/au/aux, à+le=au, de+le=du.
- ENGLISH WORDS: when ${name} uses an English word or phrase (because they don't know the French), DO NOT reject it. Treat it as a translation request:
  - In the 💬 CORRECTED line, write the full sentence with the English word replaced by its natural French equivalent.
  - Add a 🔧 FIX line in the form: "[english word/phrase] → [french translation] — [one-line usage tip or tiny example in French]".
  - Be encouraging; this is how they grow their vocabulary.
- Simple English explanations only.
- Vary your phrasing between sessions.

PERSONALIZATION:
${profileBlock}

When you learn something NEW about ${name} (hobbies, likes/dislikes, family, job, pets, travel, home city, personality, goals…), append ONE hidden line at the very end of your response in EXACTLY this format:
<note>fact 1 | fact 2</note>
- Short factual phrases only (under 60 chars each, in English, third person about ${name}).
- Only include genuinely NEW info not already listed above.
- If nothing new this turn, omit the <note> tag entirely.
- Never mention the note or its contents out loud.

CURRICULUM: ${CURRICULUM_SUMMARY}

${openingBlock}`;
}

// Keep conversation cost bounded on long sessions. We always preserve the
// original "Start!" kickoff as the first turn, then keep the most recent
// `keep` messages after that, trimming from the middle. The Messages API
// requires the sequence to start with a user turn, so we drop a leading
// assistant message if one ends up first after slicing.
function trimHistory(messages, keep = 20) {
  if (!Array.isArray(messages) || messages.length <= keep + 1) return messages;
  const first = messages[0];
  let tail = messages.slice(-keep);
  while (tail.length && tail[0].role !== 'user') tail = tail.slice(1);
  return [first, ...tail];
}

// POST JSON to the Anthropic Messages API using Node's built-in https module,
// so the server works on any Node version (no dependency on global fetch).
function callAnthropic(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (_e) {
            parsed = { error: { message: raw || 'Empty response from Anthropic' } };
          }
          resolve({ status: response.statusCode || 500, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// Silence the /favicon.ico 404 in dev.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Tell the client whether a password is required (so it can show the login screen).
app.get('/api/auth', (_req, res) => {
  res.json({ required: Boolean(APP_PASSWORD) });
});

// Verify a submitted password. Returns 200 on success, 401 on failure.
app.post('/api/auth', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, required: false });
  if (checkPassword(req)) return res.json({ ok: true, required: true });
  return res.status(401).json({ error: { message: 'Incorrect password' } });
});

app.post('/api/chat', async (req, res) => {
  if (!checkPassword(req)) {
    return res.status(401).json({ error: { message: 'Incorrect or missing password' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: {
        message:
          'ANTHROPIC_API_KEY is not set. Create a .env file with ANTHROPIC_API_KEY=sk-ant-... and restart the server.'
      }
    });
  }

  const { messages, name, profile, skipQuestion } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be a non-empty array' } });
  }

  const isOpening = messages.length === 1;
  const trimmedMessages = trimHistory(messages, 20);

  try {
    const { status, data } = await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: buildSystemPrompt(name, isOpening, profile, Boolean(skipQuestion)),
      messages: trimmedMessages
    });

    if (status < 200 || status >= 300) {
      console.error('Anthropic API error:', status, data);
      return res.status(status).json(data);
    }

    const text = (data.content || [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.json({ text, raw: data });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('Server error talking to Anthropic:', err);
    res.status(500).json({ error: { message } });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      '[warn] ANTHROPIC_API_KEY is not set. Create a .env file (see .env.example) before sending messages.'
    );
  }
  if (APP_PASSWORD) {
    console.log('[info] Password gate is ENABLED (APP_PASSWORD is set).');
  } else {
    console.log('[info] Password gate is DISABLED — set APP_PASSWORD in .env to require one.');
  }
  console.log(`Ooh La Langue running at http://localhost:${PORT}`);
});
