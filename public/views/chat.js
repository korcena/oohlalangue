// Chat view — behaviour-identical port of the original single-file tutor.
//
// The original `index.html` chat script is reproduced here, mounted into the
// shell's `#view` container. All network calls route through `ctx.api` and the
// preserved chat keys go through `ctx.storage`; the behaviour and constants
// (10 answers / 3 hours, the same localStorage keys) are unchanged.
//
// The teacher's markdown subset still uses the escaped `mdToHtml` renderer
// (`&<>` are escaped before any tags are produced). The worksheet view must
// never import that helper.

const ANSWERS_PER_WINDOW = 10;
const PAUSE_MS = 3 * 60 * 60 * 1000; // 3 hours
const SILENCE_TIMEOUT = 2500;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function mount(container, ctx) {
  const { api, storage } = ctx;
  const syncViewportHeight = ctx.syncViewportHeight || function noop() {};

  // ---- DOM (built fresh; same ids/classes so the extracted CSS applies) ----
  // The shell already renders the logo/tagline/nav header, so the view only
  // adds the session counter plus the chat surface, sized to fill #view.
  const app = el('div', 'chat-view');

  const sessionCounterEl = el('div', 'session-counter');
  sessionCounterEl.id = 'sessionCounter';
  sessionCounterEl.setAttribute('aria-live', 'polite');

  const chatEl = el('div');
  chatEl.id = 'chat';
  chatEl.setAttribute('aria-live', 'polite');

  const voiceStatus = el('div', 'voice-status');
  voiceStatus.id = 'voiceStatus';
  const voiceDot = el('span', 'dot');
  const voicePreview = el('span', 'transcript-preview', 'Listening…');
  voicePreview.id = 'voicePreview';
  const voiceHint = el('span', 'voice-hint', 'tap 🎤 to send');
  voiceStatus.append(voiceDot, voicePreview, voiceHint);

  const form = el('form');
  form.id = 'form';
  form.autocomplete = 'off';

  const input = el('textarea');
  input.id = 'input';
  input.placeholder = 'Écris ta réponse ici… (Enter to send · Shift+Enter for new line)';
  input.rows = 1;
  input.autocomplete = 'off';

  const micBtn = el('button', 'mic', '🎤');
  micBtn.type = 'button';
  micBtn.id = 'micBtn';
  micBtn.title = 'Speak your answer';

  const sendBtn = el('button', 'send', 'Envoyer');
  sendBtn.type = 'submit';
  sendBtn.id = 'sendBtn';

  form.append(input, micBtn, sendBtn);

  const pauseEl = el('div', 'pause-inline hidden');
  pauseEl.id = 'pause';
  pauseEl.setAttribute('role', 'status');
  pauseEl.setAttribute('aria-live', 'polite');
  const pauseTitle = el('p', 'pause-inline-title', "À tout à l'heure\u00a0!");
  const pauseTimerEl = el('div', 'pause-timer', '03:00:00');
  pauseTimerEl.id = 'pauseTimer';
  const pauseSub = el(
    'p',
    'pause-sub',
    'Session limit reached. Review the corrections above — your input returns when the timer ends.'
  );
  pauseEl.append(pauseTitle, pauseTimerEl, pauseSub);

  app.append(sessionCounterEl, chatEl, voiceStatus, form, pauseEl);

  // ---- Password + name gate ----
  // Reuse the gate markup the shell (`public/index.html`) already renders, so
  // we don't duplicate ids. It lives outside #view and is shown/hidden here.
  const gateEl = document.getElementById('gate');
  const gateForm = document.getElementById('gateForm');
  const gateIntro = gateEl.querySelector('p');
  const gateName = document.getElementById('gateName');
  const gatePassword = document.getElementById('gatePassword');
  const gatePasswordField = gatePassword.closest('.field');
  const gateSubmit = document.getElementById('gateSubmit');
  const gateError = document.getElementById('gateError');

  container.appendChild(app);

  // ---- State ----
  const history = [];
  let busy = false;
  let passwordRequired = false;
  let pauseTick = null;
  let destroyed = false;

  // ---- Session limit (10 answers → 3h pause, persisted across refreshes) ----
  function getAnswers() {
    return storage.getAnswers();
  }
  function setAnswers(n) {
    storage.setAnswers(n);
  }
  function getPauseUntil() {
    return storage.getPauseUntil();
  }
  function setPauseUntil(ts) {
    storage.setPauseUntil(ts);
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  function updateSessionCounter() {
    if (!sessionCounterEl) return;
    if (getPauseUntil() > Date.now()) {
      sessionCounterEl.textContent = '';
      return;
    }
    const remaining = Math.max(0, ANSWERS_PER_WINDOW - getAnswers());
    sessionCounterEl.textContent = '';
    if (remaining > 0 && remaining < ANSWERS_PER_WINDOW) {
      const strong = el('strong', null, String(remaining));
      sessionCounterEl.append(
        strong,
        document.createTextNode(` answer${remaining === 1 ? '' : 's'} left in this session`)
      );
    }
  }

  function showPause() {
    pauseEl.classList.remove('hidden');
    form.classList.add('hidden');
    voiceStatus.classList.remove('active');
    sendBtn.disabled = true;
    micBtn.disabled = true;
    input.disabled = true;
    scrollToBottom();
  }
  function hidePause() {
    pauseEl.classList.add('hidden');
    form.classList.remove('hidden');
    sendBtn.disabled = false;
    micBtn.disabled = false;
    input.disabled = false;
  }

  function onPauseEnded() {
    if (pauseTick) {
      clearInterval(pauseTick);
      pauseTick = null;
    }
    setPauseUntil(0);
    setAnswers(0);
    updateSessionCounter();
    hidePause();
    if (history.length === 0) {
      send('Start!', { display: false });
    } else {
      try {
        input.focus();
      } catch (_e) {
        /* ignore */
      }
    }
  }

  function enforcePauseIfActive() {
    const until = getPauseUntil();
    if (!until) return false;
    const remaining = until - Date.now();
    if (remaining <= 0) {
      onPauseEnded();
      return false;
    }
    showPause();
    pauseTimerEl.textContent = formatDuration(remaining);
    if (pauseTick) clearInterval(pauseTick);
    pauseTick = setInterval(() => {
      const left = getPauseUntil() - Date.now();
      if (left <= 0) {
        onPauseEnded();
      } else {
        pauseTimerEl.textContent = formatDuration(left);
      }
    }, 1000);
    return true;
  }

  function recordAnswerAndMaybePause() {
    const next = getAnswers() + 1;
    setAnswers(next);
    updateSessionCounter();
    if (next >= ANSWERS_PER_WINDOW) {
      setPauseUntil(Date.now() + PAUSE_MS);
      enforcePauseIfActive();
      return true;
    }
    return false;
  }

  // ---- Learned-profile storage (behaviour from the original) ----
  function getProfile() {
    return storage.getProfile();
  }
  function setProfile(list) {
    storage.setProfile(list);
  }
  function addProfileFacts(newFacts) {
    if (!newFacts || !newFacts.length) return;
    const existing = getProfile();
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    for (const f of newFacts) {
      const clean = String(f)
        .replace(/[`<>{}\[\]"]/g, '')
        .trim()
        .slice(0, 120);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(clean);
    }
    setProfile(existing.slice(-40));
  }

  // Extract and strip a hidden <note>...</note> block from teacher text.
  function extractNote(text) {
    const re = /<note>([\s\S]*?)<\/note>/i;
    const m = text.match(re);
    if (!m) return { visible: text, facts: [] };
    const raw = m[1] || '';
    const facts = raw
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    const visible = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
    return { visible, facts };
  }

  // ---- Voice / Speech (browser-native APIs, zero cost) ----
  const SpeechRecognitionAPI =
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  let recognition = null;
  let isListening = false;
  let finalTranscript = '';
  let interimText = '';
  let silenceTimer = null;
  let wantListening = false;

  if (!SpeechRecognitionAPI) micBtn.classList.add('no-support');

  function showVoiceStatus(show) {
    voiceStatus.classList.toggle('active', show);
  }

  function updatePreview(text) {
    voicePreview.textContent = text || 'Listening…';
  }

  function stopAndSend() {
    wantListening = false;
    clearTimeout(silenceTimer);
    isListening = false;
    try {
      recognition.stop();
    } catch (_e) {
      /* ignore */
    }
    micBtn.classList.remove('listening');
    showVoiceStatus(false);
    const text = finalTranscript.trim();
    finalTranscript = '';
    interimText = '';
    if (text) {
      input.value = '';
      autoresize();
      send(text, { display: true, voice: true });
    }
  }

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stopAndSend, SILENCE_TIMEOUT);
  }

  function startListening() {
    if (!SpeechRecognitionAPI || busy) return;
    if (isListening || wantListening) {
      stopAndSend();
      return;
    }
    if (!recognition) {
      recognition = new SpeechRecognitionAPI();
      recognition.lang = 'fr-FR';
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;

      recognition.addEventListener('result', (e) => {
        const result = e.results[0];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
          interimText = '';
        } else {
          interimText = result[0].transcript;
        }
        updatePreview(finalTranscript + interimText || 'Listening…');
        resetSilenceTimer();
      });

      recognition.addEventListener('end', () => {
        isListening = false;
        if (wantListening) {
          try {
            recognition.start();
            isListening = true;
          } catch (_e) {
            stopAndSend();
          }
        }
      });

      recognition.addEventListener('error', (e) => {
        clearTimeout(silenceTimer);
        isListening = false;
        if (e.error === 'no-speech' && wantListening) {
          try {
            recognition.start();
            isListening = true;
          } catch (_e) {
            stopAndSend();
          }
          return;
        }
        wantListening = false;
        micBtn.classList.remove('listening');
        showVoiceStatus(false);
        finalTranscript = '';
        interimText = '';
        if (e.error !== 'aborted') {
          showError('Voice error: ' + e.error);
        }
      });
    }
    finalTranscript = '';
    interimText = '';
    wantListening = true;
    isListening = true;
    micBtn.classList.add('listening');
    updatePreview('Listening…');
    showVoiceStatus(true);
    recognition.start();
    resetSilenceTimer();
  }

  // Strip symbols, emoji, and markdown so the TTS engine reads only natural
  // spoken text.
  function cleanForSpeech(raw) {
    let s = raw;
    s = s.replace(/\*+/g, '');
    s = s.replace(/#+ */g, '');
    s = s.replace(/[_~`>|]/g, '');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/[☀-➿︀-️\u{1F000}-\u{1FAFF}\u{E0020}-\u{E007F}‍]/gu, '');
    s = s.replace(/→/g, ', ');
    s = s.replace(/—/g, ', ');
    s = s.replace(/[(){}\[\]<>]/g, '');
    s = s.replace(/ {2,}/g, ' ');
    return s.trim();
  }

  function speakFrench(text) {
    if (!text || !window.speechSynthesis) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(clean);
    utt.lang = 'fr-FR';
    utt.rate = 0.85;
    const voices = window.speechSynthesis.getVoices();
    const fr = voices.find((v) => v.lang === 'fr-FR') || voices.find((v) => v.lang.startsWith('fr'));
    if (fr) utt.voice = fr;
    window.speechSynthesis.speak(utt);
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', () => {});
  }

  function extractFrenchForTTS(text) {
    const parsed = parseTeacherReply(text);
    if (!parsed.hasMarkers) return text;
    const parts = [];
    const corrected = parsed.corrections.find((c) => c.type === 'corrected');
    if (corrected) parts.push(corrected.text);
    if (parsed.question) parts.push(parsed.question);
    return parts.join('. ') || text;
  }

  function configureGateForRequirement(required) {
    passwordRequired = required;
    gatePasswordField.style.display = required ? '' : 'none';
    gatePassword.required = required;
    gateIntro.textContent = required
      ? 'Enter your name and the password to start practicing.'
      : 'What should we call you?';
  }

  function showGate(errorText) {
    gateEl.classList.remove('hidden');
    gateError.textContent = errorText || '';
    gatePassword.value = '';
    gateName.value = storage.getName();
    setTimeout(() => (gateName.value ? gatePassword : gateName).focus(), 50);
  }
  function hideGate() {
    gateEl.classList.add('hidden');
    gateError.textContent = '';
  }

  const onGateSubmit = async (e) => {
    e.preventDefault();
    const name = gateName.value.trim().slice(0, 40);
    const pw = gatePassword.value.trim();
    if (!name) return;
    if (passwordRequired && !pw) return;
    gateSubmit.disabled = true;
    gateError.textContent = '';
    try {
      if (passwordRequired) {
        let ok = false;
        try {
          const res = await api.verifyPassword(pw);
          ok = Boolean(res && res.ok);
        } catch (_err) {
          ok = false;
        }
        if (!ok) {
          showGate('Incorrect password');
          return;
        }
        storage.setPassword(pw);
      }
      storage.setName(name);
      hideGate();
      send('Start!', { display: false });
    } catch (err) {
      showGate('Network error: ' + (err && err.message ? err.message : err));
    } finally {
      gateSubmit.disabled = false;
    }
  };
  gateForm.addEventListener('submit', onGateSubmit);

  async function verifyStoredPassword() {
    const pw = storage.getPassword();
    if (!pw) return false;
    try {
      const res = await api.verifyPassword(pw);
      return Boolean(res && res.ok);
    } catch (_e) {
      return false;
    }
  }

  async function bootstrapAuth() {
    let required = false;
    try {
      const data = await api.authRequired();
      required = Boolean(data && data.required);
    } catch (_e) {
      // If we can't reach the server, fall through and let /api/chat fail visibly.
    }

    if (destroyed) return;
    configureGateForRequirement(required);
    updateSessionCounter();

    // Mid-pause: show the timer and stop (no auth flow, no new conversation).
    if (enforcePauseIfActive()) return;

    const haveName = Boolean(storage.getName());
    const havePassword = Boolean(storage.getPassword());

    if (!required && haveName) {
      send('Start!', { display: false });
      return;
    }

    if (required && haveName && havePassword && (await verifyStoredPassword())) {
      send('Start!', { display: false });
      return;
    }

    if (!havePassword) storage.setPassword('');
    showGate();
  }

  // -- Rendering -------------------------------------------------------------

  function mdToHtml(text) {
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function makeRow(role) {
    const row = el('div', 'row ' + role);
    const avatar = el('div', 'avatar', role === 'teacher' ? '🇫🇷' : '📝');
    const content = el('div', 'content');
    row.append(avatar, content);
    return { row, content };
  }

  function addStudentMessage(text) {
    const { row, content } = makeRow('student');
    content.appendChild(el('div', 'bubble', text));
    chatEl.appendChild(row);
    scrollToBottom();
  }

  function showTyping() {
    const { row, content } = makeRow('teacher');
    row.id = 'typing-row';
    const bubble = el('div', 'bubble');
    const typing = el('div', 'typing');
    typing.append(el('span'), el('span'), el('span'));
    bubble.appendChild(typing);
    content.appendChild(bubble);
    chatEl.appendChild(row);
    scrollToBottom();
  }

  function removeTyping() {
    const existing = document.getElementById('typing-row');
    if (existing) existing.remove();
  }

  function showError(msg) {
    chatEl.appendChild(el('div', 'error', msg));
    scrollToBottom();
  }

  function parseTeacherReply(text) {
    const markers = [
      { key: 'good', regex: /^✅\s*GOOD:\s*/i },
      { key: 'fix', regex: /^🔧\s*FIX:\s*/i },
      { key: 'corrected', regex: /^💬\s*CORRECTED:\s*/i },
      { key: 'sayit', regex: /^🗣️\s*SAY IT:\s*/i }
    ];

    const lines = text.split(/\r?\n/);
    const introLines = [];
    const correctionLines = [];
    const questionLines = [];

    let stage = 'intro';
    let sawCorrected = false;

    for (const raw of lines) {
      const line = raw.trim();
      let matched = null;
      for (const m of markers) {
        if (m.regex.test(line)) {
          matched = m;
          break;
        }
      }

      if (matched) {
        const content = line.replace(matched.regex, '').trim();
        correctionLines.push({ type: matched.key, text: content });
        stage = 'correction';
        if (matched.key === 'corrected' || matched.key === 'sayit') sawCorrected = true;
        continue;
      }

      if (stage === 'intro') {
        if (line) introLines.push(line);
      } else if (stage === 'correction') {
        if (sawCorrected) {
          if (line) {
            stage = 'question';
            questionLines.push(line);
          }
        } else if (line && correctionLines.length) {
          correctionLines[correctionLines.length - 1].text += ' ' + line;
        }
      } else if (stage === 'question') {
        if (line) questionLines.push(line);
      }
    }

    return {
      intro: introLines.join('\n').trim(),
      corrections: correctionLines,
      question: questionLines.join('\n').trim(),
      hasMarkers: correctionLines.length > 0
    };
  }

  function renderTeacherReply(text) {
    const { row, content } = makeRow('teacher');
    const parsed = parseTeacherReply(text);

    if (!parsed.hasMarkers) {
      const bubble = el('div', 'bubble');
      bubble.innerHTML = mdToHtml(text);
      content.appendChild(bubble);
      chatEl.appendChild(row);
      scrollToBottom();
      return;
    }

    if (parsed.intro) {
      const bubble = el('div', 'bubble intro');
      bubble.innerHTML = mdToHtml(parsed.intro);
      content.appendChild(bubble);
    }

    if (parsed.corrections.length) {
      const card = el('div', 'correction');
      const labelMap = {
        good: { cls: 'good', icon: '✅', label: 'Good' },
        fix: { cls: 'fix', icon: '🔧', label: 'Fix' },
        corrected: { cls: 'corrected', icon: '💬', label: 'Corrected' },
        sayit: { cls: 'sayit', icon: '🗣️', label: 'Say it' }
      };
      for (const c of parsed.corrections) {
        const meta = labelMap[c.type];
        if (!meta) continue;
        const section = el('div', 'section ' + meta.cls);
        const icon = el('span', 'icon', meta.icon);
        const body = el('span');
        body.appendChild(el('span', 'label', meta.label));
        const textSpan = el('span');
        textSpan.innerHTML = mdToHtml(c.text);
        body.appendChild(textSpan);
        section.append(icon, body);
        card.appendChild(section);
      }
      content.appendChild(card);
    }

    if (parsed.question) {
      const bubble = el('div', 'bubble question');
      bubble.innerHTML = mdToHtml(parsed.question);
      content.appendChild(bubble);
    }

    chatEl.appendChild(row);
    scrollToBottom();
  }

  async function send(userText, { display = true, voice = false } = {}) {
    if (busy) return;
    if (enforcePauseIfActive()) return;
    busy = true;
    sendBtn.disabled = true;
    micBtn.disabled = true;

    if (display) addStudentMessage(userText);

    history.push({ role: 'user', content: userText });
    showTyping();

    const willTriggerPause = display && getAnswers() + 1 >= ANSWERS_PER_WINDOW;

    try {
      const data = await api.chat({
        messages: history,
        name: storage.getName(),
        profile: getProfile(),
        skipQuestion: willTriggerPause,
        voiceMode: voice
      });
      removeTyping();

      // A 500 from the provider is surfaced as an error; the request itself
      // throws for non-2xx through the api wrapper, handled below.
      renderTeacherReplyFromData(data, voice);

      if (display) {
        recordAnswerAndMaybePause();
      }
    } catch (err) {
      removeTyping();

      if (err && err.status === 401) {
        storage.setPassword('');
        history.pop();
        showGate('Session expired — please re-enter the password');
        return;
      }

      // The api wrapper already normalises provider/network errors into a
      // human-readable `message`, so surface it as-is.
      if (err && err.name === 'ApiError') {
        showError(err.message || 'Request failed');
        history.pop();
        return;
      }

      showError('Network error: ' + (err && err.message ? err.message : err));
      history.pop();
    } finally {
      busy = false;
      if (!enforcePauseIfActive()) {
        sendBtn.disabled = false;
        micBtn.disabled = false;
        input.focus();
      }
    }
  }

  function renderTeacherReplyFromData(data, voice) {
    const rawText = (data && data.text) || '';
    const { visible, facts } = extractNote(rawText);
    if (facts.length) addProfileFacts(facts);
    history.push({ role: 'assistant', content: visible });
    renderTeacherReply(visible);

    if (voice) {
      const frenchText = extractFrenchForTTS(visible);
      speakFrench(frenchText);
    }
  }

  // -- Input handling --------------------------------------------------------

  // ---- Mobile keyboard handling ----
  function pinToBottom() {
    syncViewportHeight();
    requestAnimationFrame(() => {
      setTimeout(() => {
        syncViewportHeight();
        scrollToBottom();
        window.scrollTo(0, 0);
      }, 120);
    });
  }

  const onInputKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  const onInputFocus = () => pinToBottom();
  const onInputBlur = () => syncViewportHeight();
  const onViewportResize = () => pinToBottom();
  const onViewportScroll = () => window.scrollTo(0, 0);

  function autoresize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  const onFormSubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    autoresize();
    send(text);
  };

  micBtn.addEventListener('click', startListening);
  input.addEventListener('keydown', onInputKeydown);
  input.addEventListener('input', autoresize);
  input.addEventListener('focus', onInputFocus);
  input.addEventListener('blur', onInputBlur);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportResize);
    window.visualViewport.addEventListener('scroll', onViewportScroll);
  } else {
    window.addEventListener('resize', onViewportResize);
  }
  form.addEventListener('submit', onFormSubmit);
  syncViewportHeight();

  bootstrapAuth();

  // Cleanup when leaving the view.
  function destroy() {
    destroyed = true;
    if (pauseTick) {
      clearInterval(pauseTick);
      pauseTick = null;
    }
    clearTimeout(silenceTimer);
    try {
      if (recognition) recognition.abort();
    } catch (_e) {
      /* ignore */
    }
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (_e) {
      /* ignore */
    }
    micBtn.removeEventListener('click', startListening);
    input.removeEventListener('keydown', onInputKeydown);
    input.removeEventListener('input', autoresize);
    input.removeEventListener('focus', onInputFocus);
    input.removeEventListener('blur', onInputBlur);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onViewportResize);
      window.visualViewport.removeEventListener('scroll', onViewportScroll);
    } else {
      window.removeEventListener('resize', onViewportResize);
    }
    form.removeEventListener('submit', onFormSubmit);
    gateForm.removeEventListener('submit', onGateSubmit);
    // Hide (do not remove) the shell-owned gate so the next view/route is not
    // covered by it.
    gateEl.classList.add('hidden');
    gateError.textContent = '';
  }

  // The router treats a returned function as the view cleanup.
  return destroy;
}

export { ANSWERS_PER_WINDOW, PAUSE_MS, SILENCE_TIMEOUT };
export default mount;
