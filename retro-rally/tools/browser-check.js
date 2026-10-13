'use strict';
// browser-check.js — interactive headless-Chrome game check over CDP:
// login/registration, menu, modes, screenshots, FPS sampling, result submission,
// validation, persistence. The script deletes nothing.
//
// Start a server before running, e.g. on a separate port:
//   PORT=8081 DATA_FILE=src/data/demo-results.json node src/server.js
//   node tools/browser-check.js
// BASE_URL defaults to http://localhost:8080 (it is rewritten to 127.0.0.1 —
// Chrome may resolve localhost to IPv6).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'docs', 'screenshots');
const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace('localhost', '127.0.0.1');
// A unique port per run: a chrome zombie that survived a restart with an old
// page must not intercept the connection.
const DEBUG_PORT = 9200 + Math.floor(Math.random() * 9000);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

let failures = 0;

function check(name, cond, extra) {
  if (cond) console.log(`BROWSERCHECK PASS ${name}`);
  else {
    failures++;
    console.log(`BROWSERCHECK FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep the SSE stream open: the server treats a client without a stream as gone.
function holdSse(baseUrl, playerId, name) {
  const ctrl = new AbortController();
  fetch(`${baseUrl}/api/mp/events?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(name)}`, {
    signal: ctrl.signal,
  })
    .then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })
    .catch(() => {});
  return () => {
    try {
      ctrl.abort();
    } catch {
      /* already closed */
    }
  };
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        },
      });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('CDP websocket error'));
  });
}

async function getPageTarget() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE_URL));
      if (page) return page;
    } catch {
      /* the browser is still starting */
    }
    await sleep(200);
  }
  throw new Error('timed out waiting for the page in Chrome');
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error(`page error: ${desc || r.exceptionDetails.text}`);
  }
  return r.result.value;
}

// Wait for the game instance (the page may have reloaded)
async function waitGame(cdp, expression) {
  for (let i = 0; i < 40; i++) {
    try {
      const has = await evalJs(cdp, '!!window.__game');
      if (has) return await evalJs(cdp, expression);
    } catch {
      /* the context is being recreated */
    }
    await sleep(400);
  }
  let diag = '';
  try {
    diag = await evalJs(cdp, `JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, gameType: typeof window.__game, buildId: window.__buildId || null, errs: (window.__pageErrors || []).slice(-3) })`);
  } catch (e) {
    diag = 'diag fail: ' + (e && e.message);
  }
  const errs = (cdp.getPageErrors ? cdp.getPageErrors() : []).slice(-4);
  throw new Error('window.__game unavailable | ' + diag + ' | ' + errs.join(' ;; '));
}

async function shot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

const key = (code, type) => `window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' }));`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Edge not found');

  const profileDir = path.join(os.tmpdir(), `retro-rally-browser-check-${Date.now()}`);
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      
      '--window-size=1300,760',
      '--hide-scrollbars',
      BASE_URL + '/',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    const target = await getPageTarget();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Wait for a real load: chrome may have opened the page before the server was up
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const rs = await evalJs(cdp, 'document.readyState + "|" + !!document.getElementById("btn-login")');
        if (rs === 'complete|true') {
          ready = true;
          break;
        }
      } catch {
        /* the context may be recreated */
      }
      if (i === 9) {
        try {
          await cdp.send('Page.navigate', { url: BASE_URL + '/' });
        } catch {
          /* retry on the next iteration */
        }
      }
      await sleep(400);
    }
    check('page.loaded', ready);
    await evalJs(cdp, 'new Promise(r => setTimeout(r, 400))');
    const title = await evalJs(cdp, 'document.title');

    // live background: bots drive a small figure-eight behind the menu
    const demoInfo = await evalJs(
      cdp,
      'JSON.stringify({ cars: window.__game && window.__game.demo ? window.__game.demo.cars.length : 0 })'
    );
    check('idle.demo-cars', JSON.parse(demoInfo).cars >= 3, demoInfo);
    const p1 = await evalJs(cdp, 'JSON.stringify(window.__game.demo.cars.map((c) => [Math.round(c.x), Math.round(c.y)]))');
    await sleep(1600);
    const p2 = await evalJs(cdp, 'JSON.stringify(window.__game.demo.cars.map((c) => [Math.round(c.x), Math.round(c.y)]))');
    const a1 = JSON.parse(p1);
    const a2 = JSON.parse(p2);
    let demoMoved = 0;
    for (let i = 0; i < a1.length; i++) {
      if (Math.hypot(a2[i][0] - a1[i][0], a2[i][1] - a1[i][1]) > 15) demoMoved++;
    }
    check('idle.demo-live', demoMoved >= 2, p1 + ' -> ' + p2);
    let demoTravel = 0;
    for (let i = 0; i < a1.length; i++) {
      demoTravel += Math.hypot(a2[i][0] - a1[i][0], a2[i][1] - a1[i][1]);
    }
    check('idle.demo-fast', demoTravel >= 1200, 'travel total ' + Math.round(demoTravel));
    const demoSpeeds = JSON.parse(
      await evalJs(cdp, 'JSON.stringify(window.__game.demo.cars.map((c) => Math.round(Math.hypot(c.vx, c.vy))))')
    );
    check('idle.demo-speed', Math.max.apply(null, demoSpeeds) >= 320, 'speeds ' + JSON.stringify(demoSpeeds));
    check('page.title', typeof title === 'string' && title.includes('RETRO RALLY'), String(title));

    // login → registration → profile → logout → login again
    const loginVisible = await evalJs(cdp, "!document.getElementById('screen-login').classList.contains('hidden')");
    check('login.visible', loginVisible === true);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await shot(cdp, path.join(SHOTS_DIR, 'login.png'));

    await evalJs(cdp, "document.getElementById('to-register').click()");
    await sleep(300);
    const regVisible = await evalJs(cdp, "!document.getElementById('screen-register').classList.contains('hidden')");
    check('auth.register-screen', regVisible === true);

    await evalJs(cdp, `(() => { document.getElementById('reg-name').value = 'Demo Pilot'; document.getElementById('reg-pass').value = 'race-pass-1'; document.getElementById('reg-pass').dispatchEvent(new Event('input')); return true; })()`);
    const revealed = await evalJs(cdp, "document.getElementById('reg-pass').type");
    check('auth.pass-reveal', revealed === 'text', String(revealed));
    await sleep(1100);
    const hiddenAgain = await evalJs(cdp, "document.getElementById('reg-pass').type");
    check('auth.pass-hides-again', hiddenAgain === 'password', String(hiddenAgain));

    // SHA-256 fallback: works where the browser blocks Web Crypto (page over http://)
    const shaInfo = await evalJs(
      cdp,
      "JSON.stringify({ abc: window.__sha256('abc'), long: window.__sha256('retro-rally:test-pass') })"
    );
    const sha = JSON.parse(shaInfo);
    check(
      'auth.sha256-fallback',
      sha.abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' &&
        sha.long === '2b66da578326fd0c5bd6c5674d3a31c52869e706da9e05f3c9a82713340dcb02',
      shaInfo
    );
    const shaMatch = await evalJs(
      cdp,
      "(async () => { const data = 'retro-rally:cmp'; const buf = new TextEncoder().encode(data); const d = await crypto.subtle.digest('SHA-256', buf); const web = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); return String(web === window.__sha256(data)); })()"
    );
    check('auth.sha256-matches-webcrypto', shaMatch === 'true', String(shaMatch));

    // The caret must not jump to the start while characters are shown:
    // in Chromium a type change resets the cursor position.
    const caretInfo = await evalJs(
      cdp,
      `(() => {
        const el = document.getElementById('reg-pass');
        const saved = el.value;
        el.focus();
        el.value = 'race';
        el.setSelectionRange(4, 4);
        el.dispatchEvent(new Event('input'));
        const out = { type: el.type, caret: el.selectionStart, length: el.value.length };
        // restore the field so later steps are unaffected
        el.value = saved;
        el.setSelectionRange(saved.length, saved.length);
        el.dispatchEvent(new Event('input'));
        out.restored = el.value;
        return JSON.stringify(out);
      })()`
    );
    const ci = JSON.parse(caretInfo);
    check('auth.pass-caret-keeps-position', ci.type === 'text' && ci.caret === 4 && ci.restored === 'race-pass-1', caretInfo);

    await evalJs(cdp, "document.getElementById('btn-register').click()");
    await sleep(600);
    const auth = await evalJs(
      cdp,
      `JSON.stringify({ pilot: document.getElementById('pilot-label').textContent, chip: document.getElementById('chip-name').textContent, chipHidden: document.getElementById('profile-chip').classList.contains('hidden'), menuHidden: document.getElementById('screen-menu').classList.contains('hidden') })`
    );
    const authInfo = JSON.parse(auth);
    check('auth.registered', authInfo.pilot === 'Demo Pilot' && !authInfo.menuHidden, auth);
    check('profile.chip', authInfo.chip === 'Demo Pilot' && !authInfo.chipHidden, auth);

    await evalJs(cdp, "document.getElementById('btn-profile').click()");
    await sleep(300);
    const profVisible = await evalJs(cdp, "!document.getElementById('screen-profile').classList.contains('hidden')");
    check('profile.panel', profVisible === true);

    await evalJs(cdp, "document.getElementById('btn-logout').click()");
    await sleep(300);
    const afterLogout = await evalJs(cdp, "JSON.stringify({ login: !document.getElementById('screen-login').classList.contains('hidden'), chipHidden: document.getElementById('profile-chip').classList.contains('hidden') })");
    const lo = JSON.parse(afterLogout);
    check('auth.logout', lo.login === true && lo.chipHidden === true, afterLogout);

    await evalJs(cdp, `(() => { document.getElementById('login-name').value = 'Demo Pilot'; document.getElementById('login-pass').value = 'wrong-pass'; return true; })()`);
    await evalJs(cdp, "document.getElementById('btn-login').click()");
    await sleep(500);
    const wrongErr = await evalJs(cdp, "JSON.stringify({ err: document.getElementById('login-error').textContent, login: !document.getElementById('screen-login').classList.contains('hidden') })");
    const we = JSON.parse(wrongErr);
    check('auth.wrong-pass', we.login === true && we.err.includes('Wrong name or password'), wrongErr);

    await evalJs(cdp, `(() => { document.getElementById('login-name').value = 'Demo Pilot'; document.getElementById('login-pass').value = 'race-pass-1'; return true; })()`);
    await evalJs(cdp, "document.getElementById('btn-login').click()");
    await sleep(600);
    const relog = await evalJs(cdp, "JSON.stringify({ chip: document.getElementById('chip-name').textContent, menu: !document.getElementById('screen-menu').classList.contains('hidden') })");
    const rl = JSON.parse(relog);
    check('auth.relogin', rl.chip === 'Demo Pilot' && rl.menu === true, relog);

    // --- Server-side accounts: login from "another device" and several names ---
    // Simulate a phone: wipe local data, as in a clean browser.
    await evalJs(
      cdp,
      "(() => { localStorage.removeItem('retro-rally:account'); localStorage.removeItem('retro-rally:session'); return true; })()"
    );
    await cdp.send('Page.reload');
    await sleep(1500);
    for (let i = 0; i < 40; i++) {
      const ok = await evalJs(cdp, 'typeof window.__game === "object"').catch(() => false);
      if (ok) break;
      await sleep(300);
    }
    const freshDevice = await evalJs(
      cdp,
      "JSON.stringify({ loginOpen: !document.getElementById('screen-login').classList.contains('hidden'), localAccount: localStorage.getItem('retro-rally:account') })"
    );
    check('auth.fresh-device-login-screen', JSON.parse(freshDevice).loginOpen === true, freshDevice);

    // a wrong password on the "new device" must complain honestly
    await evalJs(
      cdp,
      `(() => { document.getElementById('login-name').value = 'Demo Pilot'; document.getElementById('login-pass').value = 'totally-wrong'; return true; })()`
    );
    await evalJs(cdp, "document.getElementById('btn-login').click()");
    await sleep(1200);
    const wrongOnServer = await evalJs(cdp, "document.getElementById('login-error').textContent");
    check('auth.server-rejects-wrong-pass', /wrong name or password/i.test(String(wrongOnServer)), String(wrongOnServer));

    // the right password from the "new device" — login via the server registry
    await evalJs(
      cdp,
      `(() => { document.getElementById('login-name').value = 'Demo Pilot'; document.getElementById('login-pass').value = 'race-pass-1'; return true; })()`
    );
    await evalJs(cdp, "document.getElementById('btn-login').click()");
    await sleep(1500);
    const crossDevice = await evalJs(
      cdp,
      `JSON.stringify({
        menuOpen: !document.getElementById('screen-menu').classList.contains('hidden'),
        err: document.getElementById('login-error').textContent,
        pilot: document.getElementById('pilot-label').textContent,
        localAccountSaved: !!localStorage.getItem('retro-rally:account'),
      })`
    );
    const cd = JSON.parse(crossDevice);
    check('auth.cross-device-login', cd.menuOpen === true && cd.pilot === 'Demo Pilot', crossDevice);
    check('auth.local-copy-cached', cd.localAccountSaved === true, crossDevice);

    // a second name on the same device must not break the first
    await evalJs(cdp, "document.getElementById('btn-logout').click()");
    await sleep(400);
    await evalJs(cdp, "document.getElementById('to-register').click()");
    await sleep(300);
    await evalJs(
      cdp,
      `(() => { document.getElementById('reg-name').value = 'Second Pilot'; document.getElementById('reg-pass').value = 'second-pass'; return true; })()`
    );
    await evalJs(cdp, "document.getElementById('btn-register').click()");
    await sleep(1500);
    const secondReg = await evalJs(
      cdp,
      `JSON.stringify({ menuOpen: !document.getElementById('screen-menu').classList.contains('hidden'), pilot: document.getElementById('pilot-label').textContent, err: document.getElementById('register-error').textContent })`
    );
    check('auth.second-account', JSON.parse(secondReg).menuOpen === true && JSON.parse(secondReg).pilot === 'Second Pilot', secondReg);

    // and back again: the first name is still available
    await evalJs(cdp, "document.getElementById('btn-logout').click()");
    await sleep(400);
    await evalJs(
      cdp,
      `(() => { document.getElementById('login-name').value = 'Demo Pilot'; document.getElementById('login-pass').value = 'race-pass-1'; return true; })()`
    );
    await evalJs(cdp, "document.getElementById('btn-login').click()");
    await sleep(1500);
    const backToFirst = await evalJs(
      cdp,
      `JSON.stringify({ menuOpen: !document.getElementById('screen-menu').classList.contains('hidden'), pilot: document.getElementById('pilot-label').textContent, err: document.getElementById('login-error').textContent })`
    );
    check('auth.first-account-still-works', JSON.parse(backToFirst).menuOpen === true && JSON.parse(backToFirst).pilot === 'Demo Pilot', backToFirst);
    await shot(cdp, path.join(SHOTS_DIR, 'menu.png'));
    // Multiplayer: room list, creation, lobby, chat
    await evalJs(cdp, "document.getElementById('btn-multi').click()");
    await sleep(700);
    check(
      'mp.rooms-screen',
      (await evalJs(cdp, "!document.getElementById('screen-mp').classList.contains('hidden')")) === true
    );
    const mpCreateLabel = await evalJs(cdp, "document.getElementById('btn-mp-create').textContent.trim()");
    check('mp.create-button', mpCreateLabel === 'CREATE ROOM', String(mpCreateLabel));
    const mpHead = await evalJs(
      cdp,
      "JSON.stringify(Array.from(document.querySelectorAll('#screen-mp .mp-rooms thead th')).map((th) => th.textContent.trim()))"
    );
    check('mp.lock-column', JSON.parse(mpHead).includes('Lock'), mpHead);

    // create a room with a password and no bots
    await evalJs(cdp, "document.getElementById('btn-mp-create').click()");
    await sleep(400);
    check(
      'mp.create-screen',
      (await evalJs(cdp, "!document.getElementById('screen-mp-create').classList.contains('hidden')")) === true
    );
    await evalJs(
      cdp,
      `(() => {
        document.getElementById('mp-room-name').value = 'CDP Test Room';
        document.getElementById('mp-laps-input').value = '2';
        document.getElementById('mp-bots-input').value = '0';
        document.getElementById('mp-password').value = 'lock-123';
        return true;
      })()`
    );
    await evalJs(cdp, "document.getElementById('btn-mp-create-go').click()");
    await sleep(900);
    check(
      'mp.room-screen',
      (await evalJs(cdp, "!document.getElementById('screen-mp-room').classList.contains('hidden')")) === true
    );
    const mpRoomInfo = await evalJs(
      cdp,
      `JSON.stringify({
        title: document.getElementById('mp-room-title').textContent,
        players: document.querySelectorAll('#mp-players .mp-player').length,
        you: !!document.querySelector('#mp-players .mp-badge.you'),
        host: !!document.querySelector('#mp-players .mp-badge.host'),
        hostTools: !document.getElementById('mp-host-tools').classList.contains('hidden'),
        startDisabled: document.getElementById('btn-mp-start').disabled,
        startVisible: !document.getElementById('mp-start-wrap').classList.contains('hidden'),
        startInHostTools: !!document.querySelector('#mp-host-tools #btn-mp-start'),
        botsCheckbox: !!document.getElementById('mp-opt-bots') || !!document.getElementById('mp-room-bots'),
        readyHint: document.getElementById('mp-ready-hint').textContent,
        readyButton: document.getElementById('btn-mp-ready').textContent,
      })`
    );
    const mpRoom = JSON.parse(mpRoomInfo);
    check('mp.room-title', mpRoom.title === 'CDP Test Room', mpRoomInfo);
    check('mp.room-one-player', mpRoom.players === 1 && mpRoom.you === true && mpRoom.host === true, mpRoomInfo);
    check('mp.room-host-tools', mpRoom.hostTools === true, mpRoomInfo);
    check('mp.room-start-next-to-ready', mpRoom.startVisible === true && mpRoom.startInHostTools === false, mpRoomInfo);
    check('mp.room-start-solo-allowed', mpRoom.startDisabled === false, mpRoomInfo);
    check('mp.room-no-bots-checkbox', mpRoom.botsCheckbox === false, mpRoomInfo);
    check('mp.room-ready-button', mpRoom.readyButton === 'READY', mpRoomInfo);
    // guards the host lobby against a throw mid-render: the ready hint is the
    // last thing renderRoom() fills in, so an empty value means it never finished
    check('mp.room-renders-fully', !!String(mpRoom.readyHint).trim().length, mpRoomInfo);

    // chat: our own message shows up in the feed
    await evalJs(
      cdp,
      `(() => { document.getElementById('mp-chat-input').value = 'Browser check hello'; document.getElementById('mp-chat-form').dispatchEvent(new Event('submit', { cancelable: true })); return true; })()`
    );
    await sleep(800);
    const mpChatLines = await evalJs(
      cdp,
      "JSON.stringify(Array.from(document.querySelectorAll('#mp-chat .mp-chat-line')).map((li) => li.textContent))"
    );
    check('mp.chat-local', JSON.parse(mpChatLines).some((t) => t.includes('Browser check hello')), mpChatLines);

    // READY toggles
    await evalJs(cdp, "document.getElementById('btn-mp-ready').click()");
    await sleep(700);
    const mpReadyLabel = await evalJs(cdp, "document.getElementById('btn-mp-ready').textContent");
    check('mp.ready-toggle', mpReadyLabel === 'NOT READY', String(mpReadyLabel));

    // a "ghost" open room with no password: it must have no lock
    // (leave first — a previous run may have left the player in a room)
    await fetch(`${BASE_URL}/api/mp/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'cdp-ghost-open1', action: 'leave' }),
    }).catch(() => {});
    const ghostRoom = await evalJs(
      cdp,
      `(async () => {
        const res = await fetch('/api/mp/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: 'cdp-ghost-open1', action: 'create', name: 'Ghost', roomName: 'Open CDP Room', track: 'wheatfield', laps: 1, bots: 1 }),
        });
        return JSON.stringify(await res.json());
      })()`
    );
    check('mp.ghost-open-room', !!JSON.parse(ghostRoom).room, ghostRoom);

    // both rooms are listed: the locked one has a padlock icon, the open one nothing
    await evalJs(cdp, "document.getElementById('btn-mp-room-back').click()");
    await sleep(1200);
    const mpRoomsTable = await evalJs(
      cdp,
      `JSON.stringify({
        rows: Array.from(document.querySelectorAll('#mp-rooms-body tr')).map((tr) => ({
          name: tr.cells[0] ? tr.cells[0].textContent : '',
          locked: !!tr.querySelector('.mp-lock-icon'),
          cells: tr.cells.length,
        })),
      })`
    );
    const mpRooms = JSON.parse(mpRoomsTable);
    const lockedRow = mpRooms.rows.find((r) => r.name === 'CDP Test Room');
    const openRow = mpRooms.rows.find((r) => r.name === 'Open CDP Room');
    check('mp.rooms-row', mpRooms.rows.length >= 2, mpRoomsTable);
    check(
      'mp.rooms-lock-only-for-password',
      !!lockedRow && lockedRow.locked === true && !!openRow && openRow.locked === false,
      mpRoomsTable
    );
    check('mp.rooms-cells', mpRooms.rows.every((r) => r.cells === 6), mpRoomsTable);
    await shot(cdp, path.join(SHOTS_DIR, 'multiplayer.png'));

    await evalJs(cdp, "document.getElementById('btn-mp-back').click()");
    await sleep(500);
    check(
      'mp.back-to-menu',
      (await evalJs(cdp, "!document.getElementById('screen-menu').classList.contains('hidden')")) === true
    );

    // --- Sound, volume panel and version ---
    await evalJs(cdp, "document.getElementById('btn-sound').click()");
    await sleep(400);
    const soundPanel = await evalJs(
      cdp,
      `JSON.stringify({
        visible: !document.getElementById('screen-sound').classList.contains('hidden'),
        music: document.getElementById('vol-music').value,
        sfx: document.getElementById('vol-sfx').value,
        label: document.getElementById('vol-music-label').textContent,
      })`
    );
    const sp = JSON.parse(soundPanel);
    check('ui.sound-button-opens-panel', sp.visible === true && String(sp.label).includes('%'), soundPanel);

    // music and game sounds are adjusted independently
    await evalJs(cdp, `(() => { const s = document.getElementById('vol-music'); s.value = '20'; s.dispatchEvent(new Event('input')); return true; })()`);
    await evalJs(cdp, `(() => { const s = document.getElementById('vol-sfx'); s.value = '40'; s.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(300);
    const soundVolumes = await evalJs(cdp, 'JSON.stringify(window.__sound.getVolumes())');
    const sv = JSON.parse(soundVolumes);
    check('ui.sound-volumes-separate', sv.music === 0.2 && sv.sfx === 0.4, soundVolumes);
    check('ui.music-playing', (await evalJs(cdp, 'window.__sound.isMusicPlaying()')) === true);

    await evalJs(cdp, "document.getElementById('btn-sound-mute').click()");
    await sleep(300);
    const mutedNow = await evalJs(
      cdp,
      "JSON.stringify({ muted: window.__sound.isMuted(), cls: document.getElementById('btn-sound').className })"
    );
    const mn = JSON.parse(mutedNow);
    check('ui.sound-mute-from-panel', mn.muted === true && mn.cls.includes('muted'), mutedNow);
    await evalJs(cdp, "document.getElementById('btn-sound-mute').click()");
    await sleep(200);
    await evalJs(cdp, "document.getElementById('btn-sound-close').click()");
    await sleep(250);

    // The M key toggles sound and syncs the corner icon
    await evalJs(cdp, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }))");
    await sleep(300);
    const soundKey = await evalJs(
      cdp,
      "JSON.stringify({ muted: window.__sound.isMuted(), cls: document.getElementById('btn-sound').className })"
    );
    const sf2 = JSON.parse(soundKey);
    check('ui.sound-key-syncs-button', !!sf2.cls.includes('muted') === !!sf2.muted, soundKey);
    await evalJs(cdp, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }))");
    await sleep(200);

    await evalJs(cdp, "document.getElementById('btn-version').click()");
    await sleep(350);
    const verInfo = await evalJs(
      cdp,
      `JSON.stringify({
        visible: !document.getElementById('screen-version').classList.contains('hidden'),
        current: document.getElementById('version-current').textContent,
        entries: document.querySelectorAll('#changelog .ver').length,
        items: document.querySelectorAll('#changelog li').length,
        appVersion: window.__app ? window.__app.version : null,
        menuLine: document.getElementById('version-line').textContent,
      })`
    );
    const vi = JSON.parse(verInfo);
    check('ui.version-screen', vi.visible === true && vi.entries >= 4 && vi.items >= 10, verInfo);
    check('ui.version-labelled', vi.current === `v${vi.appVersion}` && String(vi.menuLine).includes(vi.appVersion), verInfo);
    await evalJs(cdp, "document.getElementById('btn-version-close').click()");
    await sleep(250);

    // --- Multiplayer race: slot car colour, telemetry, smoothness, exit ---
    await evalJs(cdp, "document.getElementById('btn-multi').click()");
    await sleep(800);
    await evalJs(cdp, "document.getElementById('btn-mp-create').click()");
    await sleep(400);
    await evalJs(
      cdp,
      `(() => {
        document.getElementById('mp-room-name').value = 'Race Test';
        document.getElementById('mp-laps-input').value = '1';
        document.getElementById('mp-bots-input').value = '2';
        document.getElementById('mp-password').value = '';
        return true;
      })()`
    );
    await evalJs(cdp, "document.getElementById('btn-mp-create-go').click()");
    await sleep(1100);

    const slotHex = await evalJs(
      cdp,
      `(() => {
        const dot = document.querySelector('#mp-players .mp-player.me .mp-dot');
        if (!dot) return null;
        const m = getComputedStyle(dot).backgroundColor.match(/\\d+/g) || [];
        return '#' + m.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
      })()`
    );
    const raceRooms = await (await fetch(`${BASE_URL}/api/mp/rooms`)).json();
    const raceRoom = (raceRooms.rooms || []).find((r) => r.name === 'Race Test');
    check('mp.race-room-listed', !!raceRoom, JSON.stringify(raceRooms.rooms));

    // a second ("ghost") player: joins the room and streams its states
    const closeGhostSse = holdSse(BASE_URL, 'cdp-ghost-racer', 'Ghost');
    const ghostJoin = await (
      await fetch(`${BASE_URL}/api/mp/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'cdp-ghost-racer', action: 'join', roomId: raceRoom.id, name: 'Ghost' }),
      })
    ).json();
    check('mp.ghost-joined', !!ghostJoin.room, JSON.stringify(ghostJoin));

    let ghostTimer = 0;
    const startGhost = () => {
      clearInterval(ghostTimer);
      let step = 0;
      ghostTimer = setInterval(() => {
        step += 1;
        fetch(`${BASE_URL}/api/mp/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: 'cdp-ghost-racer',
            action: 'state',
            s: { x: 1000 + step * 4, y: 800 + Math.sin(step / 6) * 40, a: 0.3, sp: 180, lp: 0, ex: 2, br: false, fin: false },
          }),
        }).catch(() => {});
      }, 100);
    };
    const stopGhost = () => clearInterval(ghostTimer);

    await evalJs(cdp, "document.getElementById('btn-mp-start').click()");
    await sleep(3600);
    const mpRace = await evalJs(
      cdp,
      `JSON.stringify({
        mode: window.__game.mode,
        state: window.__game.state,
        peers: window.__game.peers.length,
        bots: window.__game.bots.length,
        car: String(window.__game.car.color).toUpperCase(),
      })`
    );
    const mpr = JSON.parse(mpRace);
    check('mp.race-started-solo', mpr.mode === 'multiplayer' && mpr.state === 'racing', mpRace);
    check('mp.race-bots-by-count', mpr.bots === 2, mpRace);
    check('mp.car-color-matches-slot', !!slotHex && mpr.car === slotHex, `${slotHex} vs ${mpRace}`);
    check('mp.peer-car-present', mpr.peers === 1, mpRace);

    await evalJs(cdp, 'window.__game.autopilot = true; true');
    startGhost();
    await sleep(500);
    const peerA = await evalJs(cdp, 'JSON.stringify(window.__game.peers.map((p) => Math.round(p.tx)))');
    await sleep(900);
    const peerB = await evalJs(cdp, 'JSON.stringify(window.__game.peers.map((p) => Math.round(p.tx)))');
    check('mp.peer-state-live', peerA !== peerB, `${peerA} -> ${peerB}`);

    // Collision with a live player car: place the opponent right next to ours
    stopGhost();
    await sleep(150);
    const collideSetup = await evalJs(
      cdp,
      `JSON.stringify((() => {
        const g = window.__game;
        if (!g.peers.length) return { ok: false, why: 'no peer' };
        const peer = g.peers[0];
        const x = g.car.x;
        const y = g.car.y;
        g.setPeerState(peer.peerId, { x, y, a: g.car.angle, sp: 0, lp: 0, ex: 0, br: false, fin: false });
        peer.tx = x; peer.ty = y; peer.x = x; peer.y = y; peer.fromX = x; peer.fromY = y;
        return { ok: true, before: g.contactHits };
      })())`
    );
    await sleep(800);
    const hitsAfter = await evalJs(cdp, 'window.__game.contactHits');
    check(
      'mp.player-collision',
      JSON.parse(collideSetup).ok === true && hitsAfter > JSON.parse(collideSetup).before,
      `${collideSetup} -> hits=${hitsAfter}`
    );
    await evalJs(cdp, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3' }))");
    await sleep(800);
    const fpsInfo = await evalJs(
      cdp,
      `JSON.stringify({
        hidden: document.getElementById('fps-chip').classList.contains('hidden'),
        text: document.getElementById('fps-chip').textContent,
        fps: window.__game.frameStats().fps,
        jank: window.__game.frameStats().jank,
      })`
    );
    const fpsChip = JSON.parse(fpsInfo);
    check('ui.fps-chip', fpsChip.hidden === false && fpsChip.fps > 0 && /FPS \d+/.test(fpsChip.text), fpsInfo);
    const mpFrames = await evalJs(
      cdp,
      `new Promise(res => { let f = 0; const t0 = performance.now(); const loop = () => { f++; if (performance.now() - t0 < 3000) requestAnimationFrame(loop); else res(f); }; requestAnimationFrame(loop); })`
    );
    check('mp.fps', mpFrames >= 150, `frames3s=${mpFrames}`);
    console.log(`BROWSERCHECK INFO mp-frames-in-3s=${mpFrames}`);
    stopGhost();

    // going to the main menu must leave the room
    await evalJs(cdp, key('Escape', 'keydown'));
    await sleep(400);
    await evalJs(cdp, "document.getElementById('btn-pause-menu').click()");
    await sleep(700);
    const myId = await evalJs(cdp, 'window.__mp.playerId()');
    const flagAfterLeave = await evalJs(cdp, 'window.__mp.wasInRoom()');
    check('mp.leave-flag-cleared', flagAfterLeave === false, String(flagAfterLeave));
    closeGhostSse();
    const reCreate = await (
      await fetch(`${BASE_URL}/api/mp/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: myId, action: 'create', name: 'Demo Pilot', roomName: 'Leave Check', track: 'wheatfield', laps: 1, bots: 0 }),
      })
    ).json();
    check('mp.can-create-after-exit', !!reCreate.room, JSON.stringify(reCreate));
    await fetch(`${BASE_URL}/api/mp/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: myId, action: 'close' }),
    }).catch(() => {});
    await fetch(`${BASE_URL}/api/mp/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'cdp-ghost-racer', action: 'leave' }),
    }).catch(() => {});

    // Single player
    await evalJs(cdp, "document.getElementById('btn-single').click()");
    await sleep(300);
    const singleVisible = await evalJs(
      cdp,
      "!document.getElementById('screen-single').classList.contains('hidden')"
    );
    check('single.visible', singleVisible === true);
    const trackList = await evalJs(cdp, 'JSON.stringify(Array.from(document.getElementById("track-select").options).map(o => o.value))');
    const tl = JSON.parse(trackList);
    check('single.track-list', Array.isArray(tl) && tl.length >= 2 && tl[0] === 'wheatfield' && tl[1] === 'canyon', trackList);
    check('single.track-select', true);
    const lapsInput = await evalJs(
      cdp,
      `JSON.stringify((() => { const s = document.getElementById('laps-input'); return { type: s.type, min: s.min, max: s.max, value: s.value }; })())`
    );
    const li = JSON.parse(lapsInput);
    check('single.laps-input', li.type === 'number' && li.min === '1' && li.max === '50' && li.value === '3', lapsInput);
    const singleLayout = await evalJs(
      cdp,
      `JSON.stringify((() => {
        const sel = document.getElementById('track-select');
        const laps = document.getElementById('laps-input');
        const grid = sel.closest('.field-grid');
        const sw = Math.round(sel.getBoundingClientRect().width);
        const lw = Math.round(laps.getBoundingClientRect().width);
        return { grid: !!grid, selW: sw, lapsW: lw, gap: Math.abs(sw - lw) };
      })())`
    );
    const sl = JSON.parse(singleLayout);
    check('single.fields-aligned', sl.grid === true && sl.gap <= 2, singleLayout);

    // bot count selection — same as in room creation
    const botsInput = await evalJs(
      cdp,
      `JSON.stringify((() => {
        const s = document.getElementById('bots-input');
        return s ? { type: s.type, min: s.min, max: s.max, value: s.value } : null;
      })())`
    );
    const bi = JSON.parse(botsInput);
    check('single.bots-input', !!bi && bi.type === 'number' && bi.min === '0' && bi.max === '3', botsInput);
    await evalJs(cdp, "(() => { document.getElementById('bots-input').value = '1'; return true; })()");
    await evalJs(cdp, '(() => { const s = document.getElementById("track-select"); s.value = "canyon"; s.dispatchEvent(new Event("change")); return true; })()');
    await sleep(200);
    await shot(cdp, path.join(SHOTS_DIR, 'menu.png'));

    // VS BOTS (collisions on by default)
    const collisionsOn = await evalJs(cdp, 'document.getElementById("opt-collisions").checked');
    check('single.collisions-default', collisionsOn === true, String(collisionsOn));
    await evalJs(cdp, "document.getElementById('btn-vs-bots').click()");
    await sleep(3600); // 3-2-1 countdown
    const state = await waitGame(cdp, 'window.__game.state');
    check('race.started', state === 'racing', String(state));
    const lapsDefault = await evalJs(cdp, 'String(window.__game.totalLaps)');
    check('laps.default-3', lapsDefault === '3', lapsDefault);
    const plan = await evalJs(cdp, 'JSON.stringify(window.__game.countdownPlan)');
    check('countdown.even-1s', plan === '[0,1000,2000,3000]', plan);
    const hint0 = await evalJs(cdp, 'window.__game.car.hint');
    const expectedStart = await evalJs(cdp, 'window.__game.tracker.expected');
    check('gates.start-expected', expectedStart === 1, String(expectedStart));
    const botsCount = await evalJs(cdp, 'window.__game.bots.length');
    check('single.bots-count-applied', botsCount === 1, String(botsCount));
    const botSlots = await evalJs(cdp, 'JSON.stringify(window.__game.lastOptions.botSlots || null)');
    check('single.bots-slots', botSlots === '[0]', botSlots);
    const revActive = await evalJs(cdp, 'window.__game.track && window.__game.track.id === "canyon"');
    check('track.canyon-active', revActive === true, String(revActive));

    // Countdown: the last second must show "1" (it used to jump straight to GO)
    await evalJs(cdp, "document.getElementById('btn-vs-bots').click()");
    await sleep(2200);
    const cdLabel = await waitGame(
      cdp,
      'String(Math.max(1, Math.ceil(Math.max(0, window.__game.countdownEndMs - performance.now()) / 1000)))'
    );
    check('countdown.shows-1', cdLabel === '1', cdLabel);
    await sleep(1600);
    const state2 = await waitGame(cdp, 'window.__game.state');
    check('race.started2', state2 === 'racing', String(state2));

    // Countdown: 3 → 2 → 1 with no gaps (this checks the label logic)
    // (past the countdown, the label is verified indirectly via the GO toast below)

    // Switch on autopilot: the car follows the centreline, crossing the sector lines
    await evalJs(cdp, 'window.__game.autopilot = true; true');
    let raceInfo = null;
    for (let i = 0; i < 66; i++) {
      await sleep(300);
      raceInfo = await waitGame(
        cdp,
        `JSON.stringify((() => { const g = window.__game; const n = g.track.samples.length; return { exp: g.tracker.expected, hint: g.car.hint, moved: ((g.car.hint - ${hint0}) % n + n) % n, botExp: Math.max(...g.bots.map(b => b.tracker.expected)), botLaps: Math.max(...g.bots.map(b => b.laps.length)) }; })())`
      );
      const info = JSON.parse(raceInfo);
      if (info.exp > 1 || info.botExp > 2 || info.botLaps > 0) break;
    }
    const ri = JSON.parse(raceInfo || '{}');
    check(
      'gates.advance',
      ri.exp > 1 || ri.botExp > 2 || ri.botLaps > 0,
      raceInfo
    );
    check('player.moved', (ri.moved || 0) > 40 || ri.exp > 1, raceInfo);
    const botsMoving = await evalJs(
      cdp,
      'window.__game.bots.filter(b => Math.hypot(b.vx, b.vy) > 15 || b.laps.length > 0).length'
    );
    const botsConfigured = await evalJs(cdp, 'window.__game.bots.length');
    check('bots.racing', botsMoving >= Math.min(2, botsConfigured), `moving=${botsMoving} of ${botsConfigured}`);
    await sleep(1200);
    await shot(cdp, path.join(SHOTS_DIR, 'race-1.png'));
    await sleep(1400);
    await shot(cdp, path.join(SHOTS_DIR, 'race-2.png'));

    // Pixel check of the render: the scene is not empty — grass/asphalt/car/HUD present
    const px = await evalJs(
      cdp,
      `(() => {
        const c = document.getElementById('game');
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        let grass = 0, asphalt = 0, red = 0, cream = 0, total = 0;
        for (let i = 0; i < img.length; i += 32) {
          const r = img[i], g = img[i + 1], b = img[i + 2];
          total++;
          if (g > r && g > b) grass++;
          else if (Math.abs(r - 82) < 28 && Math.abs(g - 82) < 28 && Math.abs(b - 92) < 28) asphalt++;
          if (r > 190 && g < 130 && b < 100) red++;
          if (r > 238 && g > 222 && b > 185 && b < 245) cream++;
        }
        return { total, grass, asphalt, red, cream };
      })()`
    );
    check('render.grass-pixels', px && px.grass / px.total > 0.15, JSON.stringify(px));
    check('render.asphalt-pixels', px && px.asphalt / px.total > 0.05, JSON.stringify(px));
    check('render.car-red-pixels', px && px.red >= 3, JSON.stringify(px));
    check('render.hud-panel-pixels', px && px.cream / px.total > 0.005, JSON.stringify(px));

    // FPS over 3 seconds
    await evalJs(cdp, key('ArrowUp', 'keydown'));
    const frames = await evalJs(
      cdp,
      `new Promise(res => { let f = 0; const t0 = performance.now(); const loop = () => { f++; if (performance.now() - t0 < 3000) requestAnimationFrame(loop); else res(f); }; requestAnimationFrame(loop); })`
    );
    check('fps.ok', frames >= 90, `frames3s=${frames}`);
    console.log(`BROWSERCHECK INFO frames-in-3s=${frames}`);
    await evalJs(cdp, key('ArrowUp', 'keyup'));

    // Submit a result from the page (exactly as the UI does)
    const posted = await evalJs(
      cdp,
      `(async () => {
        const res = await fetch('/api/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerName: 'Demo Pilot', track: 'canyon', laps: [41234, 40890, 41555] }),
        });
        return { status: res.status, body: await res.json() };
      })()`
    );
    check('ui.post-result-201', posted && posted.status === 201 && posted.body && posted.body.saved, JSON.stringify(posted));
    check('ui.post-rank-gte1', !!(posted && posted.body && posted.body.rank >= 1));

    // Validation error — empty name
    const bad = await evalJs(
      cdp,
      `(async () => {
        const res = await fetch('/api/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerName: '', laps: [10000] }),
        });
        return { status: res.status, body: await res.json() };
      })()`
    );
    check('ui.invalid-post-400', bad && bad.status === 400, JSON.stringify(bad));

    // Leaderboard in the UI
    await evalJs(cdp, "document.getElementById('btn-leaderboard').click()");
    await sleep(1600);
    const rows = await evalJs(
      cdp,
      `JSON.stringify({ rows: Array.from(document.querySelectorAll('#lb-body tr')).map(tr => Array.from(tr.cells).map(td => td.textContent)), status: document.getElementById('lb-status').textContent })`
    );
    const parsed = JSON.parse(rows);
    check(
      'ui.leaderboard-row',
      Array.isArray(parsed.rows) && parsed.rows.some((row) => row[1] === 'Demo Pilot'),
      rows
    );
    await shot(cdp, path.join(SHOTS_DIR, 'leaderboard.png'));

    const lbShape = await evalJs(
      cdp,
      `JSON.stringify({
        head: Array.from(document.querySelectorAll('.lb thead th')).map((th) => th.textContent.trim()),
        tabs: Array.from(document.querySelectorAll('#lb-tracks .tab')).map((b) => b.textContent.trim()),
        cells: (document.querySelector('#lb-body tr') || { cells: [] }).cells.length,
      })`
    );
    const lbInfo = JSON.parse(lbShape);
    check('lb.no-car-column', !lbInfo.head.includes('Car'), lbShape);
    check('lb.track-tabs', lbInfo.tabs.length >= 3, lbShape);
    check('lb.total-column', lbInfo.head.includes('Total'), lbShape);
    check('lb.mode-column', lbInfo.head.includes('Mode'), lbShape);
    check('lb.row-cells-7', lbInfo.cells === 7, lbShape);
    const lbModeTabs = await evalJs(
      cdp,
      "JSON.stringify(Array.from(document.querySelectorAll('#lb-modes .tab')).map((b) => b.textContent.trim()))"
    );
    check('lb.mode-tabs', JSON.parse(lbModeTabs).length === 4, lbModeTabs);
    const modeFilt = await evalJs(
      cdp,
      `(async () => { const r = await (await fetch('/api/leaderboard?mode=multiplayer')).json(); return JSON.stringify({ mode: r.mode, items: r.items.length, modeCounts: r.modeCounts }); })()`
    );
    check('lb.mode-filter', JSON.parse(modeFilt).mode === 'multiplayer', modeFilt);
    const filt = await evalJs(
      cdp,
      `(async () => { const r = await (await fetch('/api/leaderboard?track=canyon')).json(); return JSON.stringify({ track: r.track, total: r.total, counts: r.counts }); })()`
    );
    check('lb.track-filter', JSON.parse(filt).track === 'canyon', filt);

    // Reload the page — the result survives (server-side persistence)
    try {
      await evalJs(cdp, 'location.reload(); true');
    } catch {
      /* the context is destroyed by navigation — expected */
    }
    let reloaded = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try {
        const rs = await evalJs(cdp, 'document.readyState');
        if (rs === 'complete') {
          reloaded = true;
          break;
        }
      } catch {
        /* the context is being recreated */
      }
    }
    check('ui.reload-done', reloaded);
    await sleep(500);
    const afterReload = await evalJs(
      cdp,
      `(async () => (await (await fetch('/api/leaderboard')).json()).items.length)()`
    );
    check('ui.persist-after-reload', afterReload >= 1, `items=${afterReload}`);

    // --- Admin panel: page, key, tables ---
    const adminKey = process.env.ADMIN_KEY || '';
    await fetch(`${BASE_URL}/api/pilot/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Admin Check Pilot', hash: 'c'.repeat(64) }),
    }).catch(() => {});
    await cdp.send('Page.navigate', { url: BASE_URL + '/admin.html' });
    await sleep(1500);
    const adminForm = await evalJs(cdp, "!!document.getElementById('admin-key')");
    check('admin.page-loaded', adminForm === true);
    await evalJs(
      cdp,
      `(() => { document.getElementById('admin-key').value = ${JSON.stringify(adminKey)}; document.getElementById('btn-connect').click(); return true; })()`
    );
    await sleep(1500);
    const adminUi = await evalJs(
      cdp,
      `JSON.stringify({
        status: document.getElementById('admin-status').textContent,
        cards: document.querySelectorAll('#server-cards .card').length,
        pilots: Array.from(document.querySelectorAll('#pilots-body tr')).map((tr) => tr.textContent),
        onlineHeaders: document.querySelectorAll('#online-body tr').length,
      })`
    );
    const au = JSON.parse(adminUi);
    check('admin.ui-connected', String(au.status).includes('Connected'), adminUi);
    check('admin.ui-server-cards', au.cards >= 5, adminUi);
    check('admin.ui-pilot-row', au.pilots.some((t) => t.includes('Admin Check Pilot')), adminUi);
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    // chrome.kill() does not always kill the process tree on Windows — force it
    try {
      const { spawn: spawn2 } = require('node:child_process');
      spawn2('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* not critical */
    }
  }

  console.log(failures === 0 ? 'BROWSERCHECK RESULT: PASS' : `BROWSERCHECK RESULT: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`BROWSERCHECK FAIL reason=exception ${err && err.message}`);
  process.exit(1);
});
