require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json(data);
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.json({ text, raw: data });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ooh La Langue running at http://localhost:${PORT}`);
});
