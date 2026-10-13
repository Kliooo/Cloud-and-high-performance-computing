// admin.js — reads /api/admin/summary with the key and renders the tables.

const KEY_STORAGE = 'retro-rally:admin-key';
const REFRESH_MS = 3000;
const $ = (id) => document.getElementById(id);

let adminKey = '';
let timer = 0;

function setStatus(text, bad = false) {
  const el = $('admin-status');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

function cell(value) {
  const td = document.createElement('td');
  td.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  return td;
}

function row(values) {
  const tr = document.createElement('tr');
  for (const value of values) tr.appendChild(cell(value));
  return tr;
}

function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fillTable(id, rows, emptyText, colSpan) {
  const tbody = $(id);
  tbody.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = cell(emptyText);
    td.colSpan = colSpan;
    td.className = 'muted';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const tr of rows) tbody.appendChild(tr);
}

function card(label, value) {
  const box = document.createElement('div');
  box.className = 'card';
  const b = document.createElement('b');
  b.textContent = String(value);
  const s = document.createElement('span');
  s.textContent = label;
  box.appendChild(b);
  box.appendChild(s);
  return box;
}

function render(summary) {
  // Server
  const cards = $('server-cards');
  cards.textContent = '';
  const up = summary.server.uptimeSec || 0;
  cards.appendChild(card('version', summary.server.version));
  cards.appendChild(card('uptime, min', Math.round(up / 60)));
  cards.appendChild(card('online', summary.online.length));
  cards.appendChild(card('rooms', summary.rooms.length));
  cards.appendChild(card('pilots registered', summary.pilots.length));
  cards.appendChild(card('races stored', summary.results.total));

  // Online
  fillTable(
    'online-body',
    summary.online.map((p) =>
      row([
        p.name,
        p.playerId,
        p.connections,
        p.roomName || 'in lobby',
        p.roomPhase || '—',
        p.ready ? 'yes' : 'no',
        p.finished ? 'finished' : '—',
      ])
    ),
    'Nobody is online',
    7
  );

  // Rooms
  fillTable(
    'rooms-body',
    summary.rooms.map((r) =>
      row([
        `${r.name} (${r.players.length}/${r.maxPlayers})`,
        r.hostName || '—',
        r.players.map((p) => `${p.name}${p.isHost ? '*' : ''}${p.connected ? '' : ' (off)'}`).join(', '),
        r.settings.track,
        r.settings.laps,
        r.settings.bots,
        r.locked ? '🔒' : '—',
        r.phase,
        r.chatMessages,
      ])
    ),
    'No rooms',
    9
  );

  // Pilots
  fillTable(
    'pilots-body',
    summary.pilots.map((p) => row([p.name, shortTime(p.createdAt), shortTime(p.lastSeenAt), p.logins, p.source])),
    'Registry is empty',
    5
  );

  // Results
  const res = $('results-cards');
  res.textContent = '';
  const byMode = summary.results.byMode || {};
  res.appendChild(card('total', summary.results.total));
  res.appendChild(card('training', byMode.training || 0));
  res.appendChild(card('vs bots', (byMode.bots || 0) + (byMode.legacy || 0)));
  res.appendChild(card('multiplayer', byMode.multiplayer || 0));
  for (const [track, count] of Object.entries(summary.results.tracks || {})) {
    res.appendChild(card(`track ${track}`, count));
  }

  $('updated-at').textContent = `updated ${new Date(summary.t).toLocaleTimeString()}`;
}

async function fetchSummary() {
  const res = await fetch('/api/admin/summary', { headers: { 'x-admin-key': adminKey } });
  if (res.status === 401) {
    const err = new Error('admin_key_required');
    err.code = 'bad_key';
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const summary = await fetchSummary();
    render(summary);
    setStatus(`Connected · online ${summary.online.length} · rooms ${summary.rooms.length}`, false);
  } catch (err) {
    if (err.code === 'bad_key') {
      setStatus('Wrong admin key.', true);
      stopAuto();
      return;
    }
    setStatus(`The server did not respond: ${err.message}`, true);
  }
}

function startAuto() {
  stopAuto();
  timer = setInterval(refresh, REFRESH_MS);
}

function stopAuto() {
  if (timer) clearInterval(timer);
  timer = 0;
}

function connect() {
  const value = $('admin-key').value.trim();
  if (!value) {
    setStatus('Enter the admin key.', true);
    return;
  }
  adminKey = value;
  try {
    sessionStorage.setItem(KEY_STORAGE, adminKey);
  } catch {
    /* private mode — just do not remember it */
  }
  setStatus('Loading…', false);
  refresh().then(startAuto);
}

$('btn-connect').addEventListener('click', connect);
$('btn-refresh').addEventListener('click', () => refresh());
$('admin-key').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});

try {
  const saved = sessionStorage.getItem(KEY_STORAGE);
  if (saved) {
    $('admin-key').value = saved;
    connect();
  }
} catch {
  /* no sessionStorage access — stay on manual entry */
}
