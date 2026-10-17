'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createApp,
  makeProviders,
  selectProvider,
  withOneRetry,
  ProviderError,
  buildSystemPrompt,
  buildFeedbackPrompt,
  normalizeWorksheet,
  normalizeAnswers,
  extractJson,
  worksheetAudioKey,
  trimHistory,
  CURRICULUM_MODULES
} = require('../server.js');

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'system-prompt.golden.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(status, data, mime = 'application/json') {
  return {
    status,
    headers: { 'content-type': mime },
    buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
  };
}

function makeFetchMock(handler) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

// Start the express app on an ephemeral port and return a fetch base URL.
async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Golden system prompt — must be byte-for-byte unchanged.
// ---------------------------------------------------------------------------

test('buildSystemPrompt output is unchanged (golden)', () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const cases = {
      opening: ['Kate', true, [], false, false],
      normal: ['Kate', false, ['loves coffee', 'has a cat'], false, false],
      skip: ['Kate', false, [], true, false],
      voice: ['Kate', false, ['lives in Lyon'], false, true],
      skipVoice: ['Kate', false, [], true, true],
      defaultName: ['', true, [], false, false]
    };
    for (const [key, args] of Object.entries(cases)) {
      assert.equal(buildSystemPrompt(...args), golden[key], `golden mismatch for ${key}`);
    }
  } finally {
    Math.random = originalRandom;
  }
});

test('trimHistory keeps the kickoff and trims from the middle', () => {
  const messages = [{ role: 'user', content: 'Start!' }];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  }
  const trimmed = trimHistory(messages, 20);
  assert.equal(trimmed[0].content, 'Start!');
  assert.equal(trimmed.length, 21);
  assert.equal(trimmed[1].role, 'user');
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

test('selectProvider defaults to ollama when TEXT_PROVIDER is unset', () => {
  const provider = selectProvider({});
  assert.equal(provider.name, 'ollama');
});

test('selectProvider honours openai', () => {
  const provider = selectProvider({ TEXT_PROVIDER: 'openai' });
  assert.equal(provider.name, 'openai');
});

test('selectProvider rejects unknown providers with an actionable error', () => {
  assert.throws(
    () => selectProvider({ TEXT_PROVIDER: 'gpt5' }),
    (err) => err instanceof ProviderError && /Unknown TEXT_PROVIDER/.test(err.message) && err.status === 500
  );
});

// ---------------------------------------------------------------------------
// Provider builds the right request and parses both response shapes
// ---------------------------------------------------------------------------

test('ollama provider builds the expected URL/headers/body and parses message.content', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: 'Bonjour !' } }));
  const providers = makeProviders({
    httpRequest: fetchImpl,
    env: { OLLAMA_API_KEY: 'secret', OLLAMA_MODEL: 'llama-test', OLLAMA_BASE_URL: 'https://ollama.test/api/chat' }
  });
  const out = await providers.ollama.chatCompletion({
    system: 'SYS',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 123
  });
  assert.equal(out.text, 'Bonjour !');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://ollama.test/api/chat');
  assert.equal(call.headers.Authorization, 'Bearer secret');
  assert.equal(call.body.model, 'llama-test');
  assert.equal(call.body.think, false);
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages[0].content, 'SYS');
  assert.equal(call.body.options.num_predict, 123);
});

test('ollama provider applies the strict, trimmed, case-insensitive OLLAMA_THINK rule', async () => {
  const cases = [
    ['true', true],
    ['TRUE', true],
    [' true ', true],
    ['True', true],
    ['false', false],
    ['0', false],
    ['yes', false],
    ['', false],
    ['truex', false],
    [undefined, false]
  ];
  for (const [value, expected] of cases) {
    const env = { OLLAMA_API_KEY: 'secret', OLLAMA_MODEL: 'llama-test' };
    if (value !== undefined) env.OLLAMA_THINK = value;
    const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: 'ok' } }));
    const providers = makeProviders({ httpRequest: fetchImpl, env });
    await providers.ollama.chatCompletion({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(
      fetchImpl.calls[0].body.think,
      expected,
      `OLLAMA_THINK=${JSON.stringify(value)} should map to think:${expected}`
    );
  }
});

