'use strict';
/* 작은 회복 웹판: the Android app's screens, with sound synthesized in an AudioWorklet (synth.js). Nothing is sent anywhere;
   only the sound, volume, guide, meditation length and bell choices are kept in this browser. */

const NAMES = ['소리 없이', '잔잔한 음', '부드러운 빗소리', '파도', '호흡 파도', '시냇물', '숲속 새소리', '풀벌레', '모닥불', '바람', '싱잉볼', '윈드차임', '브라운 노이즈'];
const SHORT = ['소리 없음', '잔잔한 음', '빗소리', '파도', '호흡 파도', '시냇물', '새소리', '풀벌레', '모닥불', '바람', '싱잉볼', '윈드차임', '브라운 노이즈'];
const DESCRIPTIONS = ['조용히 호흡에만', '낮고 부드러운 화음', '창밖에 내리는 비', '밀려왔다 물러가는 바다', '4초 밀려오고 6초 물러가요', '돌 사이로 흐르는 물', '아침 숲의 작은 새들', '여름밤 귀뚜라미', '타닥타닥 장작 타는 소리', '들판을 지나는 바람', '길게 울리는 명상 종', '바람에 흔들리는 풍경', '깊고 고른 소리, 집중에'];
const $ = id => document.getElementById(id);
const now = () => performance.now();
const pad = n => String(n).padStart(2, '0');
const clockText = ms => { const s = Math.ceil(ms / 1000); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };

// ---- settings (private windows may refuse storage; the app works without it) ----
const prefs = (() => {
  // The bell is opt-in; it is stored as 'bells' so browsers that saved the old always-on default start with it off.
  const defaults = { sound: 1, volume: 35, guide: true, medMinutes: 20, bells: false };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('small-recovery') || '{}') || {}; } catch (e) { saved = {}; }
  const p = Object.assign({}, defaults, saved);
  if (!(p.sound >= 0 && p.sound < NAMES.length)) p.sound = 1;
  p.save = () => { try { localStorage.setItem('small-recovery', JSON.stringify({ sound: p.sound, volume: p.volume, guide: p.guide, medMinutes: p.medMinutes, bells: p.bells })); } catch (e) { /* not kept */ } };
  return p;
})();

// ---- session clock (same rules as the Android Session class) ----
const session = {
  minutes: 1, elapsed: 0, started: 0, running: false, completed: false,
  duration() { return this.minutes * 60000; },
  elapsedAt(t) { return Math.min(this.duration(), this.elapsed + (this.running ? Math.max(0, t - this.started) : 0)); },
  remaining(t) { return Math.max(0, this.duration() - this.elapsedAt(t)); },
  start(t) { if (this.completed) this.reset(); this.started = t; this.running = true; },
  pause(t) { this.elapsed = this.elapsedAt(t); this.running = false; },
  reset() { this.running = false; this.completed = false; this.elapsed = 0; },
  tick(t) { if (this.running && this.remaining(t) === 0) { this.pause(t); this.completed = true; return true; } return false; },
  phase(t) { return (this.elapsedAt(t) % 10000) / 10000; },
  inhale(t) { return this.phase(t) < 0.4; },
  expansion(t) { const p = this.phase(t), x = p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6; return 0.5 - 0.5 * Math.cos(Math.PI * x); },
};

// ---- audio: one worklet plays whatever is current: the reset's sound, a preview, or the meditation ----
const audio = {
  ctx: null, node: null, gain: null, ready: null, mode: null,
  /** Must start inside a tap: browsers (iOS especially) only allow sound after a user gesture. */
  unlock() {
    // Safari 16.4+: play like a media app, so the ring/silent switch does not mute it.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !window.AudioWorkletNode) return Promise.reject(new Error('no audio worklet'));
      this.ctx = new AC({ latencyHint: 'playback' });
      this.ctx.resume();
      this.ready = this.ctx.audioWorklet.addModule('synth.js').then(() => {
        this.node = new AudioWorkletNode(this.ctx, 'soundscape', { numberOfInputs: 0, outputChannelCount: [2] });
        this.gain = this.ctx.createGain(); this.gain.gain.value = prefs.volume / 100;
        this.node.connect(this.gain); this.gain.connect(this.ctx.destination);
        this.node.port.onmessage = e => meditation.fromAudio(e.data);
      });
      this.ctx.addEventListener('statechange', () => meditation.contextChanged());
    } else if (this.ctx.state !== 'running') this.ctx.resume();
    return this.ready;
  },
  send(m) { if (this.node) this.node.port.postMessage(m); },
  play(sound, opts) {
    this.mode = opts.meditation ? 'meditation' : opts.preview ? 'preview' : 'reset';
    this.send(Object.assign({ type: 'play', sound, seed: (Math.random() * 4294967296) >>> 0 }, opts));
    this.setLevel(prefs.volume / 100);
  },
  stop() { this.send({ type: 'stop' }); this.mode = null; },
  setLevel(v, seconds) { if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, seconds || .05); },
};

