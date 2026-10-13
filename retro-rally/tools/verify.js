'use strict';

// verify.js — integration check of the server: health, result storage,
// validation, leaderboard ordering and persistence across a process restart.
//
// The script deletes nothing: test results go to a separate file
// (src/data/test-results.json, set via DATA_FILE) which can be removed by hand —
// it never touches the game data (src/data/results.json).

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
// A fresh file per run: the script deletes nothing (by design), so every run
// starts from clean storage. src/data/test-results-*.json can be removed by hand.
const DATA_FILE = process.env.VERIFY_DATA_FILE
  ? path.resolve(process.env.VERIFY_DATA_FILE)
  : path.join(ROOT, 'src', 'data', `test-results-${process.pid}-${Date.now()}.json`);
// The pilot registry gets its own file too, otherwise test pilots linger in the
// shared data/pilots.json and spoil the next run.
const PILOTS_FILE = path.join(ROOT, 'src', 'data', `test-pilots-${process.pid}-${Date.now()}.json`);

let failures = 0;

function check(name, cond, extra) {
  if (cond) {
    console.log(`VERIFY PASS ${name}`);
  } else {
    failures++;
    console.log(`VERIFY FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE, PILOTS_FILE, ADMIN_KEY: 'verify-admin-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* the server has not come up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function postJson(pathname, raw, contentType = 'application/json') {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: raw,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal SSE client for the multiplayer checks: reads the event stream and
// can wait for a specific event matching a predicate.
async function openEvents(playerId, name) {
  const ctrl = new AbortController();
  const events = [];
  const waiters = [];
  const api = {
    events,
    of(type) {
      return events.filter((e) => e.type === type);
    },
    wait(type, timeoutMs = 4000, predicate = null) {
      return new Promise((resolve) => {
        const found = events.filter((e) => e.type === type && (!predicate || predicate(e.data)));
        if (found.length) return resolve(found[found.length - 1].data);
        const timer = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({
          type,
          predicate,
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          },
        });
      });
    },
    close() {
      try {
        ctrl.abort();
      } catch {
        /* already closed */
      }
    },
  };

  const res = await fetch(
    `${BASE}/api/mp/events?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(name)}`,
    { signal: ctrl.signal }
  );
  if (!res.ok || !res.body) throw new Error(`SSE did not open: ${res.status}`);

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = 'message';
          const dataLines = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          let data = null;
          try {
            data = JSON.parse(dataLines.join('\n'));
          } catch {
            data = null;
          }
          events.push({ type, data });
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w.type === type && (!w.predicate || w.predicate(data))) {
              waiters.splice(i, 1);
              w.resolve(data);
            }
          }
        }
      }
    } catch {
      /* the stream is closed — that is normal */
    }
  })();

  return api;
}

async function main() {
  const server = startServer();
  check('server.up', await waitHealth());
  check('server.child-alive', server.exitCode === null, `exitCode=${server.exitCode}`);

  const health = await getJson('/api/health');
  check('health.ok', health.status === 200 && health.json && health.json.status === 'ok', JSON.stringify(health.json));
  check(
    'health.storage-match',
    !!(health.json && health.json.storage && path.resolve(health.json.storage) === path.resolve(DATA_FILE)),
    JSON.stringify(health.json && health.json.storage)
  );

  // Three valid races
  const p1 = await postJson('/api/results', JSON.stringify({ playerName: 'Bot-Pilot-1', carName: 'Test Car', laps: [41234, 40999, 41500] }));
  check('post1.created', p1.status === 201 && p1.json && p1.json.saved, JSON.stringify(p1.json));
  check('post1.best=min(laps)', !!(p1.json && p1.json.saved && p1.json.saved.bestLapMs === 40999));
  check('post1.rank1', !!(p1.json && p1.json.rank === 1));

  const p2 = await postJson('/api/results', JSON.stringify({ playerName: 'Bot-Pilot-2', laps: [40900, 41111] }));
  check('post2.created', p2.status === 201);
  check('post2.rank1-total2', !!(p2.json && p2.json.rank === 1 && p2.json.total === 2));

  const p3 = await postJson('/api/results', JSON.stringify({ playerName: 'Bot-Pilot-3', laps: [42000] }));
  check('post3.created', p3.status === 201);
  check('post3.rank3-total3', !!(p3.json && p3.json.rank === 3 && p3.json.total === 3));

  // Invalid requests
  const bad1 = await postJson('/api/results', JSON.stringify({ playerName: '', laps: [10000] }));
  check('reject.empty-name', bad1.status === 400);
  const bad2 = await postJson('/api/results', JSON.stringify({ playerName: 'X' }));
  check('reject.no-laps', bad2.status === 400);
  const bad3 = await postJson('/api/results', JSON.stringify({ playerName: 'X', laps: [100] }));
  check('reject.lap-too-small', bad3.status === 400);
  const bad4 = await postJson('/api/results', '{broken json');
  check('reject.bad-json', bad4.status === 400);
  const bad5 = await postJson('/api/results', JSON.stringify({ playerName: 'X', laps: Array.from({ length: 51 }, () => 42000) }));
  check('reject.too-many-laps', bad5.status === 400);
// a non-latin track slug must be rejected outright
  const pTrack = await postJson('/api/results', JSON.stringify({ playerName: 'Track-Bad', track: 'плохая трасса!', laps: [42000] }));
  check('reject.bad-track', pTrack.status === 400, JSON.stringify(pTrack.json));

  // Leaderboard ordering
  const lb = await getJson('/api/leaderboard');
  const names = lb.json && lb.json.items ? lb.json.items.map((i) => i.playerName) : [];
  check(
    'leaderboard.sorted',
    lb.status === 200 && names[0] === 'Bot-Pilot-2' && names[1] === 'Bot-Pilot-1' && names[2] === 'Bot-Pilot-3',
    names.join(',')
  );
  check('leaderboard.total=3', !!(lb.json && lb.json.total === 3));

  // Persistence: restart the server process
  await stopServer(server);
  const server2 = startServer();
  check('server.restart', await waitHealth());

  const lb2 = await getJson('/api/leaderboard');
  const names2 = lb2.json && lb2.json.items ? lb2.json.items.map((i) => i.playerName) : [];
  check(
    'persistence.same-3-results',
    lb2.status === 200 && names2.length === 3 && names2[0] === 'Bot-Pilot-2',
    names2.join(',')
  );
  const ids1 = ((lb.json && lb.json.items) || []).map((i) => i.id).sort();
  const ids2 = ((lb2.json && lb2.json.items) || []).map((i) => i.id).sort();
  check('persistence.same-ids', JSON.stringify(ids1) === JSON.stringify(ids2));

  await stopServer(server2);

  // ---------- Multiplayer: rooms, password, ready, chat, synchronised start ----------
  const mpServer = startServer();
  check('mp.server.up', await waitHealth());

  const AID = 'mp-test-alpha-01';
  const BID = 'mp-test-bravo-02';
  const CID = 'mp-test-charlie3';
  const evA = await openEvents(AID, 'Alpha');
  const evC = await openEvents(CID, 'Charlie');
  check('mp.hello', !!(await evA.wait('hello')) && !!(await evC.wait('hello')));

  const rooms0 = await getJson('/api/mp/rooms');
  check('mp.rooms-endpoint', rooms0.status === 200 && Array.isArray(rooms0.json.rooms), JSON.stringify(rooms0.json));

  // A: open room, no bots; B: password room
  const rc = await postJson(
    '/api/mp/action',
    JSON.stringify({ playerId: AID, action: 'create', name: 'Alpha', roomName: 'Open Cup', track: 'wheatfield', laps: 1, bots: 0, collisions: true })
  );
  check('mp.create-open-room', rc.status === 200 && !!rc.json.room && rc.json.room.hasPassword === false, JSON.stringify(rc.json));
  const roomA = rc.json.room.id;

  const rl = await postJson(
    '/api/mp/action',
    JSON.stringify({ playerId: BID, action: 'create', name: 'Bravo', roomName: 'Locked Cup', track: 'canyon', laps: 3, bots: 2, password: 's3cret' })
  );
  check('mp.create-locked-room', rl.status === 200 && !!rl.json.room && rl.json.room.hasPassword === true, JSON.stringify(rl.json));
  const roomB = rl.json.room.id;

  const rooms1 = await getJson('/api/mp/rooms');
  const infoA = (rooms1.json.rooms || []).find((r) => r.id === roomA);
  const infoB = (rooms1.json.rooms || []).find((r) => r.id === roomB);
  check('mp.rooms-list', !!infoA && !!infoB, JSON.stringify(rooms1.json));
  check('mp.room-lock-flag', !!infoB && infoB.hasPassword === true && !!infoA && infoA.hasPassword === false);
  check('mp.room-max-players', !!infoA && infoA.maxPlayers === 4 && infoA.players === 1, JSON.stringify(infoA));
  check('mp.room-settings', !!infoB && infoB.bots === 2 && infoB.track === 'canyon' && infoB.laps === 3, JSON.stringify(infoB));

  // C against the password room
  const j1 = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomB, name: 'Charlie' }));
  check('mp.join.password-required', j1.status === 403 && j1.json.error === 'password_required', JSON.stringify(j1.json));
  const j2 = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomB, name: 'Charlie', password: 'wrong' }));
  check('mp.join.bad-password', j2.status === 403 && j2.json.error === 'bad_password', JSON.stringify(j2.json));
  const j3 = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomB, name: 'Charlie', password: 's3cret' }));
  check('mp.join.correct-password', j3.status === 200 && !!j3.json.room && j3.json.room.players.length === 2, JSON.stringify(j3.json));
  const j3b = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomB, name: 'Charlie' }));
  check('mp.join.rejoin-idempotent', j3b.status === 200 && !!j3b.json.room && j3b.json.room.players.length === 2, JSON.stringify(j3b.json));
  const j4 = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomA, name: 'Charlie' }));
  check('mp.join.already-in-room', j4.status === 409 && j4.json.error === 'already_in_room', JSON.stringify(j4.json));
  const leave1 = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'leave' }));
  check('mp.leave', leave1.status === 200 && leave1.json.left === true, JSON.stringify(leave1.json));
  const closeB = await postJson('/api/mp/action', JSON.stringify({ playerId: BID, action: 'close' }));
  check('mp.close-room', closeB.status === 200 && !!closeB.json.ok, JSON.stringify(closeB.json));

  // C joins open room A; the two players get different slots
  const jc = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'join', roomId: roomA, name: 'Charlie' }));
  check('mp.join.open-room', jc.status === 200 && !!jc.json.room && jc.json.room.players.length === 2, JSON.stringify(jc.json));
  const slotA = jc.json.room.players.find((p) => p.id === AID).slot;
  const slotC = jc.json.room.players.find((p) => p.id === CID).slot;
  check('mp.slots-unique', slotA !== slotC, `${slotA}/${slotC}`);

  const readyA = await postJson('/api/mp/action', JSON.stringify({ playerId: AID, action: 'ready', ready: true }));
  check('mp.ready-one-waits', readyA.status === 200 && readyA.json.ready === true && !readyA.json.autostart, JSON.stringify(readyA.json));

  const chatC = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'chat', text: 'Hello from Charlie' }));
  check('mp.chat-send', chatC.status === 200 && !!chatC.json.ok, JSON.stringify(chatC.json));
  const chatSeen = await evA.wait('chat', 3000, (d) => d && d.message && d.message.text === 'Hello from Charlie');
  check('mp.chat-broadcast', !!chatSeen && chatSeen.message.name === 'Charlie', JSON.stringify(chatSeen));
  const chatXss = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'chat', text: '<img src=x onerror=alert(1)>' }));
  const xssSeen = await evA.wait('chat', 3000, (d) => d && d.message && d.message.text.includes('onerror'));
  check('mp.chat-keeps-text-as-data', chatXss.status === 200 && !!xssSeen && typeof xssSeen.message.text === 'string');

  // both ready — autostart with a shared countdown
  const readyC = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'ready', ready: true }));
  check('mp.autostart', readyC.status === 200 && readyC.json.autostart === true, JSON.stringify(readyC.json));
  const startA = await evA.wait('race_start', 3000);
  check('mp.race-start-grid', !!startA && Array.isArray(startA.grid) && startA.grid.length === 2, JSON.stringify(startA && startA.grid));
  const cdLeft = startA ? startA.startAt - Date.now() : null;
  check('mp.race-start-countdown', cdLeft !== null && cdLeft > 0 && cdLeft <= 3500, String(cdLeft));
  check('mp.race-bots-off', !!startA && startA.bots === 0, startA ? String(startA.bots) : 'null');
  check('mp.race-track', !!startA && startA.track === 'wheatfield' && startA.laps === 1, JSON.stringify(startA && { track: startA.track, laps: startA.laps }));

  // car position exchange
  const st = await postJson(
    '/api/mp/action',
    JSON.stringify({ playerId: AID, action: 'state', s: { x: 100, y: 200, a: 0.5, sp: 120, lp: 0, ex: 3, br: true, fin: false } })
  );
  check('mp.state-accepted', st.status === 200 && st.json.relayed === true, JSON.stringify(st.json));
  const peer = await evC.wait('peer', 3000, (d) => d && d.id === AID);
  check('mp.peer-broadcast', !!peer && !!peer.s && peer.s.x === 100 && peer.s.br === true, JSON.stringify(peer));

  // both finish — places from the server and a leaderboard write
  const finA = await postJson('/api/mp/action', JSON.stringify({ playerId: AID, action: 'finish', laps: [42000, 43000], lapsDone: 2 }));
  check('mp.finish-accepted', finA.status === 200 && finA.json.ok === true, JSON.stringify(finA.json));
  const finC = await postJson('/api/mp/action', JSON.stringify({ playerId: CID, action: 'finish', laps: [41000, 44000], lapsDone: 2 }));
  check('mp.finish-second', finC.status === 200 && finC.json.ok === true, JSON.stringify(finC.json));
  const results = await evA.wait('results', 4000);
  check('mp.results-event', !!results && Array.isArray(results.standings) && results.standings.length === 2, JSON.stringify(results && results.standings));
  check('mp.results-order', !!results && results.standings[0].name === 'Charlie' && results.standings[0].place === 1, JSON.stringify(results && results.standings));
  check('mp.results-saved', !!results && Array.isArray(results.saved) && results.saved.length === 2, JSON.stringify(results && results.saved));

  // leaderboard: mode tag and mode filter
  const lbMp = await getJson('/api/leaderboard?mode=multiplayer');
  const mpNames = (lbMp.json.items || []).map((i) => i.playerName);
  check('lb.mp-filter', lbMp.status === 200 && mpNames.includes('Alpha') && mpNames.includes('Charlie'), JSON.stringify(mpNames));
  check('lb.mp-mode-field', (lbMp.json.items || []).length > 0 && lbMp.json.items.every((i) => i.mode === 'multiplayer'), JSON.stringify(lbMp.json.items));

  const tr = await postJson('/api/results', JSON.stringify({ playerName: 'Trainer', track: 'wheatfield', laps: [45000, 46000], mode: 'training' }));
  check('res.training-post', tr.status === 201 && !!tr.json.saved, JSON.stringify(tr.json));
  const lbTr = await getJson('/api/leaderboard?mode=training');
  check('lb.training-filter', lbTr.status === 200 && (lbTr.json.items || []).some((i) => i.playerName === 'Trainer'), JSON.stringify(lbTr.json.items));
  check(
    'lb.mode-counts',
    !!lbTr.json.modeCounts && lbTr.json.modeCounts.training >= 1 && lbTr.json.modeCounts.multiplayer === 2,
    JSON.stringify(lbTr.json.modeCounts)
  );
  const badMode = await postJson('/api/results', JSON.stringify({ playerName: 'Trainer', track: 'wheatfield', laps: [45000], mode: 'hack' }));
  check('res.reject-bad-mode', badMode.status === 400, JSON.stringify(badMode.json));

  const mpStats = await getJson('/api/mp/stats');
  check('mp.stats', mpStats.status === 200 && typeof mpStats.json.rooms === 'number' && mpStats.json.players >= 2, JSON.stringify(mpStats.json));

  // a solo start in multiplayer is no longer rejected
  const DID = 'mp-test-delta-004';
  const evD = await openEvents(DID, 'Delta');
  check('mp.solo.hello', !!(await evD.wait('hello')));
  const soloCreate = await postJson(
    '/api/mp/action',
    JSON.stringify({ playerId: DID, action: 'create', name: 'Delta', roomName: 'Solo Cup', track: 'canyon', laps: 1, bots: 2 })
  );
  check('mp.solo.create', soloCreate.status === 200 && !!soloCreate.json.room, JSON.stringify(soloCreate.json));
  const soloReady = await postJson('/api/mp/action', JSON.stringify({ playerId: DID, action: 'ready', ready: true }));
  check('mp.solo.ready-no-autostart', soloReady.status === 200 && !soloReady.json.autostart, JSON.stringify(soloReady.json));
  const soloStart = await postJson('/api/mp/action', JSON.stringify({ playerId: DID, action: 'start' }));
  check('mp.solo.start-accepted', soloStart.status === 200 && !!soloStart.json.ok, JSON.stringify(soloStart.json));
  const soloRace = await evD.wait('race_start', 3000);
  check(
    'mp.solo.start-grid',
    !!soloRace && Array.isArray(soloRace.grid) && soloRace.grid.length === 1 && soloRace.bots === 2,
    JSON.stringify(soloRace && { grid: soloRace.grid, bots: soloRace.bots })
  );
  const soloFin = await postJson('/api/mp/action', JSON.stringify({ playerId: DID, action: 'finish', laps: [44000], lapsDone: 1 }));
  check('mp.solo.finish', soloFin.status === 200 && soloFin.json.ok === true, JSON.stringify(soloFin.json));
  const soloResults = await evD.wait('results', 4000);
  check(
    'mp.solo.results',
    !!soloResults && Array.isArray(soloResults.standings) && soloResults.standings.length === 1 && soloResults.saved.length === 1,
    JSON.stringify(soloResults && soloResults.standings)
  );
  evD.close();

  // ---------- Pilot registry and admin API (same test server) ----------
  check('admin.server.up', await waitHealth());

  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  const reg1 = await postJson('/api/pilot/register', JSON.stringify({ name: 'Reg Pilot', hash: HASH_A }));
  check('pilot.register', reg1.status === 200 && reg1.json.ok === true && !!reg1.json.pilot, JSON.stringify(reg1.json));
  const reg2 = await postJson('/api/pilot/register', JSON.stringify({ name: 'Reg Pilot', hash: HASH_A }));
  check('pilot.register-idempotent', reg2.status === 200 && reg2.json.existed === true, JSON.stringify(reg2.json));
  const reg3 = await postJson('/api/pilot/register', JSON.stringify({ name: 'Reg Pilot', hash: HASH_B }));
  check('pilot.register-name-taken', reg3.status === 409 && reg3.json.error === 'name_taken', JSON.stringify(reg3.json));
  const regBad = await postJson('/api/pilot/register', JSON.stringify({ name: '', hash: HASH_A }));
  check('pilot.register-bad-name', regBad.status === 400, JSON.stringify(regBad.json));

  const loginBad = await postJson('/api/pilot/login', JSON.stringify({ name: 'Reg Pilot', hash: HASH_B }));
  check('pilot.login-bad-password', loginBad.status === 403 && loginBad.json.error === 'bad_password', JSON.stringify(loginBad.json));
  const loginOk = await postJson('/api/pilot/login', JSON.stringify({ name: 'Reg Pilot', hash: HASH_A }));
  check('pilot.login-ok', loginOk.status === 200 && loginOk.json.pilot && loginOk.json.pilot.logins >= 2, JSON.stringify(loginOk.json));
  const loginImport = await postJson('/api/pilot/login', JSON.stringify({ name: 'Imported Pilot', hash: HASH_B, allowImport: true }));
  check(
    'pilot.login-imports-local-account',
    loginImport.status === 200 && loginImport.json.created === true && loginImport.json.pilot.source === 'imported',
    JSON.stringify(loginImport.json)
  );
  const seen = await postJson('/api/pilot/seen', JSON.stringify({ name: 'Reg Pilot' }));
  check('pilot.seen', seen.status === 200 && !!seen.json.pilot.lastSeenAt, JSON.stringify(seen.json));
  // 'seen' with a hash imports an account from the old local-only build
  const seenImport = await postJson('/api/pilot/seen', JSON.stringify({ name: 'Seen Pilot', hash: HASH_A }));
  check(
    'pilot.seen-imports-local-account',
    seenImport.status === 200 && seenImport.json.created === true && !!seenImport.json.pilot,
    JSON.stringify(seenImport.json)
  );

  const noKey = await getJson('/api/admin/summary');
  check('admin.requires-key', noKey.status === 401, JSON.stringify(noKey.json));
  const wrongKey = await getJson('/api/admin/summary?key=nope');
  check('admin.rejects-bad-key', wrongKey.status === 401, JSON.stringify(wrongKey.json));

  const adminRes = await fetch(`${BASE}/api/admin/summary?key=verify-admin-key`);
  const summary = await adminRes.json();
  check(
    'admin.summary-shape',
    adminRes.status === 200 && !!summary.server && Array.isArray(summary.pilots) && Array.isArray(summary.online) && Array.isArray(summary.rooms),
    JSON.stringify(summary.server)
  );
  check('admin.summary-lists-pilot', (summary.pilots || []).some((p) => p.name === 'Reg Pilot'), JSON.stringify(summary.pilots));
  check('admin.summary-hides-hashes', !JSON.stringify(summary).includes(HASH_A), 'password hashes must not appear in the summary');
  check(
    'admin.summary-results',
    !!summary.results && typeof summary.results.total === 'number' && !!summary.results.byMode,
    JSON.stringify(summary.results)
  );
  const headerRes = await fetch(`${BASE}/api/admin/summary`, { headers: { 'x-admin-key': 'verify-admin-key' } });
  check('admin.accepts-header-key', headerRes.status === 200, String(headerRes.status));

  evA.close();
  evC.close();
  await wait(150);
  await stopServer(mpServer);

  console.log(failures === 0 ? 'VERIFY RESULT: PASS' : `VERIFY RESULT: FAIL (${failures})`);
  console.log(`VERIFY NOTE test-data-file=${DATA_FILE} (safe to delete manually)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`VERIFY FAIL reason=exception ${err && err.message}`);
  process.exit(1);
});
