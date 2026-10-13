'use strict';

// lib/multiplayer.js — lobby over Server-Sent Events + POST actions, no dependencies.
// Rooms live in process memory (a restart clears the lobby, which races survive —
// finish results go to the shared storage file through the saveResults callback).
//
//   GET  /api/mp/events?playerId=..&name=..  — the player's SSE stream
//   POST /api/mp/action                      — one action (join/ready/chat/…)
//   GET  /api/mp/rooms                       — a snapshot of the room list
//
// SSE events: hello, rooms, room, chat, race_start, peer, finished, results,
//             room_closed, kicked, phase, error.
// Actions:    hello, create, join, leave, ready, settings, start, kick, close,
//             chat, state, finish, ping.

const crypto = require('node:crypto');

// ---------- Protocol constants ----------

const MAX_PLAYERS = 4;          // seats per room, host included
const MAX_ROOMS = 50;           // lobby overflow guard
const ROOM_NAME_MAX = 24;
const PLAYER_NAME_MAX = 24;
const PASSWORD_MAX = 32;
const CHAT_MAX_LEN = 200;       // per-message limit
const CHAT_HISTORY = 40;        // how many recent messages a joiner receives
const LAPS_MAX = 50;
const BOTS_MAX = 3;             // never more bots than free grid slots
const COUNTDOWN_MS = 3000;      // synchronised countdown before the start
const FINISH_WAIT_MS = 20000;   // grace period for stragglers after the first finish
const EMPTY_ROOM_TTL_MS = 30000;   // an emptied room is dropped after this delay
const DISCONNECT_GRACE_MS = 12000; // how long a player may stay disconnected
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TRACK_RE = /^[a-z0-9_-]{1,32}$/i;

// Player car colours, taken from the UI palette (style.css).
const PLAYER_COLORS = ['#E8542F', '#2E7D74', '#F2B33D', '#8AB653'];

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// ---------- Validation ----------

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > max) return null;
  return cleaned;
}

function cleanPassword(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > PASSWORD_MAX) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length < 1) return null;
  return cleaned;
}