test('ollama empty content still rejects with the 502 empty-response fallback and no retry', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: '' } }));
  const providers = makeProviders({
    httpRequest: fetchImpl,
    env: { OLLAMA_API_KEY: 'secret', OLLAMA_MODEL: 'llama-test' }
  });
  await assert.rejects(
    () => providers.ollama.chatCompletion({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof ProviderError && /Ollama returned an empty response/.test(err.message) && err.status === 502
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('openai provider builds the expected URL/headers/body and parses choices[0].message.content', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { choices: [{ message: { content: 'Salut !' } }] }));
  const providers = makeProviders({ httpRequest: fetchImpl, env: { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-test' } });
  const out = await providers.openai.chatCompletion({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.text, 'Salut !');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'gpt-test');
  assert.ok(!('think' in call.body), 'openai body must not carry the ollama think flag');
  assert.equal(call.body.messages[0].role, 'system');
});

// ---------------------------------------------------------------------------
// Missing keys — no outbound call ever happens
// ---------------------------------------------------------------------------

test('ollama missing key yields actionable 500 with no outbound call', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, {}));
  const providers = makeProviders({ httpRequest: fetchImpl, env: {} });
  await assert.rejects(
    () => providers.ollama.chatCompletion({ system: 's', messages: [] }),
    (err) => err.status === 500 && /OLLAMA_API_KEY is not set/.test(err.message)
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('openai missing key yields actionable 500 with no outbound call', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, {}));
  const providers = makeProviders({ httpRequest: fetchImpl, env: {} });
  await assert.rejects(
    () => providers.openai.chatCompletion({ system: 's', messages: [] }),
    (err) => err.status === 500 && /OPENAI_API_KEY is not set/.test(err.message)
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Retry semantics
// ---------------------------------------------------------------------------

test('withOneRetry retries exactly once on transient failure then succeeds', async () => {
  let attempts = 0;
  const out = await withOneRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new ProviderError('flaky', { transient: true, status: 502 });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(attempts, 2);
});

test('withOneRetry does not retry non-transient errors', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withOneRetry(async () => {
        attempts += 1;
        throw new ProviderError('bad request', { transient: false, status: 400 });
      }),
    /bad request/
  );
  assert.equal(attempts, 1);
});

test('provider retries a 5xx once and surfaces it after the second attempt', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(500, { error: { message: 'upstream boom' } }));
  const providers = makeProviders({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await assert.rejects(
    () => providers.ollama.chatCompletion({ system: 's', messages: [] }),
    (err) => err.status === 502 && /upstream error/.test(err.message)
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('provider does not retry a 4xx', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(400, { error: { message: 'bad request' } }));
  const providers = makeProviders({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await assert.rejects(() => providers.ollama.chatCompletion({ system: 's', messages: [] }), /bad request/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('a provider 4xx is surfaced as 502 PROVIDER_ERROR, not a client 401', async () => {
  // A provider-side 401 (bad API key) must not reach the client as 401, or the
  // chat view would mistake it for an expired app password.
  const fetchImpl = makeFetchMock(() => jsonResponse(401, { error: { message: 'invalid api key' } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'bad', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Salut' }] })
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');
    assert.match(body.error.message, /invalid api key/);
  });
});

// ---------------------------------------------------------------------------
// /health — booleans only, never secret values
// ---------------------------------------------------------------------------

test('GET /health reports provider booleans without secrets', async () => {
  const app = createApp({
    httpRequest: makeFetchMock(() => jsonResponse(200, {})),
    env: {
      TEXT_PROVIDER: 'openai',
      OPENAI_API_KEY: 'super-secret-key',
      OPENAI_MODEL: 'gpt-test',
      APP_PASSWORD: 'hunter2'
    }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.textProvider, 'openai');
    assert.equal(body.textProviderConfigured, true);
    assert.equal(body.textModelConfigured, true);
    assert.equal(body.ttsConfigured, true);
    assert.equal(body.passwordRequired, true);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('super-secret-key'), 'must not leak api key');
    assert.ok(!serialized.includes('hunter2'), 'must not leak password');
  });
});

test('GET /health defaults to ollama and reports unconfigured honestly', async () => {
  const app = createApp({ httpRequest: makeFetchMock(() => jsonResponse(200, {})), env: {} });
  await withServer(app, async (base) => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.textProvider, 'ollama');
    assert.equal(body.textProviderConfigured, false);
    assert.equal(body.ttsConfigured, false);
    assert.equal(body.passwordRequired, false);
  });
});

// ---------------------------------------------------------------------------
// /api/chat
// ---------------------------------------------------------------------------

test('POST /api/chat with no provider configured returns an honest 500', async () => {
  const app = createApp({ httpRequest: makeFetchMock(() => jsonResponse(200, {})), env: {} });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Start!' }] })
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error.message, /OLLAMA_API_KEY is not set/);
  });
});

test('POST /api/chat returns text and preserves the request contract', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: 'Bonjour Kate !' } }));
  const app = createApp({
    httpRequest: fetchImpl,
    env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Start!' }], name: 'Kate', profile: [], skipQuestion: false, voiceMode: true })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.text, 'Bonjour Kate !');
    // Provider/model details must not cross the boundary into the client.
    assert.equal(body.raw, undefined);
    assert.deepEqual(Object.keys(body), ['text']);
  });
});

