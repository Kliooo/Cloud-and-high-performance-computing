// mp-screen.js — multiplayer screens: room list, creation, lobby with chat,
// race start off the server's synchronised start, and the final standings.
//
// Runs on MpClient (SSE + POST actions). All rendering builds nodes and sets
// textContent, so foreign names and chat messages never reach innerHTML.

import { MpClient } from './mp-client.js';
import { setTrack, TRACK_LIST, formatLap } from './track.js';

const $ = (id) => document.getElementById(id);

const MAX_ROOM_NAME = 24;
const MAX_CHAT_LEN = 200;
const MAX_BOTS = 3;

const MODE_LABELS = { training: 'TRAINING', bots: 'BOTS', multiplayer: 'MULTI' };

const ERRORS = {
  bad_password: 'Wrong password — the room stays locked.',
  password_required: 'This room is locked: enter the password.',
  room_full: 'This room is full (4 players max).',
  race_in_progress: 'The race has already started in this room.',
  name_taken: 'Another pilot in this room already uses this name.',
  room_not_found: 'The room no longer exists.',
  already_in_room: 'You are already in a room.',
  need_two_players: 'At least two players are needed to start.',
  no_players: 'Nobody is in the room.',
  host_only: 'Only the host can do that.',
  too_many_rooms: 'The lobby is full — try again later.',
  not_in_room: 'You are not in a room anymore.',
  cannot_kick_host: 'The host cannot be kicked.',
  player_not_found: 'That player has already left.',
};

function errorText(code) {
  return ERRORS[code] || `Lobby error: ${code}`;
}

