/*
 * Relaxing soundscapes synthesized live, ported from the Android app (Soundscapes.java).
 * No audio files: nothing to license, nothing loops audibly, and the breath waves follow the 4 s in / 6 s out guide.
 *
 * Methods follow published procedural-audio work: water, rain plinks and surf foam are clouds of Minnaert bubbles with
 * van den Doel's damping and rising pitch ("Physically-based models for liquid sounds", 2005); fire and wind are layered
 * the way A. Farnell builds them in "Designing Sound"; the mono mix is widened with decorrelating all-pass chains.
 *
 * This one file is both the AudioWorklet (registered at the bottom when loaded by audioWorklet.addModule)
 * and a plain script that Node tests can require.
 */
'use strict';

let RATE = 44100;
const TAU = 2 * Math.PI;
const BREATH_WAVES = 4;
const NAMES = ['소리 없이', '잔잔한 음', '부드러운 빗소리', '파도', '호흡 파도', '시냇물', '숲속 새소리', '풀벌레', '모닥불', '바람', '싱잉볼', '윈드차임', '브라운 노이즈'];
const SHORT = ['소리 없음', '잔잔한 음', '빗소리', '파도', '호흡 파도', '시냇물', '새소리', '풀벌레', '모닥불', '바람', '싱잉볼', '윈드차임', '브라운 노이즈'];
const DESCRIPTIONS = ['조용히 호흡에만', '낮고 부드러운 화음', '창밖에 내리는 비', '밀려왔다 물러가는 바다', '4초 밀려오고 6초 물러가요', '돌 사이로 흐르는 물', '아침 숲의 작은 새들', '여름밤 귀뚜라미', '타닥타닥 장작 타는 소리', '들판을 지나는 바람', '길게 울리는 명상 종', '바람에 흔들리는 풍경', '깊고 고른 소리, 집중에'];
/** Output gain per sound so switching sounds keeps a similar loudness (calibrated in the Android tests, rechecked in test/synth.test.js). */
const GAIN = [0, 1.42, .865, 1, .87, 2.31, 1.31, 1.64, .74, .55, 1.68, .94, .535];

function setRate(rate) { RATE = rate; }

// ---- building blocks ----

