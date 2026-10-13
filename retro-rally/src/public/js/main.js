// main.js — screens, pilot login/registration, menu, races, leaderboard.

import { RaceGame } from './game.js';
import { formatLap, TRACK, setTrack, TRACK_LIST } from './track.js';
import { getHealth, getLeaderboard, postResult } from './api.js';
import { createMultiplayerScreen } from './mp-screen.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);

const screens = {
  login: $('screen-login'),
  register: $('screen-register'),
  menu: $('screen-menu'),
  single: $('screen-single'),
  mp: $('screen-mp'),
  mpCreate: $('screen-mp-create'),
  mpRoom: $('screen-mp-room'),
  leaderboard: $('screen-leaderboard'),
  help: $('screen-help'),
  profile: $('screen-profile'),
  results: $('screen-results'),
  version: $('screen-version'),
  sound: $('screen-sound'),
  pause: $('screen-pause'),
};

// corner buttons and the profile chip only show on menu screens, never mid-race
const MENU_SCREENS = new Set(['menu', 'single', 'mp', 'mpCreate', 'mpRoom', 'leaderboard', 'help', 'profile', 'version', 'sound']);

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
  $('corner-buttons').classList.toggle('hidden', !MENU_SCREENS.has(name));
  $('profile-chip').classList.toggle('hidden', !(!!readSession() && MENU_SCREENS.has(name)));
}

function hideScreens() {
  for (const el of Object.values(screens)) el.classList.add('hidden');
  $('corner-buttons').classList.add('hidden');
  $('profile-chip').classList.add('hidden');
}

// ---------- Pilot account (local copy, checked on the device) ----------

const ACCOUNT_KEY = 'retro-rally:account';
const SESSION_KEY = 'retro-rally:session';
const PASS_MIN = 4;
const LEVEL_STATE = { level: 1, progress: 0 };

// SHA-256 in plain JS. Needed because a page opened over http:// (neither HTTPS
// nor localhost) has no window.crypto.subtle — Web Crypto only exists in a
// secure context. Without this fallback registration and login failed silently.
function sha256Hex(text) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // string -> UTF-8 bytes
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (text.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  for (const v of [hi, lo]) bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        (bytes[i + t * 4] << 24) |
        (bytes[i + t * 4 + 1] << 16) |
        (bytes[i + t * 4 + 2] << 8) |
        bytes[i + t * 4 + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

const HASH_SALT = 'retro-rally:';

// SHA-256(salt + password) as hex. Web Crypto is the fast path; if the browser
// refuses it (page opened over http) we compute it ourselves — bit-identical, so
// existing accounts keep working.
async function hashPass(pass) {
  const data = HASH_SALT + pass;
  const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle ? crypto.subtle : null;
  // test hook: forces the fallback path
  const forced = typeof globalThis !== 'undefined' && globalThis.__forceShaFallback === true;
  if (subtle && typeof subtle.digest === 'function' && !forced) {
    try {
      const buf = new TextEncoder().encode(data);
      const digest = await subtle.digest('SHA-256', buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* unavailable — fall through to the JS implementation below */
    }
  }
  return sha256Hex(data);
}

function readAccount() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
  } catch {
    return null;
  }
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function setSession(name) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ name, since: new Date().toISOString() }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function playerName() {
  const s = readSession();
  return (s && s.name) || 'Racer';
}

function renderProfile() {
  const name = playerName();
  $('avatar-initial').textContent = name.slice(0, 1).toUpperCase();
  $('chip-name').textContent = name;
  $('chip-level').textContent = `LVL ${LEVEL_STATE.level} · ${LEVEL_STATE.progress}%`;
  $('chip-bar-fill').style.width = `${LEVEL_STATE.progress}%`;
  $('pilot-label').textContent = name;
}

// Changing an input's type resets the caret (a Chromium quirk), so save the
// selection and restore it after the switch.
function setInputType(input, type) {
  if (input.type === type) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.type = type;
  try {
    if (start !== null && end !== null) input.setSelectionRange(start, end);
  } catch {
    /* some input types do not support selection */
  }
}

// The "eye" button plus a brief peek at what has been typed
function attachPassReveal(inputId, eyeId) {
  const input = $(inputId);
  const eye = $(eyeId);
  let hideTimer = 0;
  input.addEventListener('input', () => {
    if (eye.dataset.pinned === '1') return;
    setInputType(input, 'text');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (eye.dataset.pinned !== '1') setInputType(input, 'password');
    }, 900);
  });
  eye.addEventListener('click', () => {
    const pinned = eye.dataset.pinned === '1';
    eye.dataset.pinned = pinned ? '0' : '1';
    setInputType(input, pinned ? 'password' : 'text');
    input.focus();
  });
}