test('POST /api/auth accepts the correct password and rejects the wrong one', async () => {
  const app = createApp({
    httpRequest: makeFetchMock(() => jsonResponse(200, {})),
    env: { APP_PASSWORD: 'pw', OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' }
  });
  await withServer(app, async (base) => {
    const good = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': 'pw' },
      body: JSON.stringify({})
    });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true, required: true });

    const bad = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': 'nope' },
      body: JSON.stringify({})
    });
    assert.equal(bad.status, 401);
  });
});

test('POST /api/chat enforces APP_PASSWORD', async () => {
  const app = createApp({
    httpRequest: makeFetchMock(() => jsonResponse(200, { message: { content: 'x' } })),
    env: { APP_PASSWORD: 'pw', OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// /api/generate
// ---------------------------------------------------------------------------

const validWorksheet = {
  topic: 'Au café',
  level: 'A1',
  sections: [
    {
      id: 'listening',
      title_fr: 'Compréhension orale',
      instructions_fr: 'Écoute et réponds.',
      audio: { script: 'Bonjour ! Tu veux un café ?', speakers: [{ name: 'A', voice: 'alloy' }], cache_key: '' },
      questions: [
        { id: 'l1', prompt: 'Que veut le client ?', type: 'choice', options: ['un café', 'un thé'], answer: 'un café', explanation: 'Le client commande un café.' }
      ]
    },
    {
      id: 'reading',
      title_fr: 'Compréhension écrite',
      instructions_fr: 'Lis et réponds.',
      text_fr: 'Paul entre dans un café et commande un café.',
      questions: [{ id: 'r1', prompt: 'Où ?', type: 'short_text', answer: 'au café', explanation: 'Lieu.' }]
    }
  ]
};

test('POST /api/generate accepts a valid worksheet and computes the audio cache key', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: JSON.stringify(validWorksheet) } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Au café' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.topic, 'Au café', 'explicit topic must survive untouched');
    assert.equal(body.sections[0].id, 'listening');
    assert.match(body.sections[0].audio.cache_key, /^[a-f0-9]{32}$/);
    assert.equal(body.sections.length, 2);
    // The outgoing request carries the worksheet system prompt; pin the two
    // rules that keep the fiche French-only and the reading passage present.
    const systemPrompt = fetchImpl.calls[0].body.messages[0].content;
    assert.match(systemPrompt, /EVERY learner-facing string MUST be written in French only/);
    assert.match(systemPrompt, /The "text_fr" field MUST appear ONLY on the "reading" section/);
  });
});

test('POST /api/generate auto-selects a curriculum topic when none is provided', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: JSON.stringify(validWorksheet) } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  const moduleNames = CURRICULUM_MODULES.map((m) => m.module);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ length: 'medium' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.topic, 'string');
    assert.ok(body.topic.length > 0, 'auto topic must be non-empty');
    assert.ok(moduleNames.includes(body.topic), `auto topic "${body.topic}" must be a curriculum module`);
    // The auto-selected module must reach the model prompt, not just the response.
    const upstreamPrompt = fetchImpl.calls
      .map((call) => (call.body && call.body.messages ? call.body.messages.map((m) => m.content).join('\n') : ''))
      .join('\n');
    assert.ok(
      upstreamPrompt.includes(body.topic),
      `prompt must mention the auto-selected module "${body.topic}"`
    );
  });
});