/**
 * Keeps the screen on for whoever needs it (the reset, the meditation). The web cannot keep sound going with an iPhone's screen off,
 * so the meditation is listened to with the screen on. Browsers drop the lock when the page is hidden; it is taken again on return.
 */
const awake = {
  lock: null, pending: false, reasons: new Set(), supported: 'wakeLock' in navigator,
  want(reason, on) { if (on) this.reasons.add(reason); else this.reasons.delete(reason); this.apply(); },
  apply() {
    if (this.reasons.size && !this.lock && !this.pending && this.supported && !document.hidden) {
      this.pending = true;
      navigator.wakeLock.request('screen').then(l => {
        this.pending = false;
        if (!this.reasons.size) { l.release().catch(() => {}); return; }
        this.lock = l; l.addEventListener('release', () => { this.lock = null; });
      }).catch(() => { this.pending = false; });
    }
    if (!this.reasons.size && this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
  },
};

// ---- breath circle ----
function drawCircle(canvas, inner, label, sub, big) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const x = w / 2, y = h / 2, max = Math.max(10, Math.min(Math.min(w, h) / 2 - 6, 136));
  c.fillStyle = '#ebefe5'; c.beginPath(); c.arc(x, y, max, 0, 2 * Math.PI); c.fill();
  c.strokeStyle = '#cedaca'; c.lineWidth = 1; c.stroke();
  c.fillStyle = '#d9e7d4'; c.beginPath(); c.arc(x, y, max * inner, 0, 2 * Math.PI); c.fill();
  c.textAlign = 'center'; c.fillStyle = '#2d4034';
  const font = getComputedStyle(document.body).fontFamily;
  c.font = (big ? '300 40px ' : '20px ') + font; c.fillText(label, x, y + (big ? 10 : -3));
  c.fillStyle = '#6d7c6d'; c.font = '12px ' + font; c.fillText(sub, x, y + (big ? 34 : 23));
}