function cleanTrack(value) {
  if (typeof value !== 'string' || !TRACK_RE.test(value)) return null;
  return value.toLowerCase();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------- Hub factory ----------

function createMultiplayer(options = {}) {
  const { sendJson, readBody, saveResults, log } = options;

  const hub = {
    rooms: new Map(),   // roomId -> room
    conns: new Map(),   // playerId -> Set<res>
    names: new Map(),   // playerId -> last known name
    roomOf: new Map(),  // playerId -> roomId
  };

  // ---------- Helpers ----------

  const now = () => Date.now();

  function say(text) {
    if (log) log(`[mp] ${text}`);
  }

  function connectedCount(room) {
    let n = 0;
    for (const p of room.players.values()) if (p.connected) n++;
    return n;
  }

  // Lobby room list: only what is needed to pick a room.
  function roomListItem(room) {
    return {
      id: room.id,
      name: room.name,
      players: connectedCount(room),
      humans: room.players.size,
      maxPlayers: MAX_PLAYERS,
      hasPassword: !!room.passwordHash,
      track: room.settings.track,
      laps: room.settings.laps,
      bots: room.settings.bots,
      collisions: room.settings.collisions,
      phase: room.phase,
      hostName: room.players.get(room.hostId) ? room.players.get(room.hostId).name : null,
      createdAt: room.createdAt,
    };
  }

  // Admin panel summary: who is online and which rooms are alive.
  // Passwords and hashes are never exposed.
  function adminInfo() {
    const online = [];
    for (const [playerId, set] of hub.conns.entries()) {
      const roomId = hub.roomOf.get(playerId);
      const room = roomId ? hub.rooms.get(roomId) : null;
      const player = room ? room.players.get(playerId) : null;
      online.push({
        playerId,
        name: hub.names.get(playerId) || (player && player.name) || 'Pilot',
        connections: set.size,
        roomId: room ? room.id : null,
        roomName: room ? room.name : null,
        roomPhase: room ? room.phase : null,
        ready: player ? !!player.ready : false,
        slot: player ? player.slot : null,
        finished: !!(room && room.race && room.race.finishes.has(playerId)),
      });
    }
    online.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const rooms = [...hub.rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      hostName: room.players.get(room.hostId) ? room.players.get(room.hostId).name : null,
      phase: room.phase,
      locked: !!room.passwordHash,
      maxPlayers: MAX_PLAYERS,
      settings: { ...room.settings },
      createdAt: room.createdAt,
      players: [...room.players.values()].map((p) => ({
        name: p.name,
        ready: !!p.ready,
        connected: !!p.connected,
        slot: p.slot,
        isHost: p.id === room.hostId,
      })),
      chatMessages: room.messages.length,
    }));

    return { online, rooms };
  }

  function roomList() {
    return [...hub.rooms.values()]
      .filter((room) => connectedCount(room) > 0 || now() - room.createdAt < EMPTY_ROOM_TTL_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(roomListItem);
  }

  // Full room snapshot for its members.
  function roomSnapshot(room) {
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      hasPassword: !!room.passwordHash,
      phase: room.phase,
      startAt: room.startAt || null,
      maxPlayers: MAX_PLAYERS,
      settings: { ...room.settings },
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        connected: p.connected,
        color: p.color,
        slot: p.slot,
        isHost: p.id === room.hostId,
      })),
      messages: room.messages.slice(-CHAT_HISTORY),
      race: room.race
        ? {
            track: room.settings.track,
            laps: room.settings.laps,
            grid: room.race.grid,
            deadline: room.race.deadline || null,
          }
        : null,
    };
  }

  // ---------- Broadcast ----------

  function sseWrite(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* the connection is already dead — req 'close' handles cleanup */
    }
  }

  function sendTo(playerId, event, data) {
    const set = hub.conns.get(playerId);
    if (!set) return;
    for (const res of set) sseWrite(res, event, data);
  }

  function broadcastRoom(room, event, data, excludeId = null) {
    for (const p of room.players.keys()) {
      if (p === excludeId) continue;
      sendTo(p, event, data);
    }
  }

  function broadcastRoomsList() {
    const payload = { rooms: roomList(), t: now() };
    for (const playerId of hub.conns.keys()) sendTo(playerId, 'rooms', payload);
  }

  function pushRoom(room) {
    broadcastRoom(room, 'room', { room: roomSnapshot(room), t: now() });
  }

  function systemMessage(room, text) {
    const msg = { id: crypto.randomUUID(), system: true, name: null, text, at: now() };
    room.messages.push(msg);
    if (room.messages.length > CHAT_HISTORY * 2) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
    broadcastRoom(room, 'chat', { message: msg });
  }

  // ---------- Room lifecycle ----------

  function touchLobby() {
    broadcastRoomsList();
  }

  // The host left or dropped: hand the role to a connected player first,
  // otherwise to the longest present.
  function reassignHost(room) {
    const current = room.players.get(room.hostId);
    if (current && current.connected) return;
    let next = null;
    for (const p of room.players.values()) {
      if (p.id === room.hostId && current) continue;
      if (!next) {
        next = p;
        continue;
      }
      const better =
        (p.connected && !next.connected) ||
        (p.connected === next.connected && p.joinedAt < next.joinedAt);
      if (better) next = p;
    }
    if (next) {
      room.hostId = next.id;
      say(`room ${room.id}: new host ${next.name}`);
      systemMessage(room, `${next.name} is the new host`);
    }
  }

  function removePlayer(room, playerId, reason) {
    const p = room.players.get(playerId);
    if (!p) return;
    room.players.delete(playerId);
    hub.roomOf.delete(playerId);
    systemMessage(room, reason || `${p.name} left the room`);
    if (room.players.size === 0) {
      room.emptySince = now();
    } else {
      reassignHost(room);
      // a roster change clears ready flags — the start needs everyone's consent
      for (const other of room.players.values()) other.ready = false;
      if (room.phase === 'lobby') pushRoom(room);
    }
    touchLobby();
  }

  function deleteRoom(room, event = 'room_closed') {
    if (room.race && room.race.timer) clearTimeout(room.race.timer);
    for (const p of room.players.keys()) {
      if (hub.roomOf.get(p) === room.id) hub.roomOf.delete(p);
      sendTo(p, event, { roomId: room.id, name: room.name, t: now() });
    }
    hub.rooms.delete(room.id);
    touchLobby();
    say(`room ${room.id} deleted`);
  }

  // ---------- Race ----------

  function buildGrid(room) {
    // humans in join order into slots 0..3; clients fill the rest with bots
    const grid = [...room.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, slot: p.slot }));
    return grid;
  }

  function startRace(room) {
    if (room.phase !== 'lobby') return { error: 'race_already_started' };
    // solo races are allowed: multiplayer does not require company
    if (room.players.size < 1) return { error: 'no_players' };
    for (const p of room.players.values()) {
      if (!p.ready) return { error: 'not_everybody_ready' };
    }
    if (room.race && room.race.timer) clearTimeout(room.race.timer);
    room.phase = 'countdown';
    room.startAt = now() + COUNTDOWN_MS;
    room.race = {
      grid: buildGrid(room),
      finishes: new Map(),
      deadline: null,
      timer: null,
      startedAt: now(),
    };
    say(`room ${room.id}: start, players ${room.race.grid.length}`);
    broadcastRoom(room, 'race_start', {
      t: now(),
      startAt: room.startAt,
      track: room.settings.track,
      laps: room.settings.laps,
      collisions: room.settings.collisions,
      bots: room.settings.bots,
      grid: room.race.grid,
      seed: room.seed,
    });
    touchLobby();
    return { ok: true };
  }

