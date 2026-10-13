'use strict';

// selftest.js — headless check of EVERY track in the registry: the map (sector
// posts, decor, bridge) plus 3 laps driven by a bot on pure physics.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModules() {
  const base = path.join(__dirname, '..', 'src', 'public', 'js');
  const trackMod = await import(pathToFileURL(path.join(base, 'track.js')).href);
  const physicsMod = await import(pathToFileURL(path.join(base, 'physics.js')).href);
  return { trackMod, physicsMod };
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function botInput(car, TRACK) {
  const samples = TRACK.samples;
  const n = samples.length;
  const lookCfg = TRACK.botLook || { base: 150, skill: 90 };
  const look = Math.max(3, Math.round(lookCfg.base / (TRACK.spacing || 14)));
  const target = samples[(car.hint + look) % n];
  const angleToTarget = Math.atan2(target.y - car.y, target.x - car.x);
  const diff = normalizeAngle(angleToTarget - car.angle);
  const steer = Math.max(-1, Math.min(1, diff * 1.8));
  const speed = Math.hypot(car.vx, car.vy);
  let throttle = 1;
  let brake = 0;
  // lift off only while moving — otherwise the "stand still → big angle → no throttle" cycle
  if (speed > 60 && Math.abs(diff) > 0.55) {
    throttle = 0;
    if (speed > 230) brake = 1;
  } else if (Math.abs(diff) > 0.25 && speed > 140) {
    throttle = 0.6;
  }
  return { throttle, brake, steer, handbrake: false, diff };
}

// Live-background profile: long lookahead, almost no lift (mirrors _demoInput).
function demoInput(car, TRACK) {
  const samples = TRACK.samples;
  const n = samples.length;
  const skill = car.skill ?? 1;
  const look = Math.max(3, Math.round((100 + skill * 45) / (TRACK.spacing || 10)));
  const target = samples[(car.hint + look) % n];
  const diff = normalizeAngle(Math.atan2(target.y - car.y, target.x - car.x) - car.angle);
  const speed = Math.hypot(car.vx, car.vy);
  const steer = Math.max(-1, Math.min(1, diff * 1.45 * Math.min(1, 0.32 + speed / 175)));
  let throttle = 1;
  let brake = 0;
  if (Math.abs(diff) > 0.85) {
    throttle = 0.7;
    if (speed > 300) brake = 0.25;
  } else if (Math.abs(diff) > 0.4) {
    throttle = 0.9;
  }
  return { throttle, brake, steer, handbrake: false, diff };
}

function runLaps(trackMod, physicsMod, maxSimSec = 300, totalLaps = 3, inputFn = botInput, speedFactor = 1) {
  const TRACK = trackMod.TRACK;
  const STEP = 1 / 120;
  const car = physicsMod.createCar(TRACK);
  car.speedFactor = speedFactor;
  car.skill = 1;
  const tracker = trackMod.createCheckpointTracker(TRACK);
  let simSec = 0;
  let lapStart = 0;
  const lapTimes = [];
  let stuckTime = 0;
  let reversing = 0;
  let lastDiff = 1;
  let skips = 0;

  while (simSec < maxSimSec && lapTimes.length < totalLaps) {
    let input;
    if (reversing > 0) {
      reversing -= STEP;
      input = { throttle: 0, brake: 1, steer: -Math.sign(lastDiff || 1), handbrake: false };
    } else {
      input = inputFn(car, TRACK);
      lastDiff = input.diff;
      const speed = Math.hypot(car.vx, car.vy);
      if (speed < 15) stuckTime += STEP;
      else stuckTime = 0;
      if (stuckTime > 1.2) {
        reversing = 0.9;
        stuckTime = 0;
      }
    }

    physicsMod.stepCar(car, input, STEP, TRACK);

    for (const ev of tracker.update(car.x, car.y, simSec * 1000)) {
      if (ev.type === 'gate' && ev.gate === 0) {
        lapTimes.push(simSec - lapStart);
        lapStart = simSec;
      } else if (ev.type === 'skip') {
        skips++;
      }
    }

    if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.vx) || !Number.isFinite(car.vy)) {
      return { lapTimes, simSec, skips, error: 'non-finite-car-state' };
    }
    simSec += STEP;
  }
  return { lapTimes, simSec, skips };
}