// ---- main screen: the short reset ----
const main = {
  lastCue: -1, answered: false,
  init() {
    for (const b of $('durations').children) b.addEventListener('click', () => {
      session.reset(); session.minutes = +b.dataset.min; this.stopSound(); $('feedback').hidden = true; this.refresh();
    });
    $('primary').addEventListener('click', () => this.primary());
    $('stop').addEventListener('click', () => { session.pause(now()); this.stopSound(); session.completed = true; this.refresh(); });
    for (const b of $('feedback').querySelectorAll('button')) b.addEventListener('click', () => {
      $('message').textContent = b.dataset.feel === 'worse' ? '더 쉬어도 괜찮아요. 오늘은 천천히 가요.' : '지금의 나를 알아차린 것만으로 충분해요.';
      this.answered = true; $('feedback').hidden = true;
    });
    this.refresh(); this.loop();
  },
  primary() {
    if (session.running) { this.pause('잠시 멈췄어요. 준비되면 이어가세요.'); return; }
    if (meditation.active) {
      if (!confirm('명상을 끝내고 리셋을 시작할까요?')) return;
      meditation.end();
    }
    $('feedback').hidden = true;
    session.start(now()); this.lastCue = -1; this.refresh(); awake.want('reset', true);
    if (prefs.sound > 0) {
      audio.unlock().then(() => { if (session.running) audio.play(prefs.sound, { breathMs: session.elapsedAt(now()) % 10000 }); })
        .catch(() => { $('message').textContent = '이 브라우저에서는 소리를 낼 수 없어 조용히 진행해요.'; });
    }
  },
  pause(why) {
    session.pause(now()); this.stopSound(); this.refresh(); $('message').textContent = why;
  },
  stopSound() { if (audio.mode === 'reset') audio.stop(); awake.want('reset', false); },
  refresh() {
    const t = now();
    for (const b of $('durations').children) {
      const picked = session.minutes === +b.dataset.min;
      b.setAttribute('aria-pressed', picked); b.disabled = !session.completed && (session.running || session.elapsed > 0);
    }
    $('primary').textContent = session.running ? '잠시 멈추기' : session.completed ? `다시 ${session.minutes}분 쉬기` : session.elapsed > 0 ? '이어서 쉬기' : `${session.minutes}분 리셋 시작`;
    $('stop').hidden = !(session.running || (session.elapsed > 0 && !session.completed));
    $('feedback').hidden = !session.completed || this.answered;
    $('message').textContent = session.completed ? '잠시 내려놓은 시간, 충분히 잘했어요.' : session.running ? '지금은 숨 하나에만 머물러요.' : session.elapsed > 0 ? '잠시 멈췄어요. 준비되면 이어가세요.' : '이 시간만큼은 나에게 돌아와요.';
    $('soundChip').textContent = '♪ ' + SHORT[prefs.sound]; $('soundChip').setAttribute('aria-label', '소리 고르기, 지금은 ' + NAMES[prefs.sound]);
    this.updateClock(t); this.draw(t);
  },
  updateClock(t) {
    const label = clockText(session.remaining(t));
    if ($('clock').textContent !== label) $('clock').textContent = label;
    if (prefs.guide && session.running) {
      const cue = session.inhale(t) ? 0 : 1;
      if (cue !== this.lastCue) { this.lastCue = cue; $('breath').setAttribute('aria-label', cue === 0 ? '편하게 들이쉬어요, 4초' : '천천히 내쉬어요, 6초'); }
    }
    const m = meditation.active ? `☾ 명상 중 · 남은 ${Math.ceil(meditation.remainingMs / 60000)}분 ›` : '☾ 명상 모드 · 화면을 켠 채 들어요 ›';
    if ($('meditateLink').textContent !== m) $('meditateLink').textContent = m;
  },
  draw(t) {
    const moving = prefs.guide && session.running;
    const label = session.completed ? '잘 쉬었어요' : !session.running ? (session.elapsed > 0 ? '잠시 머물러요' : '숨을 편하게') : !prefs.guide ? '편하게 쉬어요' : session.inhale(t) ? '들이쉬어요' : '내쉬어요';
    const sub = moving ? (session.inhale(t) ? '편안하게 · 4초' : '천천히 · 6초') : '지금, 이 순간';
    drawCircle($('breath'), moving ? 0.65 + 0.27 * session.expansion(t) : 0.78, label, sub, false);
  },
  /** The clock runs on a timer, so the end is caught even where animation frames are paused; frames only animate the circle. */
  loop() {
    setInterval(() => {
      const t = now();
      if (session.tick(t)) {
        this.answered = false; this.stopSound(); this.refresh();
        $('message').textContent = '리셋을 마쳤어요. 지금 마음은 어떤가요?';
      }
      if (session.running) {
        const left = session.remaining(t);
        if (left < 1500 && audio.mode === 'reset') audio.setLevel(prefs.volume / 100 * left / 1500, .02);
      }
      if (!$('main').hidden) this.updateClock(t);
    }, 100);
    const frame = () => { if (session.running && !$('main').hidden) this.draw(now()); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  },
};

// ---- sound screen ----
const sounds = {
  previewing: -1,
  init() {
    const grid = $('grid');
    NAMES.forEach((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tile'; b.setAttribute('role', 'option'); b.dataset.i = i;
      b.innerHTML = '<span class="name"></span><span class="detail"></span>';
      b.querySelector('.name').textContent = name;
      b.addEventListener('click', () => this.choose(i));
      grid.appendChild(b);
    });
    $('volume').value = prefs.volume;
    $('volume').addEventListener('input', e => { prefs.volume = +e.target.value; audio.setLevel(prefs.volume / 100); });
    $('volume').addEventListener('change', () => prefs.save());
    $('guide').checked = prefs.guide;
    $('guide').addEventListener('change', e => { prefs.guide = e.target.checked; prefs.save(); });
  },
  show() {
    $('soundsSub').textContent = meditation.active ? '누르면 명상 소리가 바로 바뀌어요.' : '눌러서 미리 들어보고 골라요.';
    this.refresh();
    const picked = $('grid').children[prefs.sound]; if (picked) picked.scrollIntoView({ block: 'nearest' });
  },
  hide() { if (audio.mode === 'preview') audio.stop(); this.previewing = -1; },
  choose(i) {
    prefs.sound = i; prefs.save();
    if (meditation.active) { audio.send({ type: 'sound', sound: i, seed: (Math.random() * 4294967296) >>> 0 }); meditation.refresh(); this.refresh(); return; }
    if (i === 0 || this.previewing === i) { if (audio.mode === 'preview') audio.stop(); this.previewing = -1; this.refresh(); return; }
    this.previewing = i; this.refresh();
    audio.unlock().then(() => { if (this.previewing === i) audio.play(i, { preview: true }); })
      .catch(() => { this.previewing = -1; $('soundStatus').textContent = '이 브라우저에서는 소리를 낼 수 없어요.'; this.refresh(); });
  },
  refresh() {
    [...$('grid').children].forEach((b, i) => {
      const picked = i === prefs.sound, playing = i === this.previewing;
      b.setAttribute('aria-selected', picked); b.classList.toggle('playing', playing);
      b.querySelector('.detail').textContent = playing ? '♪ 듣는 중' : DESCRIPTIONS[i];
    });
    $('soundStatus').textContent = meditation.active ? '명상 중에는 소리가 2초에 걸쳐 바뀌어요.' : this.previewing > 0 ? '미리 듣는 중이에요. 다시 누르면 멈춰요.' : '고른 소리는 바로 저장돼요.';
  },
};

// ---- meditation ----
const meditation = {
  active: false, held: false, ending: false, remainingMs: 0, minutes: 20,
  init() {
    for (const b of $('medDurations').children) b.addEventListener('click', () => { prefs.medMinutes = +b.dataset.min; prefs.save(); this.refresh(); });
    $('bell').checked = prefs.bells;
    $('bell').addEventListener('change', e => { prefs.bells = e.target.checked; prefs.save(); });
    $('medPrimary').addEventListener('click', () => this.primary());
    $('medEnd').addEventListener('click', () => this.end());
    $('medDim').addEventListener('click', () => this.dim(true));
    $('dim').addEventListener('click', () => this.dim(false));
    $('dim').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') this.dim(false); });
    this.refresh(); setInterval(() => { if (!$('meditation').hidden) this.draw(); if (!$('dim').hidden) this.drawDim(); }, 250);
  },
  primary() {
    if (!this.active) this.begin(); else if (this.held) this.resume(); else this.hold();
  },
  begin() {
    if (session.running) main.pause('명상을 시작해서 리셋은 잠시 멈췄어요.');
    this.minutes = prefs.medMinutes; this.remainingMs = this.minutes * 60000; this.active = true; this.held = false; this.ending = false;
    this.refresh();
    audio.unlock().then(() => {
      if (!this.active) return;
      audio.play(prefs.sound, { meditation: true, minutes: this.minutes, bell: prefs.bells });
    }).catch(() => { this.active = false; awake.want('meditation', false); $('medNote').textContent = '이 브라우저에서는 소리를 낼 수 없어요.'; this.refresh(); });
    awake.want('meditation', true);
  },
  hold(why) { this.held = true; audio.send({ type: 'pause' }); awake.want('meditation', false); this.refresh(); if (why) $('medNote').textContent = why; },
  resume() {
    this.held = false; awake.want('meditation', true);
    audio.unlock().then(() => audio.send({ type: 'resume' }));
    this.refresh();
  },
  end() { this.active = false; this.held = false; this.ending = false; audio.stop(); awake.want('meditation', false); this.refresh(); if (!$('dim').hidden) this.drawDim(); },
  /** A black screen for the meditation: only a faint clock that drifts every minute so no spot stays lit. Tap to come back. */
  dim(on) {
    $('dim').hidden = !on;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', on ? '#000000' : '#f6f7f1');
    if (on) { $('dimHint').classList.remove('gone'); clearTimeout(this.hintTimer); this.hintTimer = setTimeout(() => $('dimHint').classList.add('gone'), 4000); this.drawDim(); $('dim').focus(); }
    else $('medPrimary').focus();
  },
  drawDim() {
    const text = this.active ? (this.ending ? '잘 머물렀어요' : clockText(this.remainingMs) + (this.held ? ' · 멈춤' : '')) : '명상을 마쳤어요';
    if ($('dimClock').textContent !== text) $('dimClock').textContent = text;
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== this.dimMinute) {
      this.dimMinute = minute;
      const r = (Math.imul(minute, 2654435761) >>> 0) / 4294967296, q = (minute * 40503 % 1000) / 1000;
      $('dimClock').parentElement.style.setProperty('--dx', ((r - .5) * 50).toFixed(1) + 'vw');
      $('dimClock').parentElement.style.setProperty('--dy', ((q - .5) * 50).toFixed(1) + 'vh');
    }
  },
  fromAudio(m) {
    if (audio.mode !== 'meditation') return;
    if (m.type === 'tick') { this.remainingMs = m.remainingMs; if (m.ending !== this.ending) { this.ending = m.ending; this.refresh(); } }
    else if (m.type === 'ended') { this.end(); $('medNote').textContent = '잘 머물렀어요. 명상을 마쳤어요.'; }
  },
  /** iOS stops web audio when the screen goes off or a call comes in; show it as paused so one tap brings it back. */
  contextChanged() {
    if (this.active && !this.held && audio.ctx.state !== 'running') this.hold('소리가 멈췄어요. 누르면 이어져요.');
  },
  refresh() {
    for (const b of $('medDurations').children) {
      b.setAttribute('aria-pressed', (this.active ? this.minutes : prefs.medMinutes) === +b.dataset.min); b.disabled = this.active;
    }
    $('medChip').textContent = '♪ ' + SHORT[prefs.sound]; $('medChip').setAttribute('aria-label', '소리 고르기, 지금은 ' + NAMES[prefs.sound]);
    $('medPrimary').textContent = !this.active ? `${prefs.medMinutes}분 명상 시작` : this.ending ? '마무리하는 중' : this.held ? '이어서 하기' : '잠시 멈추기';
    $('medPrimary').disabled = this.ending;
    $('medEnd').hidden = $('medDim').hidden = !this.active || this.ending;
    $('medNote').textContent = !this.active ? (awake.supported ? '화면은 저절로 꺼지지 않아요.' : '이 기기는 화면이 저절로 꺼질 수 있어요. 자동 잠금 시간을 늘려 주세요.')
      : this.ending ? '마지막 종소리가 잦아들고 있어요.' : this.held ? '잠시 멈췄어요.' : '어둡게를 누르면 화면이 어두워져요.';
    this.draw();
  },
  draw() {
    const t = now(), moving = this.active && !this.held && !this.ending;
    const left = this.active ? this.remainingMs : prefs.medMinutes * 60000;
    drawCircle($('medCircle'), moving ? 0.74 + 0.06 * Math.sin(2 * Math.PI * (t % 16000) / 16000) : 0.78, clockText(left),
      !this.active ? '편안한 자세로' : this.ending ? '잘 머물렀어요' : this.held ? '잠시 멈춤' : '그저 머물러요', true);
    const spoken = '남은 시간 ' + Math.ceil(left / 60000) + '분';
    if ($('medCircle').getAttribute('aria-label') !== spoken) $('medCircle').setAttribute('aria-label', spoken);
  },
};

