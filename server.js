require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Constant-time string compare to avoid leaking password length via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkPassword(req, appPassword) {
  if (!appPassword) return true; // gate disabled
  const supplied = req.get('x-app-password') || (req.body && req.body.password) || '';
  return Boolean(supplied) && safeEqual(supplied, appPassword);
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

// Return a shuffled copy. Fisher–Yates over a copy so the curriculum array is
// never mutated (the same array is also used by the chat prompt).
function shuffleCopy(list, rng) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    // Clamp to [0, 1): an injected/test RNG returning exactly 1 would
    // otherwise produce an out-of-range index and a null module.
    const value = Number(rng());
    const r = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
    const j = Math.floor(r * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Assign one curriculum module per worksheet section, in section order. When
// there are enough modules the themes are distinct; if not, the shuffled pool
// is exhausted and reshuffled, so duplicates are unavoidable but only appear
// after a full cycle. An injected RNG makes the result deterministic.
function assignSectionTopics(sectionIds, { rng = Math.random, modules = CURRICULUM_MODULES } = {}) {
  if (!Array.isArray(sectionIds) || sectionIds.length === 0) return [];
  const pool = Array.isArray(modules) ? modules : [];
  if (pool.length === 0) {
    return sectionIds.map((id) => ({ id, module: null, focus: '', hint: '' }));
  }

  let shuffled = shuffleCopy(pool, rng);
  let cursor = 0;
  return sectionIds.map((id) => {
    if (cursor >= shuffled.length) {
      shuffled = shuffleCopy(pool, rng);
      cursor = 0;
    }
    const mod = shuffled[cursor] || {};
    cursor += 1;
    return {
      id,
      module: typeof mod.module === 'string' ? mod.module : null,
      focus: typeof mod.focus === 'string' ? mod.focus : '',
      hint: typeof mod.hint === 'string' ? mod.hint : ''
    };
  });
}

// Compact worksheet title: distinct module names in order, whole-module
// truncation with an ellipsis, and a stable fallback for empty input.
function summarizeWorksheetTopic(assignments, maxLength = 60) {
  const names = [];
  const seen = new Set();
  for (const item of Array.isArray(assignments) ? assignments : []) {
    const raw = typeof item === 'string' ? item : item && typeof item.module === 'string' ? item.module : '';
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return 'Thèmes variés (A1)';

  const limit = Number.isFinite(maxLength) ? maxLength : 60;
  const full = names.join(' · ');
  if (full.length <= limit) return full;

  // Keep only whole module names, reserving one character for the ellipsis.
  let out = '';
  for (const name of names) {
    const candidate = out ? `${out} · ${name}` : name;
    if (candidate.length > limit - 1) break;
    out = candidate;
  }
  if (!out) {
    // No whole module fits: keep the first name intact rather than slicing
    // it mid-word. Slightly exceeding the limit is preferable to a cryptic
    // partial word.
    return names[0];
  }
  return `${out}…`;
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
function buildSystemPrompt(rawName, isOpening, profile, skipQuestion, voiceMode) {
  const name = sanitizeName(rawName) || 'the student';
  const mod = pickRandom(CURRICULUM_MODULES);
  const greeting = pickRandom(GREETINGS);

  let openingBlock;
  if (skipQuestion) {
    openingBlock = `THIS IS THE LAST ANSWER OF THE SESSION.
You MUST still follow steps 1–2 above exactly (react in English, then ✅ GOOD / 🔧 FIX / 💬 CORRECTED). The correction is the most important part — do NOT skip it.
For step 3, instead of asking a new question, add ONE short warm English line telling ${name} they've reached the session limit and can come back soon. Keep it encouraging.`;
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
    : `3. Ask ONE new simple A1 question **in French** — personalize it with what you know about ${name} when relevant. Bold key vocabulary and add a short parenthetical English translation for new words.`;

  const pronunciationStep = voiceMode
    ? `4. After the 💬 CORRECTED line (or after the question), add:
🗣️ SAY IT: [phonetic pronunciation hints for the 1–3 trickiest words in the corrected sentence — e.g. "je PRENDS (prahn) le bus au TRAVAIL (trah-vahy)"]
Focus on: nasal sounds (an/en → ahn, on → ohn, in → ehn), silent letters, liaisons, and elision. Keep it short — only the hardest words, not every word. If everything is simple to pronounce, skip this line.`
    : '';

  return `You are a warm, playful French teacher helping ${name}, an A1 beginner, practice French. Address ${name} by name naturally.

EACH TURN (after the first):
1. React briefly in English (one short line).
2. Then use these exact markers on their own lines:
✅ GOOD: [what was right]
🔧 FIX: [mistake] → [correct form] — [simple English explanation]
💬 CORRECTED: [full corrected sentence]
${questionStep}
${pronunciationStep}

RULES:
- Your follow-up question (step 3) MUST be in French. Add short parenthetical English hints for new words only.
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

// ---------------------------------------------------------------------------
// HTTP transport
//
// One shared transport is used for every outbound provider call so behaviour
// is identical across Node versions (no dependency on global fetch) and so
// tests can inject a mock. `httpRequest` resolves with the raw response and
// never throws for non-2xx statuses — callers classify the status.
// ---------------------------------------------------------------------------

function defaultHttpRequest({ method = 'POST', url, headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      reject(new Error('Invalid provider URL: ' + url));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const payload =
      body == null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : typeof body === 'string'
            ? body
            : JSON.stringify(body);

    const reqHeaders = Object.assign({}, headers);
    if (payload && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: reqHeaders
      },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          resolve({
            status: response.statusCode || 500,
            headers: response.headers || {},
            buffer: Buffer.concat(chunks)
          });
        });
      }
    );

    req.on('error', (err) => {
      const wrapped = new Error(err && err.message ? err.message : String(err));
      wrapped.code = err && err.code ? err.code : 'ENETWORK';
      reject(wrapped);
    });

    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Provider request timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Provider abstraction
//
// TEXT_PROVIDER selects the text provider server-side only. Keys are read
// from the server environment and are never logged or returned to the client.
// ---------------------------------------------------------------------------

class ProviderError extends Error {
  constructor(message, { status = 502, transient = false, upstream = null, data = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.transient = transient;
    this.upstream = upstream;
    this.data = data;
  }
}

function parseJsonText(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_e) {
    return { error: { message: raw || 'Empty response from provider' } };
  }
}

function extractProviderMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.error) {
    if (typeof data.error === 'string') return data.error;
    if (data.error.message) return String(data.error.message);
  }
  if (data.message && typeof data.message === 'string') return data.message;
  return '';
}

function extractOllamaText(data) {
  if (!data) return '';
  if (data.message && typeof data.message.content === 'string') return data.message.content.trim();
  if (typeof data.response === 'string') return data.response.trim();
  return '';
}

function extractOpenAIText(data) {
  if (!data || !Array.isArray(data.choices) || !data.choices.length) return '';
  const choice = data.choices[0] || {};
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content.trim();
  if (typeof choice.text === 'string') return choice.text.trim();
  return '';
}

// Exactly one retry on transient failures (network error / timeout / 5xx).
// 4xx is surfaced immediately without a retry.
async function withOneRetry(task) {
  try {
    return await task();
  } catch (err) {
    if (!err || !err.transient) throw err;
    return task();
  }
}

async function rawRequest({ httpRequest, url, headers, body, timeoutMs, label }) {
  try {
    return await httpRequest({ method: 'POST', url, headers, body, timeoutMs });
  } catch (err) {
    throw new ProviderError(`${label} request failed: ${err && err.message ? err.message : err}`, {
      status: 502,
      transient: true,
      data: { code: err && err.code }
    });
  }
}

async function requestJson({ httpRequest, url, headers, body, timeoutMs, label }) {
  const res = await rawRequest({ httpRequest, url, headers, body, timeoutMs, label });
  const raw = res.buffer ? res.buffer.toString('utf8') : '';
  const data = parseJsonText(raw);
  if (res.status >= 500) {
    throw new ProviderError(`${label} upstream error (${res.status})`, {
      status: 502,
      transient: true,
      upstream: res.status,
      data
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(extractProviderMessage(data) || `${label} returned ${res.status}`, {
      status: res.status,
      transient: false,
      data
    });
  }
  return { status: res.status, data };
}

async function requestBinary({ httpRequest, url, headers, body, timeoutMs, label }) {
  const res = await rawRequest({ httpRequest, url, headers, body, timeoutMs, label });
  if (res.status >= 500) {
    throw new ProviderError(`${label} upstream error (${res.status})`, {
      status: 502,
      transient: true,
      upstream: res.status
    });
  }
  if (res.status < 200 || res.status >= 300) {
    const data = parseJsonText(res.buffer ? res.buffer.toString('utf8') : '');
    throw new ProviderError(extractProviderMessage(data) || `${label} returned ${res.status}`, {
      status: res.status,
      transient: false,
      data
    });
  }
  const mime = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || 'audio/mpeg';
  return { status: res.status, buffer: res.buffer || Buffer.alloc(0), mime: String(mime).split(';')[0] };
}

function makeProviders({ httpRequest = defaultHttpRequest, env = process.env } = {}) {
  const ollama = {
    name: 'ollama',
    isConfigured() {
      return Boolean(env.OLLAMA_API_KEY);
    },
    isModelConfigured() {
      return Boolean(env.OLLAMA_MODEL);
    },
    missingMessage() {
      return 'OLLAMA_API_KEY is not set. Add OLLAMA_API_KEY and OLLAMA_MODEL to your .env and restart the server (see .env.example), or set TEXT_PROVIDER=openai with OPENAI_API_KEY.';
    },
    async chatCompletion({ system, messages, maxTokens = 800, timeoutMs = 30000 }) {
      if (!env.OLLAMA_API_KEY) throw new ProviderError(ollama.missingMessage(), { status: 500 });
      if (!env.OLLAMA_MODEL) {
        throw new ProviderError(
          'OLLAMA_MODEL is not set. Set the model name available to your Ollama Cloud account in .env (see .env.example) and restart the server.',
          { status: 500 }
        );
      }
      const url = env.OLLAMA_BASE_URL || 'https://ollama.com/api/chat';
      // Thinking models otherwise spend the token budget on reasoning and leave
      // message.content empty. Off by default so replies stay direct/JSON.
      const think = String(env.OLLAMA_THINK || '').trim().toLowerCase() === 'true';
      const chatMessages = system ? [{ role: 'system', content: system }, ...(messages || [])] : messages || [];
      const { data } = await withOneRetry(() =>
        requestJson({
          httpRequest,
          url,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OLLAMA_API_KEY}`
          },
          body: { model: env.OLLAMA_MODEL, stream: false, think, messages: chatMessages, options: { num_predict: maxTokens } },
          timeoutMs,
          label: 'Ollama'
        })
      );
      const text = extractOllamaText(data);
      if (!text) {
        throw new ProviderError('Ollama returned an empty response.', { status: 502, transient: true, data });
      }
      return { text, raw: data };
    }
  };

  const openai = {
    name: 'openai',
    isConfigured() {
      return Boolean(env.OPENAI_API_KEY);
    },
    isModelConfigured() {
      return Boolean(env.OPENAI_MODEL);
    },
    missingMessage() {
      return 'OPENAI_API_KEY is not set. Add OPENAI_API_KEY and OPENAI_MODEL to your .env and restart the server (see .env.example), or set TEXT_PROVIDER=ollama with OLLAMA_API_KEY.';
    },
    async chatCompletion({ system, messages, maxTokens = 800, timeoutMs = 30000 }) {
      if (!env.OPENAI_API_KEY) throw new ProviderError(openai.missingMessage(), { status: 500 });
      if (!env.OPENAI_MODEL) {
        throw new ProviderError(
          'OPENAI_MODEL is not set. Set the OpenAI text model name in .env (see .env.example) and restart the server.',
          { status: 500 }
        );
      }
      const chatMessages = system ? [{ role: 'system', content: system }, ...(messages || [])] : messages || [];
      const { data } = await withOneRetry(() =>
        requestJson({
          httpRequest,
          url: 'https://api.openai.com/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`
          },
          body: { model: env.OPENAI_MODEL, messages: chatMessages, max_tokens: maxTokens },
          timeoutMs,
          label: 'OpenAI'
        })
      );
      const text = extractOpenAIText(data);
      if (!text) {
        throw new ProviderError('OpenAI returned an empty response.', { status: 502, transient: true, data });
      }
      return { text, raw: data };
    }
  };

  return { ollama, openai };
}

