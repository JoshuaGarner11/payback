// Builds data.json (all encrypted) from private/content.json (answers in plain text, never published).
//
// How the lock works:
//  - Every question gets a random 32-byte token.
//  - For each accepted answer, the token is encrypted with AES-GCM under a key derived from that
//    answer with PBKDF2 (slow on purpose). Decoy blobs pad every question to the same count.
//  - The key for the next world = SHA-256(previous key + every token of this world, in order).
//  - Each world's questions, hints and the ending are encrypted under the key for that step.
// So the page source holds no answers, no later questions, and no ending. You only get the next
// step by typing the right answers.
//
// Usage: node tools/build.mjs            (fails if the ending or any world is missing)
//        node tools/build.mjs --preview  (local test build; stubs the parts not written yet)

import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const crypto = webcrypto;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'private', 'content.json');
const OUT = path.join(ROOT, 'data.json');
const ITER = 310000;
const BLOBS_PER_QUESTION = 8;
const preview = process.argv.includes('--preview');

const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// Must match normalize() in game.js exactly.
export function normalize(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, 'AND')
    .replace(/^\s*THE\s+/, '')
    .replace(/[^A-Z0-9]/g, '');
}

async function answerKey(answer, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalize(answer)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
}

async function seal(key, bytes) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function rawToAes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function chainKey(prev, tokens) {
  const parts = [prev, ...tokens];
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function lockQuestion(accepted, quip = '') {
  const uniq = [...new Set(accepted.map(normalize))].filter(Boolean);
  if (!uniq.length) throw new Error('Question has no usable accepted answers');
  if (uniq.length > BLOBS_PER_QUESTION) throw new Error(`Too many variants (${uniq.length}) for ${accepted[0]}`);
  const token = rand(32);
  const salt = rand(16);
  const q = enc.encode(quip);
  const plain = new Uint8Array(32 + q.length);
  plain.set(token); plain.set(q, 32);
  const blobs = [];
  for (const a of uniq) blobs.push(b64(await seal(await answerKey(a, salt), plain)));
  while (blobs.length < BLOBS_PER_QUESTION) blobs.push(b64(rand(12 + plain.length + 16)));
  return { token, salt: b64(salt), blobs: shuffle(blobs) };
}

async function main() {
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
  const worlds = [...content.worlds];
  let ending = content.ending;

  const missing = [];
  if (!ending) missing.push('ending');
  for (const w of worlds) if (w.pending) missing.push(`world "${w.name}"`);
  if (missing.length && !preview) {
    console.error(`Not ready to ship. Missing: ${missing.join(', ')}. Use --preview for a local test build.`);
    process.exit(1);
  }
  const live = worlds.filter((w) => !w.pending);
  if (!ending) {
    ending = { title: 'PREVIEW BUILD', lines: ['The ending is not loaded yet.', 'This build is for local testing only.'], details: [] };
  }

  // Login gate
  const login = await lockQuestion(content.login.accepted);
  let key = await chainKey(enc.encode('payback-v1'), [login.token]);

  const chain = [];
  const steps = [...live.map((w) => ({ type: w.type || 'world', w })), { type: 'ending', w: ending }];
  for (const step of steps) {
    let payload;
    let tokens = [];
    if (step.type === 'ending') {
      payload = { type: 'ending', ...step.w };
    } else {
      const qs = [];
      for (const q of step.w.questions) {
        const lock = await lockQuestion(q.accepted, q.right || '');
        tokens.push(lock.token);
        const { accepted, right, publicAnswer, ...pub } = q;
        qs.push({ ...pub, salt: lock.salt, blobs: lock.blobs });
      }
      const { questions, pending, ...meta } = step.w;
      payload = { ...meta, type: step.type, questions: qs };
    }
    const plain = JSON.stringify(payload);
    if (plain.includes('"accepted"')) throw new Error('accepted answers would be sealed into the payload');
    // Anyone who unlocks this step can read it in dev tools, so it must not name any answer
    // from this step or later ones.
    if (step.type !== 'ending') {
      const flat = normalize(plain);
      const idx = steps.indexOf(step);
      for (const later of steps.slice(idx)) {
        if (later.type === 'ending') continue;
        for (const lq of later.w.questions.filter((x) => !x.publicAnswer)) for (const a of lq.accepted) {
          const n = normalize(a);
          if (n.length >= 4 && flat.includes(n)) throw new Error(`"${step.w.title}" payload gives away answer "${a}" (${lq.id})`);
        }
      }
    }
    chain.push(b64(await seal(await rawToAes(key), enc.encode(plain))));
    if (tokens.length) key = await chainKey(key, tokens);
  }

  const data = {
    v: 1,
    iter: ITER,
    preview,
    login: { salt: login.salt, blobs: login.blobs },
    chain,
  };
  fs.writeFileSync(OUT, JSON.stringify(data));

  // Self-check: nothing from the answers file leaks into the output.
  const out = fs.readFileSync(OUT, 'utf8').toUpperCase();
  const leaks = [];
  const scan = (arr) => arr.forEach((a) => { const n = normalize(a); if (n.length >= 6 && out.includes(n)) leaks.push(a); });
  scan(content.login.accepted);
  worlds.forEach((w) => (w.questions || []).forEach((q) => scan(q.accepted || [])));
  for (const f of ['game.js', 'index.html', 'style.css']) {
    const txt = normalize(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const all = [...content.login.accepted, ...worlds.flatMap((w) => (w.questions || []).filter((q) => !q.publicAnswer).flatMap((q) => q.accepted))];
    for (const a of all) { const n = normalize(a); if (n.length >= 5 && txt.includes(n)) leaks.push(`${a} (in ${f})`); }
  }
  if (leaks.length) {
    console.error('LEAK CHECK FAILED, answers found in data.json:', leaks);
    process.exit(1);
  }
  console.log(`Built data.json: ${live.length} worlds, ${chain.length} sealed steps${preview ? ' (PREVIEW)' : ''}. Leak check passed.`);
  if (missing.length) console.log(`Still missing for ship: ${missing.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