/** mulberry32: fast, seedable, plenty for noise. */
class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  uniform() {
    let t = (this.s = (this.s + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.uniform(); }
  white() { return this.uniform() * 2 - 1; }
  /** Samples until the next event of a Poisson process with this many events per second. */
  gap(perSecond) { return 1 + Math.floor(Math.min(1e9, -Math.log(1 - this.uniform()) / perSecond * RATE)); }
  /** Power-law sample in [lo, hi] with density ~ x^-beta: many small bubbles, few large ones. */
  power(lo, hi, beta) { const e = 1 - beta, u = this.uniform(); return Math.pow(Math.pow(lo, e) + u * (Math.pow(hi, e) - Math.pow(lo, e)), 1 / e); }
}
class Lowpass {
  constructor(hz) { this.y = 0; this.set(hz); }
  set(hz) { this.a = 1 - Math.exp(-TAU * hz / RATE); }
  run(x) { return this.y += this.a * (x - this.y); }
}
/** RBJ band-pass with 0 dB peak gain; retune every few dozen samples, not every sample. */
class Bandpass {
  constructor(hz, q) { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(hz, q); }
  set(hz, q) {
    const w = TAU * hz / RATE, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b2 = -al / a0; this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
/** Paul Kellet's economy pink filter. */
class Pink {
  constructor() { this.b0 = this.b1 = this.b2 = 0; }
  run(w) {
    this.b0 = 0.99765 * this.b0 + w * 0.0990460; this.b1 = 0.96300 * this.b1 + w * 0.2965164; this.b2 = 0.57000 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.25;
  }
}
/** Leaky integrator: -6 dB/octave above about 70 Hz. */
class BrownNoise {
  constructor() { this.y = 0; }
  run(w) { this.y = (this.y + 0.02 * w) / 1.01; return this.y * 2.4; }
}
/** Smoothly wandering random value with roughly unit RMS: flicker, gurgle. */
class Wobble {
  constructor(hz) { this.lp = new Lowpass(hz); this.norm = 1 / (0.577 * Math.sqrt(this.lp.a / (2 - this.lp.a))); }
  run(w) { return this.lp.run(w) * this.norm; }
}
/** Slow 0..1 drift from incommensurate sines: gusts, distance. */
class Drift {
  constructor(r, ...periods) { this.periods = periods; this.phases = periods.map(() => r.uniform() * TAU); this.t = 0; }
  step(samples) {
    this.t += samples / RATE; let s = 0;
    for (let i = 0; i < this.periods.length; i++) s += Math.sin(TAU * this.t / this.periods[i] + this.phases[i]);
    return Math.max(0, Math.min(1, 0.5 + 0.5 * s / Math.sqrt(this.periods.length)));
  }
}
/** Sine by rotating a unit vector: two multiply-adds per sample instead of Math.sin. */
class Osc {
  constructor() { this.x = 0; this.y = 1; this.c = 1; this.s = 0; this.step = 0; }
  tune(radiansPerSample) { this.step = radiansPerSample; this.c = Math.cos(radiansPerSample); this.s = Math.sin(radiansPerSample); }
  run() { const nx = this.x * this.c + this.y * this.s; this.y = this.y * this.c - this.x * this.s; this.x = nx; return nx; }
  normalise() { const m = 1 / Math.sqrt(this.x * this.x + this.y * this.y); this.x *= m; this.y *= m; }
}
/** A decaying sine partial with a soft attack: bubbles, chimes, bowls. Glide is applied every 16 samples. */
class Ring {
  constructor() { this.osc = new Osc(); this.alive = false; this.amp = 0; this.level = 0; }
  start(hz, amp, seconds, attackSeconds, glide) {
    this.osc.x = 0; this.osc.y = 1; this.osc.tune(TAU * hz / RATE); this.glide16 = Math.pow(glide, 16); this.amp = amp; this.level = 1; this.n = 0;
    this.rise = attackSeconds > 0 ? 0 : 1; this.attack = attackSeconds > 0 ? 1 - Math.exp(-1 / (attackSeconds * RATE)) : 1;
    this.decay = Math.exp(-1 / (seconds * RATE)); this.alive = true;
  }
  run() {
    this.rise += (1 - this.rise) * this.attack; this.level *= this.decay;
    if (this.glide16 !== 1 && (++this.n & 15) === 0) this.osc.tune(this.osc.step * this.glide16);
    // Free the voice only once it is inaudible, so stealing a voice never cuts off a ringing tone.
    if (this.amp * this.level < 3e-4) this.alive = false;
    return this.amp * this.rise * this.level * this.osc.run();
  }
}
class Rings {
  constructor(n) { this.voices = Array.from({ length: n }, () => new Ring()); }
  /** A free voice, or the quietest one when all are busy. */
  take() {
    let best = this.voices[0];
    for (const v of this.voices) { if (!v.alive) return v; if (v.amp * v.level < best.amp * best.level) best = v; }
    return best;
  }
  run() { let s = 0; for (const v of this.voices) if (v.alive) s += v.run(); return s; }
  /** One air bubble of this radius in mm: Minnaert frequency, van den Doel damping and rising pitch. */
  bubble(radiusMm, amp, xi) {
    const hz = 3260 / radiusMm, d = 0.043 * hz + 0.0014 * Math.pow(hz, 1.5);
    if (hz < RATE * 0.4) this.take().start(hz, amp, 1 / d, .0003, 1 + xi * d / RATE);
  }
}
/** A short burst of band-passed noise: a raindrop striking a leaf, a crackle in the embers. */
class Impact {
  constructor() { this.band = new Bandpass(1000, 1); this.env = 0; this.decay = 0; }
  start(hz, q, amp, seconds) { this.band.set(hz, q); this.env = amp; this.decay = Math.exp(-1 / (seconds * RATE)); }
  run(white) { if (this.env < 1e-5) return 0; const y = this.band.run(white * this.env); this.env *= this.decay; return y; }
}
class Impacts {
  constructor(n) { this.voices = Array.from({ length: n }, () => new Impact()); this.next = 0; }
  take() { const v = this.voices[this.next]; this.next = (this.next + 1) % this.voices.length; return v; }
  run(r) { let s = 0; for (const v of this.voices) if (v.env >= 1e-5) s += v.run(r.white()); return s; }
}

/** Mono to stereo: each side adds its own Schroeder all-pass chain, so ears hear decorrelated copies while L+R stays close to the dry sound. */
class Widener {
  constructor(sound) {
    const scale = RATE / 44100;
    this.left = [227, 557, 1091].map(d => new AllPass(Math.round(d * scale)));
    this.right = [331, 701, 887].map(d => new AllPass(Math.round(d * scale)));
    // Tonal sounds get less width: all-pass phase shifts would make some notes dip when the sides are summed.
    this.side = sound === 1 || sound === 10 || sound === 11 ? .22 : .42; this.dry = 1.2 - this.side;
    this.l = 0; this.r = 0;
  }
  run(x) {
    let a = x, b = x;
    for (const p of this.left) a = p.run(a);
    for (const p of this.right) b = p.run(b);
    this.l = x * this.dry + a * this.side; this.r = x * this.dry + b * this.side;
  }
}
class AllPass {
  constructor(delay) { this.line = new Float64Array(delay); this.i = 0; }
  run(x) { const d = this.line[this.i], v = x + .5 * d; this.line[this.i] = v; if (++this.i === this.line.length) this.i = 0; return d - .5 * v; }
}

// ---- soundscapes ----

/** A soft chord; each note is a slowly beating pair (a gentle chorus) with its own breathing movement. */
class Calm {
  constructor() {
    this.HZ = [130.81, 196, 261.63, 329.63, 392]; this.AMP = [.12, .08, .06, .04, .025]; const DETUNE = [.13, .21, .17, .29, .23];
    this.tones = []; for (let n = 0; n < 10; n++) { const o = new Osc(); o.tune(TAU * (this.HZ[n >> 1] + (n % 2) * DETUNE[n >> 1]) / RATE); this.tones.push(o); }
    this.swell = new Float64Array(5); this.overall = 0; this.i = 0;
  }
  next() {
    if ((this.i++ & 63) === 0) {
      const t = this.i / RATE;
      for (let k = 0; k < 5; k++) this.swell[k] = this.AMP[k] * (0.85 + 0.15 * Math.sin(TAU * t / (11 + 4 * k))) * .5;
      this.overall = 0.72 + 0.12 * Math.sin(TAU * t / 32);
      if ((this.i & 4095) === 1) for (const o of this.tones) o.normalise();
    }
    let s = 0; for (let n = 0; n < 10; n++) s += this.tones[n].run() * this.swell[n >> 1];
    return s * this.overall;
  }
}
/** Distant rain as band-limited pink noise that slowly thickens and thins, plus close drops and the odd puddle plink. */
class Rain {
  constructor(r) {
    this.r = r; this.pink = new Pink(); this.top = new Lowpass(3200); this.bottom = new Lowpass(280); this.air = new Lowpass(7000);
    this.drops = new Impacts(12); this.plinks = new Rings(16); this.density = new Drift(r, 23.1, 41.7, 67.3);
    this.next_ = r.gap(14); this.nextDrip = r.gap(.3); this.tick = 0; this.d = .5;
  }
  next() {
    const r = this.r;
    if ((this.tick++ & 255) === 0) this.d = this.density.step(256);
    const n = this.pink.run(r.white()), hi = n - this.air.run(n);
    const bed = (this.top.run(n) - this.bottom.run(n)) * (.8 + .35 * this.d) + hi * .12;
    if (--this.next_ <= 0) {
      this.next_ = r.gap(10 + 10 * this.d);
      this.drops.take().start(r.range(1500, 6500), r.range(.8, 2), r.range(.02, .08), r.range(.0015, .004));
      if (r.uniform() < .25) this.plinks.bubble(r.power(.9, 2.6, 2), r.range(.006, .02), .1);
    }
    if (--this.nextDrip <= 0) { this.nextDrip = r.gap(.3); this.plinks.bubble(r.range(3, 5), r.range(.02, .035), .1); }
    return bed * .55 + this.drops.run(r) + this.plinks.run();
  }
}
/** Pink noise whose brightness and level swell with each wave; the breaking foam fizzes with tiny bubbles. */
class Waves {
  constructor(r, breath, breathMs) {
    this.r = r; this.breath = breath; this.pink = new Pink(); this.body = new Lowpass(400); this.foam = new Bandpass(3000, .6); this.fizz = new Rings(40);
    this.tick = 0; this.next_ = 1;
    // Same curve as the guide: rises for 40 % of the cycle, falls for 60 %.
    if (breath) { this.len = RATE * 10; this.peak = .4; this.height = 1; this.pos = Math.floor((((breathMs % 10000) + 10000) % 10000) * RATE / 1000); }
    else { this.nextWave(); this.pos = Math.floor(this.len * r.uniform()); }
  }
  nextWave() { const r = this.r; this.len = Math.floor(r.range(8, 12.5) * RATE); this.peak = r.range(.3, .45); this.height = r.range(.65, 1); }
  next() {
    const r = this.r;
    if (this.pos >= this.len) { this.pos = 0; if (!this.breath) this.nextWave(); }
    const p = this.pos++ / this.len;
    const env = this.height * (p < this.peak ? 0.5 - 0.5 * Math.cos(Math.PI * p / this.peak) : 0.5 + 0.5 * Math.cos(Math.PI * (p - this.peak) / (1 - this.peak)));
    if ((this.tick++ & 31) === 0) this.body.set(220 + 1300 * env);
    const foamy = p > this.peak * .8 ? env : 0;
    if (foamy > .05 && --this.next_ <= 0) { this.next_ = r.gap(900 * foamy); this.fizz.bubble(r.power(.25, 1.6, 2.5), r.range(.002, .009) * foamy, .1); }
    const w = r.white();
    return (0.15 + 0.85 * env) * this.body.run(this.pink.run(w)) * .45 + env * env * this.foam.run(w) * .03 + this.fizz.run();
  }
}
/** Band-limited rushing water with a gurgling level, plus a stream of bubbles from tiny to large. */
class Stream {
  constructor(r) {
    this.r = r; this.water = new Bandpass(1400, .7); this.sparkle = new Bandpass(5200, 1.2); this.gurgle = new Wobble(6); this.shimmer = new Wobble(11);
    this.rumble = new Lowpass(250); this.bubbles = new Rings(40); this.next_ = r.gap(60);
  }
  next() {
    const r = this.r, w = r.white();
    const mod = Math.max(.15, .7 + .3 * this.gurgle.run(r.white())), shine = Math.max(0, .5 + .5 * this.shimmer.run(r.white()));
    if (--this.next_ <= 0) {
      this.next_ = r.gap(90 * mod);
      const radius = r.power(.5, 6, 2.2);
      this.bubbles.bubble(radius, .05 * Math.pow(radius / 6, .6) * r.range(.6, 1.2), .1);
    }
    return this.water.run(w) * mod * .18 + this.sparkle.run(w) * shine * .05 + this.rumble.run(r.white()) * .25 + this.bubbles.run();
  }
}
/** A soft leafy breeze with two birds singing short, varied phrases. */
class Birds {
  constructor(r) { this.r = r; this.pink = new Pink(); this.leaves = new Lowpass(900); this.breeze = new Drift(r, 9.1, 17.3, 29.9); this.birds = [new Bird(r), new Bird(r)]; this.tick = 0; this.g = 0; }
  next() {
    if ((this.tick++ & 63) === 0) this.g = this.breeze.step(64);
    let s = this.leaves.run(this.pink.run(this.r.white())) * (.35 + .65 * this.g) * .15;
    for (const b of this.birds) s += b.run(this.r);
    return s;
  }
}
class Bird {
  constructor(r) { this.wait = Math.floor(r.range(.5, 4) * RATE); this.notesLeft = 0; this.inNote = false; this.phase = 0; }
  phrase(r) {
    this.base = r.range(2300, 4600); this.sweep = r.range(-.5, .6); this.trill = r.uniform() < .4 ? r.range(25, 45) : 0; this.depth = this.trill > 0 ? r.range(.04, .12) : 0;
    this.noteLen = r.range(.05, .16); this.gapLen = r.range(.03, .12); this.notesLeft = Math.floor(r.range(2, 8)); this.amp = r.range(.03, .09);
  }
  run(r) {
    if (!this.inNote) {
      if (--this.wait > 0) return 0;
      if (this.notesLeft <= 0) this.phrase(r);
      this.inNote = true; this.pos = 0; this.len = Math.floor(this.noteLen * r.range(.8, 1.2) * RATE); this.notesLeft--; this.noteBase = this.base * r.range(.95, 1.06);
    }
    const u = this.pos / this.len;
    const f = this.noteBase * Math.pow(2, this.sweep * u) * (1 + this.depth * Math.sin(TAU * this.trill * this.pos / RATE));
    this.phase += TAU * f / RATE; if (this.phase > TAU) this.phase -= TAU;
    let e = Math.sin(Math.PI * u); e *= e;
    if (++this.pos >= this.len) { this.inNote = false; this.wait = Math.floor((this.notesLeft > 0 ? this.gapLen * r.range(.7, 1.3) : r.range(2, 7)) * RATE); }
    return this.amp * e * (Math.sin(this.phase) + .12 * Math.sin(2 * this.phase));
  }
}
/** A few crickets with their own pitch, rhythm and rests, over a quiet night hum. */
class Crickets {
  constructor(r) { this.r = r; this.brown = new BrownNoise(); this.night = new Lowpass(220); this.crickets = [new Cricket(r), new Cricket(r), new Cricket(r)]; }
  next() { let s = this.night.run(this.brown.run(this.r.white())) * .12; for (const c of this.crickets) s += c.run(this.r); return s; }
}
class Cricket {
  constructor(r) {
    this.hz = r.range(3900, 4700); this.amp = r.range(.02, .045); this.period = r.range(.45, .8); this.pulseLen = r.range(.012, .018); this.pulseGap = r.range(.026, .034); this.pulses = Math.floor(r.range(3, 5));
    this.singing = r.uniform() < .7; this.stateLeft = Math.floor(r.range(2, 12) * RATE); this.chirpLen = Math.floor(this.period * RATE); this.t = Math.floor(r.uniform() * this.chirpLen); this.phase = 0;
  }
  run(r) {
    this.phase += TAU * this.hz / RATE; if (this.phase > TAU) this.phase -= TAU;
    this.stateLeft--;
    if (++this.t >= this.chirpLen) {
      this.t = 0; this.chirpLen = Math.floor(this.period * r.range(.93, 1.07) * RATE);
      // Only start or stop between chirps so no pulse is cut off.
      if (this.stateLeft <= 0) { this.singing = !this.singing; this.stateLeft = Math.floor((this.singing ? r.range(6, 20) : r.range(2, 8)) * RATE); }
    }
    if (!this.singing) return 0;
    const tt = this.t / RATE, k = Math.floor(tt / this.pulseGap); if (k >= this.pulses) return 0;
    const u = (tt - k * this.pulseGap) / this.pulseLen; if (u >= 1) return 0;
    const e = Math.sin(Math.PI * u);
    return this.amp * e * e * Math.sin(this.phase);
  }
}
/** Farnell's three layers of fire: lapping roar, surging hiss, and clustered crackles at random pitches with the odd pop. */
class Fire {
  constructor(r) {
    this.r = r; this.brown = new BrownNoise(); this.roar = new Lowpass(380); this.hissLow = new Lowpass(2500);
    this.flicker = new Wobble(2.5); this.flare = new Wobble(.9); this.cracks = new Impacts(16);
    this.next_ = r.gap(5); this.nextPop = r.gap(.25); this.burst = 0;
  }
  next() {
    const r = this.r;
    const f = Math.max(.2, .8 + .2 * this.flicker.run(r.white())), surge = Math.max(0, this.flare.run(r.white()));
    const w = r.white();
    const s = this.roar.run(this.brown.run(r.white())) * f * .9 + (w - this.hissLow.run(w)) * surge * surge * .012;
    if (--this.next_ <= 0) {
      const loud = r.range(.15, .9) * (r.uniform() < .08 ? 1.8 : 1);
      this.cracks.take().start(r.range(1500, 7000), r.range(.9, 2.2), loud, r.range(.0006, .003));
      if (this.burst > 0) { this.burst--; this.next_ = Math.floor(r.range(.005, .04) * RATE); }
      else { if (r.uniform() < .35) this.burst = Math.floor(r.range(2, 6)); this.next_ = r.gap(4 * f + 1); }
    }
    if (--this.nextPop <= 0) { this.nextPop = r.gap(.25); this.cracks.take().start(r.range(350, 900), 2, r.range(.4, .8), r.range(.008, .02)); }
    return s + this.cracks.run(r) * .5;
  }
}
/** Farnell's wind: a band rising with slow gusts, squalls inside each gust, a tracking whistle, and leaves at its strongest. */
class Wind {
  constructor(r) {
    this.r = r; this.pink = new Pink(); this.band = new Bandpass(500, 1.1); this.whistle = new Bandpass(1150, 9);
    this.brown = new BrownNoise(); this.rumble = new Lowpass(120); this.leafLow = new Lowpass(2200); this.squall = new Wobble(1.3); this.rustle = new Wobble(7);
    this.gust = new Drift(r, 7.3, 13.1, 23.7, 41.3); this.tick = 0; this.g = 0;
  }
  next() {
    const r = this.r;
    if ((this.tick++ & 63) === 0) { this.g = this.gust.step(64); const hz = 300 + 550 * this.g; this.band.set(hz, 1.1); this.whistle.set(hz * 2.3, 9); }
    const g = this.g, n = this.pink.run(r.white()), sq = 1 + .2 * g * this.squall.run(r.white()), leaves = n - this.leafLow.run(n);
    return this.band.run(n) * (.25 + .9 * g * g) * sq * 1.4 + this.whistle.run(n) * g * g * g * .6
      + leaves * g * g * Math.max(0, .6 + .4 * this.rustle.run(r.white())) * .25 + this.rumble.run(this.brown.run(r.white())) * .4;
  }
}
const BOWL = { RATIO: [1, 2.76, 5.18, 8.4], AMP: [1, .45, .22, .09], SECONDS: [14, 8, 4.5, 2.5], BEAT: [1.3, 2.1, 3.2, 4.1] };
/** Struck bowls: inharmonic partials, each a slightly detuned pair so they beat, decaying for many seconds. */
function strike(rings, base, velocity, amp) {
  for (let k = 0; k < 4; k++) {
    rings.take().start(base * BOWL.RATIO[k], BOWL.AMP[k] * velocity * amp, BOWL.SECONDS[k], .006, 1);
    rings.take().start(base * BOWL.RATIO[k] + BOWL.BEAT[k], BOWL.AMP[k] * velocity * amp, BOWL.SECONDS[k] * .9, .006, 1);
  }
}
class Bowl {
  constructor(r) { this.r = r; this.rings = new Rings(40); this.next_ = Math.floor(.2 * RATE); }
  next() {
    const r = this.r;
    if (--this.next_ <= 0) { strike(this.rings, r.uniform() < .7 ? 196 : 261.63, r.range(.75, 1), .05); this.next_ = Math.floor(r.range(10, 15) * RATE); }
    return this.rings.run();
  }
}
/** Pentatonic tubes (free-bar partials 1 : 2.76 : 5.40 : 8.93) rung more often as the wind picks up. */
class Chimes {
  constructor(r) {
    this.r = r; this.rings = new Rings(48); this.gust = new Drift(r, 8.3, 15.7, 27.1); this.pink = new Pink(); this.air = new Lowpass(500);
    this.next_ = Math.floor(.3 * RATE); this.tick = 0; this.g = .5;
    this.NOTES = [783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093]; this.RATIO = [1, 2.756, 5.404, 8.933]; this.AMP = [1, .32, .12, .05]; this.SECONDS = [3.2, 1.3, .55, .3];
  }
  next() {
    const r = this.r;
    if ((this.tick++ & 255) === 0) this.g = this.gust.step(256);
    if (--this.next_ <= 0) {
      const f = this.NOTES[Math.floor(r.uniform() * this.NOTES.length)], v = r.range(.3, 1);
      for (let k = 0; k < 4; k++) this.rings.take().start(f * this.RATIO[k] * (1 + r.range(-.002, .002)), this.AMP[k] * v * .06, this.SECONDS[k] * r.range(.8, 1.2), .002, 1);
      this.next_ = r.gap(.15 + 1.8 * this.g * this.g);
    }
    return this.rings.run() + this.air.run(this.pink.run(r.white())) * (.3 + .7 * this.g) * .25;
  }
}
class Brown {
  constructor(r) { this.r = r; this.brown = new BrownNoise(); this.soft = new Lowpass(900); }
  next() { return this.soft.run(this.brown.run(this.r.white())); }
}

/** A mono generator for the sound, or null for silence. @param breathMs position in the 10-second breath cycle. */
function create(sound, seed, breathMs) {
  const r = new Rng(seed);
  const makers = [null, () => new Calm(), () => new Rain(r), () => new Waves(r, false, 0), () => new Waves(r, true, breathMs), () => new Stream(r),
    () => new Birds(r), () => new Crickets(r), () => new Fire(r), () => new Wind(r), () => new Bowl(r), () => new Chimes(r), () => new Brown(r)];
  const make = makers[sound]; if (!make) return null;
  const g = make(), gain = GAIN[sound];
  return { next: () => g.next() * gain };
}
/** Stereo source: fills lr[0], lr[1]; null for silence. */
function stereo(sound, seed, breathMs) {
  const g = create(sound, seed, breathMs); if (!g) return null;
  const w = new Widener(sound);
  return { next(lr) { w.run(g.next()); lr[0] = w.l; lr[1] = w.r; } };
}

/**
 * The mix that actually plays: a background sound that fades in, can be swapped with a 2 s crossfade,
 * follows a target level (used for the meditation's closing fade), plus a singing-bowl bell on request.
 */
class Mix {
  constructor(bed, startLevel, settleSeconds) {
    this.bed = bed; this.old = null; this.level = startLevel; this.target = 1; this.fade = 1; this.o = [0, 0];
    this.bell = new Rings(16); this.smooth = 1 - Math.exp(-1 / (settleSeconds * RATE));
  }
  setBed(s) { this.old = this.bed; this.bed = s; this.fade = 0; }
  ringBell() { strike(this.bell, 196, 1, .07); }
  next(lr) {
    this.level += (this.target - this.level) * this.smooth;
    if (this.bed) this.bed.next(lr); else { lr[0] = 0; lr[1] = 0; }
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + 1 / (2 * RATE));
      const o = this.o; if (this.old) this.old.next(o); else { o[0] = 0; o[1] = 0; }
      lr[0] = lr[0] * this.fade + o[0] * (1 - this.fade); lr[1] = lr[1] * this.fade + o[1] * (1 - this.fade);
      if (this.fade >= 1) this.old = null;
    }
    const b = this.bell.run();
    lr[0] = lr[0] * this.level + b; lr[1] = lr[1] * this.level + b;
  }
}

const FADE_MS = 30000, BELL_MS = 14000;
/**
 * Runs in the audio thread. A meditation keeps its own clock here (in rendered frames), so its closing fade and bell
 * still happen on time when the page is in the background and the main thread is throttled.
 */
class Player {
  constructor(post) { this.post = post || (() => {}); this.mix = null; this.lr = [0, 0]; this.frames = 0; this.duration = 0; this.ending = -1; this.paused = false; }
  message(m) {
    if (m.type === 'play') {
      this.mix = new Mix(stereo(m.sound, m.seed, m.breathMs || 0), 0, m.meditation ? 3 : .3);
      this.frames = 0; this.duration = m.meditation ? Math.round(m.minutes * 60 * RATE) : 0; this.ending = -1; this.paused = false; this.bellOn = !!m.bell;
      if (m.meditation && m.bell) this.mix.ringBell();
    } else if (m.type === 'sound' && this.mix) this.mix.setBed(stereo(m.sound, m.seed, m.breathMs || 0));
    else if (m.type === 'pause') this.paused = true;
    else if (m.type === 'resume') this.paused = false;
    else if (m.type === 'stop') this.mix = null;
  }
  render(left, right) {
    const n = left.length;
    if (!this.mix || this.paused) { left.fill(0); right.fill(0); return; }
    const lr = this.lr;
    for (let i = 0; i < n; i++) { this.mix.next(lr); left[i] = lr[0]; right[i] = lr[1]; }
    if (!this.duration) return;
    this.frames += n;
    const remaining = Math.max(0, this.duration - this.frames) * 1000 / RATE;
    if (this.ending < 0) {
      this.mix.target = Math.min(1, remaining / FADE_MS);
      if (remaining <= 0) { this.ending = this.frames; if (this.bellOn) this.mix.ringBell(); }
    }
    if (this.ending >= 0 && (!this.bellOn || this.frames - this.ending > BELL_MS * RATE / 1000)) { this.mix = null; this.post({ type: 'ended' }); }
    // About four updates a second for the timer on screen and the lock-screen controls.
    if ((this.frames / n) % 32 === 0) this.post({ type: 'tick', remainingMs: remaining, ending: this.ending >= 0 });
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class SoundscapeProcessor extends AudioWorkletProcessor {
    constructor() {
      super(); setRate(sampleRate);
      this.player = new Player(m => this.port.postMessage(m));
      this.port.onmessage = e => this.player.message(e.data);
    }
    process(inputs, outputs) {
      const out = outputs[0];
      this.player.render(out[0], out[1] || out[0]);
      return true;
    }
  }
  registerProcessor('soundscape', SoundscapeProcessor);
}
if (typeof module !== 'undefined') module.exports = { NAMES, SHORT, DESCRIPTIONS, BREATH_WAVES, setRate, create, stereo, Mix, Player, Widener };