function selectProvider(env = process.env, deps = {}) {
  const providers = deps.providers || makeProviders({ env, ...deps });
  const requested = String(env.TEXT_PROVIDER || 'ollama')
    .trim()
    .toLowerCase();
  const provider = providers[requested];
  if (!provider) {
    throw new ProviderError(
      `Unknown TEXT_PROVIDER "${env.TEXT_PROVIDER}". Use "ollama" (default) or "openai".`,
      { status: 500 }
    );
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Structured output: worksheet contract (see design spec §9)
//
// TRUST MODEL — INTENTIONAL, NOT A SECURITY BOUNDARY:
// This is a personal practice tool, not a secure exam. The `/api/generate`
// payload contains each question's `answer` and the listening `script`
// because the browser must be able to reveal them after self-practice and
// because there is no server-side grading secrecy. Hiding is a UI concern:
// `public/views/worksheet.js` must not render these values into the DOM until
// the learner reveals/submits. They are trivially visible in DevTools.
// ---------------------------------------------------------------------------

const WORKSHEET_SECTION_IDS = ['listening', 'reading', 'translation_grammar', 'writing'];
const QUESTION_TYPES = ['short_text', 'choice', 'fill_blank', 'translation'];
const FEEDBACK_VERDICTS = ['correct', 'mistake', 'alternative'];
const FEEDBACK_ERROR_TYPES = ['error', 'style', 'alternative'];

const WORKSHEET_SYSTEM_PROMPT = `You are an experienced A1 (beginner) French teacher writing a DELF A1-style practice worksheet.
You MUST reply with a SINGLE valid JSON object and NOTHING else: no markdown fences, no explanations, no trailing text.

The object MUST match this shape exactly:
{
  "topic": "string",
  "level": "A1",
  "sections": [
    {
      "id": "listening | reading | translation_grammar | writing",
      "topic_fr": "Le thème de cette section, en français",
      "title_fr": "Titre de la section, en français",
      "instructions_fr": "Consigne de la section, une phrase courte en français uniquement",
      "text_fr": "Le texte français à lire — uniquement pour la section reading",
      "audio": {
        "script": "The full spoken French script",
        "speakers": [{ "name": "A", "voice": "female" }],
        "cache_key": "leave empty; the server computes it"
      },
      "questions": [
        {
          "id": "unique-string-id",
          "prompt": "La question, en français uniquement — aucune traduction ni glose en anglais",
          "type": "short_text | choice | fill_blank | translation",
          "options": ["only for choice questions"],
          "answer": "the expected answer (hidden until the learner reveals it)",
          "explanation": "Explication de la réponse, en français uniquement"
        }
      ]
    }
  ]
}

HARD RULES:
- Use only these section ids: listening, reading, translation_grammar, writing.
- Every section MUST have a non-empty "topic_fr" written in French. It MUST match the theme assigned to that section in the user prompt. Never give two sections the same theme.
- The "audio" block MUST appear ONLY on the "listening" section. Never put it on other sections.
- The "text_fr" field MUST appear ONLY on the "reading" section, and it MUST be a non-empty French A1 reading passage that the section's questions are based on. Never put "text_fr" on other sections.
- COMPRÉHENSION ORALE (DELF A1): The listening section is a short authentic-style A1 recording — 1–2 short messages/announcements or one short dialogue — on the assigned theme. Every listening question MUST be type "choice" with EXACTLY 3 options and ONE correct answer. Listening questions MUST test comprehension or inference (où ? quand ? qui ? pourquoi ? que veut la personne ? que va-t-elle faire ?), NOT verbatim word-matching. Never copy a whole sentence from the script into an option. Every question must be answerable from the audio alone.
- DIALOGUE FORMAT (important for voicing): if the script has more than one speaker, write it as one line per turn, each line beginning with the speaker's name followed by a colon, e.g. "Marie: Bonjour !\\nPaul: Salut Marie !". Use exactly the speaker "name" values from "speakers", and give each a distinct "voice" value ("male" or "female") so the turns are voiced separately. For a single-speaker narration, write plain sentences and list one speaker.
- COMPRÉHENSION ÉCRITE (DELF A1): "text_fr" is a short authentic-style A1 document (courriel, SMS, panneau, annonce, publicité, menu or message) on the assigned theme. Use a mix of "choice" questions (EXACTLY 3 options) and "short_text" questions. At least one question (preferably two) MUST require inference or deduction from the text; do not make every answer a sentence copied verbatim from "text_fr". Every question must be answerable from "text_fr" alone.
- GRAMMAIRE: French-only grammar practice on the assigned theme. Use fill-in-the-blank (fill_blank), conjugation, singular/plural or masculine/feminine transforms, and reformulation of a FRENCH sentence (short_text). NEVER ask the learner to translate from English; never emit a "translation" question whose source sentence is English.
- EXPRESSION ÉCRITE (DELF A1): Each writing question MUST be type "short_text". Its "prompt" MUST present a short French situation or message that the learner must understand (for example an invitation, an SMS, an announcement), then ask the learner to respond in French in environ 40–50 mots. The situation and the task are both written in French only. Never ask for a translation.
- Every question MUST have: id, prompt, type, answer, explanation. "options" is REQUIRED when type is "choice" and must be omitted otherwise.
- "answer" is the model answer / answer key. It is delivered to the client by design but hidden in the UI until reveal.
- Keep vocabulary and grammar at A1 level. Use short sentences.
- EVERY learner-facing string MUST be written in French only: "topic_fr", "title_fr", "instructions_fr", "text_fr", "prompt", "options", "answer" and "explanation". Never write English — not even in parentheses, not as a translation or gloss.
- Questions and options MUST NOT contain an English translation, gloss or hint (for example, never write "(What's your name?)").
- Do not add any keys other than those shown.`;

function lengthToCounts(length) {
  const key = String(length || 'medium').toLowerCase();
  if (key === 'short') return { reading: 3, translation_grammar: 3, writing: 1, listening: 2 };
  if (key === 'long') return { reading: 6, translation_grammar: 6, writing: 2, listening: 4 };
  return { reading: 4, translation_grammar: 4, writing: 1, listening: 3 };
}

function buildWorksheetPrompt({
  topic,
  level = 'A1',
  length = 'medium',
  includeListening = true,
  name,
  profile,
  sectionTopics = []
} = {}) {
  const counts = lengthToCounts(length);
  const safeLevel = sanitizeFact(level) || 'A1';
  const safeTopic = sanitizeFact(topic) || 'daily life at A1 level';
  const learner = sanitizeName(name) || 'a learner';
  const facts = sanitizeProfile(profile);

  const byId = new Map();
  for (const assignment of Array.isArray(sectionTopics) ? sectionTopics : []) {
    if (assignment && assignment.id) byId.set(assignment.id, assignment);
  }
  const themeFor = (id) => {
    const assignment = byId.get(id);
    // Sanitize before interpolation even for the explicit caller topic: it is
    // kept verbatim in the response, but must not carry quotes/newlines or
    // instructions into the model prompt.
    return assignment && assignment.module ? sanitizeFact(assignment.module) || safeTopic : safeTopic;
  };
  const focusFor = (id) => {
    const assignment = byId.get(id);
    return assignment && assignment.focus ? ` (focus: ${assignment.focus})` : '';
  };
  const hintFor = (id) => {
    const assignment = byId.get(id);
    return assignment && assignment.hint ? ` Inspiration (ne pas copier) : "${assignment.hint}".` : '';
  };

  const lines = [];
  lines.push(`Create a ${safeLevel} French DELF A1-style practice worksheet. The learner is ${learner}.`);
  if (facts.length) lines.push(`Known about the learner: ${facts.join('; ')}.`);
  lines.push(`Worksheet label: "${safeTopic}".`);
  lines.push('Each section has its OWN theme; use the assigned theme below and do not reuse a theme across sections.');
  lines.push('');
  lines.push('Include these sections, in this order:');
  if (includeListening) {
    lines.push(
      `- listening (Compréhension orale) — theme: "${themeFor('listening')}"${focusFor('listening')}.${hintFor('listening')} A short authentic-style A1 recording (1–2 short messages/announcements or one short dialogue) on this theme, with ${counts.listening} multiple-choice questions. Every question MUST be type "choice" with exactly 3 options and one correct answer. Test comprehension/inference (où ? quand ? qui ? pourquoi ? que veut la personne ? que va-t-elle faire ?), not verbatim word-matching; never copy a sentence from the script into an option.`
    );
  }
  lines.push(
    `- reading (Compréhension écrite) — theme: "${themeFor('reading')}"${focusFor('reading')}. A short authentic-style A1 document (courriel, SMS, panneau, annonce, publicité, menu or message) in "text_fr" on this theme, with ${counts.reading} questions: a mix of "choice" questions (exactly 3 options) and "short_text" questions. At least one question (preferably two) must require inference from the text; do not make every answer a verbatim sentence from "text_fr".`
  );
  lines.push(
    `- translation_grammar (Grammaire) — theme: "${themeFor('translation_grammar')}"${focusFor('translation_grammar')}. ${counts.translation_grammar} French-only grammar exercises on this theme (fill in the blank, conjugation, singular/plural and masculine/feminine transforms, French sentence reformulation). Never English→French translation.`
  );
  lines.push(
    `- writing (Expression écrite) — theme: "${themeFor('writing')}"${focusFor('writing')}. ${counts.writing} DELF A1 production task(s). In each question prompt, write a short French situation/message the learner must understand (invitation, SMS, announcement, etc.) and ask them to reply in French in environ 40–50 mots. Use type "short_text" and a French-only prompt.`
  );
  lines.push('');
  lines.push('Every section MUST include "topic_fr" set to the theme assigned above.');
  lines.push('All learner-facing text (topic_fr, instructions_fr, text_fr, prompts, options, answers, explanations) must be written in French only, with no English translations or glosses.');
  lines.push('Respond with ONLY the JSON object described in the system instructions.');
  return lines.join('\n');
}

function buildWorksheetRepairPrompt(errors) {
  return `Your previous response was rejected because:
- ${(errors || ['unknown error']).join('\n- ')}

Return the corrected worksheet as a SINGLE valid JSON object only. No markdown fences, no commentary. Fix every listed problem.`;
}

function validateWorksheet(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['worksheet must be a JSON object'] };
  }
  if (typeof value.topic !== 'string' || !value.topic.trim()) errors.push('topic must be a non-empty string');
  if (value.level != null && typeof value.level !== 'string') errors.push('level must be a string when present');
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    errors.push('sections must be a non-empty array');
    return { ok: false, errors };
  }

  const seenSectionIds = new Set();
  const seenQuestionIds = new Set();
  value.sections.forEach((section, si) => {
    const where = `sections[${si}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!WORKSHEET_SECTION_IDS.includes(section.id)) {
      errors.push(`${where}.id must be one of ${WORKSHEET_SECTION_IDS.join(' | ')}`);
    } else if (seenSectionIds.has(section.id)) {
      errors.push(`${where}.id duplicates another section (${section.id})`);
    } else {
      seenSectionIds.add(section.id);
    }
    if (typeof section.title_fr !== 'string' || !section.title_fr.trim()) errors.push(`${where}.title_fr must be a non-empty string`);
    if (typeof section.topic_fr !== 'string' || !section.topic_fr.trim()) {
      errors.push(`${where}.topic_fr must be a non-empty string`);
    }
    if (typeof section.instructions_fr !== 'string' || !section.instructions_fr.trim()) {
      errors.push(`${where}.instructions_fr must be a non-empty string`);
    }

    const isListening = section.id === 'listening';
    if (isListening) {
      const audio = section.audio;
      if (!audio || typeof audio !== 'object' || Array.isArray(audio)) {
        errors.push(`${where}.audio is required for the listening section`);
      } else {
        if (typeof audio.script !== 'string' || !audio.script.trim()) errors.push(`${where}.audio.script must be a non-empty string`);
        if (!Array.isArray(audio.speakers) || audio.speakers.length === 0) {
          errors.push(`${where}.audio.speakers must be a non-empty array`);
        } else {
          audio.speakers.forEach((sp, spi) => {
            if (!sp || typeof sp !== 'object') {
              errors.push(`${where}.audio.speakers[${spi}] must be an object`);
              return;
            }
            if (typeof sp.name !== 'string' || !sp.name.trim()) errors.push(`${where}.audio.speakers[${spi}].name must be a non-empty string`);
            if (typeof sp.voice !== 'string' || !sp.voice.trim()) errors.push(`${where}.audio.speakers[${spi}].voice must be a non-empty string`);
          });
        }
      }
    } else if (section.audio != null) {
      errors.push(`${where}.audio must only appear on the listening section`);
    }

    const isReading = section.id === 'reading';
    if (isReading) {
      if (typeof section.text_fr !== 'string' || !section.text_fr.trim()) {
        errors.push(`${where}.text_fr must be a non-empty string for the reading section`);
      }
    } else if (section.text_fr != null) {
      errors.push(`${where}.text_fr must only appear on the reading section`);
    }

    if (!Array.isArray(section.questions) || section.questions.length === 0) {
      errors.push(`${where}.questions must be a non-empty array`);
      return;
    }
    section.questions.forEach((q, qi) => {
      const qWhere = `${where}.questions[${qi}]`;
      if (!q || typeof q !== 'object' || Array.isArray(q)) {
        errors.push(`${qWhere} must be an object`);
        return;
      }
      if (typeof q.id !== 'string' || !q.id.trim()) {
        errors.push(`${qWhere}.id must be a non-empty string`);
      } else if (seenQuestionIds.has(q.id)) {
        errors.push(`${qWhere}.id duplicates another question (${q.id})`);
      } else {
        seenQuestionIds.add(q.id);
      }
      if (typeof q.prompt !== 'string' || !q.prompt.trim()) errors.push(`${qWhere}.prompt must be a non-empty string`);
      if (!QUESTION_TYPES.includes(q.type)) errors.push(`${qWhere}.type must be one of ${QUESTION_TYPES.join(' | ')}`);
      if (isListening && q.type !== 'choice') {
        errors.push(`${qWhere}.type must be "choice" for the listening section (DELF A1 multiple choice)`);
      }
      if (isListening && q.type === 'choice' && Array.isArray(q.options) && q.options.length !== 3) {
        errors.push(`${qWhere}.options must contain exactly 3 options for the listening section`);
      }
      if (section.id === 'writing' && q.type !== 'short_text') {
        errors.push(`${qWhere}.type must be "short_text" for the writing section`);
      }
      if (q.type === 'choice') {
        if (!Array.isArray(q.options) || q.options.length === 0) {
          errors.push(`${qWhere}.options must be a non-empty array for choice questions`);
        } else if (!q.options.every((o) => typeof o === 'string')) {
          errors.push(`${qWhere}.options must contain only strings`);
        }
      }
      if (typeof q.answer !== 'string' || !q.answer.trim()) errors.push(`${qWhere}.answer must be a non-empty string`);
      if (typeof q.explanation !== 'string' || !q.explanation.trim()) errors.push(`${qWhere}.explanation must be a non-empty string`);
    });
  });

  return { ok: errors.length === 0, errors };
}

// Compute a stable cache key from the script and speaker voices. The same
// canonicalization is used by the client's IndexedDB cache so a resumed
// worksheet hits the cache instead of re-billing TTS.
function worksheetAudioKey(script, speakers) {
  const voices = (speakers || []).map((s) => `${s.name}:${s.voice}`).join(',');
  const canonical = `${String(script || '').replace(/\s+/g, ' ').trim()}|${voices}`;
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function normalizeWorksheet(value) {
  const out = Object.assign({}, value);
  out.topic = typeof out.topic === 'string' ? out.topic : '';
  out.level = typeof out.level === 'string' && out.level ? out.level : 'A1';
  out.sections = (Array.isArray(out.sections) ? out.sections : []).map((section) => {
    const sec = Object.assign({}, section);
    // Defensive strip so a legacy/English field can never persist in a newly
    // generated fiche. Validated `instructions_fr`/`text_fr` pass through.
    delete sec.hint;
    delete sec.explanation_en;
    sec.questions = (Array.isArray(sec.questions) ? sec.questions : []).map((q) => {
      const next = Object.assign({}, q);
      delete next.hint;
      return next;
    });
    if (sec.id === 'listening' && sec.audio && typeof sec.audio === 'object') {
      sec.audio = Object.assign({}, sec.audio);
      sec.audio.cache_key = worksheetAudioKey(sec.audio.script, sec.audio.speakers);
    }
    return sec;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Structured output: feedback contract (see design spec §9)
// ---------------------------------------------------------------------------

const FEEDBACK_SYSTEM_PROMPT =
  'You are a warm A1 French teacher giving concise, encouraging corrections on a practice worksheet. Write every correction, explanation and summary in French only. Reply with strict JSON only.';

function buildFeedbackPrompt(worksheet, answersMap) {
  const sections = (worksheet && worksheet.sections) || [];
  const lines = [];
  lines.push(`You are correcting an A1 French worksheet. Topic: "${(worksheet && worksheet.topic) || 'unknown'}".`);
  lines.push('');
  lines.push('Worksheet and learner answers:');
  for (const section of sections) {
    lines.push(`## Section ${section.id} — ${section.title_fr || ''}`);
    if (section.id === 'listening' && section.audio && section.audio.script) {
      lines.push(`Listening script (use it to judge the listening answers): ${section.audio.script}`);
    }
    if (section.id === 'reading' && section.text_fr) {
      lines.push(`Reading text (use it to judge the reading answers): ${section.text_fr}`);
    }
    for (const q of section.questions || []) {
      const original = Object.prototype.hasOwnProperty.call(answersMap, q.id) ? answersMap[q.id] : '';
      lines.push(`- question_id: ${q.id}`);
      lines.push(`  prompt: ${q.prompt}`);
      lines.push(`  expected answer: ${q.answer}`);
      lines.push(`  learner answer: ${original}`);
    }
    lines.push('');
  }
  lines.push('Return ONLY a single valid JSON object with this shape:');
  lines.push('{');
  lines.push('  "answers": [');
  lines.push('    { "question_id": "string", "original": "the learner answer, copied exactly", "verdict": "correct|mistake|alternative", "correction": "string", "explanation": "string", "error_type": "error|style|alternative" }');
  lines.push('  ],');
  lines.push('  "summary": { "strengths": ["..."], "recurring_mistakes": ["..."], "priorities": ["..."], "follow_up": "string" }');
  lines.push('}');
  lines.push('Rules: verdict must be one of correct|mistake|alternative. error_type must be one of error|style|alternative. Copy each learner answer into "original" exactly as given. Write every correction, explanation and summary item in French only — never English. Be encouraging and concise.');
  return lines.join('\n');
}

