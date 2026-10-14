// node test/synth.test.js — renders every sound: level, headroom, no silent stretch, determinism, breath sync, stereo, meditation timing, speed.
'use strict';
const assert = require('node:assert');
const S = require('../synth.js');
const R = 48000;
S.setRate(R);   // phones usually run Web Audio at 48 kHz
function render(sound, seed, breathMs, seconds) {
  const g = S.create(sound, seed, breathMs), x = new Float32Array(Math.round(seconds * R));
  for (let i = 0; i < x.length; i++) x[i] = g.next();
  return x;
}
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

assert.strictEqual(S.create(0, 1, 0), null, 'silence has no generator');
assert.ok(S.NAMES.length === 13 && S.SHORT.length === 13 && S.DESCRIPTIONS.length === 13);
for (let s = 1; s < 13; s++) {
  const x = render(s, 7, 0, 90);
  let peak = 0; for (const v of x) { assert.ok(Number.isFinite(v), S.NAMES[s] + ' finite'); peak = Math.max(peak, Math.abs(v)); }
  let quietest = 1; for (let w = 0; w + 10 * R <= x.length; w += 10 * R) quietest = Math.min(quietest, rms(x, w, w + 10 * R));
  const level = rms(x);
  assert.ok(peak < 0.9, `${S.NAMES[s]} headroom ${peak}`);
  assert.ok(level > 0.03 && level < 0.16, `${S.NAMES[s]} level ${level}`);
  assert.ok(quietest > 0.01, `${S.NAMES[s]} never falls silent ${quietest}`);
  const again = render(s, 7, 0, 1); for (let i = 0; i < again.length; i++) assert.strictEqual(again[i], x[i], S.NAMES[s] + ' repeatable');
  const st = S.stereo(s, 7, 0), lr = [0, 0]; let ll = 0, rr = 0, lrs = 0;
  for (let i = 0; i < 20 * R; i++) { st.next(lr); assert.ok(Math.abs(lr[0]) < .95 && Math.abs(lr[1]) < .95, S.NAMES[s] + ' stereo headroom'); ll += lr[0] ** 2; rr += lr[1] ** 2; lrs += lr[0] * lr[1]; }
  const corr = lrs / Math.sqrt(ll * rr); assert.ok(corr > .5 && corr < .98, `${S.NAMES[s]} stereo width ${corr}`);
  if (process.argv.includes('--report')) console.log(`${S.NAMES[s].padEnd(8)} rms ${level.toFixed(4)} peak ${peak.toFixed(3)} corr ${corr.toFixed(2)}`);
}
// Breath waves crest at 4 s (end of inhale) and are quietest at 0/10 s, wherever the session is.
for (const offset of [0, 2500, 7000]) {
  const x = render(S.BREATH_WAVES, 3, offset, 40); let crest = 0, trough = 0;
  for (let c = 0; c < 4; c++) {
    const ca = Math.floor(((40000 + 4000 - offset) % 10000) / 1000 * R) + c * 10 * R, ta = Math.floor(((40000 - offset) % 10000) / 1000 * R) + c * 10 * R;
    crest += rms(x, Math.max(0, ca - R / 4), Math.min(x.length, ca + R / 4)); trough += rms(x, Math.max(0, ta - R / 4), Math.min(x.length, ta + R / 4));
  }
  assert.ok(crest > trough * 2.5, `breath waves follow the guide from ${offset} ms (${crest / trough})`);
}
// Meditation in the audio thread: bell at the start, bed fades in, fades out over the last 30 s, bell, then 'ended'.
{
  const posts = []; const p = new S.Player(m => posts.push(m));
  p.message({ type: 'play', sound: 2, seed: 5, meditation: true, minutes: 1, bell: true });
  const L = new Float32Array(128), Rt = new Float32Array(128), out = [];
  for (let f = 0; f < 80 * R && !posts.some(m => m.type === 'ended'); f += 128) { p.render(L, Rt); out.push(rms(L)); }
  const at = s => out[Math.floor(s * R / 128)];
  assert.ok(posts.some(m => m.type === 'ended'), 'meditation ends');
  const endedAt = out.length * 128 / R;
  assert.ok(endedAt > 73 && endedAt < 75.5, 'ends after the 14 s closing bell: ' + endedAt);
  assert.ok(at(20) > at(58) * 2, 'bed fades out over the last 30 s');
  assert.ok(at(60.5) > at(59.5) * 2, 'closing bell rings');
  const ticks = posts.filter(m => m.type === 'tick'); assert.ok(ticks.length > 200 && ticks[ticks.length - 1].ending, 'ticks report the ending');
  // Pause stops both sound and clock.
  const q = new S.Player(); q.message({ type: 'play', sound: 9, seed: 1, meditation: true, minutes: 1, bell: false }); q.message({ type: 'pause' });
  q.render(L, Rt); assert.strictEqual(rms(L), 0); assert.strictEqual(q.frames, 0, 'paused clock holds');
}
const t0 = performance.now(); for (let s = 1; s < 13; s++) render(s, 11, 0, 60);
const ms = performance.now() - t0;
assert.ok(ms < 60000 * .25, 'synthesis far faster than real time');
console.log(`PASS: 12 sounds level/headroom/no gaps/stereo, breath sync, meditation fade-bell-end and pause, ${ms.toFixed(0)} ms for 12 min of 48 kHz audio`);