attachPassReveal('login-pass', 'login-eye');
attachPassReveal('reg-pass', 'reg-eye');

function showAuthError(elId, message) {
  const el = $(elId);
  el.textContent = message;
  el.classList.remove('hidden');
}

// Safety net: if login/registration fails, the player sees why, not silence.
window.addEventListener('unhandledrejection', function (event) {
  let reason = 'unknown error';
  if (event && event.reason) reason = event.reason.message || String(event.reason);
  const regOpen = document.getElementById('screen-register') && !document.getElementById('screen-register').classList.contains('hidden');
  const loginOpen = document.getElementById('screen-login') && !document.getElementById('screen-login').classList.contains('hidden');
  if (regOpen) showAuthError('register-error', 'Sign in unavailable: ' + reason);
  else if (loginOpen) showAuthError('login-error', 'Sign in unavailable: ' + reason);
  console.error('[retro-rally] unhandled error:', reason);
});
function enterMenu() {
  renderProfile();
  showScreen('menu');
  refreshServerStatus();
  Sound.unlock();
  Sound.startMusic();
  const localAccount = readAccount();
  syncPilot('seen', playerName(), localAccount ? localAccount.hash : null);
}

$('to-register').addEventListener('click', () => {
  $('reg-name').value = $('login-name').value;
  showScreen('register');
});
$('to-login').addEventListener('click', () => {
  $('login-name').value = $('reg-name').value;
  showScreen('login');
});

// Login and registration go through the server-side pilot registry, which stores
// the name and password hash — so one account works on desktop and phone alike,
// and several names can live side by side. The local copy only covers offline login.

async function postPilot(path, name, hash) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, hash }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function saveLocalAccount(name, hash) {
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ name, hash, createdAt: new Date().toISOString() }));
}

$('btn-login').addEventListener('click', async () => {
  $('login-error').classList.add('hidden');
  const name = $('login-name').value.replace(/\s+/g, ' ').trim();
  const pass = $('login-pass').value;
  if (!name || !pass) {
    showAuthError('login-error', 'Enter your pilot name and password');
    return;
  }
  const hash = await hashPass(pass);
  const local = readAccount();

// 1) this account is already on the device — log in locally (works offline too)
  if (local && local.name === name && local.hash === hash) {
    setSession(local.name);
    $('login-pass').value = '';
    syncPilot('seen', name, hash);
    enterMenu();
    return;
  }

// 2) otherwise ask the server — that is how login from a phone or another browser works
  try {
    const res = await postPilot('/api/pilot/login', name, hash);
    if (res.status === 200) {
      saveLocalAccount(name, hash);
      setSession(name);
      $('login-pass').value = '';
      enterMenu();
      return;
    }
    if (res.status === 403) {
      showAuthError('login-error', 'Wrong name or password');
      return;
    }
    if (res.status === 404) {
      showAuthError('login-error', 'No such pilot on the server — please register');
      return;
    }
    showAuthError('login-error', 'Server error — try again in a moment');
  } catch {
    if (local && local.name === name) {
      showAuthError('login-error', 'Wrong name or password');
    } else {
      showAuthError('login-error', 'Server unavailable — try again in a moment');
    }
  }
});

$('btn-register').addEventListener('click', async () => {
  $('register-error').classList.add('hidden');
  const name = $('reg-name').value.replace(/\s+/g, ' ').trim().slice(0, 24);
  const pass = $('reg-pass').value;
  if (!name) {
    showAuthError('register-error', 'Enter a pilot name (1–24 characters)');
    return;
  }
  if (pass.length < PASS_MIN) {
    showAuthError('register-error', 'Password must be at least ' + PASS_MIN + ' characters');
    return;
  }
  const hash = await hashPass(pass);

// the account is created on the server, so it is available from any device
  try {
    const res = await postPilot('/api/pilot/register', name, hash);
    if (res.status === 409) {
      showAuthError('register-error', 'This name is already taken — log in with its password');
      return;
    }
    if (res.status !== 200) {
      showAuthError('register-error', 'Server error — try again in a moment');
      return;
    }
  } catch {
    console.warn('[retro-rally] server unreachable: account saved on this device only');
  }

  saveLocalAccount(name, hash);
  setSession(name);
  $('reg-pass').value = '';
  enterMenu();
});