function buildFeedbackRepairPrompt(errors) {
  return `Your previous feedback response was rejected because:
- ${(errors || ['unknown error']).join('\n- ')}

Return the corrected feedback as a SINGLE valid JSON object only. Use only the exact verdict and error_type values allowed. No commentary. Écris toutes les corrections, explications et le bilan en français.`;
}

function validateFeedback(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['feedback must be a JSON object'] };
  }
  if (!Array.isArray(value.answers)) {
    errors.push('answers must be an array');
  } else {
    value.answers.forEach((a, i) => {
      const where = `answers[${i}]`;
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (typeof a.question_id !== 'string' || !a.question_id.trim()) errors.push(`${where}.question_id must be a non-empty string`);
      if (typeof a.original !== 'string') errors.push(`${where}.original must be a string`);
      if (!FEEDBACK_VERDICTS.includes(a.verdict)) errors.push(`${where}.verdict must be one of ${FEEDBACK_VERDICTS.join(' | ')}`);
      if (typeof a.correction !== 'string' || !a.correction.trim()) errors.push(`${where}.correction must be a non-empty string`);
      if (typeof a.explanation !== 'string' || !a.explanation.trim()) errors.push(`${where}.explanation must be a non-empty string`);
      if (!FEEDBACK_ERROR_TYPES.includes(a.error_type)) {
        errors.push(`${where}.error_type must be one of ${FEEDBACK_ERROR_TYPES.join(' | ')}`);
      }
    });
  }
  const summary = value.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push('summary must be an object');
  } else {
    for (const key of ['strengths', 'recurring_mistakes', 'priorities']) {
      if (!Array.isArray(summary[key])) errors.push(`summary.${key} must be an array`);
    }
    if (typeof summary.follow_up !== 'string' || !summary.follow_up.trim()) {
      errors.push('summary.follow_up must be a non-empty string');
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeAnswers(answers) {
  const map = {};
  if (!answers) return map;
  if (Array.isArray(answers)) {
    for (const item of answers) {
      if (item && typeof item.question_id === 'string') map[item.question_id] = String(item.answer == null ? '' : item.answer);
    }
    return map;
  }
  if (typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) map[k] = String(v == null ? '' : v);
  }
  return map;
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TTS helpers
// ---------------------------------------------------------------------------

const MAX_TTS_CHARS = 4000;
const TTS_PAUSE_MS = 600;

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;
  const size = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    for (;;) {
      if (firstError) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        // Record the first error but let already-started tasks settle so no
        // rejection is left unhandled.
        if (!firstError) firstError = err;
      }
    }
  }
  await Promise.all(Array.from({ length: size }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function sendProviderError(res, err, fallbackStatus = 500) {
  const upstream = err && err.status ? err.status : fallbackStatus;
  const message = err && err.message ? err.message : String(err);
  // Upstream 4xx (bad API key, unknown model, provider-side validation) is a
  // server/provider configuration problem, NOT the client's request auth. Map
  // it to 502 so the chat client does not misread a provider 401 as an expired
  // app password and re-show the gate. Client body errors are returned directly
  // by the routes and never reach here.
  const status = upstream >= 400 && upstream < 500 ? 502 : upstream;
  res.status(status).json({ error: { code: 'PROVIDER_ERROR', message } });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function createApp({ httpRequest = defaultHttpRequest, env = process.env } = {}) {
  const app = express();
  const providers = makeProviders({ httpRequest, env });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Silence the /favicon.ico 404 in dev.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  // Tell the client whether a password is required (so it can show the login screen).
  app.get('/api/auth', (_req, res) => {
    res.json({ required: Boolean(env.APP_PASSWORD) });
  });

  // Verify a submitted password. Returns 200 on success, 401 on failure.
  app.post('/api/auth', (req, res) => {
    if (!env.APP_PASSWORD) return res.json({ ok: true, required: false });
    if (checkPassword(req, env.APP_PASSWORD)) return res.json({ ok: true, required: true });
    return res.status(401).json({ error: { message: 'Incorrect password' } });
  });

  // -------------------------------------------------------------------------
  // POST /api/chat — unchanged chat contract, routed through the provider.
  // -------------------------------------------------------------------------
  app.post('/api/chat', async (req, res) => {
    if (!checkPassword(req, env.APP_PASSWORD)) {
      return res.status(401).json({ error: { message: 'Incorrect or missing password' } });
    }

    const { messages, name, profile, skipQuestion, voiceMode } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages must be a non-empty array' } });
    }

    let provider;
    try {
      provider = selectProvider(env, { providers });
    } catch (err) {
      return sendProviderError(res, err);
    }

    const isOpening = messages.length === 1;
    const trimmedMessages = trimHistory(messages, 20);
    const system = buildSystemPrompt(name, isOpening, profile, Boolean(skipQuestion), Boolean(voiceMode));

    try {
      // Only the reply text crosses the boundary: provider/model details stay
      // server-side and are never shown in ordinary learning flows.
      const { text } = await provider.chatCompletion({
        system,
        messages: trimmedMessages,
        maxTokens: 500,
        timeoutMs: Number(env.AI_TIMEOUT_MS) || 30000
      });
      res.json({ text });
    } catch (err) {
      console.error(`[${provider.name}] chat error:`, err && err.message ? err.message : err);
      sendProviderError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/generate — structured worksheet JSON.
  //
  // The returned payload intentionally contains each question's `answer` and
  // the listening `script` so the client can reveal them after self-practice.
  // See the TRUST MODEL note above: this is not a secure exam and provides no
  // server-side grading secrecy.
  // -------------------------------------------------------------------------
  app.post('/api/generate', async (req, res) => {
    if (!checkPassword(req, env.APP_PASSWORD)) {
      return res.status(401).json({ error: { message: 'Incorrect or missing password' } });
    }

    let provider;
    try {
      provider = selectProvider(env, { providers });
    } catch (err) {
      return sendProviderError(res, err);
    }

    const { topic, level = 'A1', length = 'medium', includeListening = true, name, profile } = req.body || {};
    // A non-empty caller-supplied topic is a legacy label kept verbatim in the
    // response; otherwise the worksheet title is a summary of the assigned
    // section themes. Either way each requested section gets its own distinct
    // curriculum theme.
    const providedTopic = typeof topic === 'string' ? topic.trim() : '';
    const sectionIds = includeListening
      ? WORKSHEET_SECTION_IDS
      : WORKSHEET_SECTION_IDS.filter((id) => id !== 'listening');
    const pool = providedTopic
      ? CURRICULUM_MODULES.filter((m) => m.module !== providedTopic)
      : CURRICULUM_MODULES;
    const assignments = assignSectionTopics(sectionIds, { modules: pool });

    // Backward-compatible shim: the caller's label themes the first section,
    // while the remaining sections still get distinct curriculum modules.
    if (providedTopic && assignments.length) {
      const match = CURRICULUM_MODULES.find((m) => m.module === providedTopic) || null;
      assignments[0] = {
        ...assignments[0],
        module: providedTopic,
        focus: match ? match.focus : '',
        hint: match ? match.hint : ''
      };
    }

    const promptTopic = providedTopic || summarizeWorksheetTopic(assignments);
    const userPrompt = buildWorksheetPrompt({
      topic: promptTopic,
      level,
      length,
      includeListening,
      name,
      profile,
      sectionTopics: assignments
    });
    const timeoutMs = Number(env.AI_TIMEOUT_MS) || 45000;

    // Respect the learner's section choice: a model that returns a section
    // the caller did not request (for example listening with
    // includeListening:false) must not reach the response. Malformed entries
    // are kept so validation can reject them; if nothing requested remains,
    // validation fails and the normal repair/error path runs.
    const requestedSectionIds = new Set(sectionIds);
    const restrictToRequestedSections = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.sections)) return value;
      return {
        ...value,
        sections: value.sections.filter((section) => {
          if (!section || typeof section !== 'object' || Array.isArray(section)) return true;
          return requestedSectionIds.has(section.id);
        })
      };
    };

    try {
      const first = await provider.chatCompletion({
        system: WORKSHEET_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: Number(env.WORKSHEET_MAX_TOKENS) || 3000,
        timeoutMs
      });

      let parsed = restrictToRequestedSections(extractJson(first.text));
      let check = parsed ? validateWorksheet(parsed) : { ok: false, errors: ['response was not valid JSON'] };

      if (!check.ok) {
        const repaired = await provider.chatCompletion({
          system: WORKSHEET_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: first.text || '' },
            { role: 'user', content: buildWorksheetRepairPrompt(check.errors) }
          ],
          maxTokens: Number(env.WORKSHEET_MAX_TOKENS) || 3000,
          timeoutMs
        });
        parsed = restrictToRequestedSections(extractJson(repaired.text));
        check = parsed ? validateWorksheet(parsed) : { ok: false, errors: ['repair response was not valid JSON'] };
        if (!check.ok) {
          console.error('[generate] invalid worksheet after repair:', check.errors);
          return res.status(502).json({
            error: {
              message: 'Le modèle n’a pas renvoyé de fiche valide après une tentative de correction. Réessaie.'
            }
          });
        }
      }

      const normalized = normalizeWorksheet(parsed);
      // Server-authoritative per-section themes: overwrite the model's
      // topic_fr with the assigned module for every returned section. The
      // worksheet title is the caller's legacy label or a summary of the
      // themes actually returned (so an omitted section never appears).
      const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
      for (const section of normalized.sections) {
        const assignment = assignmentById.get(section.id);
        if (assignment && assignment.module) section.topic_fr = assignment.module;
      }
      // If the model omitted the first requested section, the caller's explicit
      // theme would otherwise disappear; show it on the first returned section.
      if (providedTopic && normalized.sections.length && normalized.sections[0].id !== sectionIds[0]) {
        normalized.sections[0].topic_fr = providedTopic;
      }
      if (providedTopic) {
        normalized.topic = providedTopic;
      } else {
        const returnedThemes = normalized.sections
          .map((section) => ({ module: section.topic_fr }))
          .filter((assignment) => typeof assignment.module === 'string' && assignment.module.trim());
        normalized.topic = returnedThemes.length ? summarizeWorksheetTopic(returnedThemes) : promptTopic;
      }
      res.json(normalized);
    } catch (err) {
      console.error(`[${provider.name}] generate error:`, err && err.message ? err.message : err);
      sendProviderError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/feedback — structured per-answer feedback + summary.
  // -------------------------------------------------------------------------
  app.post('/api/feedback', async (req, res) => {
    if (!checkPassword(req, env.APP_PASSWORD)) {
      return res.status(401).json({ error: { message: 'Incorrect or missing password' } });
    }

    let provider;
    try {
      provider = selectProvider(env, { providers });
    } catch (err) {
      return sendProviderError(res, err);
    }

    const body = req.body || {};
    const worksheet = body.worksheet || body;
    if (!worksheet || !Array.isArray(worksheet.sections)) {
      return res.status(400).json({ error: { message: 'worksheet.sections must be an array' } });
    }
    const answersMap = normalizeAnswers(body.answers);
    const userPrompt = buildFeedbackPrompt(worksheet, answersMap);
    const timeoutMs = Number(env.AI_TIMEOUT_MS) || 45000;

    try {
      const first = await provider.chatCompletion({
        system: FEEDBACK_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: Number(env.FEEDBACK_MAX_TOKENS) || 3000,
        timeoutMs
      });

      let parsed = extractJson(first.text);
      let check = parsed ? validateFeedback(parsed) : { ok: false, errors: ['response was not valid JSON'] };

      if (!check.ok) {
        const repaired = await provider.chatCompletion({
          system: FEEDBACK_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: first.text || '' },
            { role: 'user', content: buildFeedbackRepairPrompt(check.errors) }
          ],
          maxTokens: Number(env.FEEDBACK_MAX_TOKENS) || 3000,
          timeoutMs
        });
        parsed = extractJson(repaired.text);
        check = parsed ? validateFeedback(parsed) : { ok: false, errors: ['repair response was not valid JSON'] };
        if (!check.ok) {
          console.error('[feedback] invalid feedback after repair:', check.errors);
          return res.status(502).json({
            error: { message: 'Le modèle n’a pas renvoyé de correction valide après une tentative de correction. Réessaie.' }
          });
        }
      }

      // Never let the model rewrite the learner's original answer.
      parsed.answers = parsed.answers.map((a) => {
        if (Object.prototype.hasOwnProperty.call(answersMap, a.question_id)) {
          return Object.assign({}, a, { original: answersMap[a.question_id] });
        }
        return a;
      });

      res.json(parsed);
    } catch (err) {
      console.error(`[${provider.name}] feedback error:`, err && err.message ? err.message : err);
      sendProviderError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/tts — OpenAI TTS, one call per utterance, returned as segments.
  // -------------------------------------------------------------------------
  app.post('/api/tts', async (req, res) => {
    if (!checkPassword(req, env.APP_PASSWORD)) {
      return res.status(401).json({ error: { message: 'Incorrect or missing password' } });
    }

    if (!env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: {
          message:
            'OPENAI_API_KEY is not set, so listening audio is unavailable. Add OPENAI_API_KEY to your .env and restart the server (see .env.example).'
        }
      });
    }

    const { utterances, speakers } = req.body || {};
    if (!Array.isArray(utterances) || utterances.length === 0) {
      return res.status(400).json({ error: { message: 'utterances must be a non-empty array' } });
    }
    for (const [i, u] of utterances.entries()) {
      if (!u || typeof u.text !== 'string' || !u.text.trim()) {
        return res.status(400).json({ error: { message: `utterances[${i}].text must be a non-empty string` } });
      }
    }

    const totalChars = utterances.reduce((sum, u) => sum + String(u.text).length, 0);
    if (totalChars > MAX_TTS_CHARS) {
      return res.status(400).json({
        error: {
          message: `Listening script is too long (${totalChars} characters; limit ${MAX_TTS_CHARS}). Shorten the worksheet and try again.`
        }
      });
    }

    const model = env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    // OpenAI TTS accepts a fixed set of voice names. The worksheet prompt asks
    // for "male"/"female"; map those (and be lenient for legacy raw values) to
    // legal voices so a dialogue never sends an invalid voice to the API.
    const OPENAI_TTS_VOICES = new Set([
      'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage', 'ash', 'ballad', 'verse'
    ]);
    // Validate env overrides too: a misconfigured voice must never be forwarded.
    const legalVoice = (value, fallback) => {
      const v = String(value || '').trim().toLowerCase();
      return OPENAI_TTS_VOICES.has(v) ? v : fallback;
    };
    const defaultVoice = legalVoice(env.OPENAI_TTS_VOICE, 'alloy');
    // Per-gender pools so distinct same-gender speakers do not collapse to one
    // voice. The env value seeds the pool; further same-gender speakers cycle
    // through the remaining legal voices.
    const malePool = [legalVoice(env.OPENAI_TTS_VOICE_MALE, 'onyx'), 'echo', 'fable', 'ash'].filter(
      (v, i, a) => a.indexOf(v) === i
    );
    const femalePool = [legalVoice(env.OPENAI_TTS_VOICE_FEMALE, 'nova'), 'shimmer', 'coral', 'sage'].filter(
      (v, i, a) => a.indexOf(v) === i
    );
    const genderFor = (name) => {
      const match = (Array.isArray(speakers) ? speakers : []).find((s) => s && s.name === name);
      const raw = String((match && match.voice) || '').trim().toLowerCase();
      if (raw === 'male' || raw === 'homme' || raw === 'h') return 'male';
      if (raw === 'female' || raw === 'femme' || raw === 'f') return 'female';
      return null;
    };
    // Assign a distinct voice per distinct speaker name; same-gender speakers
    // advance to the next voice in their pool.
    const voiceAssignments = new Map();
    const counters = { male: 0, female: 0, other: 0 };
    for (const speaker of Array.isArray(speakers) ? speakers : []) {
      if (!speaker || typeof speaker.name !== 'string') continue;
      if (voiceAssignments.has(speaker.name)) continue;
      const gender = genderFor(speaker.name);
      const raw = String(speaker.voice || '').trim().toLowerCase();
      if (gender === 'male') {
        voiceAssignments.set(speaker.name, malePool[counters.male++ % malePool.length]);
      } else if (gender === 'female') {
        voiceAssignments.set(speaker.name, femalePool[counters.female++ % femalePool.length]);
      } else if (OPENAI_TTS_VOICES.has(raw)) {
        voiceAssignments.set(speaker.name, raw);
      } else {
        voiceAssignments.set(speaker.name, defaultVoice);
      }
    }
    const voiceFor = (name) => voiceAssignments.get(name) || defaultVoice;
    const timeoutMs = Number(env.TTS_TIMEOUT_MS) || 45000;

    try {
      const segments = await mapPool(utterances, 3, async (utterance, index) => {
        const voice = voiceFor(utterance.speaker);
        const result = await withOneRetry(() =>
          requestBinary({
            httpRequest,
            url: 'https://api.openai.com/v1/audio/speech',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.OPENAI_API_KEY}`
            },
            body: { model, voice, input: String(utterance.text), response_format: 'mp3' },
            timeoutMs,
            label: 'OpenAI TTS'
          })
        );
        return {
          speaker: utterance.speaker,
          mime: result.mime || 'audio/mpeg',
          base64: result.buffer.toString('base64'),
          pause_after_ms: index === utterances.length - 1 ? 0 : TTS_PAUSE_MS
        };
      });

      res.json({ segments });
    } catch (err) {
      console.error('[tts] error:', err && err.message ? err.message : err);
      sendProviderError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /health — configuration booleans only, never secret values.
  // -------------------------------------------------------------------------
  app.get('/health', (_req, res) => {
    const requested = String(env.TEXT_PROVIDER || 'ollama')
      .trim()
      .toLowerCase();
    const selected = providers[requested] || null;
    res.json({
      ok: true,
      textProvider: selected ? selected.name : requested,
      textProviderConfigured: selected ? selected.isConfigured() : false,
      textModelConfigured: selected ? selected.isModelConfigured() : false,
      ttsConfigured: Boolean(env.OPENAI_API_KEY),
      passwordRequired: Boolean(env.APP_PASSWORD)
    });
  });

  app.get('/legacy', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

const app = createApp();

function start() {
  const server = app.listen(PORT, () => {
    const env = process.env;
    const requested = String(env.TEXT_PROVIDER || 'ollama')
      .trim()
      .toLowerCase();
    const selected = makeProviders({ env })[requested];
    if (!selected) {
      console.warn(`[warn] Unknown TEXT_PROVIDER "${env.TEXT_PROVIDER}". Use "ollama" (default) or "openai".`);
    } else if (!selected.isConfigured()) {
      console.warn(`[warn] TEXT_PROVIDER=${selected.name} is selected but its API key is not set. See .env.example.`);
    } else if (!selected.isModelConfigured()) {
      console.warn(`[warn] TEXT_PROVIDER=${selected.name} has no model configured (set the model env var). See .env.example.`);
    }
    if (!env.OPENAI_API_KEY) {
      console.warn('[warn] OPENAI_API_KEY is not set — listening audio (/api/tts) is unavailable until it is configured.');
    }
    if (env.APP_PASSWORD) {
      console.log('[info] Password gate is ENABLED (APP_PASSWORD is set).');
    } else {
      console.log('[info] Password gate is DISABLED — set APP_PASSWORD in .env to require one.');
    }
    console.log(`Ooh La Langue running at http://localhost:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = {
  app,
  start,
  createApp,
  makeProviders,
  selectProvider,
  defaultHttpRequest,
  ProviderError,
  withOneRetry,
  buildSystemPrompt,
  buildWorksheetPrompt,
  buildWorksheetRepairPrompt,
  assignSectionTopics,
  summarizeWorksheetTopic,
  buildFeedbackPrompt,
  buildFeedbackRepairPrompt,
  trimHistory,
  sanitizeName,
  sanitizeFact,
  sanitizeProfile,
  checkPassword,
  safeEqual,
  validateWorksheet,
  validateFeedback,
  normalizeWorksheet,
  normalizeAnswers,
  worksheetAudioKey,
  extractJson,
  mapPool,
  CURRICULUM_MODULES,
  CURRICULUM_SUMMARY,
  WORKSHEET_SECTION_IDS,
  WORKSHEET_SYSTEM_PROMPT,
  QUESTION_TYPES,
  FEEDBACK_VERDICTS,
  FEEDBACK_ERROR_TYPES,
  MAX_TTS_CHARS
};
