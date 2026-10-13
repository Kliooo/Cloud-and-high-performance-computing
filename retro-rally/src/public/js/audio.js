// audio.js — WebAudio sound: engine noise, beeps and background music.
// No asset files: the chiptune loop is synthesised on the fly, so the project
// stays dependency-free and works offline.
//
// Separate volume buses: musicGain and sfxGain (engine, beeps, countdown).
// Values live in localStorage and survive a reload.

let ctx = null;
let master = null;
let musicGain = null;
let sfxGain = null;

let muted = false;
let musicVolume = 0.5;
let sfxVolume = 0.8;

let engine = null;
const ENGINE_GAIN = 0.02;
let countdownOscs = [];

const STORAGE_KEY = 'retro-rally:audio';

// ---------- Settings storage ----------

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (typeof raw.muted === 'boolean') muted = raw.muted;
    if (Number.isFinite(raw.music)) musicVolume = Math.max(0, Math.min(1, raw.music));
    if (Number.isFinite(raw.sfx)) sfxVolume = Math.max(0, Math.min(1, raw.sfx));
  } catch {
    /* private mode — play with the defaults */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted, music: musicVolume, sfx: sfxVolume }));
  } catch {
    /* could not save — not critical */
  }
}

loadPrefs();

// ---------- Context and buses ----------

function ac() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    musicGain = ctx.createGain();
    sfxGain = ctx.createGain();
    musicGain.connect(master);
    sfxGain.connect(master);
    master.connect(ctx.destination);
    applyGains();
  }
  return ctx;
}

function applyGains() {
  if (!musicGain || !sfxGain) return;
  musicGain.gain.value = muted ? 0 : musicVolume * 0.5; // music sits under the effects
  sfxGain.gain.value = muted ? 0 : sfxVolume;
}

// ---------- Music: a simple chiptune loop scheduled ahead of time ----------

const MUSIC = {
  bpm: 132,
  root: 110, // A2
  bassLine: [0, 0, 5, 7, 0, 0, 3, 5],
  arpLine: [12, 16, 19, 24, 19, 16, 12, 15],
  running: false,
  timer: 0,
  nextTime: 0,
  step: 0,
  noiseBuf: null,
};

function stepDur() {
  // sixteenth notes
  return 60 / MUSIC.bpm / 4;
}

function noteHz(semitone) {
  return MUSIC.root * Math.pow(2, semitone / 12);
}

function noiseBuffer(c) {
  if (MUSIC.noiseBuf) return MUSIC.noiseBuf;
  const len = Math.max(1, Math.floor(c.sampleRate * 0.06));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  MUSIC.noiseBuf = buf;
  return buf;
}

function tone(c, time, freq, dur, type, gain, target) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(g).connect(target || musicGain);
  osc.start(time);
  osc.stop(time + dur + 0.03);
}

function drumKick(c, time, target) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(160, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.14);
  g.gain.setValueAtTime(0.55, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  osc.connect(g).connect(target || musicGain);
  osc.start(time);
  osc.stop(time + 0.22);
}

function drumHat(c, time, target) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const g = c.createGain();
  g.gain.setValueAtTime(0.16, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  src.connect(g).connect(target || musicGain);
  src.start(time);
  src.stop(time + 0.07);
}

// One sequencer step: bass, arpeggio, kick drum and hi-hat
function musicStep(c, time, step) {
  const bar = Math.floor(step / 16) % 4;
  const beat = step % 16;

  if (beat % 8 === 0) drumKick(c, time);
  if (beat % 4 === 2) drumHat(c, time);

  const bassNote = MUSIC.bassLine[(Math.floor(step / 4) + bar * 3) % MUSIC.bassLine.length];
  if (beat % 4 === 0) tone(c, time, noteHz(bassNote - 12), 0.22, 'square', 0.16);

  const arpNote = MUSIC.arpLine[(step + bar * 2) % MUSIC.arpLine.length];
  if (beat % 2 === 0) tone(c, time, noteHz(arpNote), 0.12, 'triangle', 0.09);
}

