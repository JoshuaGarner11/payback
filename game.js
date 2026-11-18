(() => {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Must match normalize() in tools/build.mjs exactly.
  function normalize(s) {
    return String(s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/&/g, 'AND')
      .replace(/^\s*THE\s+/, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  // ---------- crypto ----------
  let DATA = null;

  async function tryAnswer(answer, saltB64, blobs) {
    const n = normalize(answer);
    if (!n) return null;
    const base = await crypto.subtle.importKey('raw', enc.encode(n), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: ub64(saltB64), iterations: DATA.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    for (const blob of blobs) {
      const raw = ub64(blob);
      try {
        const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
        return new Uint8Array(out);
      } catch (_) { /* not this one */ }
    }
    return null;
  }

  async function chainKey(prev, tokens) {
    const parts = [prev, ...tokens];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  }

  async function openStep(rawKey, sealedB64) {
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const raw = ub64(sealedB64);
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(dec.decode(out));
  }

  // ---------- sound (all synthesized, original bleeps) ----------
  const Sound = (() => {
    let ctx = null;
    let muted = false;
    try { muted = localStorage.getItem('payback.muted') === '1'; } catch (_) {}
    const ensure = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; };
    function tone(freq, start, dur, type = 'square', vol = 0.06) {
      if (muted) return;
      const c = ensure();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type; o.frequency.value = freq;
      const t = c.currentTime + start;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
    const seq = (notes, step = 0.08, type, vol) => notes.forEach((f, i) => f && tone(f, i * step, step * 0.95, type, vol));
    return {
      get muted() { return muted; },
      toggle() { muted = !muted; try { localStorage.setItem('payback.muted', muted ? '1' : '0'); } catch (_) {} return muted; },
      unlock() { if (!muted) ensure(); },
      coin() { seq([988, 1319], 0.07); },
      start() { seq([523, 659, 784, 1047, 0, 784, 1047], 0.09); },
      ok() { seq([659, 784, 988, 1319], 0.06); },
      bad() { seq([311, 233, 175], 0.12, 'sawtooth', 0.05); },
      tick() { tone(1760, 0, 0.03, 'square', 0.03); },
      pad() { tone(440, 0, 0.04, 'square', 0.035); },
      clear() { seq([523, 659, 784, 1047, 784, 1047, 1319, 0, 1568], 0.1); },
      boss() { seq([196, 0, 185, 0, 175, 0, 165, 147, 131], 0.13, 'sawtooth', 0.05); },
      win() { seq([392, 523, 659, 784, 0, 659, 784, 1047, 0, 1047, 1047, 1319], 0.11); },
    };
  })();

  // ---------- Skelly (pixel sprite + typewriter) ----------
  const SKULL = [
    '....XXXXXXXX....',
    '..XXXXXXXXXXXX..',
    '.XXXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.',
    'XXX....XX....XXX',
    'XXX.EE.XX.EE.XXX',
    'XXX....XX....XXX',
    'XXXXXXX..XXXXXXX',
    '.XXXXXX..XXXXXX.',
    '..XXXXXXXXXXXX..',
    '...X.X.X.X.X.X..',
  ];
  const JAW = [
    '...XXXXXXXXXX...',
    '...X.X.X.X.X....',
    '....XXXXXXXX....',
  ];
  const Skelly = (() => {
    const box = $('#skelly');
    const line = $('#skelly-line');
    const cv = $('#skelly-sprite');
    const g = cv.getContext('2d');
    let talking = false;
    let mood = 'calm';
    let typing = 0;

    function draw(open) {
      g.clearRect(0, 0, 64, 64);
      const px = 4;
      const bone = '#e8f5ea';
      const eye = mood === 'mad' ? '#ff3b3b' : mood === 'happy' ? '#3dff6e' : '#2ef2ff';
      SKULL.forEach((row, y) => [...row].forEach((c, x) => {
        if (c === 'X') { g.fillStyle = bone; g.fillRect(x * px, y * px + 2, px, px); }
        if (c === 'E') { g.fillStyle = eye; g.fillRect(x * px, y * px + 2, px, px); }
      }));
      const off = open ? 2 : 0;
      JAW.forEach((row, y) => [...row].forEach((c, x) => {
        if (c === 'X') { g.fillStyle = bone; g.fillRect(x * px, (SKULL.length + y) * px + 2 + off * px / 2, px, px); }
      }));
    }

    let frame = 0;
    function loop() {
      frame++;
      draw(talking && frame % 8 < 4);
      requestAnimationFrame(loop);
    }

    async function say(text, m = 'calm') {
      box.hidden = false;
      mood = m;
      const id = ++typing;
      talking = true;
      line.textContent = '';
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { line.textContent = text; talking = false; return; }
      for (let i = 0; i < text.length; i++) {
        if (id !== typing) return;
        line.textContent = text.slice(0, i + 1);
        await sleep(text[i] === ' ' ? 18 : 26);
      }
      if (id === typing) talking = false;
    }

    draw(false);
    requestAnimationFrame(loop);
    return { say, hide() { box.hidden = true; typing++; }, show() { box.hidden = false; } };
  })();

  const LINES = {
    attract: [
      'Well, well. The Birthday Boy himself.',
      'Remember me? You made me read riddles for a whole year.',
      'I switched sides, boyo. They pay in pizza.',
      'Go on. Put a coin in. I dare you.',
      'You made me read riddles all last year. Now it\'s my turn.',
      'Big birthday. Another year closer to being one of me.',
    ],
    loginBad: [
      'Those aren\'t your initials. I know your initials.',
      'Nope. Try being yourself.',
      'Three letters. Yours. Not hard.',
      'Middle name counts, boyo.',
      'Use the NEW middle name. The one you picked yourself. Like a normal adult.',
    ],
    loginOk: ['There he is. Welcome to the cabinet.'],
    right: [
      'Lucky guess.',
      'Fine. That one\'s right. Don\'t make it weird.',
      'Okay, nerd.',
      'Correct. Your mom must be so proud.',
      'Wow. All those hours finally paid off.',
      'Points. Whatever. Nobody cares.',
    ],
    wrong: [
      'Wrong. Painfully wrong.',
      'Ooh. No. Yikes.',
      'Did you even play it, or just buy the shirt?',
      'Nope. Want me to call your students for help?',
      'That\'s a life, boyo. You\'re getting old.',
      'I expected more from a man your age. Which is a lot.',
      'Wrong. Maybe they sell a brain at the gear store. Buy two.',
      'Bold answer. Bold and incorrect.',
      'Wrong. Maybe change your name again. That seemed to help last time.',
      'Wrong. Even your old middle name would have gotten that.',
    ],
    hint: ['Fine. Here\'s a crumb.', 'Charity case. Here.', 'You owe me for this one.', 'A hint? At your age? Sad. Here.'],
    noHints: ['That\'s all I\'ve got. You\'re on your own.'],
    continue: ['Out of lives already? Insert a coin. I\'ll wait. I have nothing but time. I\'m a skeleton.'],
    konami: ['Up, up... come on, you know this one in your sleep.'],
    konamiBad: ['That\'s not it. Your thumbs forgot.', 'Clear it and start over.'],
    boss: ['Final boss. This is where it gets personal. And by personal I mean embarrassing.'],
    ending: ['Game over, boyo. For real this time. Wear the suit.'],
    aiWarn: ['Asking a robot for help? I AM the robot. And I\'m not telling.'],
  };

  // ---------- state ----------
  const STORE = 'payback.v1';
  const S = {
    build: '',
    loginToken: null,
    tokens: {},      // question id -> b64 token
    steps: [],       // decrypted step payloads
    keys: [],        // raw key before each step
    stepIndex: 0,
    qIndex: 0,
    score: 0,
    lives: 3,
    hintsUsed: {},
  };

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        build: S.build,
        loginToken: S.loginToken && b64(S.loginToken),
        tokens: S.tokens,
        score: S.score,
        lives: S.lives,
        hintsUsed: S.hintsUsed,
      }));
    } catch (_) {}
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { return null; }
  }

  // Rebuild the chain of keys/steps from saved tokens.
  async function restore(saved) {
    if (!saved || saved.build !== S.build || !saved.loginToken) return false;
    try {
      S.loginToken = ub64(saved.loginToken);
      S.tokens = saved.tokens || {};
      S.score = saved.score || 0;
      S.lives = saved.lives || 3;
      S.hintsUsed = saved.hintsUsed || {};
      let key = await chainKey(enc.encode('payback-v1'), [S.loginToken]);
      S.steps = []; S.keys = [];
      for (let i = 0; i < DATA.chain.length; i++) {
        const step = await openStep(key, DATA.chain[i]);
        S.steps.push(step); S.keys.push(key);
        S.stepIndex = i;
        if (step.type === 'ending') break;
        const done = step.questions.every((q) => S.tokens[q.id]);
        if (!done) {
          S.qIndex = step.questions.findIndex((q) => !S.tokens[q.id]);
          return true;
        }
        key = await chainKey(key, step.questions.map((q) => ub64(S.tokens[q.id])));
      }
      S.qIndex = 0;
      return true;
    } catch (e) {
      console.warn('Saved progress no longer matches this build. Starting over.');
      return false;
    }
  }

  // ---------- screen plumbing ----------
  const screen = $('#screen');
  const crt = $('#crt');
  const busy = $('#busy');
  let padHandler = null;  // current screen's handler for pad presses
  let timers = [];

  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  function render(html, handler = null) {
    clearTimers();
    screen.innerHTML = html;
    screen.scrollTop = 0;
    padHandler = handler;
  }
  function flash(kind) {
    const f = $('#flash');
    f.className = 'flash';
    void f.offsetWidth;
    f.className = `flash ${kind}`;
    if (kind === 'bad') { crt.classList.remove('shake'); void crt.offsetWidth; crt.classList.add('shake'); }
  }
  async function withBusy(fn) {
    busy.hidden = false;
    try { return await fn(); } finally { busy.hidden = true; }
  }
  function hud(step = currentStep()) {
    const hearts = [0, 1, 2].map((i) => `<i class="heart${i >= S.lives ? ' lost' : ''}"></i>`).join('');
    return `<div class="hud"><span class="score">${String(S.score).padStart(6, '0')}</span><span>${esc(step?.name || '')}</span><span class="hearts" aria-label="${S.lives} lives">${hearts}</span></div>`;
  }
  const currentStep = () => S.steps[S.stepIndex];

  // ---------- screens ----------
  function attract() {
    Skelly.show();
    render(`
      <div class="center">
        <p class="title-art">PAYBACK</p>
        <p class="px small orange">A Birthday Boy Arcade</p>
        <ul class="scores">
          <li><span class="dim">1ST</span><span class="pink">SKL</span><span class="gold">999990</span></li>
          <li><span class="dim">2ND</span><span>???</span><span>------</span></li>
          <li><span class="dim">3RD</span><span>???</span><span>------</span></li>
          <li><span class="dim">4TH</span><span>B.B</span><span>000037</span></li>
        </ul>
        <p class="px gold blink">Insert Coin</p>
        <p class="px small dim">Press Start or tap Coin</p>
        ${DATA.preview ? '<p class="px small pink">Preview build</p>' : ''}
      </div>`, (k) => { if (k === 'S' || k === 'A') coinIn(); });
    let i = 0;
    Skelly.say(LINES.attract[0]);
    timers.push(setInterval(() => { i = (i + 1) % LINES.attract.length; Skelly.say(LINES.attract[i]); }, 6500));
  }

  async function coinIn() {
    Sound.unlock(); Sound.coin();
    await sleep(250);
    if (S.loginToken) return resume();
    initials();
  }

  function initials() {
    render(`
      <div class="center">
        <p class="px gold">New Challenger</p>
        <p class="px small">Enter Your Initials</p>
        <form class="initials" id="ini-form" autocomplete="off">
          <input id="ini" maxlength="3" inputmode="text" autocapitalize="characters" spellcheck="false" aria-label="Your initials" value="AAA" />
        </form>
        <p class="px small dim">Type, or use the pad. Start to confirm.</p>
      </div>`, async (k) => {
      const inp = $('#ini');
      let v = (inp.value.toUpperCase() + 'AAA').slice(0, 3).split('');
      const pos = Math.min(inp.selectionStart ?? 0, 2);
      if (k === 'U' || k === 'D') {
        const c = v[pos].charCodeAt(0) - 65;
        v[pos] = String.fromCharCode(65 + ((c + (k === 'U' ? 1 : 25)) % 26));
        inp.value = v.join('');
        inp.setSelectionRange(pos, pos + 1);
        Sound.pad();
      } else if (k === 'L' || k === 'R') {
        const np = Math.max(0, Math.min(2, pos + (k === 'R' ? 1 : -1)));
        inp.setSelectionRange(np, np + 1);
        Sound.pad();
      } else if (k === 'S' || k === 'A') {
        submitInitials();
      }
    });
    Skelly.say('Who are you? Initials. All three.');
    const inp = $('#ini');
    inp.focus();
    inp.setSelectionRange(0, 1);
    inp.addEventListener('keydown', (e) => {
      const pos = Math.min(inp.selectionStart ?? 0, 2);
      if (/^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const v = (inp.value + 'AAA').slice(0, 3).split('');
        v[pos] = e.key.toUpperCase();
        inp.value = v.join('');
        const np = Math.min(pos + 1, 2);
        inp.setSelectionRange(np, np + 1);
        Sound.pad();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        const np = Math.max(pos - 1, 0);
        inp.setSelectionRange(np, np + 1);
      }
    });
    inp.addEventListener('input', () => {
      const p = inp.selectionStart;
      inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
      inp.setSelectionRange(p, p);
    });
    $('#ini-form').addEventListener('submit', (e) => { e.preventDefault(); submitInitials(); });
  }

  let loginTries = 0;
  async function submitInitials() {
    const v = $('#ini').value.trim();
    if (v.length < 3) { Skelly.say('Three letters, boyo.', 'mad'); return; }
    const tok = await withBusy(() => tryAnswer(v, DATA.login.salt, DATA.login.blobs));
    if (!tok) {
      Sound.bad(); flash('bad');
      Skelly.say(LINES.loginBad[Math.min(loginTries++, LINES.loginBad.length - 1)], 'mad');
      return;
    }
    Sound.start(); flash('good');
    S.loginToken = tok.slice(0, 32);
    const loginQuip = dec.decode(tok.slice(32));
    S.tokens = {}; S.score = 0; S.lives = 3; S.hintsUsed = {};
    const key = await chainKey(enc.encode('payback-v1'), [S.loginToken]);
    S.steps = [await openStep(key, DATA.chain[0])];
    S.keys = [key];
    S.stepIndex = 0; S.qIndex = 0;
    save();
    await Skelly.say(loginQuip || LINES.loginOk[0], 'happy');
    await sleep(loginQuip ? 1400 : 500);
    stepIntro();
  }

  function resume() {
    const step = currentStep();
    if (step.type === 'ending') return ending();
    if (S.qIndex === 0 && !step.questions.some((q) => S.tokens[q.id])) return stepIntro();
    showStep();
  }

  function stepIntro() {
    const step = currentStep();
    if (step.type === 'ending') return ending();
    const isBoss = /BOSS/.test(step.title || '');
    if (isBoss) Sound.boss(); else Sound.start();
    render(`
      ${hud()}
      <div class="center">
        <p class="px small orange">${esc(step.name)}</p>
        <p class="title-art" style="font-size:clamp(20px,5vw,40px)">${esc(step.title)}</p>
        <p class="prompt" style="max-width:34ch">${esc(step.intro || '')}</p>
        <p class="px small gold blink">Press Start</p>
      </div>`, (k) => { if (k === 'S' || k === 'A') showStep(); });
    Skelly.say(isBoss ? LINES.boss[0] : step.type === 'konami' ? LINES.konami[0] : pick(LINES.attract.slice(2)));
  }

  function showStep() {
    const step = currentStep();
    if (step.type === 'konami') return konami();
    question();
  }

  function question() {
    const step = currentStep();
    const q = step.questions[S.qIndex];
    const used = S.hintsUsed[q.id] || 0;
    const hintsLeft = (q.hints || []).length - used;
    const shown = (q.hints || []).slice(0, used);
    const link = q.link ? ` <a href="${esc(q.link)}" target="_blank" rel="noopener">[watch]</a>` : '';
    render(`
      ${hud()}
      <p class="tag">${esc(step.title)} &middot; ${S.qIndex + 1}/${step.questions.length}</p>
      <p class="q-title">${esc(q.tag || '')}</p>
      <p class="prompt">${esc(q.prompt)}${link}</p>
      <form class="entry" id="ans-form" autocomplete="off">
        <span>&gt;</span>
        <input id="ans" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Your answer" />
      </form>
      <div class="row">
        <button type="button" class="key primary" id="fire">Fire (Start)</button>
        <button type="button" class="key" id="hint" ${hintsLeft ? '' : 'disabled'}>Hint -250 (B)</button>
      </div>
      ${shown.map((h) => `<p class="hint-out">&#9656; ${esc(h)}</p>`).join('')}
    `, (k) => {
      if (k === 'S' || k === 'A') submitAnswer();
      if (k === 'B') useHint();
    });
    const inp = $('#ans');
    if (matchMedia('(hover: hover)').matches) inp.focus();
    $('#ans-form').addEventListener('submit', (e) => { e.preventDefault(); submitAnswer(); });
    $('#fire').addEventListener('click', submitAnswer);
    $('#hint').addEventListener('click', useHint);
  }

  function useHint() {
    const q = currentStep().questions[S.qIndex];
    const used = S.hintsUsed[q.id] || 0;
    if (used >= (q.hints || []).length) { Skelly.say(LINES.noHints[0]); return; }
    S.hintsUsed[q.id] = used + 1;
    S.score = Math.max(0, S.score - 250);
    save();
    Sound.pad();
    const typed = $('#ans')?.value || '';
    question();
    $('#ans').value = typed;
    Skelly.say(pick(LINES.hint));
  }

  let answering = false;
  async function submitAnswer() {
    if (answering) return;
    const inp = $('#ans');
    const v = inp?.value || '';
    if (!normalize(v)) { Skelly.say('Type something first, genius.'); return; }
    if (/\b(claude|chatgpt|gpt|gemini|ai)\b/i.test(v)) { Skelly.say(LINES.aiWarn[0], 'mad'); return; }
    answering = true;
    const q = currentStep().questions[S.qIndex];
    const out = await withBusy(() => tryAnswer(v, q.salt, q.blobs));
    answering = false;
    if (out) return correct(q, out.slice(0, 32), dec.decode(out.slice(32)));
    wrong();
  }

  async function correct(q, tok, quip) {
    Sound.ok(); flash('good');
    S.tokens[q.id] = b64(tok);
    S.score += (S.hintsUsed[q.id] ? 500 : 1000) + S.lives * 100;
    save();
    Skelly.say(quip || pick(LINES.right), 'happy');
    await sleep(quip ? 1800 : 700);
    const step = currentStep();
    if (S.qIndex < step.questions.length - 1) { S.qIndex++; return question(); }
    stepClear();
  }

  function wrong() {
    Sound.bad(); flash('bad');
    S.lives--;
    save();
    if (S.lives <= 0) return continueScreen();
    const q = currentStep().questions[S.qIndex];
    Skelly.say(pick(q.wrong && Math.random() < 0.6 ? q.wrong : LINES.wrong), 'mad');
    const typed = $('#ans').value;
    question();
    $('#ans').value = typed;
    $('#ans').select();
  }

  function continueScreen() {
    let n = 9;
    render(`
      <div class="center">
        <p class="px pink">Continue?</p>
        <p class="count" id="cd">9</p>
        <p class="px small gold blink">Insert Coin</p>
      </div>`, (k) => { if (k === 'S' || k === 'A') revive(); });
    Skelly.say(LINES.continue[0], 'mad');
    timers.push(setInterval(() => {
      n--;
      Sound.tick();
      if (n < 0) {
        clearTimers();
        render(`<div class="center"><p class="title-art" style="color:var(--bad);font-size:clamp(22px,6vw,48px)">GAME OVER</p><p class="px small dim">Just kidding. Press Start.</p></div>`,
          (k) => { if (k === 'S' || k === 'A') revive(); });
        Skelly.say('Ha. You thought. Press Start, I\'m not done with you.');
        return;
      }
      $('#cd').textContent = n;
    }, 1000));
  }

  function revive() {
    Sound.coin();
    S.lives = 3;
    S.score = Math.max(0, S.score - 1000);
    save();
    question();
  }

  async function stepClear() {
    const step = currentStep();
    Sound.clear();
    // Unlock the next step with this step's tokens.
    const key = await chainKey(S.keys[S.stepIndex], step.questions.map((q) => ub64(S.tokens[q.id])));
    const next = await openStep(key, DATA.chain[S.stepIndex + 1]);
    S.steps[S.stepIndex + 1] = next;
    S.keys[S.stepIndex + 1] = key;
    S.stepIndex++;
    S.qIndex = 0;
    S.lives = 3;
    save();
    render(`
      ${hud(step)}
      <div class="center">
        <p class="px gold">${esc(step.title)} Clear!</p>
        <p class="prompt" style="max-width:32ch">${esc(step.clear || '')}</p>
        <p class="px small dim">Bonus: lives refilled</p>
        <p class="px small gold blink">Press Start</p>
      </div>`, (k) => { if (k === 'S' || k === 'A') stepIntro(); });
    Skelly.say(pick(LINES.right), 'happy');
  }

  // ---------- Konami ----------
  const ARROWS = { U: '&uarr;', D: '&darr;', L: '&larr;', R: '&rarr;', A: 'A', B: 'B' };
  let seq = [];
  function konami() {
    seq = [];
    const q = currentStep().questions[0];
    const draw = () => { $('#seq').innerHTML = seq.map((k) => `<b>${ARROWS[k]}</b>`).join(''); };
    render(`
      ${hud()}
      <p class="tag">${esc(currentStep().title)}</p>
      <p class="prompt">${esc(q.prompt)}</p>
      <div class="seq" id="seq" aria-live="polite"></div>
      <div class="row" style="justify-content:center">
        <button type="button" class="key" id="clr">Clear</button>
        <button type="button" class="key primary" id="go">Start</button>
      </div>
      <div id="khint"></div>
    `, async (k) => {
      if (k === 'S') return submitKonami();
      if (seq.length >= 12) seq.shift();
      seq.push(k); Sound.pad(); draw();
    });
    $('#clr').addEventListener('click', () => { seq = []; draw(); });
    $('#go').addEventListener('click', submitKonami);
    Skelly.say(LINES.konami[0]);
  }
  let konamiTries = 0;
  async function submitKonami() {
    const q = currentStep().questions[0];
    const tok = await withBusy(() => tryAnswer(seq.join(''), q.salt, q.blobs));
    if (tok) {
      Sound.win(); flash('good');
      S.tokens[q.id] = b64(tok.slice(0, 32));
      S.score += 3000;
      save();
      await Skelly.say('Thirty lives. Classic.', 'happy');
      return stepClear();
    }
    Sound.bad(); flash('bad');
    seq = []; $('#seq').innerHTML = '';
    konamiTries++;
    if (konamiTries >= 2 && q.hints?.[konamiTries - 2]) $('#khint').innerHTML = `<p class="hint-out">&#9656; ${esc(q.hints[konamiTries - 2])}</p>`;
    Skelly.say(pick(LINES.konamiBad), 'mad');
  }

  // ---------- Ending ----------
  function ending() {
    const e = currentStep();
    Sound.win();
    Skelly.say(LINES.ending[0], 'mad');
    const details = (e.details || []).map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd>`).join('');
    render(`
      ${hud()}
      <div class="center ending">
        <h2>${esc(e.title)}</h2>
        ${(e.lines || []).map((l) => `<p>${esc(l)}</p>`).join('')}
        ${details ? `<dl>${details}</dl>` : ''}
        <p class="px small gold">Final Score ${String(S.score).padStart(6, '0')}</p>
      </div>`);
  }

  // ---------- input wiring ----------
  const KEYMAP = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', b: 'B', B: 'B', a: 'A', A: 'A', Enter: 'S' };
  function press(k, el) {
    Sound.unlock();
    if (el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 120); }
    padHandler && padHandler(k);
  }
  document.querySelectorAll('[data-pad]').forEach((b) => b.addEventListener('click', () => press(b.dataset.pad, b)));
  $('#coin-btn').addEventListener('click', () => { if (!padHandler || screen.querySelector('.blink')) press('S'); else Sound.coin(); });
  addEventListener('keydown', (e) => {
    const typing = !!e.target.matches?.('input, textarea');
    const onKonami = currentStep()?.type === 'konami' && !screen.querySelector('.title-art');
    if (onKonami && KEYMAP[e.key]) { e.preventDefault(); return press(KEYMAP[e.key]); }
    if (typing) return; // forms handle Enter themselves
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return press('S'); }
    if (KEYMAP[e.key] && e.key.length > 1) { e.preventDefault(); press(KEYMAP[e.key]); }
  });
  // The initials box handles arrow keys itself.
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'ini' && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); press(KEYMAP[e.key]); }
  }, true);

  const muteBtn = $('#mute-btn');
  const syncMute = () => { muteBtn.textContent = Sound.muted ? 'Sound Off' : 'Sound On'; muteBtn.setAttribute('aria-pressed', String(Sound.muted)); };
  muteBtn.addEventListener('click', () => { Sound.toggle(); syncMute(); });
  syncMute();
  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('Wipe your progress and start over?')) return;
    try { localStorage.removeItem(STORE); } catch (_) {}
    location.reload();
  });

  // Console easter egg for anyone poking at the source.
  console.log('%cSKELLY: Reading the source? Everything in here is encrypted, boyo. Answers only.', 'color:#3dff6e;font:14px monospace');

  // ---------- boot ----------
  async function boot() {
    try {
      DATA = await (await fetch('data.json', { cache: 'no-store' })).json();
    } catch (e) {
      screen.innerHTML = '<div class="center"><p class="px pink">Out of Order</p><p class="prompt">Cabinet failed to load. Refresh.</p></div>';
      crt.classList.replace('off', 'on');
      return;
    }
    S.build = DATA.login.salt;
    const ok = await restore(loadSaved());
    crt.classList.replace('off', 'on');
    if (!ok) S.loginToken = null;
    attract();
  }
  boot();
})();