// ---- navigation: hash routes, so the iPhone swipe-back and the browser back button work ----
function route() {
  const view = location.hash === '#sounds' ? 'sounds' : location.hash === '#meditation' ? 'meditation' : 'main';
  for (const id of ['main', 'sounds', 'meditation']) $(id).hidden = id !== view;
  if (view !== 'sounds') sounds.hide();
  if (view !== 'main' && session.running) main.pause('잠시 멈췄어요. 준비되면 이어가세요.');
  if (view === 'sounds') sounds.show();
  if (view === 'main') main.refresh();
  if (view === 'meditation') meditation.refresh();
}
// Leaving the page pauses the short reset (like the Android app). The meditation plays on where the browser allows it
// (a desktop tab in the background); if the phone stopped the audio meanwhile, it shows as paused on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session.running) main.pause('잠시 멈췄어요. 준비되면 이어가세요.');
  if (document.hidden && audio.mode === 'preview') sounds.hide(), sounds.refresh();
  if (!document.hidden) {
    awake.apply();
    if (meditation.active && !meditation.held && audio.ctx && audio.ctx.state !== 'running') meditation.hold('화면이 꺼져서 멈췄어요. 누르면 이어져요.');
  }
});
// A wake lock can be refused when the page is not focused yet; ask again on the next touch.
document.addEventListener('pointerdown', () => awake.apply());
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { main.draw(now()); meditation.draw(); });
main.init(); sounds.init(); meditation.init(); route();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