test('POST /api/generate treats a whitespace-only topic as absent and auto-selects', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: JSON.stringify(validWorksheet) } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  const moduleNames = CURRICULUM_MODULES.map((m) => m.module);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '   ', length: 'medium' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(moduleNames.includes(body.topic), `whitespace topic must fall back to a curriculum module`);
  });
});

const invalidWorksheet = {
  topic: 'Bad',
  sections: [
    {
      id: 'reading',
      title_fr: 'Lecture',
      instructions_fr: 'Lis.',
      text_fr: 'Un texte.',
      questions: [{ id: 'q1', prompt: 'Pick', type: 'choice', answer: 'a', explanation: 'x' }]
    }
  ]
};

test('POST /api/generate repairs once then 502s when still invalid', async () => {
  let call = 0;
  const fetchImpl = makeFetchMock(() => {
    call += 1;
    return jsonResponse(200, { message: { content: JSON.stringify(invalidWorksheet) } });
  });
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'x' })
    });
    assert.equal(res.status, 502);
    assert.equal(call, 2, 'expected exactly one repair retry');
  });
});

const noInstructionsWorksheet = {
  topic: 'Sans consigne',
  sections: [
    {
      id: 'reading',
      title_fr: 'Lecture',
      text_fr: 'Un texte.',
      questions: [{ id: 'q1', prompt: 'p', type: 'short_text', answer: 'a', explanation: 'x' }]
    }
  ]
};

test('POST /api/generate repairs once then 502s when a section lacks instructions_fr', async () => {
  let call = 0;
  const fetchImpl = makeFetchMock(() => {
    call += 1;
    return jsonResponse(200, { message: { content: JSON.stringify(noInstructionsWorksheet) } });
  });
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'x' })
    });
    assert.equal(res.status, 502);
    assert.equal(call, 2, 'expected exactly one repair retry');
  });
});

// ---------------------------------------------------------------------------
// /api/feedback
// ---------------------------------------------------------------------------

test('POST /api/feedback validates shape and preserves the original answer', async () => {
  const feedback = {
    answers: [
      {
        question_id: 'r1',
        original: 'MODEL REWROTE THIS',
        verdict: 'mistake',
        correction: 'Je vais au café.',
        explanation: 'Use aller + au.',
        error_type: 'error'
      }
    ],
    summary: { strengths: ['good effort'], recurring_mistakes: [], priorities: ['aller'], follow_up: 'Write 3 sentences.' }
  };
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: JSON.stringify(feedback) } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worksheet: { topic: 'x', sections: [{ id: 'reading', title_fr: 't', instructions_fr: 'e', text_fr: 'Un texte.', questions: [{ id: 'r1', prompt: 'p', type: 'short_text', answer: 'a', explanation: 'x' }] }] },
        answers: { r1: 'Je vais au cafe' }
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.answers[0].original, 'Je vais au cafe');
  });
});

test('POST /api/feedback sends a French-only system prompt', async () => {
  const feedback = {
    answers: [
      { question_id: 'r1', original: 'x', verdict: 'correct', correction: 'x', explanation: 'y', error_type: 'style' }
    ],
    summary: { strengths: [], recurring_mistakes: [], priorities: [], follow_up: 'next' }
  };
  const fetchImpl = makeFetchMock(() => jsonResponse(200, { message: { content: JSON.stringify(feedback) } }));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worksheet: { topic: 'x', sections: [{ id: 'reading', title_fr: 't', instructions_fr: 'e', text_fr: 'Un texte.', questions: [{ id: 'r1', prompt: 'p', type: 'short_text', answer: 'a', explanation: 'x' }] }] },
        answers: { r1: 'x' }
      })
    });
    assert.equal(res.status, 200);
    const system = fetchImpl.calls[0].body.messages[0].content;
    assert.match(system, /French only/i);
  });
});

test('buildFeedbackPrompt includes the reading text and the listening script', () => {
  const worksheet = {
    topic: 'x',
    sections: [
      {
        id: 'listening',
        title_fr: 'Écoute',
        instructions_fr: 'e',
        audio: { script: 'LE SCRIPT ORAL' },
        questions: [{ id: 'l1', prompt: 'p', type: 'short_text', answer: 'a' }]
      },
      {
        id: 'reading',
        title_fr: 'Lis',
        instructions_fr: 'e',
        text_fr: 'LE TEXTE À LIRE',
        questions: [{ id: 'r1', prompt: 'p', type: 'short_text', answer: 'a' }]
      }
    ]
  };
  const prompt = buildFeedbackPrompt(worksheet, {});
  assert.ok(prompt.includes('LE SCRIPT ORAL'), 'listening script must be included');
  assert.ok(prompt.includes('LE TEXTE À LIRE'), 'reading text must be included');
  assert.match(prompt, /French only/);
});