function checkMap(trackMod) {
  const TRACK = trackMod.TRACK;
  const sectorGates = TRACK.gates.filter((g) => g.id !== 0);
  if (!sectorGates.every((g) => Array.isArray(g.posts) && g.posts.length === 2)) return 'gate-posts-missing';
  const billboardClear = TRACK.decor.trees.every((t) =>
    TRACK.decor.billboards.every((b) => Math.hypot(t.x - b.x, t.y - b.y) >= 80)
  );
  if (!billboardClear) return 'tree-overlaps-billboard';
  if (!TRACK.decor.pond || !TRACK.decor.grandstand) return 'landmarks-missing';
  const landmarksClear = [TRACK.decor.pond, TRACK.decor.grandstand].every(
    (l) => trackMod.nearestSample(TRACK, l.x, l.y).dist >= 100
  );
  if (!landmarksClear) return 'landmark-too-close-to-road';
  const postsClear = TRACK.obstacles.every((o) => trackMod.nearestSample(TRACK, o.x, o.y).dist >= 52);
  if (!postsClear) return 'post-on-road';
  return null;
}

async function main() {
  const { trackMod, physicsMod } = await loadModules();
  const fmt = (sec) => {
    const ms = Math.round(sec * 1000);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };

  for (const def of trackMod.TRACK_LIST) {
    trackMod.setTrack(def.id);
    const mapErr = checkMap(trackMod);
    if (mapErr) {
      console.log(`SELFTEST FAIL track=${def.id} reason=${mapErr}`);
      process.exit(1);
    }
    const { lapTimes, simSec, skips, error } = runLaps(trackMod, physicsMod);
    if (error) {
      console.log(`SELFTEST FAIL track=${def.id} reason=${error}`);
      process.exit(1);
    }
    if (lapTimes.length < 3) {
      console.log(`SELFTEST FAIL track=${def.id} reason=laps-not-completed laps=${lapTimes.length} simSec=${simSec.toFixed(1)}`);
      process.exit(1);
    }
    for (const sec of lapTimes) {
      const ms = sec * 1000;
      if (ms < 5000 || ms > 120000) {
        console.log(`SELFTEST FAIL track=${def.id} reason=lap-out-of-range lapMs=${ms.toFixed(0)}`);
        process.exit(1);
      }
    }
    console.log(
      `SELFTEST PASS track=${def.id} laps=${lapTimes.map(fmt).join(',')} skips=${skips} posts=${trackMod.TRACK.obstacles.length} bridge=${trackMod.TRACK.bridgeRange ? 'yes' : 'no'}`
    );
  }

  // live background: the small figure-eight must be drivable
  Object.assign(trackMod.TRACK, trackMod.buildDemoTrack());
  const demoErr = checkMap(trackMod);
  if (demoErr) {
    console.log(`SELFTEST FAIL track=demo8 reason=${demoErr}`);
    process.exit(1);
  }
  const demoRun = runLaps(trackMod, physicsMod, 150, 2);
  if (demoRun.error || demoRun.lapTimes.length < 2) {
    console.log(`SELFTEST FAIL track=demo8 reason=not-drivable laps=${demoRun.lapTimes.length}`);
    process.exit(1);
  }
  console.log(`SELFTEST PASS track=demo8 laps=${demoRun.lapTimes.map(fmt).join(',')} crossing=${trackMod.TRACK.crossing ? 'yes' : 'no'}`);
  const fastRun = runLaps(trackMod, physicsMod, 150, 2, demoInput, 1.12);
  const fastAvg = fastRun.lapTimes.reduce((a, b) => a + b, 0) / fastRun.lapTimes.length;
  Object.assign(trackMod.TRACK, trackMod.buildDemoTrack());
  const perimeter = trackMod.TRACK.samples.reduce((acc, s, i) => {
    const p = trackMod.TRACK.samples[(i + 1) % trackMod.TRACK.samples.length];
    return acc + Math.hypot(p.x - s.x, p.y - s.y);
  }, 0);
  console.log(`SELFTEST PASS track=demo8-fast laps=${fastRun.lapTimes.map(fmt).join(',')} avg=${fmt(fastAvg)} speed=${Math.round(perimeter / fastAvg)}px/s`);

  trackMod.setTrack(trackMod.TRACK_LIST[0].id);
  console.log(`SELFTEST MAP OK tracks=${trackMod.TRACK_LIST.length}+demo8`);
  process.exit(0);
}

main().catch((err) => {
  console.log(`SELFTEST FAIL reason=exception ${err && err.message}`);
  process.exit(1);
});
