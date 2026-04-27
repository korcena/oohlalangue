# Ooh La Langue

A tiny web app for practicing French conversation with a warm, playful AI tutor. You chat in French; the tutor replies in English with a per-turn correction block (`✅ GOOD`, `🔧 FIX`, `💬 CORRECTED`) and an A1-level follow-up question drawn from a structured curriculum.

Built around the [Anthropic Messages API](https://docs.claude.com/en/api/messages) (Claude Haiku 4.5), Node.js, and a single static HTML page — no build step, no framework.

---

## Features

- **A1 curriculum-driven prompts.** Each session picks one module (salutations, passé composé, prépositions, métiers, …) and anchors the teacher's questions around it, so you practice concrete grammar instead of generic "how was your day" chatter.
- **Structured corrections.** The teacher response is parsed on the client into three sections: what you got right, what to fix, and the fully corrected sentence — rendered as clean cards, not a wall of text.
- **Teach-on-English.** Drop an English word into your French ("je want du café") and the tutor translates it into the corrected sentence and explains how to use it, instead of rejecting the turn.
- **Session limit with timer.** Every 5 answers the composer is replaced with a live 3-hour countdown. State is persisted in `localStorage`, so refreshing or closing the tab doesn't reset it. The 5th answer never spawns a wasted question the student would be locked out of.
- **Personalization that persists.** The tutor quietly extracts short facts it learns (hobbies, family, job, city, …) via a hidden `<note>…</note>` trailer, the client strips the tag and stores the facts in `localStorage`, and future prompts include them under `KNOWN ABOUT <NAME>` so questions feel personal across sessions.
- **Optional password gate** for shared deployments.
- **Mobile-friendly.** The chat handles iOS/Android virtual-keyboard quirks with `visualViewport` tracking and scroll-pinning.

---

## Quickstart

```bash
git clone https://github.com/korcena/oohlalangue.git
cd oohlalangue
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY
npm start
```

Then open <http://localhost:3000>.

### Requirements

- **Node.js ≥ 18** (uses built-in `https` only — no native `fetch` dependency).
- An **Anthropic API key**. Get one at <https://console.anthropic.com/>.

### Environment variables

| Variable            | Required | Description                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Your Anthropic API key.                                                   |
| `PORT`              | no       | HTTP port to listen on (default `3000`).                                  |
| `APP_PASSWORD`      | no       | If set, visitors must enter this password before they can chat. Leave blank to disable the gate. |

---

## Architecture

```
┌──────────────┐        POST /api/chat          ┌──────────────┐        ┌────────────────┐
│  index.html  │ ──────────────────────────────▶│  server.js   │ ─────▶ │ Anthropic API  │
│  (vanilla JS)│    { messages, name,           │   (Express)  │        │  claude-haiku  │
│              │◀──   profile, skipQuestion }   │              │◀─────  │  4.5           │
└──────────────┘        { text, raw }           └──────────────┘        └────────────────┘
       │
       ├── localStorage
       │     oohlalangue_name
       │     oohlalangue_password
       │     oohlalangue_profile       (array of learned facts)
       │     oohlalangue_answers       (0–5 counter)
       │     oohlalangue_pause_until   (epoch ms)
       └── in-memory history (the Messages-API transcript)
```

- **`server.js`** is a thin Express server that:
  - Serves the static `index.html`.
  - Gates `/api/chat` behind the optional password.
  - Builds the per-request system prompt (curriculum module, known facts, session-end instructions) and forwards the trimmed conversation to Anthropic's Messages API.
- **`index.html`** holds everything else: chat UI, correction parser, localStorage profile, session-limit timer, mobile keyboard handling. No build step; edit and reload.

---

## Curriculum

Each session randomly picks one module and anchors the teacher's questions around it. There are currently **38 modules** spanning A1 grammar, vocabulary, and everyday situations.

### Core A1

| Module | Focus |
|---|---|
| Les Salutations | Formal vs informal greetings, "comment ça va" |
| Les Nombres | Numbers 0–100 (age, phone, quantities) |
| Les Jours et Les Mois | Days of the week (lowercase!) and months |
| Les Fruits | Fruits with correct gender (le/la/un/une) |
| La Famille | Family vocabulary + possessives (mon/ma/mes) |
| Le Verbe ÊTRE | être in present, c'est / c'était |
| Les Verbes Réfléchis | SE verbs: se lever, s'appeler, se promener |
| Les Verbes Communs | Irregular verbs: aller, avoir, faire, prendre, vouloir |
| Les Pays | Countries with en / au / aux |
| Les Articles | Partitive du / de la / de l'; "de" after negation |
| Les Possessifs | mon/ma/mes, ton/ta/tes, son/sa/ses |
| Poser une Question | qui / quoi / quand / où / comment / pourquoi / combien |

### Places & Directions

| Module | Focus |
|---|---|
| La Position | Prepositions: dans, sur, sous, devant, derrière, à côté de, chez |
| La Direction | à / au / aux / de / vers; contractions à+le=au, de+le=du |
| Les Lieux | Places in the city: boulangerie, poste, supermarché |
| Les Voies | Streets & waterways: rue, avenue, boulevard, pont, quai |
| Les Parties de la Ville | centre-ville, banlieue, quartier, zone piétonne |
| Les Lieux et les Monuments | Public buildings: mairie, gare, commissariat, banque |

### Daily Life

| Module | Focus |
|---|---|
| La Vie Quotidienne | Café / restaurant vocabulary and drinks |
| Les Métiers | Jobs — no article after être; chez + person |
| Les Loisirs | Hobbies with jouer à (sports) vs jouer de (instruments) |
| Les Adjectifs | Agreement (m/f) and BAGS rule |
| IL Y A | il y a / il n'y a pas de / il y a + time (ago) |
| La Fréquence | toujours, souvent, parfois, rarement, ne…jamais; aussi after verb |
| La Météo | il fait, il pleut, il neige, il y a du vent |
| Le Temps | Time expressions: depuis, il y a, avant, après, pendant |
| Les Nombres Ordinaux | Ordinals and floors (premier, deuxième, rez-de-chaussée) |

### Grammar

| Module | Focus |
|---|---|
| Le Passé Composé | avoir for most, être for DR MRS VANDERTRAMP + SE verbs; feminine -e |
| Le Fonctionnement | Intensity adverbs: très, trop, assez, vraiment, beaucoup, un peu |
| L'Impératif | TU/VOUS/NOUS (no pronoun, -ER drops -s); sois/aie/va; pour, parce que, mais, sans, ne…que, pendant |

### Transport & Getting Around (Apr 2026)

| Module | Focus |
|---|---|
| Le Transport | Vehicles (scooter, vélo, bus, métro, voiture, avion), se déplacer, monter, tourner à droite/gauche, tout droit |
| Les Distances et le Covoiturage | Which transport for which distance; trajet, itinéraire, arrêt, quai; économiser, covoiturage |

### Food & Descriptions (Apr 2026)

| Module | Focus |
|---|---|
| La Nourriture | petit-déjeuner, poireau, poire, citrouille, haricots, maïs, ail, piment, pastèque, pamplemousse |
| Les Pas et Les Étapes | Distinctions: les pas (walking), une étape (process), une marche (stairs) |
| La Routine et les Descriptions | se lever, se dépêcher, se marier; retraité(e), bruyant, droitier/gaucher/ambidextre |

### Advanced (Apr 2026)

| Module | Focus |
|---|---|
| La Météo Avancée | orage, tonnerre, para- words (parapente, parasol, paratonnerre) |
| Les Verbes Clés | prendre (full conjugation), devoir, apporter, économiser, voyager |
| Les Expressions Idiomatiques | peu m'importe, au bord du gouffre, c'est la fin des haricots, tu sens bon |

---

## Customization

### Add or edit curriculum modules

Each module in `server.js` is an object with a `module`, a `focus` line, and a short `hint`. Add entries to the `CURRICULUM_MODULES` array and optionally extend `CURRICULUM_SUMMARY` so the model has context when it drifts between topics.

### Change the tutor's persona or correction format

The system prompt is built in `buildSystemPrompt()` (`server.js`). The `EACH TURN` block drives how the client parses the reply — if you change the emoji markers (`✅ GOOD:`, `🔧 FIX:`, `💬 CORRECTED:`), update the regex map in `parseTeacherReply()` inside `index.html` to match.

### Adjust session limits

In `index.html`:

```js
const ANSWERS_PER_WINDOW = 5;
const PAUSE_MS = 3 * 60 * 60 * 1000; // 3 hours
```

### Reset a student's profile or session state

The student can clear everything from DevTools:

```js
localStorage.clear();
```

---

## Deploying

It's a single Node process serving static files — deploy anywhere Node runs:

- **Render / Railway / Fly.io:** point the service at `npm start`, set the env vars, and you're done.
- **VPS:** `pm2 start server.js --name oohlalangue`, put Nginx in front for TLS.
- **Shared link:** set `APP_PASSWORD` so visitors must enter it before any requests hit Anthropic on your API key.

Cost is bounded per turn: Haiku 4.5, `max_tokens: 500`, and the conversation history is trimmed to the last ~20 messages before each call.

---

## Project layout

```
.
├── server.js        # Express server + Anthropic proxy
├── index.html       # Single-page chat UI (HTML + CSS + vanilla JS)
├── package.json
├── .env.example
└── README.md
```

---

## License

`UNLICENSED` — this is a personal project. All rights reserved. Feel free to read the code for learning purposes.