// Finish: places come from total time for finishers and laps completed for the
  // rest; results are stored through saveResults.
  function finalizeRace(room) {
    const race = room.race;
    if (!race) return;
    if (race.timer) clearTimeout(race.timer);
    race.timer = null;

    const rows = [];
    for (const p of room.players.values()) {
      const fin = race.finishes.get(p.id) || null;
      rows.push({
        playerId: p.id,
        name: p.name,
        color: p.color,
        finished: !!fin,
        laps: fin ? fin.lapsDone : 0,
        bestLapMs: fin ? fin.best : null,
        totalMs: fin ? fin.total : null,
      });
    }
    rows.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) {
        if (a.totalMs !== b.totalMs) return a.totalMs - b.totalMs;
        return a.bestLapMs - b.bestLapMs;
      }
      return b.laps - a.laps;
    });
    rows.forEach((row, index) => {
      row.place = index + 1;
    });

    // Write the human results to the shared leaderboard (multiplayer mode).
    let saved = [];
    if (typeof saveResults === 'function') {
      const records = rows
        .filter((r) => r.finished)
        .map((r) => ({
          playerName: r.name,
          track: room.settings.track,
          laps: race.finishes.get(r.playerId).laps,
        }));
      try {
        saved = saveResults(records) || [];
      } catch (err) {
        say(`failed to save results: ${err.message}`);
      }
    }

    room.phase = 'lobby';
    room.startAt = null;
    room.race = null;
    room.lastResults = { standings: rows, saved, at: now() };
    for (const p of room.players.values()) p.ready = false;

    broadcastRoom(room, 'results', {
      t: now(),
      standings: rows,
      saved,
      track: room.settings.track,
      laps: room.settings.laps,
    });
    pushRoom(room);
    touchLobby();
    say(`room ${room.id}: race finished, places: ${rows.length}`);
  }

  function onPlayerFinish(room, playerId, payload) {
    if (room.phase !== 'racing' && room.phase !== 'countdown') return { error: 'no_race' };
    const race = room.race;
    if (!race) return { error: 'no_race' };
    const p = room.players.get(playerId);
    if (!p) return { error: 'not_in_room' };

    const laps = Array.isArray(payload.laps)
      ? payload.laps.filter((v) => Number.isInteger(v) && v >= 5000 && v <= 1200000).slice(0, LAPS_MAX)
      : [];
    const lapsDone = clampInt(payload.lapsDone, 0, LAPS_MAX, laps.length);
    const best = laps.length ? Math.min(...laps) : null;
    const total = laps.length ? laps.reduce((a, b) => a + b, 0) : null;
    race.finishes.set(playerId, { laps, lapsDone, best, total, at: now() });

    // The first finish starts the clock for the stragglers.
    if (!race.deadline) {
      race.deadline = now() + FINISH_WAIT_MS;
      race.timer = setTimeout(() => finalizeRace(room), FINISH_WAIT_MS + 50);
    }
    say(`room ${room.id}: ${p.name} finished (${laps.length} laps)`);
    broadcastRoom(room, 'finished', { playerId, name: p.name, t: now() });

    const everyone = [...room.players.values()].every((pl) => race.finishes.has(pl.id));
    if (everyone) finalizeRace(room);
    return { ok: true, lapsCount: laps.length };
  }

  // ---------- Players and connections ----------

  function addConnection(playerId, res, name) {
    let set = hub.conns.get(playerId);
    if (!set) {
      set = new Set();
      hub.conns.set(playerId, set);
    }
    set.add(res);
    if (name) hub.names.set(playerId, name);
  }

  function dropConnection(playerId, res) {
    const set = hub.conns.get(playerId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      hub.conns.delete(playerId);
      handleDisconnect(playerId);
    }
  }

  function handleDisconnect(playerId) {
    const roomId = hub.roomOf.get(playerId);
    if (!roomId) return;
    const room = hub.rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.disconnectAt = now();
    systemMessage(room, `${p.name} lost connection`);
    if (room.phase === 'lobby') pushRoom(room);
    touchLobby();
    say(`room ${room.id}: ${p.name} disconnected (waiting ${Math.round(DISCONNECT_GRACE_MS / 1000)} s)`);
  }

  function reconnect(playerId) {
    const roomId = hub.roomOf.get(playerId);
    if (!roomId) return;
    const room = hub.rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p || p.connected) return;
    p.connected = true;
    p.disconnectAt = null;
    systemMessage(room, `${p.name} is back`);
    if (room.phase === 'lobby') pushRoom(room);
  }

  // ---------- Periodic housekeeping ----------

  function tick() {
    const t = now();
    for (const room of [...hub.rooms.values()]) {
      // countdown -> racing on schedule (clients already start off startAt)
      if (room.phase === 'countdown' && t >= room.startAt) {
        room.phase = 'racing';
        broadcastRoom(room, 'phase', { phase: 'racing', t });
        touchLobby();
      }
      // everyone left — drop the room after a delay (a refresh can still return)
      if (room.players.size === 0 || connectedCount(room) === 0) {
        if (!room.emptySince) room.emptySince = t;
        if (t - room.emptySince >= EMPTY_ROOM_TTL_MS) {
          deleteRoom(room);
          continue;
        }
      } else {
        room.emptySince = null;
      }
      // A player without a live SSE connection is dropped after the reconnect grace
      // period. Liveness is read from hub.conns rather than a flag, so a client
      // that joined by POST but never opened a stream cannot hold a room forever
      // and block a new one.
      for (const p of [...room.players.values()]) {
        const live = hub.conns.has(p.id);
        if (live) {
          p.connected = true;
          p.disconnectAt = null;
          continue;
        }
        p.connected = false;
        if (!p.disconnectAt) p.disconnectAt = t;
        if (t - p.disconnectAt >= DISCONNECT_GRACE_MS) {
          removePlayer(room, p.id, `${p.name} left (timeout)`);
        }
      }
      if (!hub.rooms.has(room.id)) continue;
      if (room.phase === 'racing' && room.race && room.race.deadline && t >= room.race.deadline) {
        finalizeRace(room);
      }
    }
  }

  function startTicker() {
    if (hub.ticker) clearInterval(hub.ticker);
    hub.ticker = setInterval(tick, 500);
    if (hub.ticker.unref) hub.ticker.unref();
  }

  // ---------- Actions ----------

  function findRoom(roomId) {
    if (typeof roomId !== 'string') return null;
    return hub.rooms.get(roomId) || null;
  }

  function actionHello(playerId, body) {
    const name = cleanText(body.name, PLAYER_NAME_MAX);
    if (name) hub.names.set(playerId, name);
    const roomId = hub.roomOf.get(playerId);
    const room = roomId ? hub.rooms.get(roomId) : null;
    if (room) reconnect(playerId);
    return {
      ok: true,
      playerId,
      name: hub.names.get(playerId) || name || 'Pilot',
      rooms: roomList(),
      room: room ? roomSnapshot(room) : null,
    };
  }

  function actionCreate(playerId, body) {
    if (hub.roomOf.has(playerId)) return { status: 409, error: 'already_in_room' };
    if (hub.rooms.size >= MAX_ROOMS) return { status: 503, error: 'too_many_rooms' };
    const name = cleanText(body.name, PLAYER_NAME_MAX) || hub.names.get(playerId) || 'Pilot';
    hub.names.set(playerId, name);

    const roomName = cleanText(body.roomName, ROOM_NAME_MAX) || `${name}'s room`;
    const password = cleanPassword(body.password);
    const settings = {
      track: cleanTrack(body.track) || 'wheatfield',
      laps: clampInt(body.laps, 1, LAPS_MAX, 3),
      collisions: body.collisions !== false,
      bots: clampInt(body.bots ?? 2, 0, BOTS_MAX, 2),
    };

    const room = {
      id: crypto.randomUUID(),
      name: roomName,
      passwordHash: password ? sha256(`retro-rally:${password}`) : null,
      hostId: playerId,
      settings,
      phase: 'lobby',
      startAt: null,
      players: new Map(),
      messages: [],
      race: null,
      createdAt: now(),
      emptySince: null,
      seed: Math.floor(Math.random() * 1e9),
    };
    hub.rooms.set(room.id, room);

    const player = {
      id: playerId,
      name,
      ready: false,
      connected: true,
      color: PLAYER_COLORS[0],
      slot: 0,
      joinedAt: now(),
      disconnectAt: null,
    };
    room.players.set(playerId, player);
    hub.roomOf.set(playerId, room.id);
    systemMessage(room, `${name} created the room`);
    pushRoom(room);
    touchLobby();
    say(`room ${room.id} created (${room.name}), host ${name}`);
    return { ok: true, room: roomSnapshot(room) };
  }

  function actionJoin(playerId, body) {
    const room = findRoom(body.roomId);
    if (!room) return { status: 404, error: 'room_not_found' };
    if (hub.roomOf.get(playerId) === room.id) {
      reconnect(playerId);
      return { ok: true, room: roomSnapshot(room) };
    }
    if (hub.roomOf.has(playerId)) return { status: 409, error: 'already_in_room' };
    if (room.phase !== 'lobby') return { status: 409, error: 'race_in_progress' };
    if (room.players.size >= MAX_PLAYERS) return { status: 409, error: 'room_full' };
    if (room.passwordHash) {
      const password = cleanPassword(body.password);
      if (!password) return { status: 403, error: 'password_required' };
      const a = Buffer.from(sha256(`retro-rally:${password}`));
      const b = Buffer.from(room.passwordHash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { status: 403, error: 'bad_password' };
      }
    }
    const name = cleanText(body.name, PLAYER_NAME_MAX) || hub.names.get(playerId) || 'Pilot';
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) return { status: 409, error: 'name_taken' };
    }
    hub.names.set(playerId, name);

    // grid slot — the first free seat
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const color = PLAYER_COLORS[slot % PLAYER_COLORS.length];
    const player = {
      id: playerId,
      name,
      ready: false,
      connected: true,
      color,
      slot,
      joinedAt: now(),
      disconnectAt: null,
    };
    room.players.set(playerId, player);
    hub.roomOf.set(playerId, room.id);
    systemMessage(room, `${name} joined`);
    pushRoom(room);
    touchLobby();
    say(`room ${room.id}: ${name} joined (slot ${slot})`);
    return { ok: true, room: roomSnapshot(room) };
  }

  function actionLeave(playerId) {
    const roomId = hub.roomOf.get(playerId);
    if (!roomId) return { ok: true, left: false };
    const room = hub.rooms.get(roomId);
    if (room) {
      const wasRacing = !!room.race;
      removePlayer(room, playerId);
      // the room emptied mid-race — settle what was actually completed
      if (wasRacing && room.players.size === 0 && room.race) finalizeRace(room);
    }
    return { ok: true, left: true };
  }

  function actionReady(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    const p = room.players.get(playerId);
    if (!p) return { status: 409, error: 'not_in_room' };
    if (room.phase !== 'lobby') return { status: 409, error: 'race_in_progress' };
    p.ready = body.ready !== false;
    say(`room ${room.id}: ${p.name} ready=${p.ready}`);
    pushRoom(room);
    // autostart on unanimous ready — only when someone is there to race with;
    // a lone player starts with START RACE (host only)
    if (p.ready && room.players.size >= 2) {
      const all = [...room.players.values()].every((pl) => pl.ready);
      if (all) {
        const started = startRace(room);
        if (started.error) return { ok: true, ready: p.ready, autostart: started.error };
        return { ok: true, ready: p.ready, autostart: true };
      }
    }
    return { ok: true, ready: p.ready };
  }

  function actionSettings(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    if (room.hostId !== playerId) return { status: 403, error: 'host_only' };
    if (room.phase !== 'lobby') return { status: 409, error: 'race_in_progress' };
    const s = room.settings;
    if (body.track !== undefined) s.track = cleanTrack(body.track) || s.track;
    if (body.laps !== undefined) s.laps = clampInt(body.laps, 1, LAPS_MAX, s.laps);
    if (body.collisions !== undefined) s.collisions = body.collisions !== false;
    if (body.bots !== undefined) s.bots = clampInt(body.bots, 0, BOTS_MAX, s.bots);
    if (body.roomName !== undefined) {
      const n = cleanText(body.roomName, ROOM_NAME_MAX);
      if (n) room.name = n;
    }
    // changing settings clears ready — everyone confirms again
    for (const p of room.players.values()) p.ready = false;
    pushRoom(room);
    touchLobby();
    return { ok: true, settings: { ...s } };
  }

  function actionStart(playerId) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    if (room.hostId !== playerId) return { status: 403, error: 'host_only' };
    // the host may start early and solo — no minimum player count
    for (const p of room.players.values()) p.ready = true;
    const res = startRace(room);
    if (res.error) return { status: 409, error: res.error };
    return { ok: true };
  }

  function actionKick(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    if (room.hostId !== playerId) return { status: 403, error: 'host_only' };
    const target = room.players.get(body.targetId);
    if (!target) return { status: 404, error: 'player_not_found' };
    if (target.id === room.hostId) return { status: 400, error: 'cannot_kick_host' };
    sendTo(target.id, 'kicked', { roomId: room.id, by: room.players.get(room.hostId).name, t: now() });
    removePlayer(room, target.id, `${target.name} was kicked`);
    if (room.phase === 'lobby') pushRoom(room);
    return { ok: true };
  }

  function actionClose(playerId) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    if (room.hostId !== playerId) return { status: 403, error: 'host_only' };
    deleteRoom(room);
    return { ok: true };
  }

  function actionChat(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    const p = room.players.get(playerId);
    if (!p) return { status: 409, error: 'not_in_room' };
    const text = cleanText(body.text, CHAT_MAX_LEN);
    if (!text) return { status: 400, error: 'text: string of 1..200 characters' };
    const msg = { id: crypto.randomUUID(), system: false, name: p.name, text, at: now() };
    room.messages.push(msg);
    if (room.messages.length > CHAT_HISTORY * 2) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
    broadcastRoom(room, 'chat', { message: msg });
    return { ok: true };
  }

  function actionState(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room || !room.race) return { ok: true, relayed: false };
    const s = body.s || body;
    // relay a compact snapshot to the others; never echo it back to the sender
    broadcastRoom(
      room,
      'peer',
      {
        id: playerId,
        s: {
          x: Number(s.x) || 0,
          y: Number(s.y) || 0,
          a: Number(s.a) || 0,
          sp: Number(s.sp) || 0,
          lp: Number(s.lp) || 0,
          bs: s.bs == null ? null : Number(s.bs),
          ex: Number(s.ex) || 0,
          br: !!s.br,
          fin: !!s.fin,
        },
        t: now(),
      },
      playerId
    );
    return { ok: true, relayed: true };
  }

  function actionFinish(playerId, body) {
    const room = findRoom(hub.roomOf.get(playerId));
    if (!room) return { status: 409, error: 'not_in_room' };
    return onPlayerFinish(room, playerId, body);
  }

  function actionPing(playerId, body) {
    return { ok: true, pong: now(), echo: Number(body.echo) || 0 };
  }

  const ACTIONS = {
    hello: actionHello,
    create: actionCreate,
    join: actionJoin,
    leave: actionLeave,
    ready: actionReady,
    settings: actionSettings,
    start: actionStart,
    kick: actionKick,
    close: actionClose,
    chat: actionChat,
    state: actionState,
    finish: actionFinish,
    ping: actionPing,
  };

  // ---------- HTTP entry points ----------

  async function handleAction(req, res) {
    const body = await readBody(req);
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'Request body is too large' });
    if (body.failed) return sendJson(res, 400, { ok: false, error: 'Failed to read request body' });

    let parsed;
    try {
      parsed = JSON.parse(body.raw || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Malformed JSON' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return sendJson(res, 400, { ok: false, error: 'Request body must be a JSON object' });
    }
    const playerId = parsed.playerId;
    if (typeof playerId !== 'string' || !ID_RE.test(playerId)) {
      return sendJson(res, 400, { ok: false, error: 'playerId: 8..64 chars of [A-Za-z0-9_-]' });
    }
    const handler = ACTIONS[parsed.action];
    if (!handler) return sendJson(res, 400, { ok: false, error: `Unknown action: ${String(parsed.action)}` });

    const result = await handler(playerId, parsed);
    const status = result && result.status ? result.status : result && result.error ? 400 : 200;
    sendJson(res, status, result);
  }

  function handleRooms(res) {
    sendJson(res, 200, { rooms: roomList(), t: now() });
  }

  function handleEvents(req, res, url) {
    const playerId = url.searchParams.get('playerId') || '';
    if (!ID_RE.test(playerId)) {
      return sendJson(res, 400, { ok: false, error: 'playerId: 8..64 chars of [A-Za-z0-9_-]' });
    }
    const name = cleanText(url.searchParams.get('name') || '', PLAYER_NAME_MAX);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30000);
    res.write('retry: 2000\n\n');

    addConnection(playerId, res, name);
    sseWrite(res, 'hello', {
      playerId,
      name: hub.names.get(playerId) || name || 'Pilot',
      rooms: roomList(),
      t: now(),
    });
    const roomId = hub.roomOf.get(playerId);
    const room = roomId ? hub.rooms.get(roomId) : null;
    if (room) {
      reconnect(playerId);
      sseWrite(res, 'room', { room: roomSnapshot(room), t: now() });
    }

    // a ping comment keeps proxies and browsers from dropping an idle stream
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* req 'close' handles the close */
      }
    }, 15000);
    if (keepAlive.unref) keepAlive.unref();

    req.on('close', () => {
      clearInterval(keepAlive);
      dropConnection(playerId, res);
    });
  }

  // Main entry point: called from server.js for /api/mp/* paths.
  async function handleApi(req, res, pathname, url) {
    if (pathname === '/api/mp/events' && req.method === 'GET') {
      handleEvents(req, res, url);
      return true;
    }
    if (pathname === '/api/mp/rooms' && req.method === 'GET') {
      handleRooms(res);
      return true;
    }
    if (pathname === '/api/mp/action' && req.method === 'POST') {
      await handleAction(req, res);
      return true;
    }
    if (pathname === '/api/mp/stats' && req.method === 'GET') {
      // test helper: how many rooms and connections are alive
      sendJson(res, 200, {
        rooms: hub.rooms.size,
        connections: [...hub.conns.values()].reduce((a, s) => a + s.size, 0),
        players: hub.conns.size,
      });
      return true;
    }
    return false;
  }

  function dispose() {
    if (hub.ticker) clearInterval(hub.ticker);
  }

  startTicker();

  return { handleApi, tick, dispose, roomList, adminInfo };
}

module.exports = { createMultiplayer };
