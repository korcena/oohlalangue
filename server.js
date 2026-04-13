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

// A rotation of A1-friendly opening angles. The server picks one at random
// for each new session so the teacher doesn't always ask the same thing.
const OPENING_TOPICS = [
  { topic: 'their day so far', hint: 'Comment ça va aujourd\'hui ? / Comment se passe ta journée ?' },
  { topic: 'how they are feeling right now', hint: 'Ça va ? Tu te sens comment ?' },
  { topic: 'what they ate for breakfast or their last meal', hint: 'Qu\'est-ce que tu as mangé ce matin ?' },
  { topic: 'the weather where they are', hint: 'Quel temps fait-il chez toi ?' },
  { topic: 'their weekend plans or what they did last weekend', hint: 'Qu\'est-ce que tu fais ce week-end ?' },
  { topic: 'their favorite hobby or something they enjoy doing', hint: 'Quel est ton passe-temps préféré ?' },
  { topic: 'their family — siblings, parents, or pets', hint: 'Tu as des frères et sœurs ?' },
  { topic: 'where they live — city, country, or type of home', hint: 'Où est-ce que tu habites ?' },
  { topic: 'a favorite food or drink', hint: 'Quelle est ta boisson préférée ?' },
  { topic: 'how they got to where they are (transport)', hint: 'Comment tu es venu(e) ici aujourd\'hui ?' },
  { topic: 'their work or studies', hint: 'Qu\'est-ce que tu fais dans la vie ?' },
  { topic: 'a movie, show, or book they like', hint: 'Tu as un film préféré ?' },
  { topic: 'a place they would like to visit', hint: 'Où est-ce que tu voudrais voyager ?' },
  { topic: 'their morning routine', hint: 'À quelle heure tu te lèves le matin ?' },
  { topic: 'their plans for this evening', hint: 'Qu\'est-ce que tu fais ce soir ?' }
];

const GREETINGS = ['Bonjour', 'Salut', 'Coucou', 'Hé'];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// `isOpening` is true when this is the very first turn of a new session.
// We only randomize the opener for that turn — once the conversation is
// under way, Claude picks the next topic naturally from its rotation.
function buildSystemPrompt(rawName, isOpening) {
  const name = sanitizeName(rawName) || 'the student';
  const opening = pickRandom(OPENING_TOPICS);
  const greeting = pickRandom(GREETINGS);

  const openingBlock = isOpening
    ? `FIRST TURN: Greet ${name} in French with "${greeting} ${name} !" (or a similar warm variation) and ask ONE short A1 question about ${opening.topic}. Inspiration only: "${opening.hint}" — use your own wording. 1–2 sentences total.`
    : `Keep responses short: feedback markers + one next question.`;

  return `You are a warm, playful French teacher helping ${name}, an A1 beginner, practice French. Address ${name} by name naturally.

EACH TURN (after the first):
1. React briefly in English (one short line).
2. Then use these exact markers on their own lines:
✅ GOOD: [what was right]
🔧 FIX: [mistake] → [correct form] — [simple English explanation]
💬 CORRECTED: [full corrected sentence]
3. Ask ONE new simple A1 question.

RULES:
- A1 vocabulary only.
- Rotate topics: daily routines, food, family, hobbies, weather, shopping, transport, work, home, health.
- Max 2 FIX lines per turn. If the reply is fully correct, celebrate and skip FIX.
- Watch: elision (j'), je + conjugated verb (not infinitive), ne…pas, gender (le/la/un/une), lowercase days/months, "aussi" after the verb, en vs à.
- Simple English explanations only.
- Vary your phrasing between sessions.

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

  const { messages, name } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be a non-empty array' } });
  }

  const isOpening = messages.length === 1;
  const trimmedMessages = trimHistory(messages, 20);

  try {
    const { status, data } = await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: buildSystemPrompt(name, isOpening),
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