function timeShort(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// "was in room" flag: survives a reload within the tab so that after F5 the
// player returns to the lobby instead of lingering as a "ghost" on the server.
const IN_ROOM_KEY = 'retro-rally:mp-in-room';

function rememberInRoom(on) {
  try {
    if (on) sessionStorage.setItem(IN_ROOM_KEY, '1');
    else sessionStorage.removeItem(IN_ROOM_KEY);
  } catch {
    /* private mode — just do not remember it */
  }
}

function wasInRoom() {
  try {
    return sessionStorage.getItem(IN_ROOM_KEY) === '1';
  } catch {
    return false;
  }
}

export function createMultiplayerScreen({ game, showScreen, hideScreens, playerName, onRaceFinish }) {
  const state = {
    client: null,
    rooms: [],
    room: null,
    ready: false,
    racing: false,
    pendingJoinId: null,
    chatIds: new Set(),
    standings: null,
    errorTimer: 0,
    teleTimer: 0,
    teleBusy: false,
    teleSignature: '',
  };

  // Room snapshot received: store it and show the lobby (unless a race is running)
  function applyRoom(room) {
    state.room = room;
    rememberInRoom(true);
    if (state.racing) return; // never touch the lobby screen mid-race
    renderRoom();
    showScreen('mpRoom');
  }

  // ---------- Connection status ----------

  function setNetStatus(text, bad) {
    for (const id of ['mp-net', 'mp-room-net']) {
      const node = $(id);
      if (!node) continue;
      node.textContent = text;
      node.classList.toggle('bad', !!bad);
    }
  }

  function renderNetStatus() {
    const client = state.client;
    if (!client) {
      setNetStatus('Connecting to the lobby…', false);
      return;
    }
    if (client.status === 'online') {
      const ping = client.latencyMs == null ? '—' : `${Math.round(client.latencyMs)} ms`;
      setNetStatus(`Lobby: online · ping ${ping} · you: ${playerName()}`, false);
    } else if (client.status === 'connecting') {
      setNetStatus('Connecting to the lobby…', false);
    } else {
      setNetStatus('Lobby: connection lost — reconnecting…', true);
    }
  }

  function showError(message, target = 'mp-error') {
    const node = $(target);
    if (!node) return;
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(state.errorTimer);
    state.errorTimer = setTimeout(() => node.classList.add('hidden'), 6000);
  }

  function hideError(target = 'mp-error') {
    const node = $(target);
    if (node) node.classList.add('hidden');
  }

  // ---------- Room list ----------

  function renderRooms() {
    const tbody = $('mp-rooms-body');
    if (!tbody) return;
    tbody.textContent = '';
    const rooms = state.rooms || [];
    $('mp-rooms-count').textContent = rooms.length
      ? `${rooms.length} room${rooms.length === 1 ? '' : 's'}`
      : '';

    if (!rooms.length) {
      const tr = el('tr');
      const td = el('td', 'mp-empty', 'No rooms yet — create one and invite your friends!');
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const room of rooms) {
      const tr = document.createElement('tr');
      tr.dataset.roomId = room.id;
      tr.dataset.locked = room.hasPassword ? '1' : '0';
      const full = room.players >= room.maxPlayers;
      const racing = room.phase !== 'lobby';
      if (full || racing) tr.className = 'full';

      tr.appendChild(el('td', 'mp-room-name', room.name));
      tr.appendChild(el('td', null, trackName(room.track)));
      tr.appendChild(el('td', null, String(room.laps)));
      tr.appendChild(el('td', null, String(room.bots)));
      tr.appendChild(el('td', null, `${room.players}/${room.maxPlayers}`));

      // only password rooms get a lock icon — open rooms stay unmarked
      const lockCell = el('td', 'mp-lock');
      if (room.hasPassword) {
        const lock = el('span', 'mp-lock-icon closed', '🔒');
        lock.title = 'Locked — password required';
        lock.setAttribute('data-locked', '1');
        lock.setAttribute('aria-label', 'Password protected');
        lockCell.appendChild(lock);
      }
      tr.appendChild(lockCell);

      tr.title = racing
        ? 'Race in progress'
        : full
          ? 'Room is full'
          : `${room.players}/${room.maxPlayers} players · host ${room.hostName || '—'}`;
      tr.addEventListener('click', () => onRoomRowClick(room));
      tbody.appendChild(tr);
    }
  }

  function trackName(id) {
    const def = TRACK_LIST.find((t) => t.id === id);
    return def ? def.name : (id || '—');
  }

  async function onRoomRowClick(room) {
    if (room.players >= room.maxPlayers) {
      showError('This room is already full (4 players max).');
      return;
    }
    if (room.phase !== 'lobby') {
      showError('A race is in progress in this room.');
      return;
    }
    hideError();
    if (room.hasPassword) {
      // the password is asked for in a panel of our own, not a browser prompt
      state.pendingJoinId = room.id;
      $('mp-join').classList.remove('hidden');
      $('mp-join-pass').value = '';
      $('mp-join-pass').focus();
      return;
    }
    await joinRoom(room.id, null);
  }

  async function joinRoom(roomId, password) {
    try {
      await client().action('join', { roomId, password, name: playerName() });
      state.pendingJoinId = null;
      $('mp-join').classList.add('hidden');
    } catch (err) {
      showError(errorText(err.code || err.message));
    }
  }

  // ---------- Lobby ----------

  function renderRoom() {
    const room = state.room;
    if (!room) return;
    const me = room.players.find((p) => p.id === state.client.playerId) || null;
    const isHost = !!me && room.hostId === me.id;
    state.ready = !!(me && me.ready);

    $('mp-room-title').textContent = room.name;
    $('mp-players-count').textContent = `(${room.players.length}/${room.maxPlayers})`;

    // Players: ready dot, host badge, kick button for the host
    const list = $('mp-players');
    list.textContent = '';
    for (const p of room.players) {
      const li = el('li', 'mp-player' + (p.id === state.client.playerId ? ' me' : '') + (p.connected ? '' : ' offline'));
      const dot = el('span', 'mp-dot');
      dot.style.background = p.color || '#E8542F';
      li.appendChild(dot);
      li.appendChild(el('span', 'mp-pname', p.name + (p.connected ? '' : ' (offline)')));
      if (p.isHost) li.appendChild(el('span', 'mp-badge host', 'HOST'));
      if (p.id === state.client.playerId) li.appendChild(el('span', 'mp-badge you', 'YOU'));
      li.appendChild(el('span', `mp-badge ${p.ready ? 'ready' : 'waiting'}`, p.ready ? 'READY' : 'WAITING'));
      if (isHost && p.id !== room.hostId) {
        const kick = el('button', 'mp-kick', 'KICK');
        kick.type = 'button';
        kick.addEventListener('click', () => kickPlayer(p.id));
        li.appendChild(kick);
      }
      list.appendChild(li);
    }

    const settings = room.settings;
    $('mp-room-settings').textContent =
      `Track ${trackName(settings.track)} · ${settings.laps} lap(s) · collisions ${settings.collisions ? 'on' : 'off'} · bots ${settings.bots}`;

    // Ready button
    const readyBtn = $('btn-mp-ready');
    readyBtn.textContent = state.ready ? 'NOT READY' : 'READY';
    readyBtn.classList.toggle('btn-primary', !state.ready);
    readyBtn.disabled = room.phase !== 'lobby';

    // Host tools: START RACE sits next to READY and is only visible to the host
    $('mp-host-tools').classList.toggle('hidden', !isHost);
    const startWrap = $('mp-start-wrap');
    if (startWrap) startWrap.classList.toggle('hidden', !isHost);
    if (isHost) {
      $('mp-room-track').value = settings.track;
      $('mp-room-laps').value = String(settings.laps);
      $('mp-room-collisions').checked = !!settings.collisions;
      $('mp-room-bots-count').value = String(settings.bots);
      // the host can always start: solo and early starts are fine
      $('btn-mp-start').disabled = room.phase !== 'lobby';
    }

    const waiting = room.players.filter((p) => !p.ready);
    const others = room.players.length - 1;
    if (room.phase !== 'lobby') {
      $('mp-ready-hint').textContent = 'The race is starting…';
    } else if (others === 0) {
      $('mp-ready-hint').textContent = isHost
        ? 'You are alone — press START RACE to race solo now, or wait for other pilots.'
        : 'Waiting for the host to start the race.';
    } else if (waiting.length === 0) {
      $('mp-ready-hint').textContent = 'Everybody is READY — starting!';
    } else {
      $('mp-ready-hint').textContent = isHost
        ? `${waiting.length} pilot(s) not ready yet: ${waiting.map((p) => p.name).join(', ')}`
        : `${waiting.length} pilot(s) not ready yet.`;
    }

    renderChat(room.messages || [], false);
  }

  // ---------- Chat ----------

  function renderChat(messages, append) {
    const list = $('mp-chat');
    if (!list) return;
    if (!append) {
      list.textContent = '';
      state.chatIds.clear();
    }
    let added = false;
    for (const msg of messages) {
      if (!msg || state.chatIds.has(msg.id)) continue;
      state.chatIds.add(msg.id);
      const li = el('li', 'mp-chat-line' + (msg.system ? ' system' : ''));
      li.appendChild(el('span', 'mp-chat-time', timeShort(msg.at)));
      if (!msg.system) li.appendChild(el('span', 'mp-chat-name', `${msg.name}:`));
      li.appendChild(el('span', 'mp-chat-text', msg.text));
      list.appendChild(li);
      added = true;
      while (list.children.length > 200) list.removeChild(list.firstChild);
    }
    if (added) list.scrollTop = list.scrollHeight;
  }

  function pushSystemLine(text) {
    const list = $('mp-chat');
    const li = el('li', 'mp-chat-line system');
    li.appendChild(el('span', 'mp-chat-time', timeShort(Date.now())));
    li.appendChild(el('span', 'mp-chat-text', text));
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  // ---------- Race ----------

  const TELEMETRY_MS = 120; // ~8 snapshots per second — smoothness over rate

  // Send our position to the others while a race runs.
  // No overlapping requests (in-flight guard) and nothing sent while unchanged:
  // an empty POST every 80 ms used to eat frames.
  function startTelemetry() {
    stopTelemetry();
    state.teleBusy = false;
    state.teleSignature = '';
    state.teleTimer = setInterval(() => {
      const client = state.client;
      if (!client || !state.racing || state.teleBusy || client.status === 'offline') return;
      const snap = game.getNetState ? game.getNetState() : null;
      if (!snap) return;
      const signature = `${snap.x}|${snap.y}|${snap.a}|${snap.lp}|${snap.ex}|${snap.fin ? 1 : 0}`;
      if (signature === state.teleSignature) return;
      state.teleSignature = signature;
      state.teleBusy = true;
      client
        .action('state', { s: snap })
        .catch(() => {})
        .then(() => {
          state.teleBusy = false;
        });
    }, TELEMETRY_MS);
  }

  function stopTelemetry() {
    if (state.teleTimer) {
      clearInterval(state.teleTimer);
      state.teleTimer = 0;
    }
  }

  function beginRace(data) {
    state.racing = true;
    state.standings = null;
    const client = state.client;
    const me = data.grid.find((g) => g.id === client.playerId) || null;
    const peers = data.grid
      .filter((g) => g.id !== client.playerId)
      .map((g) => ({ id: g.id, name: g.name, color: g.color, slot: g.slot }));

    if (setTrack(data.track)) game.rebuildTrack();

    // Bots only take free grid slots: humans always come first, so a room of two or
    // three can be played with no bots at all.
    const humanSlots = new Set(data.grid.map((g) => g.slot));
    const freeSlots = [0, 1, 2, 3].filter((slot) => !humanSlots.has(slot));
    const botsWanted = Number.isFinite(data.bots) ? Math.max(0, Math.min(3, Math.round(data.bots))) : 0;
    const botSlots = freeSlots.slice(0, botsWanted);

    // synchronised start: wait out the remainder until the server startAt
    const delay = client.msUntil(data.startAt);
    hideScreens();
    game.start({
      mode: 'multiplayer',
      laps: data.laps,
      bots: botSlots.length > 0,
      botSlots,
      collisions: data.collisions,
      slot: me ? me.slot : 3,
      color: me && me.color ? me.color : undefined,
      peers,
      startDelayMs: Math.max(300, Math.min(8000, delay || 3000)),
    });
    startTelemetry();
    game.toastMsg(`MULTIPLAYER · ${data.laps} LAP${data.laps === 1 ? '' : 'S'}`, 1800);
  }

  // Final standings from the server: write them into the results screen table.
  function showStandings(data) {
    state.standings = data;
    showScreen('results');
    const tbody = $('standings-body');
    const wrap = $('standings-wrap');
    if (!tbody || !wrap) return;
    wrap.classList.remove('hidden');
    tbody.textContent = '';

    const savedByName = new Map((data.saved || []).map((s) => [s.playerName, s]));
    for (const row of data.standings) {
      const isMe = row.playerId === state.client.playerId;
      const tr = document.createElement('tr');
      if (isMe) tr.className = 'me';
      for (const value of [
        String(row.place),
        row.name + (isMe ? ' (you)' : ''),
        row.finished ? formatLap(row.bestLapMs) : `DNF · ${row.laps} lap(s)`,
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    const me = data.standings.find((r) => r.playerId === state.client.playerId);
    const ord = ['1st', '2nd', '3rd', '4th'];
    if (me) {
      const saved = savedByName.get(me.name);
      const place = `${ord[me.place - 1] || me.place} of ${data.standings.length}`;
      $('res-place').textContent = saved && saved.rank
        ? `Final: ${place} · leaderboard place ${saved.rank} of ${saved.total}`
        : `Final: ${place}`;
    }
    const note = $('res-mp-note');
    if (note) {
      note.classList.remove('hidden');
      note.textContent = 'Multiplayer result is stored by the server (mode: multiplayer).';
    }
  }

  // The local player finished: send the laps and wait for the server's standings.
  function onLocalFinish(result) {
    if (state.client && state.client.status !== 'offline') {
      state.client
        .action('finish', { laps: result.laps, lapsDone: result.laps.length })
        .catch((err) => showError(errorText(err.code || err.message), 'res-place'));
    }
    const note = $('res-mp-note');
    if (note) {
      note.classList.remove('hidden');
      note.textContent = 'Waiting for the other pilots to finish…';
    }
    if (typeof onRaceFinish === 'function') onRaceFinish(result);
  }

  // ---------- Server events ----------

  function handleEvent(event, data) {
    switch (event) {
      case 'hello':
        state.rooms = (data && data.rooms) || [];
        renderRooms();
        renderNetStatus();
        // after a page reload the player is put back into their room
        if (data && data.room) applyRoom(data.room);
        break;
      case 'rooms':
        state.rooms = (data && data.rooms) || [];
        renderRooms();
        break;
      case 'room': {
        const room = data && data.room;
        if (!room) break;
        applyRoom(room);
        break;
      }
      case 'chat':
        if (data && data.message) {
          if (state.room && state.racing) pushSystemLine(`${data.message.name || 'System'}: ${data.message.text}`);
          else renderChat([data.message], true);
        }
        break;
      case 'race_start':
        beginRace(data);
        break;
      case 'peer':
        if (data && data.id) game.setPeerState(data.id, data.s || {});
        break;
      case 'finished':
        if (state.racing && data) pushSystemLine(`${data.name} finished`);
        break;
      case 'results':
        stopTelemetry();
        state.racing = false;
        // if a race was still running locally, close it — the places are already known
        if (game.mode === 'multiplayer' && game.state !== 'idle' && game.state !== 'finished') game.toIdle();
        showStandings(data);
        break;
      case 'kicked':
        stopTelemetry();
        state.room = null;
        rememberInRoom(false);
        state.racing = false;
        game.toIdle();
        showScreen('mp');
        showError('The host removed you from the room.');
        break;
      case 'room_closed':
        stopTelemetry();
        state.room = null;
        rememberInRoom(false);
        state.racing = false;
        if (game.mode === 'multiplayer' && game.state !== 'idle') game.toIdle();
        showScreen('mp');
        showError('The room was closed by the host.');
        break;
      case 'error': {
        const code = (data && data.error) || 'unknown';
        showError(errorText(code), state.room ? 'mp-room-error' : 'mp-error');
        // already in a room is not a dead end — show our own room instead
        if (code === 'already_in_room' && state.room) {
          renderRoom();
          showScreen('mpRoom');
        }
        break;
      }
      default:
        break;
    }
  }

  function client() {
    if (!state.client) {
      state.client = new MpClient({
        name: playerName(),
        onEvent: handleEvent,
        onStatus: () => {
          renderNetStatus();
          if (state.racing && state.client && state.client.status !== 'online') {
            game.toastMsg('CONNECTION LOST — reconnecting…', 2600);
          }
        },
      });
      state.client.connect();
    }
    return state.client;
  }

  // ---------- UI actions ----------

  async function doAction(action, payload, errorTarget) {
    try {
      const res = await client().action(action, payload);
      hideError(errorTarget);
      return res;
    } catch (err) {
      showError(errorText(err.code || err.message), errorTarget);
      return null;
    }
  }

  async function kickPlayer(targetId) {
    await doAction('kick', { targetId }, 'mp-room-error');
  }

  function fillTrackSelect(select) {
    if (!select || select.options.length) return;
    for (const def of TRACK_LIST) {
      const opt = document.createElement('option');
      opt.value = def.id;
      opt.textContent = def.name;
      select.appendChild(opt);
    }
  }

  // ---------- Buttons ----------

  function wire() {
    fillTrackSelect($('mp-track-select'));
    fillTrackSelect($('mp-room-track'));

    $('btn-mp-create').addEventListener('click', () => {
      hideError();
      $('mp-room-name').value = `${playerName()} room`.slice(0, MAX_ROOM_NAME);
      showScreen('mpCreate');
    });
    $('btn-mp-create-back').addEventListener('click', () => showScreen('mp'));
    $('btn-mp-back').addEventListener('click', () => close());

    $('btn-mp-join-cancel').addEventListener('click', () => {
      state.pendingJoinId = null;
      $('mp-join').classList.add('hidden');
    });
    $('btn-mp-join-go').addEventListener('click', () => {
      if (state.pendingJoinId) joinRoom(state.pendingJoinId, $('mp-join-pass').value);
    });
    $('mp-join-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.pendingJoinId) joinRoom(state.pendingJoinId, $('mp-join-pass').value);
    });

    $('btn-mp-create-go').addEventListener('click', async () => {
      const name = $('mp-room-name').value.replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME);
      if (!name) {
        showError('Enter a room name (1–24 characters).', 'mp-create-error');
        return;
      }
      const laps = Number($('mp-laps-input').value);
      if (!Number.isFinite(laps) || laps < 1 || laps > 50) {
        showError('Laps must be between 1 and 50.', 'mp-create-error');
        return;
      }
      const botsCount = Number($('mp-bots-input').value);
      if (!Number.isFinite(botsCount) || botsCount < 0 || botsCount > MAX_BOTS) {
        showError('Bots count must be between 0 and 3.', 'mp-create-error');
        return;
      }
      const password = $('mp-password').value;
      const res = await doAction(
        'create',
        {
          name: playerName(),
          roomName: name,
          track: $('mp-track-select').value,
          laps,
          collisions: $('mp-opt-collisions').checked,
          bots: Math.max(0, Math.min(MAX_BOTS, Math.round(botsCount))),
          password: password || null,
        },
        'mp-create-error'
      );
      if (res && res.room) {
        state.room = res.room;
        showScreen('mpRoom');
        renderRoom();
      }
    });

    $('btn-mp-ready').addEventListener('click', async () => {
      const res = await doAction('ready', { ready: !state.ready }, 'mp-room-error');
      if (res) {
        state.ready = !!res.ready;
        $('btn-mp-ready').textContent = state.ready ? 'NOT READY' : 'READY';
      }
    });

    $('btn-mp-leave').addEventListener('click', () => leaveRoom());
    $('btn-mp-room-back').addEventListener('click', () => leaveRoom());

    $('btn-mp-apply').addEventListener('click', async () => {
      const laps = Number($('mp-room-laps').value);
      if (!Number.isFinite(laps) || laps < 1 || laps > 50) {
        showError('Laps must be between 1 and 50.', 'mp-room-error');
        return;
      }
      const botsCount = Number($('mp-room-bots-count').value);
      await doAction(
        'settings',
        {
          track: $('mp-room-track').value,
          laps,
          collisions: $('mp-room-collisions').checked,
          bots: Math.max(0, Math.min(MAX_BOTS, Number.isFinite(botsCount) ? Math.round(botsCount) : 0)),
        },
        'mp-room-error'
      );
    });

    $('btn-mp-start').addEventListener('click', () => doAction('start', {}, 'mp-room-error'));
    $('btn-mp-close-room').addEventListener('click', async () => {
      await doAction('close', {}, 'mp-room-error');
      leaveRoom(true);
    });

    $('mp-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('mp-chat-input');
      const text = input.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (text.length > MAX_CHAT_LEN) {
        showError(`Message is too long (max ${MAX_CHAT_LEN} characters).`, 'mp-room-error');
        return;
      }
      input.value = '';
      doAction('chat', { text }, 'mp-room-error');
    });
  }

  async function leaveRoom(silent = false) {
    if (state.client && state.room) await doAction('leave', {}, silent ? undefined : 'mp-room-error');
    stopTelemetry();
    state.room = null;
    rememberInRoom(false);
    state.ready = false;
    state.racing = false;
    if (game.mode === 'multiplayer' && game.state !== 'idle') game.toIdle();
    $('mp-join').classList.add('hidden');
    showScreen('mp');
    renderRooms();
  }

  // Leave the room without switching screens: called when the UI itself sends the
  // player back to the main menu from a race — otherwise a "ghost" stays on the server.
  function leaveIfInRoom() {
    stopTelemetry();
    state.ready = false;
    state.racing = false;
    rememberInRoom(false);
    if (!state.client || !state.room) {
      state.room = null;
      return;
    }
    state.room = null;
    state.client.action('leave', {}).catch(() => {});
  }

  // ---------- Public interface ----------

  function open() {
    client();
    hideError();
    showScreen(state.room ? 'mpRoom' : 'mp');
    renderRooms();
    renderNetStatus();
    // back in our own room (from a race, or after F5) — show the lobby
    if (state.room) renderRoom();
  }

  function close() {
    stopTelemetry();
    leaveRoom(true);
    if (state.client) {
      state.client.disconnect();
      state.client = null;
    }
    showScreen('menu');
  }

  wire();

  return {
    open,
    close,
    onLocalFinish,
    showStandings,
    leaveIfInRoom,
    wasInRoom,
    isRacing: () => state.racing,
    inRoom: () => !!state.room,
    backToRoom: () => {
      state.racing = false;
      if (state.room) {
        renderRoom();
        showScreen('mpRoom');
      } else {
        showScreen('mp');
      }
    },
    playerId: () => (state.client ? state.client.playerId : null),
    modeLabel: (mode) => MODE_LABELS[mode] || mode,
  };
}