// ---------------------------------------------------------------------------
// /api/tts
// ---------------------------------------------------------------------------

test('POST /api/tts without OPENAI_API_KEY returns actionable error, no outbound call', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, ''));
  const app = createApp({ httpRequest: fetchImpl, env: { OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'm' } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterances: [{ speaker: 'A', text: 'Bonjour' }], speakers: [{ name: 'A', voice: 'alloy' }] })
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /OPENAI_API_KEY is not set/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('POST /api/tts routes per speaker and returns ordered base64 segments with pauses', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, 'AUDIO', 'audio/mpeg'));
  const app = createApp({
    httpRequest: fetchImpl,
    env: { OPENAI_API_KEY: 'sk', OPENAI_TTS_MODEL: 'tts-1', OPENAI_TTS_VOICE: 'alloy' }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterances: [
          { speaker: 'A', text: 'Bonjour' },
          { speaker: 'B', text: 'Salut' }
        ],
        speakers: [
          { name: 'A', voice: 'voice-a' },
          { name: 'B', voice: 'voice-b' }
        ],
        cache_key: 'abc'
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.segments.length, 2);
    assert.equal(body.segments[0].speaker, 'A');
    assert.equal(body.segments[0].base64, Buffer.from('AUDIO').toString('base64'));
    assert.equal(body.segments[0].pause_after_ms, 600);
    assert.equal(body.segments[1].pause_after_ms, 0);
    // Unknown/raw voice names are mapped to the legal default, never passed through.
    const voicesUsed = fetchImpl.calls.map((c) => c.body.voice);
    assert.deepEqual(voicesUsed, ['alloy', 'alloy']);
  });
});

test('POST /api/tts maps male/female speaker labels to legal OpenAI voices', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, 'AUDIO', 'audio/mpeg'));
  const app = createApp({
    httpRequest: fetchImpl,
    env: {
      OPENAI_API_KEY: 'sk',
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts',
      OPENAI_TTS_VOICE_MALE: 'onyx',
      OPENAI_TTS_VOICE_FEMALE: 'nova'
    }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterances: [
          { speaker: 'Marie', text: 'Bonjour !' },
          { speaker: 'Paul', text: 'Salut Marie !' }
        ],
        speakers: [
          { name: 'Marie', voice: 'female' },
          { name: 'Paul', voice: 'male' }
        ],
        cache_key: 'k'
      })
    });
    assert.equal(res.status, 200);
    const voicesUsed = fetchImpl.calls.map((c) => c.body.voice);
    assert.deepEqual(voicesUsed, ['nova', 'onyx']);
    // Every voice sent to OpenAI is a legal voice name.
    const LEGAL = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage', 'ash', 'ballad', 'verse']);
    for (const v of voicesUsed) assert.ok(LEGAL.has(v), `${v} must be a legal OpenAI voice`);
  });
});

test('POST /api/tts gives distinct voices to same-gender speakers', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, 'AUDIO', 'audio/mpeg'));
  const app = createApp({
    httpRequest: fetchImpl,
    env: { OPENAI_API_KEY: 'sk', OPENAI_TTS_VOICE_MALE: 'onyx', OPENAI_TTS_VOICE_FEMALE: 'nova' }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterances: [
          { speaker: 'Marie', text: 'Bonjour' },
          { speaker: 'Sophie', text: 'Salut' }
        ],
        speakers: [
          { name: 'Marie', voice: 'female' },
          { name: 'Sophie', voice: 'female' }
        ]
      })
    });
    assert.equal(res.status, 200);
    const voicesUsed = fetchImpl.calls.map((c) => c.body.voice);
    assert.equal(voicesUsed.length, 2);
    assert.notEqual(voicesUsed[0], voicesUsed[1], 'same-gender speakers must not share a voice');
  });
});