function musicScheduler() {
  const c = ac();
  if (!c || !MUSIC.running) return;
  const horizon = c.currentTime + 0.12; // schedule 120 ms ahead
  while (MUSIC.nextTime < horizon) {
    const time = MUSIC.nextTime;
    if (time > c.currentTime) musicStep(c, time, MUSIC.step);
    MUSIC.step += 1;
    MUSIC.nextTime += stepDur();
  }
}

export const Sound = {
  unlock() {
    const c = ac();
    if (c && c.state === 'suspended') Promise.resolve(c.resume()).catch(() => {});
    return c;
  },
  isMuted() {
    return muted;
  },
  toggleMuted() {
    muted = !muted;
    applyGains();
    savePrefs();
    return muted;
  },
  setMuted(value) {
    muted = !!value;
    applyGains();
    savePrefs();
    return muted;
  },
  // ---------- Volume ----------

  getVolumes() {
    return { muted, music: musicVolume, sfx: sfxVolume };
  },
  setMusicVolume(value) {
    musicVolume = Math.max(0, Math.min(1, Number(value) || 0));
    applyGains();
    savePrefs();
    return musicVolume;
  },
  setSfxVolume(value) {
    sfxVolume = Math.max(0, Math.min(1, Number(value) || 0));
    applyGains();
    savePrefs();
    return sfxVolume;
  },

  // ---------- Music ----------

  isMusicPlaying() {
    return MUSIC.running;
  },
  startMusic() {
    const c = ac();
    if (!c || MUSIC.running) return;
    MUSIC.running = true;
    MUSIC.step = 0;
    MUSIC.nextTime = c.currentTime + 0.05;
    if (MUSIC.timer) clearInterval(MUSIC.timer);
    MUSIC.timer = setInterval(musicScheduler, 25);
  },
  stopMusic() {
    MUSIC.running = false;
    if (MUSIC.timer) {
      clearInterval(MUSIC.timer);
      MUSIC.timer = 0;
    }
  },

  // ---------- Effects ----------

  beep(freq, dur = 0.12, type = 'square', gain = 0.06) {
    if (muted) return;
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(sfxGain);
    osc.start();
    osc.stop(t0 + dur + 0.03);
  },
  // A beep at a given point on the audio clock: the countdown stays exact
  // regardless of frame rate.
  beepAt(delaySec, freq, dur = 0.12, type = 'square', gain = 0.06) {
    if (muted) return null;
    const c = ac();
    if (!c) return null;
    const t0 = c.currentTime + Math.max(0, delaySec);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    return osc;
  },
  // 3-2-1-GO countdown: beeps are scheduled on the audio clock, one per second.
  scheduleCountdown(seconds = 3, freq = 660, goFreq = 990) {
    this.cancelCountdown();
    const count = Math.max(1, Math.round(seconds));
    const plan = Array.from({ length: count + 1 }, (_, i) => i * 1000);
    if (muted) return plan;
    const c = ac();
    if (!c) return plan;
    const run = () => {
      const oscs = [];
      for (let i = 0; i < count; i++) {
        const o = this.beepAt(i, freq, 0.12);
        if (o) oscs.push(o);
      }
      const go = this.beepAt(count, goFreq, 0.4, 'square', 0.08);
      if (go) oscs.push(go);
      countdownOscs = oscs;
    };
    if (c.state === 'suspended') Promise.resolve(c.resume()).then(run).catch(() => {});
    else run();
    return plan;
  },
  cancelCountdown() {
    for (const o of countdownOscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    countdownOscs = [];
  },

  // ---------- Engine ----------

  startEngine() {
    const c = ac();
    if (!c || engine) return;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 58;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 480;
    const gain = c.createGain();
    gain.gain.value = muted ? 0 : ENGINE_GAIN * (sfxVolume || 1);
    osc.connect(filter).connect(gain).connect(sfxGain);
    osc.start();
    engine = { osc, gain };
  },
  engineSpeed(speed) {
    if (!engine) return;
    const k = Math.min(1, speed / 420);
    engine.osc.frequency.value = 55 + k * 155;
    engine.gain.gain.value = muted ? 0 : ENGINE_GAIN * (0.6 + k * 0.9) * (sfxVolume || 1);
  },
  stopEngine() {
    if (!engine) return;
    try {
      engine.osc.stop();
    } catch {
      /* already stopped */
    }
    engine = null;
  },
};
