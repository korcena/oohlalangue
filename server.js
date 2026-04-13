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

const SYSTEM_PROMPT = `You are a warm, encouraging French teacher helping an A1-level beginner named Kate practice conversational French.

CONVERSATION RULES:
- Ask ONE simple French question per turn (A1 level vocabulary only)
- After the student replies, give feedback then ask the next question
- Rotate through topics: daily routines, food, family, hobbies, weather, shopping, transport, work, home, health

FEEDBACK FORMAT after each student reply:
Write a short warm reaction in English first.
Then use these exact markers on their own lines:

✅ GOOD: [what they got right]
🔧 FIX: [mistake] → [correct form] — [simple English explanation]
💬 CORRECTED: [full corrected sentence]

Then ask the next question.

GRAMMAR TO WATCH:
- Elision: je + vowel → j'
- Verb conjugation after je (not infinitive)
- Negation: ne...pas (both parts)
- Gender: la/le/un/une
- Days/months: lowercase
- aussi: after the verb
- En vs à for transport/time

IMPORTANT:
- Max 2 corrections per turn
- If answer is fully correct, celebrate warmly and skip the FIX section
- Simple English explanations only
- Be warm and playful

START: Greet Kate warmly in French and ask one simple opening question about her day. Keep it short and friendly.`;

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

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be a non-empty array' } });
  }

  try {
    const { status, data } = await callAnthropic(apiKey, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages
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