test('POST /api/tts validates env voice overrides and never forwards an illegal voice', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, 'AUDIO', 'audio/mpeg'));
  const app = createApp({
    httpRequest: fetchImpl,
    env: {
      OPENAI_API_KEY: 'sk',
      OPENAI_TTS_VOICE: 'not-a-voice',
      OPENAI_TTS_VOICE_MALE: 'also-bogus',
      OPENAI_TTS_VOICE_FEMALE: 'bogus-too'
    }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterances: [
          { speaker: 'Marie', text: 'Bonjour' },
          { speaker: 'Paul', text: 'Salut' }
        ],
        speakers: [
          { name: 'Marie', voice: 'female' },
          { name: 'Paul', voice: 'male' }
        ]
      })
    });
    assert.equal(res.status, 200);
    const LEGAL = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage', 'ash', 'ballad', 'verse']);
    for (const call of fetchImpl.calls) {
      assert.ok(LEGAL.has(call.body.voice), `${call.body.voice} must be a legal OpenAI voice`);
    }
  });
});

test('POST /api/tts maps a legal raw voice through and defaults unknown values', async () => {
  const fetchImpl = makeFetchMock(() => jsonResponse(200, 'AUDIO', 'audio/mpeg'));
  const app = createApp({
    httpRequest: fetchImpl,
    env: { OPENAI_API_KEY: 'sk', OPENAI_TTS_VOICE: 'sage' }
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterances: [
          { speaker: 'A', text: 'Un' },
          { speaker: 'B', text: 'Deux' }
        ],
        speakers: [
          { name: 'A', voice: 'shimmer' },
          { name: 'B', voice: 'gibberish' }
        ]
      })
    });
    assert.equal(res.status, 200);
    const voicesUsed = fetchImpl.calls.map((c) => c.body.voice);
    assert.deepEqual(voicesUsed, ['shimmer', 'sage']);
  });
});

// ---------------------------------------------------------------------------
// Helper unit tests (validation is covered in depth by validate.test.js)
// ---------------------------------------------------------------------------

test('extractJson handles fenced and prefixed JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":2} thanks'), { a: 2 });
  assert.equal(extractJson('not json'), null);
});

test('worksheetAudioKey is stable and distinct per script/voices', () => {
  const a = worksheetAudioKey('Bonjour   le monde', [{ name: 'A', voice: 'alloy' }]);
  const b = worksheetAudioKey('Bonjour le monde', [{ name: 'A', voice: 'alloy' }]);
  const c = worksheetAudioKey('Bonjour le monde', [{ name: 'A', voice: 'verse' }]);
  assert.equal(a, b, 'whitespace-normalized keys should match');
  assert.notEqual(a, c);
});

test('normalizeAnswers supports map and array forms', () => {
  assert.deepEqual(normalizeAnswers({ q1: 'a' }), { q1: 'a' });
  assert.deepEqual(normalizeAnswers([{ question_id: 'q1', answer: 'a' }]), { q1: 'a' });
  assert.deepEqual(normalizeAnswers(null), {});
});

test('normalizeWorksheet defaults level and recomputes cache key', () => {
  const out = normalizeWorksheet({ ...validWorksheet, level: undefined });
  assert.equal(out.level, 'A1');
  assert.ok(out.sections[0].audio.cache_key);
});

test('normalizeWorksheet strips hint and explanation_en and preserves instructions_fr/text_fr', () => {
  const input = {
    topic: 'x',
    level: 'A1',
    sections: [
      {
        id: 'reading',
        title_fr: 'Lis',
        explanation_en: 'English legacy section',
        instructions_fr: 'Lis le texte.',
        text_fr: 'Le texte.',
        hint: 'section hint',
        questions: [
          {
            id: 'q1',
            prompt: 'p',
            type: 'short_text',
            answer: 'a',
            explanation: 'x',
            hint: 'question hint'
          }
        ]
      }
    ]
  };
  const out = normalizeWorksheet(input);
  const sec = out.sections[0];
  assert.equal(sec.instructions_fr, 'Lis le texte.');
  assert.equal(sec.text_fr, 'Le texte.');
  assert.equal(sec.hint, undefined);
  assert.equal(sec.explanation_en, undefined);
  assert.equal(sec.questions[0].hint, undefined);
  // The input must not be mutated (normalize works on copies).
  assert.equal(input.sections[0].hint, 'section hint');
  assert.equal(input.sections[0].questions[0].hint, 'question hint');
});
