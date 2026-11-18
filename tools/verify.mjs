// Walks data.json with the first accepted answer of each question (from private/content.json)
// and prints the decrypted ending. Proves the chain opens end to end.
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import { normalize } from './build.mjs';
const data = JSON.parse(fs.readFileSync(new URL('../data.json', import.meta.url)));
const content = JSON.parse(fs.readFileSync(new URL('../private/content.json', import.meta.url)));
const enc = new TextEncoder(), dec = new TextDecoder();
const ub = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
async function tryA(a, salt, blobs) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalize(a)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: ub(salt), iterations: data.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  for (const b of blobs) { const r = ub(b); try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.slice(0, 12) }, key, r.slice(12))); } catch {} }
  return null;
}
const hash = async (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', b)); };
async function open(key, s) { const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']); const r = ub(s); return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.slice(0, 12) }, k, r.slice(12)))); }
const answers = Object.fromEntries(content.worlds.flatMap((w) => w.questions.map((q) => [q.id, q.accepted])));
const lt = await tryA(content.login.accepted[0], data.login.salt, data.login.blobs);
let key = await hash([enc.encode('payback-v1'), lt.slice(0, 32)]);
for (const sealed of data.chain) {
  const step = await open(key, sealed);
  if (step.type === 'ending') { console.log(JSON.stringify(step, null, 2)); break; }
  const toks = [];
  for (const q of step.questions) {
    for (const a of answers[q.id]) { const t = await tryA(a, q.salt, q.blobs); if (!t) throw new Error(`variant "${a}" failed on ${q.id}`); }
    toks.push((await tryA(answers[q.id][0], q.salt, q.blobs)).slice(0, 32));
  }
  console.log(`opened ${step.title}: ${step.questions.length} questions, every accepted variant works`);
  key = await hash([key, ...toks]);
}