// ---------- Profile ----------

$('btn-profile').addEventListener('click', () => {
  $('profile-name').textContent = playerName();
  $('profile-level').textContent = String(LEVEL_STATE.level);
  $('profile-progress').textContent = `${LEVEL_STATE.progress}%`;
  $('level-bar-fill').style.width = `${LEVEL_STATE.progress}%`;
  showScreen('profile');
});

$('btn-profile-close').addEventListener('click', () => showScreen('menu'));

$('btn-logout').addEventListener('click', () => {
  mp.leaveIfInRoom();
  clearSession();
  game.toIdle();
  const acc = readAccount();
  $('login-name').value = acc ? acc.name : '';
  $('login-pass').value = '';
  $('login-error').classList.add('hidden');
  showScreen('login');
});

// ---------- Game ----------

const canvas = $('game');
let pendingResult = null;
let lastSubmittedId = null;

function resetSubmitButton() {
  const btn = $('btn-res-submit');
  btn.disabled = false;
  btn.textContent = 'SEND TO LEADERBOARD';
}

const game = new RaceGame(canvas, {
  onFinish(result) {
    pendingResult = result;
    lastSubmittedId = null;
    const mpNote = $('res-mp-note');
    if (mpNote) {
      mpNote.classList.add('hidden');
      mpNote.textContent = '';
    }
    $('res-best').textContent = formatLap(result.best);
    $('res-total').textContent = formatLap(result.totalMs);
    $('res-total-label').textContent = `${result.laps.length} lap${result.laps.length === 1 ? '' : 's'}`;
    $('res-avg').textContent = formatLap(Math.round(result.totalMs / result.laps.length));
    $('res-laps').textContent = `Laps: ${result.laps.map((l) => formatLap(l)).join(' · ')}`;
    const wrap = $('standings-wrap');
    const tbody = $('standings-body');
    tbody.textContent = '';
    const multiplayer = result.mode === 'multiplayer';
    if (result.standings) {
      wrap.classList.remove('hidden');
      result.standings.forEach((s, i) => {
        const tr = document.createElement('tr');
        if (s.isPlayer) tr.className = 'me';
        for (const value of [String(i + 1), s.isPlayer ? playerName() : s.name, formatLap(s.best)]) {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      const ord = ['1st', '2nd', '3rd', '4th'];
      $('res-place').textContent = `On track: ${ord[result.place - 1] || result.place} of ${result.fieldSize}`;
    } else if (multiplayer) {
// in multiplayer the final places come from the server (results event)
      wrap.classList.add('hidden');
      $('res-place').textContent = 'Waiting for the other pilots — standings arrive from the server…';
    } else {
      wrap.classList.add('hidden');
      $('res-place').textContent =
        result.mode === 'training'
          ? 'Training lap — send it to the leaderboard with the TRAINING tag.'
          : 'Training lap — the leaderboard stores VS BOTS results.';
    }
    $('btn-res-submit').classList.toggle('hidden', !(result.canSubmit && !multiplayer));
    showScreen('results');
    if (multiplayer) mp.onLocalFinish(result);
  },
  onPauseChange(visible) {
    if (visible) showScreen('pause');
    else hideScreens();
  },
  onSoundChange() {
    renderSoundButton();
  },
});

// ---------- Multiplayer: lobby, rooms, chat ----------

const mp = createMultiplayerScreen({
  game,
  showScreen,
  hideScreens,
  playerName,
  onRaceFinish: null,
});

// ---------- Menu ----------

async function refreshServerStatus() {
  const el = $('srv-status');
  try {
    const health = await getHealth();
    el.textContent = `Results server: online · races stored: ${health.resultsCount}`;
    el.classList.remove('bad');
  } catch {
    el.textContent = 'Results server: offline — results will not be saved';
    el.classList.add('bad');
  }
}

$('btn-single').addEventListener('click', () => showScreen('single'));
$('btn-multi').addEventListener('click', () => mp.open());
$('btn-leaderboard').addEventListener('click', () => {
  showScreen('leaderboard');
  loadLeaderboard();
});
$('btn-help').addEventListener('click', () => showScreen('help'));
$('btn-help-close').addEventListener('click', () => showScreen('menu'));
$('btn-version').addEventListener('click', () => {
  renderVersionScreen();
  showScreen('version');
});
$('btn-version-close').addEventListener('click', () => showScreen('menu'));
$('btn-sound').addEventListener('click', () => {
  renderSoundPanel();
  showScreen('sound');
});

function launchRace(opts) {
  // the track picked in the dropdown
  if (setTrack($('track-select').value)) game.rebuildTrack();
  hideScreens();
  resetSubmitButton();
  const lapsValue = Number(($('laps-input') || {}).value);
  const laps = Number.isFinite(lapsValue) && lapsValue > 0 ? Math.min(50, Math.round(lapsValue)) : 3;
  game.start({ laps, ...opts });
}

// How many bots are selected for single player (same field as room creation)
function readBotCount() {
  const value = Number(($('bots-input') || {}).value);
  if (!Number.isFinite(value)) return 3;
  return Math.max(0, Math.min(3, Math.round(value)));
}

// Bot grid slots: the player takes slot 3, bots fill 0..n-1
function singleBotSlots(count) {
  const n = Math.max(0, Math.min(3, Math.round(count)));
  return [0, 1, 2].slice(0, n);
}

$('btn-training').addEventListener('click', () => launchRace({ mode: 'training', bots: false }));
$('btn-vs-bots').addEventListener('click', () => {
  const botCount = readBotCount();
  launchRace({
    mode: 'race',
    bots: botCount > 0,
    botSlots: singleBotSlots(botCount),
    collisions: $('opt-collisions').checked,
  });
});
$('btn-single-back').addEventListener('click', () => showScreen('menu'));

// ---------- Leaderboard ----------

function fmtEmDash() {
  return '—';
}

function dateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

const MODE_LABELS = { training: 'TRAINING', bots: 'BOTS', multiplayer: 'MULTI' };

function modeLabel(item) {
  const label = MODE_LABELS[item.mode] || (item.mode ? String(item.mode).toUpperCase() : 'BOTS');
  return item.legacy ? `${label} (legacy)` : label;
}

let lbTrack = 'all';
let lbMode = 'all';

function renderLbTabs(counts = {}) {
  const wrap = $('lb-tracks');
  if (!wrap) return;
  wrap.textContent = '';
  const defs = [{ id: 'all', name: 'ALL TRACKS' }, ...TRACK_LIST];
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (def.id === lbTrack ? ' active' : '');
    const count = def.id === 'all'
      ? Object.keys(counts).reduce((sum, key) => sum + (counts[key] || 0), 0)
      : (counts[def.id] || 0);
    btn.textContent = def.name;
    if (count) {
      const span = document.createElement('span');
      span.className = 'count';
      span.textContent = ` ${count}`;
      btn.appendChild(span);
    }
    btn.addEventListener('click', () => { lbTrack = def.id; loadLeaderboard(); });
    wrap.appendChild(btn);
  }
}

// Mode filter: training / vs bots / multiplayer
function renderLbModeTabs(modeCounts = {}) {
  const wrap = $('lb-modes');
  if (!wrap) return;
  wrap.textContent = '';
  const total = ['training', 'bots', 'multiplayer', 'legacy'].reduce((sum, key) => sum + (modeCounts[key] || 0), 0);
  const defs = [
    { id: 'all', name: 'ALL MODES', count: total },
    { id: 'training', name: 'TRAINING', count: modeCounts.training || 0 },
    { id: 'bots', name: 'VS BOTS', count: (modeCounts.bots || 0) + (modeCounts.legacy || 0) },
    { id: 'multiplayer', name: 'MULTIPLAYER', count: modeCounts.multiplayer || 0 },
  ];
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (def.id === lbMode ? ' active' : '');
    btn.textContent = def.name;
    if (def.count) {
      const span = document.createElement('span');
      span.className = 'count';
      span.textContent = ` ${def.count}`;
      btn.appendChild(span);
    }
    btn.addEventListener('click', () => { lbMode = def.id; loadLeaderboard(); });
    wrap.appendChild(btn);
  }
}

function fillLeaderboard(data) {
  const tbody = $('lb-body');
  tbody.textContent = '';
  for (const item of data.items) {
    const tr = document.createElement('tr');
    if ((item.id && item.id === lastSubmittedId) || item.playerName === playerName()) tr.className = 'me';
    for (const value of [
      String(item.rank),
      item.playerName,
      modeLabel(item),
      formatLap(item.bestLapMs),
      item.totalMs ? formatLap(item.totalMs) : fmtEmDash(),
      String(item.lapsCount),
      dateShort(item.createdAt),
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function loadLeaderboard() {
  const status = $('lb-status');
  status.textContent = 'Loading…';
  status.classList.remove('bad');
  $('lb-body').textContent = '';
  try {
    const data = await getLeaderboard(lbTrack, lbMode);
    fillLeaderboard(data);
    renderLbTabs(data.counts || {});
    renderLbModeTabs(data.modeCounts || {});
    status.textContent = data.items.length
      ? `Total races stored: ${data.total} (all: ${data.totalAll || data.total}) · showing top ${data.items.length}`
      : 'No results yet — be the first!';
  } catch (err) {
    status.textContent = `Failed to load: ${err.message}`;
    status.classList.add('bad');
  }
}

$('btn-lb-refresh').addEventListener('click', loadLeaderboard);
$('btn-lb-close').addEventListener('click', () => {
  game.toIdle();
  showScreen('menu');
  refreshServerStatus();
});

// ---------- Race result ----------

$('btn-res-submit').addEventListener('click', async () => {
  if (!pendingResult) return;
  const btn = $('btn-res-submit');
  const place = $('res-place');
  btn.disabled = true;
  btn.textContent = 'SENDING…';
  place.textContent = '';
  try {
    const res = await postResult({
      playerName: playerName(),
      laps: pendingResult.laps,
      track: TRACK.id,
      mode: pendingResult.mode === 'training' ? 'training' : 'bots',
    });
    lastSubmittedId = res.saved ? res.saved.id : null;
    place.textContent = `Result saved: place ${res.rank} of ${res.total}!`;
    lbMode = pendingResult.mode === 'training' ? 'training' : 'bots';
    showScreen('leaderboard');
    loadLeaderboard();
  } catch (err) {
    place.textContent = `Failed to send: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'SEND TO LEADERBOARD';
  }
});

$('btn-res-again').addEventListener('click', () => {
// in multiplayer "race again" means going back to your room, not to solo play
  if (game.mode === 'multiplayer') {
    mp.backToRoom();
    return;
  }
  showScreen('single');
});
$('btn-res-menu').addEventListener('click', () => {
  game.toIdle();
  mp.leaveIfInRoom();
  showScreen('menu');
  refreshServerStatus();
});

// ---------- Pause ----------

$('btn-pause-resume').addEventListener('click', () => game.togglePause());
$('btn-pause-restart').addEventListener('click', () => {
  hideScreens();
  resetSubmitButton();
  game.start(game.lastOptions || { mode: 'race', bots: true, collisions: true });
});
$('btn-pause-menu').addEventListener('click', () => {
  game.toIdle();
// back to the menu means leaving the room too, otherwise a "ghost" stays on the server
  mp.leaveIfInRoom();
  showScreen('menu');
  refreshServerStatus();
});

// ---------- Sound: volume panel ----------

function renderSoundPanel() {
  const v = Sound.getVolumes();
  const music = $('vol-music');
  const sfx = $('vol-sfx');
  if (music) {
    music.value = String(Math.round(v.music * 100));
    $('vol-music-label').textContent = `${Math.round(v.music * 100)}%`;
  }
  if (sfx) {
    sfx.value = String(Math.round(v.sfx * 100));
    $('vol-sfx-label').textContent = `${Math.round(v.sfx * 100)}%`;
  }
  const mute = $('btn-sound-mute');
  if (mute) {
    mute.textContent = v.muted ? 'UNMUTE ALL' : 'MUTE ALL';
    mute.classList.toggle('btn-primary', v.muted);
  }
  renderSoundButton();
}

$('vol-music').addEventListener('input', () => {
  const value = Number($('vol-music').value) / 100;
  Sound.setMusicVolume(value);
  $('vol-music-label').textContent = `${Math.round(value * 100)}%`;
});

$('vol-sfx').addEventListener('input', () => {
  const value = Number($('vol-sfx').value) / 100;
  Sound.setSfxVolume(value);
  $('vol-sfx-label').textContent = `${Math.round(value * 100)}%`;
});

$('btn-sound-mute').addEventListener('click', () => {
  Sound.setMuted(!Sound.isMuted());
  renderSoundPanel();
});

$('btn-sound-close').addEventListener('click', () => showScreen('menu'));

// First user gesture: lift the autoplay block and start the music
function unlockAudio() {
  Sound.unlock();
  Sound.startMusic();
}
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

// ---------- Pilot registry (server-side record for the admin panel) ----------

async function syncPilot(kind, name, hash) {
  try {
    const payload = kind === 'seen' ? { name, hash } : { name, hash, allowImport: kind === 'login' };
    await fetch(`/api/pilot/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* the server keeps no record — login still works locally */
  }
}

// ---------- Version and changelog ----------

const APP_VERSION = '0.5.6';
const CHANGELOG = [
  {
    version: '0.5.6',
    date: '13.10.2026',
    items: [
      'Project restructured: the application now lives in src/, everything needed on the VM in deploy/, so the project root holds only the launcher, the README and the ignore files',
      'Note for existing deployments: nginx root moved to /opt/retro-rally/src/public, the systemd unit runs /opt/retro-rally/src/server.js and runtime data is written to src/data/',
    ],
  },
  {
    version: '0.5.5',
    date: '13.10.2026',
    items: [
      'Fixed: the host lobby no longer throws when it renders — the bots count field is the only control now',
      'Fixed: the admin panel remembers the admin key under a stable storage key',
      'Project housekeeping: everything is in English, comments trimmed, the Cloudflare variant and the one-off map picker removed',
    ],
  },
  {
    version: '0.5.4',
    date: '13.10.2026',
    items: [
      'Pilot accounts now live on the server: log in from any device (phone, another browser) with the same name and password',
      'Several accounts on one device are supported — registering a new name no longer locks you out of the previous one',
    ],
  },
  {
    version: '0.5.3',
    date: '13.10.2026',
    items: [
      'Fixed: sign in and sign up now work when the site is opened over plain http — password hashing falls back to the built-in SHA-256 when the browser blocks Web Crypto',
      'Auth errors are now shown on screen instead of failing silently',
    ],
  },
  {
    version: '0.5.2',
    date: '22.09.2026',
    items: [
      'Fixed: the caret no longer jumps to the start of the password field while typing',
      'Sound panel, admin panel and single player bot count from the previous update',
    ],
  },
  {
    version: '0.5.1',
    date: '22.09.2026',
    items: [
      'Single player: pick how many bots join the race (0–3), same control as in room creation',
      'Single player hints updated: training laps are stored with the TRAINING tag',
    ],
  },
  {
    version: '0.5.0',
    date: '22.09.2026',
    items: [
      'Multiplayer: cars of live pilots now collide instead of passing through each other',
      'Background music, plus separate volume sliders for music and game sounds',
      'Sound settings panel: mute, music level, game sound level (saved between sessions)',
      'Server pilot registry: who registered and when they last played',
      'Admin panel at /admin.html: online pilots, rooms, registered pilots, results',
    ],
  },
  {
    version: '0.4.1',
    date: '22.09.2026',
    items: [
      'Tidy settings: equal field widths and aligned labels in solo and host settings',
      'Smoother remote cars: linear interpolation between network updates',
      'FPS meter: press F3 or open the game with ?fps=1',
    ],
  },
  {
    version: '0.4',
    date: '22.09.2026',
    items: [
      'Multiplayer: leaving a room and reloading the page now behave correctly',
      'Smoother online races: fewer state updates, no overlapping requests',
      'Tidy host settings and single player screens',
      'Sound toggle and version buttons in the corner',
      'Your car now takes the color of its grid slot',
    ],
  },
  {
    version: '0.3',
    date: '22.09.2026',
    items: [
      'Online multiplayer: rooms (up to 4 pilots), password lock, ready check, chat',
      'Host settings: track, laps, collisions, bots count; solo races allowed',
      'Leaderboard: modes for training / vs bots / multiplayer',
    ],
  },
  {
    version: '0.2',
    date: '15.09.2026',
    items: ['Leaderboard: track tabs, total time column, laps input', 'Bots tuned per track'],
  },
  {
    version: '0.1',
    date: '15.09.2026',
    items: ['Base game: two tracks, three bots, checkpoints, cloud prototype'],
  },
];

function renderVersionScreen() {
  const current = $('version-current');
  if (current) current.textContent = `v${APP_VERSION}`;
  const box = $('changelog');
  if (!box) return;
  box.textContent = '';
  for (const entry of CHANGELOG) {
    const head = document.createElement('p');
    head.className = 'ver';
    head.textContent = `v${entry.version}`;
    const when = document.createElement('span');
    when.textContent = ` · ${entry.date}`;
    head.appendChild(when);
    if (entry.version === APP_VERSION) {
      const tag = document.createElement('span');
      tag.className = 'current';
      tag.textContent = 'CURRENT';
      head.appendChild(tag);
    }
    box.appendChild(head);
    const list = document.createElement('ul');
    for (const item of entry.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    box.appendChild(list);
  }
}

function renderSoundButton() {
  const btn = $('btn-sound');
  if (!btn) return;
  const muted = Sound.isMuted();
  btn.textContent = muted ? '🔇' : '🔊';
  btn.classList.toggle('muted', muted);
  btn.title = muted ? 'Sound: off (M)' : 'Sound: on (M)';
  btn.setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
}

// ---------- FPS counter (F3 or ?fps=1) ----------

let fpsVisible = false;
try {
  fpsVisible = new URLSearchParams(location.search).has('fps');
} catch {
  fpsVisible = false;
}

function renderFpsChip() {
  const el = $('fps-chip');
  if (!el) return;
  el.classList.toggle('hidden', !fpsVisible);
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'F3') {
    event.preventDefault();
    fpsVisible = !fpsVisible;
    renderFpsChip();
  }
});

setInterval(() => {
  if (!fpsVisible) return;
  const el = $('fps-chip');
  if (!el || typeof game.frameStats !== 'function') return;
  const s = game.frameStats();
  el.textContent = `FPS ${s.fps} · avg ${s.avgMs}ms · p95 ${s.p95Ms}ms · max ${s.maxMs}ms · jank ${s.jank}/${s.frames}`;
}, 500);

renderFpsChip();

// ---------- Startup ----------

// the canvas covers the whole screen: fit the buffer to the window, no black bars
function fitCanvas() {
  const height = 720;
  const aspect = Math.max(1.2, window.innerWidth / Math.max(1, window.innerHeight));
  canvas.width = Math.round(height * aspect);
  canvas.height = height;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

$('track-name').textContent = TRACK.name;

// track dropdown
const trackSelect = $('track-select');
for (const def of TRACK_LIST) {
  const opt = document.createElement('option');
  opt.value = def.id;
  opt.textContent = def.name;
  trackSelect.appendChild(opt);
}
trackSelect.value = TRACK.id;
trackSelect.addEventListener('change', () => {
  if (setTrack(trackSelect.value)) {
    $('track-name').textContent = TRACK.name;
    game.rebuildTrack();
  }
});
if (readSession()) {
  renderProfile();
// if the player was in a room and reloaded — put them back into the lobby
  if (mp.wasInRoom()) mp.open();
  else showScreen('menu');
} else {
  const acc = readAccount();
  $('login-name').value = acc ? acc.name : '';
  showScreen('login');
}
refreshServerStatus();

// Handles for the integration tests (tools/browser-check.js)
window.__game = game;
window.__game.track = TRACK;
window.__mp = mp;
window.__sound = Sound;
window.__app = { version: APP_VERSION, changelog: CHANGELOG };
window.__sha256 = sha256Hex;
window.__fps = { visible: () => fpsVisible, stats: () => game.frameStats() };

$('version-line').textContent = `cloud prototype · v${APP_VERSION}`;
if ($('login-version')) {
  const secure = typeof crypto !== 'undefined' && crypto.subtle;
  $('login-version').textContent = 'client v' + APP_VERSION + ' · ' + (secure ? 'secure hashing' : 'built-in hashing');
}
$('btn-version').textContent = `v${APP_VERSION}`;
renderSoundButton();
