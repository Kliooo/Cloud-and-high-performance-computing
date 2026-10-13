// game.js — race controller: loop, countdown, laps/checkpoints, camera, effects.

import { WORLD, TRACK, createCheckpointTracker, formatLap, gridSpawn, nearestSample, buildDemoTrack } from './track.js';
import { PHYS, createCar, stepCar, carSpeed } from './physics.js';
import { buildTrackCanvas, buildBridgeCanvas, drawWorld } from './render.js';
import { drawHud } from './hud.js';
import { Sound } from './audio.js';

const TOTAL_LAPS = 3;
const STEP = 1 / 120;
const CAMERA_ZOOM = 1.55;
const COUNTDOWN_MS = 3000;
// Bot rivals: differing skill (speed ceiling and corner caution).
// FxFx is fastest, Boris is mid, Daisy is slow.
const BOT_SPECS = [
  { name: 'FxFx', color: '#2E7D74', skill: 1.0, speedFactor: 1.0 },
  { name: 'Boris', color: '#F2B33D', skill: 0.95, speedFactor: 0.96 },
  { name: 'Daisy', color: '#FFF8EC', skill: 0.9, speedFactor: 0.91 },
];
const SKID_LIMIT = 900;
const PARTICLE_LIMIT = 220;

export class RaceGame {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.trackCanvas = buildTrackCanvas(TRACK);
    this.bridge = buildBridgeCanvas(TRACK);
    this.demo = this._buildDemo();
    this.tracker = createCheckpointTracker(TRACK);
    this.keys = new Set();
    this.state = 'idle';
    this.camera = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: CAMERA_ZOOM };
    this.skids = [];
    this.particles = [];
    this.shake = 0;
    this.toast = null;
    this.gateFlash = null;
    this.laps = [];
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.lapStartMs = 0;
    this.raceStartMs = 0;
    this.pausedAtMs = 0;
    this.lastGateIndex = TRACK.spawn.index;
    this.nowMs = 0;
    this.frameTimes = [];
    this.contactHits = 0;
    this.countdownEndMs = 0;
    this.raf = 0;
    this.lastFrame = 0;
    this.acc = 0;
    this.bots = [];
    this._contacts = new Set();

    this._initField();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._loop = this._loop.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.raf = requestAnimationFrame(this._loop);
  }

  // ---------- Lifecycle ----------

  _initField(opts = {}) {
    // the player sits on its grid slot (in multiplayer slot and colour come from the server)
    const playerSlot = Number.isFinite(opts.slot) ? opts.slot : 3;
    const playerSpawn = gridSpawn(TRACK, playerSlot);
    this.car = createCar(TRACK, playerSpawn);
    if (opts.color) this.car.color = opts.color;
    this.car.braking = false;
    this.car.tracker = this.tracker; // same interface as the bots, for _stepRaceCar
    // Bot slots: solo modes use 0,1,2; multiplayer sends the free slots, false means no bots.
    const botSlots = Array.isArray(opts.botSlots) ? opts.botSlots : opts.bots === false ? [] : [0, 1, 2];
    // live car colours (player + rivals): bots must not duplicate them
    const takenColors = new Set(
      [this.car.color, ...(Array.isArray(opts.peerColors) ? opts.peerColors : [])].filter(Boolean)
    );
    const botFallback = ['#2E7D74', '#F2B33D', '#8AB653', '#FFF8EC'];
    this.bots = botSlots.map((slotIndex, i) => {
      const spec = BOT_SPECS[i % BOT_SPECS.length];
      const spawn = gridSpawn(TRACK, slotIndex);
      const car = createCar(TRACK, spawn);
      car.color = spec.color;
      if (takenColors.has(car.color)) {
        const alt = botFallback.find((c) => !takenColors.has(c));
        if (alt) car.color = alt;
      }
      takenColors.add(car.color);
      car.name = spec.name;
      car.isBot = true;
      car.skill = spec.skill;
      car.speedFactor = spec.speedFactor;
      car.laps = [];
      car.bestLapMs = null;
      car.lapStartMs = 0;
      car.lastGateIndex = spawn.index;
      car.tracker = createCheckpointTracker(TRACK);
      car.stuckTime = 0;
      car.braking = false;
      return car;
    });
    // live opponent cars (multiplayer) — their positions arrive over the network
    this.peers = [];
    this.peerMap = new Map();
  }

  start(opts = {}) {
    this.lastOptions = { mode: 'race', bots: true, collisions: true, ...opts };
    this.mode = this.lastOptions.mode;
    this.botSlots = Array.isArray(this.lastOptions.botSlots) ? this.lastOptions.botSlots : null;
    this.botsEnabled = this.botSlots ? this.botSlots.length > 0 : this.lastOptions.bots !== false;
    this.carCollisions = this.lastOptions.collisions;
    this._initField({
      bots: this.botsEnabled,
      botSlots: this.botSlots || undefined,
      slot: this.lastOptions.slot,
      color: this.lastOptions.color,
      peerColors: (Array.isArray(this.lastOptions.peers) ? this.lastOptions.peers : []).map((p) => p.color),
    });
    this._initPeers(this.lastOptions.peers, this.lastOptions.slot);
    this.contactHits = 0;
    this._contacts.clear();
    this.tracker.reset();
    this.skids = [];
    this.particles = [];
    this.laps = [];
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.lastGateIndex = TRACK.spawn.index;
    this.toast = null;
    this.gateFlash = null;
    this.acc = 0;
    this.camera.x = this.car.x;
    this.camera.y = this.car.y;
    this.totalLaps = Math.max(1, Math.min(50, Math.round(this.lastOptions.laps || TOTAL_LAPS)));
    Sound.unlock();
    Sound.startEngine();
    // Schedule the 3-2-1-GO beeps on the audio clock right away: once per second,
    // independent of frame rate (they used to be frame-driven and drifted).
    // In multiplayer the countdown is aligned to the server startAt.
    const countdownMs = Math.max(600, Math.round(Number(this.lastOptions.startDelayMs) || COUNTDOWN_MS));
    this.countdownPlan = Sound.scheduleCountdown(countdownMs / 1000);
    this.state = 'countdown';
    this.countdownEndMs = performance.now() + countdownMs;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange('countdown');
  }

  toIdle() {
    this.state = 'idle';
    Sound.stopEngine();
    this._initField();
    this.camera.x = WORLD.w / 2;
    this.camera.y = WORLD.h / 2;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange('idle');
  }

  togglePause() {
    if (this.state === 'racing' || this.state === 'countdown') {
      this.pausedAtMs = performance.now();
      this._pausedPrevState = this.state;
      this.state = 'paused';
      Sound.stopEngine();
      Sound.cancelCountdown();
      if (this.callbacks.onPauseChange) this.callbacks.onPauseChange(true);
    } else if (this.state === 'paused') {
      const delta = performance.now() - this.pausedAtMs;
      this.lapStartMs += delta;
      this.raceStartMs += delta;
      this.countdownEndMs += delta;
      this.state = this._pausedPrevState || 'racing';
      if (this.state === 'racing' || this.state === 'countdown') Sound.startEngine();
      if (this.state === 'countdown') {
        const remainingSec = Math.max(0, (this.countdownEndMs - performance.now()) / 1000);
        this.countdownPlan = Sound.scheduleCountdown(remainingSec);
      }
      if (this.callbacks.onPauseChange) this.callbacks.onPauseChange(false);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    Sound.stopEngine();
  }

  // Rebuild the track canvases after a configuration change (direction, etc.)
  rebuildTrack() {
    this.trackCanvas = buildTrackCanvas(TRACK);
    this.bridge = buildBridgeCanvas(TRACK);
    this._initField({ bots: this.botsEnabled });
    this.camera.x = this.car.x;
    this.camera.y = this.car.y;
  }

  // ---------- Live background: a small figure-eight with bots behind the menu ----------

  _buildDemo() {
    const track = buildDemoTrack();
    const canvas = buildTrackCanvas(track);
    const bridge = buildBridgeCanvas(track);
    // demo cars are livelier than a race: higher speed ceiling, rarer braking
    const specs = [
      { color: '#E8542F', skill: 0.95, speedFactor: 1.08, name: 'You' },
      ...BOT_SPECS.map((b) => ({ ...b, speedFactor: b.speedFactor * 1.12 })),
    ];
    const cars = specs.map((spec, i) => {
      const car = createCar(track, gridSpawn(track, i % 4));
      car.color = spec.color;
      car.name = spec.name;
      car.skill = spec.skill;
      car.speedFactor = spec.speedFactor;
      car.stuckTime = 0;
      car.isDemo = true;
      return car;
    });
    const center = track.crossing || { x: track.samples[0].x, y: track.samples[0].y };
    return {
      track,
      canvas,
      bridge,
      cars,
      camera: { x: center.x, y: center.y, zoom: 0.55 },
      acc: 0,
    };
  }

  _stepDemo(dt) {
    const demo = this.demo;
    for (const car of demo.cars) {
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevAngle = car.angle;
      const input = this._botInput(car, demo.track);
      stepCar(car, input, dt, demo.track);
      const speed = carSpeed(car);
      if (speed < 12) car.stuckTime += dt;
      else car.stuckTime = 0;
      if (car.stuckTime > 2.2) {
        const s = demo.track.samples[car.hint];
        car.x = s.x;
        car.y = s.y;
        car.angle = s.angle;
        car.vx = 0;
        car.vy = 0;
        car.stuckTime = 0;
      }
    }
  }

  _renderDemo() {
    const demo = this.demo;
    drawWorld(this.ctx, {
      track: demo.track,
      trackCanvas: demo.canvas,
      bridge: demo.bridge,
      car: this._interp(demo.cars[0], Math.min(1, demo.acc / STEP)),
      bots: demo.cars.slice(1).map((c) => this._interp(c, Math.min(1, demo.acc / STEP))),
      hideBotNames: true,
      skids: [],
      particles: [],
      camera: demo.camera,
      shakeX: 0,
      shakeY: 0,
      gateState: null,
    });
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const vignette = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.42,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72
    );
    vignette.addColorStop(0, 'rgba(43,33,24,0)');
    vignette.addColorStop(1, 'rgba(43,33,24,0.2)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
    drawHud(this.ctx, {
      state: 'idle',
      lap: 1,
      totalLaps: 3,
      currentMs: 0,
      lastMs: null,
      bestMs: null,
      pos: { rank: 1, total: 1 },
      speed: 0,
      countdownLabel: null,
      countdownFrac: 1,
      toast: null,
      muted: Sound.isMuted(),
    });
  }

  // ---------- Input ----------

  _key(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  // Autopilot (for tests and the demo): follows the centreline, like a selftest bot
  _autopilotInput() {
    const samples = TRACK.samples;
    const n = samples.length;
    const ns = nearestSample(TRACK, this.car.x, this.car.y, this.car.hint);
    const speed = Math.hypot(this.car.vx, this.car.vy);
    const look = Math.max(3, Math.round((110 + speed * 0.55) / (TRACK.spacing || 14)));
    const t = samples[(ns.index + look) % n];
    // compensate lateral drift from the centreline — avoids oscillating near the walls
    const nx = -t.ty;
    const ny = t.tx;
    const latErr = (this.car.x - t.x) * nx + (this.car.y - t.y) * ny;
    const tx = t.x - nx * latErr * 0.85;
    const ty = t.y - ny * latErr * 0.85;
    const diff = Math.atan2(ty - this.car.y, tx - this.car.x) - this.car.angle;
    const norm = Math.atan2(Math.sin(diff), Math.cos(diff));
    const steer = Math.max(-1, Math.min(1, norm * 2.1));
    let throttle = 1;
    let brake = 0;
    if (speed > 60 && Math.abs(norm) > 0.5) {
      // lift off only while moving — a stationary car always gets throttle, otherwise
    // the "stand still → big angle → no throttle" cycle blocks the start
      throttle = 0;
      if (speed > 210) brake = 1;
    } else if (Math.abs(norm) > 0.22 && speed > 140) {
      throttle = 0.6;
    }
    return { throttle, brake, steer, handbrake: false };
  }

  _readInput() {
    if (this.autopilot) return this._autopilotInput();
    return {
      throttle: this._key('ArrowUp', 'KeyW') ? 1 : 0,
      brake: this._key('ArrowDown', 'KeyS') ? 1 : 0,
      steer: (this._key('ArrowLeft', 'KeyA') ? -1 : 0) + (this._key('ArrowRight', 'KeyD') ? 1 : 0),
      handbrake: this._key('Space'),
    };
  }

  _onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const code = e.code;
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)
    ) {
      e.preventDefault();
      this.keys.add(code);
    }
    if (code === 'KeyP' || code === 'Escape') {
      this.togglePause();
    } else if (code === 'KeyR' && this.state === 'racing') {
      this._respawn();
    } else if (code === 'KeyM') {
      Sound.toggleMuted();
      if (this.callbacks.onSoundChange) this.callbacks.onSoundChange();
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _respawn() {
    const s = TRACK.samples[this.lastGateIndex];
    this.car.x = s.x;
    this.car.y = s.y;
    this.car.angle = s.angle;
    this.car.vx = 0;
    this.car.vy = 0;
    this.car.hint = this.lastGateIndex;
    this.toastMsg('BACK ON TRACK', 1100);
  }

  toastMsg(text, ttl = 1600) {
    this.toast = { text, ttl, age: 0 };
  }

  // ---------- Multiplayer: live opponent cars ----------

  // Create "ghosts" for the room's players: placed on grid slots first, then their
  // positions arrive over the network (setPeerState) and are smoothed per frame.
  _initPeers(peers, playerSlot) {
    const list = Array.isArray(peers) ? peers : [];
    const mySlot = Number.isFinite(playerSlot) ? playerSlot : 3;
    this.peers = list.map((p, i) => {
      const slotIndex = Number.isFinite(p.slot) ? p.slot : (mySlot === i ? i + 1 : i) % 4;
      const spawn = gridSpawn(TRACK, slotIndex);
      const car = createCar(TRACK, spawn);
      car.color = p.color || '#2E7D74';
      car.name = p.name || 'Pilot';
      car.skill = 1;
      car.speedFactor = 1;
      car.laps = [];
      car.bestLapMs = null;
      car.isPeer = true;
      car.peerId = p.id;
      car.steer = 0;
      car.braking = false;
      car.tx = car.x;
      car.ty = car.y;
      car.ta = car.angle;
      car.fromX = car.x;
      car.fromY = car.y;
      car.fromA = car.angle;
      car.lerpT = 0;
      car.spanMs = 120;
      car.lastPacketMs = 0;
      car.tsp = 0;
      car.lp = 0;
      car.ex = 0;
      car.finished = false;
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevAngle = car.angle;
      car.hint = spawn.index;
      return car;
    });
    this.peerMap = new Map(this.peers.map((c) => [c.peerId, c]));
  }

  // An opponent snapshot arrived (peer event from the server).
  // The new target is NOT assigned directly: we remember "from where" and
  // interpolate over exactly one network tick, otherwise the car jerks per packet.
  setPeerState(id, s) {
    const car = this.peerMap && this.peerMap.get(id);
    if (!car || !s) return;
    const nowMs = performance.now();
    car.fromX = car.x;
    car.fromY = car.y;
    car.fromA = car.angle;
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      car.tx = s.x;
      car.ty = s.y;
      car.hint = nearestSample(TRACK, s.x, s.y, car.hint).index;
    }
    if (Number.isFinite(s.a)) car.ta = s.a;
    // bridge layer, used both for draw ordering and for the collision rule
    const range = TRACK.bridgeRange;
    car.onBridge = !!range && car.hint >= range.from && car.hint <= range.to;
    if (Number.isFinite(s.sp)) car.tsp = s.sp;
    car.braking = !!s.br;
    if (Number.isFinite(s.lp)) car.lp = s.lp;
    if (Number.isFinite(s.ex)) car.ex = s.ex;
    car.finished = !!s.fin;
    // span is derived from the actual packet arrival gaps (smoothed)
    if (car.lastPacketMs) {
      const gap = nowMs - car.lastPacketMs;
      if (gap > 20 && gap < 800) car.spanMs = car.spanMs * 0.7 + gap * 0.3;
    }
    car.lastPacketMs = nowMs;
    car.lerpT = 0;
  }

  // Snapshot of our own car to send to the server (~12 times per second)
  getNetState() {
    return {
      x: Math.round(this.car.x * 10) / 10,
      y: Math.round(this.car.y * 10) / 10,
      a: Math.round(this.car.angle * 1000) / 1000,
      sp: Math.round(carSpeed(this.car)),
      lp: this.laps.length,
      ex: this.tracker.expected,
      bs: this.bestLapMs,
      br: !!this.car.braking,
      fin: this.state === 'finished',
    };
  }

  // Opponent smoothing: between packets move linearly from "from" to "to"
  _updatePeers(dt) {
    if (!this.peers.length) return;
    const dtMs = dt * 1000;
    for (const car of this.peers) {
      car.lerpT += dtMs;
      const span = car.spanMs > 0 ? car.spanMs : 120;
      const k = Math.min(1, car.lerpT / span);
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevAngle = car.angle;
      car.x = car.fromX + (car.tx - car.fromX) * k;
      car.y = car.fromY + (car.ty - car.fromY) * k;
      let d = car.ta - car.fromA;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      car.angle = car.fromA + d * k;
    }
  }

  // Stats over the last ~120 frames — for the FPS counter (F3 or ?fps=1)
  frameStats() {
    const list = this.frameTimes || [];
    if (!list.length) return { frames: 0, fps: 0, avgMs: 0, p95Ms: 0, maxMs: 0, jank: 0 };
    const sorted = [...list].sort((a, b) => a - b);
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    return {
      frames: list.length,
      fps: Math.round(1000 / avg),
      avgMs: +avg.toFixed(1),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      maxMs: +sorted[sorted.length - 1].toFixed(1),
      jank: list.filter((x) => x > 33.4).length,
    };
  }

  // ---------- Effects ----------

  _addSkid(x, y, angle, alpha = 0.4) {
    this.skids.push({ x, y, angle, alpha });
    if (this.skids.length > SKID_LIMIT) this.skids.shift();
  }

  _addParticle(x, y, color, r, alpha = 0.5) {
    this.particles.push({ x, y, r, color, alpha, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30 });
    if (this.particles.length > PARTICLE_LIMIT) this.particles.shift();
  }

  _updateEffects(dt) {
    for (const s of this.skids) s.alpha -= dt * 0.09;
    while (this.skids.length && this.skids[0].alpha <= 0.02) this.skids.shift();

    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += dt * 9;
      p.alpha -= dt * 1.4;
    }
    this.particles = this.particles.filter((p) => p.alpha > 0.02);

    this.shake *= Math.exp(-6 * dt);
    if (this.toast) this.toast.age += dt * 1000;
  }

  _updateCamera(dt) {
    const speed = carSpeed(this.car);
    const lookX = this.car.x + this.car.vx * 0.22;
    const lookY = this.car.y + this.car.vy * 0.22;
    const k = Math.min(1, dt * 4.5);
    this.camera.x += (lookX - this.camera.x) * k;
    this.camera.y += (lookY - this.camera.y) * k;
    const halfW = this.canvas.width / (2 * this.camera.zoom);
    const halfH = this.canvas.height / (2 * this.camera.zoom);
    this.camera.x = Math.max(halfW, Math.min(WORLD.w - halfW, this.camera.x));
    this.camera.y = Math.max(halfH, Math.min(WORLD.h - halfH, this.camera.y));
    void speed;
  }

  // ---------- Physics step ----------

  _physicsStep(dt, now) {
    this._stepRaceCar(this.car, dt, now, true);
    if (this.botsEnabled) {
      for (const bot of this.bots) this._stepRaceCar(bot, dt, now, false);
    }
    // collisions count live players too — otherwise cars pass through each other in multiplayer
    if (this.carCollisions && (this.botsEnabled || this.peers.length)) {
      try {
        this._resolveCarContacts();
      } catch (err) {
        // safety net: any collision error must not kill the race loop
        this.carCollisions = false;
        this.toastMsg('COLLISIONS OFF (error)', 2200);
        console.error('[retro-rally] collisions disabled:', err);
      }
    }
  }

  _stepRaceCar(car, dt, now, isPlayer) {
    car.prevX = car.x;
    car.prevY = car.y;
    car.prevAngle = car.angle;
    const input = isPlayer ? this._readInput() : this._botInput(car);
    car.braking = input.brake > 0;
    const hit = stepCar(car, input, dt, TRACK);
    const range = TRACK.bridgeRange;
    car.onBridge = !!range && car.hint >= range.from && car.hint <= range.to;
    if (isPlayer && hit) this.shake = Math.min(9, this.shake + 4.5);

    const speed = carSpeed(car);
    if (car.slip > 55 || (input.handbrake && speed > 90)) {
      const cos = Math.cos(car.angle);
      const sin = Math.sin(car.angle);
      this._addSkid(car.x - cos * 13 - sin * 8, car.y - sin * 13 + cos * 8, car.angle, 0.4);
      this._addSkid(car.x - cos * 13 + sin * 8, car.y - sin * 13 - cos * 8, car.angle, 0.4);
    }
    if (!car.onRoad && speed > 60 && Math.random() < (isPlayer ? 0.4 : 0.25)) {
      this._addParticle(car.x - Math.cos(car.angle) * 15, car.y - Math.sin(car.angle) * 15, '201,166,107', 2.5, 0.42);
    }
    if (input.throttle > 0 && speed < 80 && Math.random() < 0.15) {
      this._addParticle(car.x - Math.cos(car.angle) * 19, car.y - Math.sin(car.angle) * 19, '120,120,128', 2, 0.3);
    }

    const events = car.tracker.update(car.x, car.y, now);
    for (const ev of events) {
      if (ev.type === 'gate') {
        car.lastGateIndex = TRACK.gates[ev.gate].index;
        if (ev.gate === 0) {
          if (isPlayer) this._onLapComplete(now);
          else this._onBotLap(car, now);
        } else if (isPlayer && this.gateFlash && this.gateFlash.id === ev.gate) {
          this.gateFlash = null;
        }
      } else if (ev.type === 'skip' && isPlayer) {
        this.toastMsg(`MISSED SECTOR ${ev.expected}`, 1600);
        this.gateFlash = { id: ev.expected, until: now + 2400 };
      }
    }

    if (!isPlayer) {
      // a stuck bot goes back to its last checkpoint
      if (speed < 12) car.stuckTime += dt;
      else car.stuckTime = 0;
      if (car.stuckTime > 2.2) {
        const s = TRACK.samples[car.lastGateIndex];
        car.x = s.x;
        car.y = s.y;
        car.angle = s.angle;
        car.vx = 0;
        car.vy = 0;
        car.hint = car.lastGateIndex;
        car.stuckTime = 0;
      }
    }
  }

  // Bot AI: follow the centreline with a skill level (lookahead, corner caution,
  // speed ceiling via speedFactor)
  _botInput(bot, track = TRACK) {
    const skill = bot.skill;
    const samples = track.samples;
    const n = samples.length;
    const speed = carSpeed(bot);
    if (bot.isDemo) return this._demoInput(bot, samples, n, speed);
    const lookCfg = track.botLook || { base: 100, skill: 45 };
    const look = Math.max(3, Math.round((lookCfg.base + skill * lookCfg.skill) / (track.spacing || 14)));
    const target = samples[(bot.hint + look) % n];
    const diff = Math.atan2(target.y - bot.y, target.x - bot.x) - bot.angle;
    const norm = Math.atan2(Math.sin(diff), Math.cos(diff));
    // steering fades at low speed — no twitchiness or bouncing backwards
    const steer = Math.max(
      -1,
      Math.min(1, norm * (1.4 + skill * 0.6) * Math.min(1, 0.3 + speed / 170))
    );
    let throttle = 1;
    let brake = 0;
    const caution = 0.5 + (1 - skill) * 0.12;
    if (speed > 60 && Math.abs(norm) > caution) {
      // stationary bots always get throttle — otherwise they never move off
      throttle = 0;
      if (speed > 180 + skill * 120) brake = 1;
    } else if (Math.abs(norm) > 0.22 && speed > 140) {
      throttle = 0.6;
    }
    return { throttle, brake, steer, handbrake: false };
  }

  // Car contact shoves rather than fully collides: the impulse goes to the car
  // ahead, the one behind barely loses momentum.
  // Live-background profile: long lookahead, almost no lift — cars run the
  // figure-eight tightly and fast, no crawling and no bouncing backwards.
  _demoInput(bot, samples, n, speed) {
    const look = Math.max(3, Math.round((100 + bot.skill * 45) / (this.demo.track.spacing || 10)));
    const target = samples[(bot.hint + look) % n];
    const diff = Math.atan2(target.y - bot.y, target.x - bot.x) - bot.angle;
    const norm = Math.atan2(Math.sin(diff), Math.cos(diff));
    const steer = Math.max(
      -1,
      Math.min(1, norm * 1.45 * Math.min(1, 0.32 + speed / 175))
    );
    let throttle = 1;
    let brake = 0;
    if (Math.abs(norm) > 0.85) {
      throttle = 0.7;
      if (speed > 300) brake = 0.25;
    } else if (Math.abs(norm) > 0.4) {
      throttle = 0.9;
    }
    return { throttle, brake, steer, handbrake: false };
  }

  _resolveCarContacts() {
    const cars = [this.car, ...this.bots, ...this.peers];
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        // two networked cars do not collide with each other — the server owns them
        if (a.isPeer && b.isPeer) continue;
        if ((a.onBridge || false) !== (b.onBridge || false)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = PHYS.CAR_CONTACT_MIN;
        if (d >= min || d <= 0.001) continue;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = min - d;

        // A live opponent car is kinematic: the network owns its position, so only the
        // local car is pushed back and the closing speed is killed.
        if (a.isPeer || b.isPeer) {
          const mover = a.isPeer ? b : a;
          const pushSign = a.isPeer ? 1 : -1;
          mover.x += pushSign * nx * overlap;
          mover.y += pushSign * ny * overlap;
          const vn = mover.vx * nx + mover.vy * ny;
          const approaching = a.isPeer ? vn < 0 : vn > 0;
          if (approaching) {
            this.contactHits += 1;
            mover.vx -= vn * nx * 1.1;
            mover.vy -= vn * ny * 1.1;
            mover.vx *= 0.9;
            mover.vy *= 0.9;
            if (mover === this.car) this.shake = Math.min(9, this.shake + 3.2);
          }
          continue;
        }

        a.x -= (nx * overlap) / 2;
        a.y -= (ny * overlap) / 2;
        b.x += (nx * overlap) / 2;
        b.y += (ny * overlap) / 2;
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const push = -vn * 1.05;
          const aDrivesIntoB = a.vx * nx + a.vy * ny > 0;
          if (aDrivesIntoB) {
            b.vx += push * nx * 0.95;
            b.vy += push * ny * 0.95;
            a.vx -= push * nx * 0.12;
            a.vy -= push * ny * 0.12;
          } else {
            a.vx -= push * nx * 0.95;
            a.vy -= push * ny * 0.95;
            b.vx += push * nx * 0.12;
            b.vy += push * ny * 0.12;
          }
        }
      }
    }
  }

  _onBotLap(bot, now) {
    if (bot.laps.length >= 3) return;
    const lapMs = Math.max(1, Math.round(now - bot.lapStartMs));
    bot.laps.push(lapMs);
    bot.bestLapMs = bot.bestLapMs === null ? lapMs : Math.min(bot.bestLapMs, lapMs);
    bot.lapStartMs = now;
  }

  _onLapComplete(now) {
    const lapMs = Math.max(1, Math.round(now - this.lapStartMs));
    this.laps.push(lapMs);
    this.lastLapMs = lapMs;
    const isBest = this.bestLapMs === null || lapMs < this.bestLapMs;
    if (isBest) this.bestLapMs = lapMs;
    this.lapStartMs = now;
    this.gateFlash = null; // a new lap brings every sector line back
    Sound.beep(880, 0.15, 'triangle', 0.07);

    if (this.laps.length >= this.totalLaps) {
      this._finishRace();
      return;
    }
    const prefix = isBest ? 'BEST LAP! ' : '';
    this.toastMsg(`${prefix}LAP ${this.laps.length}/${this.totalLaps} — ${formatLap(lapMs)}`, 2000);
  }

  _finishRace() {
    this.state = 'finished';
    Sound.stopEngine();
    Sound.beep(990, 0.35, 'triangle', 0.08);
    const total = this.laps.reduce((a, b) => a + b, 0);
    const standings = [
      { name: 'You', isPlayer: true, best: this.bestLapMs },
      ...this.bots.map((b) => ({ name: b.name, isPlayer: false, best: b.bestLapMs })),
    ].sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
    const place = standings.findIndex((s) => s.isPlayer) + 1;
    if (this.callbacks.onFinish) {
      const multiplayer = this.mode === 'multiplayer';
      // in multiplayer the server decides final places — the local table is hidden
      const standingsRows = multiplayer || !this.botsEnabled
        ? null
        : [
            { name: 'You', isPlayer: true, best: this.bestLapMs },
            ...this.bots.map((b) => ({ name: b.name, isPlayer: false, best: b.bestLapMs })),
          ].sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
      this.callbacks.onFinish({
        laps: [...this.laps],
        best: this.bestLapMs,
        totalMs: total,
        mode: this.mode,
        standings: standingsRows,
        place: standingsRows ? standingsRows.findIndex((s) => s.isPlayer) + 1 : null,
        fieldSize: standingsRows ? standingsRows.length : multiplayer ? this.peers.length + 1 : 1,
        // training laps also reach the leaderboard — tagged with the mode
        canSubmit: this.mode === 'race' || this.mode === 'training',
      });
    }
    if (this.callbacks.onStateChange) this.callbacks.onStateChange('finished');
  }

  // ---------- Frame ----------

  // Smooth rendering between physics steps: at 120+ Hz the step (1/120) does not
  // line up with a frame and the car visibly stutters. Interpolate by the remainder.
  _interp(car, alpha) {
    if (car.prevX === undefined) return car;
    const copy = Object.assign({}, car);
    copy.x = car.prevX + (car.x - car.prevX) * alpha;
    copy.y = car.prevY + (car.y - car.prevY) * alpha;
    let d = car.angle - car.prevAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    copy.angle = car.prevAngle + d * alpha;
    return copy;
  }

  _loop(ts) {
    this.raf = requestAnimationFrame(this._loop);
    if (!this.lastFrame) this.lastFrame = ts;
    const rawMs = ts - this.lastFrame;
    const dt = Math.min(1 / 30, rawMs / 1000);
    if (rawMs > 0 && rawMs < 2000) {
      this.frameTimes.push(rawMs);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
    }
    this.lastFrame = ts;
    this.nowMs = ts;

    if (this.state === 'countdown') {
      const remaining = this.countdownEndMs - ts;
      const prev = Math.ceil((remaining + dt * 1000) / 1000);
      const cur = Math.ceil(remaining / 1000);
      // the countdown beep is already scheduled in start() — this is only the visuals
      if (remaining <= 0) {
        this.state = 'racing';
        this.raceStartMs = ts;
        this.lapStartMs = ts;
        for (const bot of this.bots) bot.lapStartMs = ts;
        this.toastMsg('GO!', 1100);
        if (this.callbacks.onStateChange) this.callbacks.onStateChange('racing');
      }
    }

    if (this.state === 'racing') {
      this.acc += dt;
      while (this.acc >= STEP && this.state === 'racing') {
        this._physicsStep(STEP, ts);
        this.acc -= STEP;
      }
      Sound.engineSpeed(carSpeed(this.car));
    }

    if (this.state === 'idle') {
      // live background: bots drive a small figure-eight behind the menu
      const demo = this.demo;
      demo.acc += dt;
      while (demo.acc >= STEP) {
        this._stepDemo(STEP);
        demo.acc -= STEP;
      }
      this._renderDemo();
      return;
    }

    this._updateEffects(dt);
    this._updatePeers(dt);
    this._updateCamera(dt);

    drawWorld(this.ctx, {
      track: TRACK,
      trackCanvas: this.trackCanvas,
      bridge: this.bridge,
      car: this._interp(this.car, Math.min(1, this.acc / STEP)),
      bots: this.bots.map((b) => this._interp(b, Math.min(1, this.acc / STEP))).concat(this.peers),
      skids: this.skids,
      particles: this.particles,
      camera: this.camera,
      shakeX: (Math.random() - 0.5) * this.shake,
      shakeY: (Math.random() - 0.5) * this.shake,
      gateState: { pendingFrom: this.tracker.expected, flash: this.gateFlash, now: ts },
    });

    const progressOf = (car, isPlayer) => {
      const laps = isPlayer ? this.laps.length : car.laps.length;
      const exp = isPlayer ? this.tracker.expected : car.tracker.expected;
      return laps * 10 + (exp === 0 ? 9 : exp) + (car.hint / TRACK.samples.length) * 0.9;
    };
    const me = progressOf(this.car, true);
    let rank = 1;
    for (const bot of this.bots) {
      if (progressOf(bot, false) > me) rank += 1;
    }
    // live opponents rank by their last known progress
    for (const peer of this.peers) {
      const peerProgress = (peer.lp || 0) * 10 + ((peer.ex || 0) === 0 ? 9 : peer.ex);
      if (peerProgress > me) rank += 1;
    }

    const remaining = Math.max(0, this.countdownEndMs - ts);
    const frac = (remaining % 1000) / 1000;
    drawHud(this.ctx, {
      state: this.state,
      lap: Math.min(this.laps.length + 1, this.totalLaps),
      totalLaps: this.totalLaps,
      currentMs: this.state === 'racing' ? ts - this.lapStartMs : this.lastLapMs || 0,
      lastMs: this.lastLapMs,
      bestMs: this.bestLapMs,
      pos: { rank, total: this.bots.length + this.peers.length + 1 },
      speed: carSpeed(this.car),
      countdownLabel:
        this.state === 'countdown'
          ? remaining > 0
            ? String(Math.max(1, Math.ceil(remaining / 1000)))
            : null
          : null,
      countdownFrac: this.state === 'countdown' ? (remaining > 1000 ? frac : 1 - frac) : 1,
      toast: this.toast,
      muted: Sound.isMuted(),
    });
  }
}
