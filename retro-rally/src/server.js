'use strict';

// retro-rally — static hosting + leaderboard API + multiplayer lobby. No npm dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMultiplayer } = require('./lib/multiplayer');
const { createRegistry } = require('./lib/registry');
const { createAdmin } = require('./lib/admin');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(ROOT, 'data', 'results.json');

const MAX_BODY_BYTES = 100 * 1024;
const MAX_TOP = 25;
const LAP_MIN_MS = 5000;
const LAP_MAX_MS = 1200000;
const APP_VERSION = '0.5.6';
const PILOTS_FILE = process.env.PILOTS_FILE
  ? path.resolve(process.env.PILOTS_FILE)
  : path.join(path.dirname(DATA_FILE), 'pilots.json');
// Admin key: ADMIN_KEY from the environment, otherwise generated and kept in a file
// (otherwise the generated key would only ever be visible in the server log).
const ADMIN_KEY_FILE = path.join(path.dirname(DATA_FILE), 'admin-key.txt');

function resolveAdminKey() {
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.trim()) return process.env.ADMIN_KEY.trim();
  try {
    const saved = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* no file yet — it is created below */
  }
  const generated = crypto.randomBytes(6).toString('hex');
  try {
    fs.mkdirSync(path.dirname(ADMIN_KEY_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_KEY_FILE, `${generated}\n`, 'utf8');
  } catch (err) {
    console.warn('[retro-rally] failed to save the admin key:', err.message);
  }
  return generated;
}
// Race modes: training, vs bots, multiplayer. Records without a mode are read as 'bots'.
const RESULT_MODES = new Set(['training', 'bots', 'multiplayer']);

function normalizeMode(mode) {
  return RESULT_MODES.has(mode) ? mode : 'bots';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------- Storage ----------

function readResults() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[retro-rally] failed to read the storage file:', err.message);
    }
    return [];
  }
}

function writeResults(list) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.results-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function sortedByBest(list) {
  return [...list].sort((a, b) => {
    if (a.bestLapMs !== b.bestLapMs) return a.bestLapMs - b.bestLapMs;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function publicRecord(rec, rank) {
  const legacy = !RESULT_MODES.has(rec.mode);
  return {
    id: rec.id,
    playerName: rec.playerName,
    track: rec.track || null,
    mode: normalizeMode(rec.mode),
    bestLapMs: rec.bestLapMs,
    lapsCount: rec.lapsCount,
    totalMs: rec.totalMs,
    createdAt: rec.createdAt,
    rank,
    ...(legacy ? { legacy: true } : {}),
  };
}

// ---------- Validation ----------

function sanitizeName(value, max) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > max) return null;
  return cleaned;
}

function validateResult(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const playerName = sanitizeName(body.playerName, 24);
  if (!playerName) return { error: 'playerName: string of 1..24 characters' };

  let carName = null;
  if (body.carName !== undefined && body.carName !== null) {
    carName = sanitizeName(body.carName, 24);
    if (!carName) return { error: 'carName: string up to 24 characters' };
  }

  // mode is optional: older clients and older records count as 'bots'
  let mode = null;
  if (body.mode !== undefined && body.mode !== null && body.mode !== '') {
    if (typeof body.mode !== 'string' || !RESULT_MODES.has(body.mode)) {
      return { error: "mode: one of 'training' | 'bots' | 'multiplayer'" };
    }
    mode = body.mode;
  }

  let track = null;
  if (body.track !== undefined && body.track !== null && body.track !== '') {
    if (typeof body.track !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(body.track)) {
      return { error: 'track: short latin slug (a-z, 0-9, dash, underscore)' };
    }
    track = body.track.toLowerCase();
  }

  if (!Array.isArray(body.laps) || body.laps.length < 1 || body.laps.length > 50) {
    return { error: 'laps: array of 1..50 lap times' };
  }
  const laps = [];
  for (const value of body.laps) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      return { error: 'laps: each lap must be an integer number of milliseconds' };
    }
    if (value < LAP_MIN_MS || value > LAP_MAX_MS) {
      return { error: `laps: lap time must be within ${LAP_MIN_MS}..${LAP_MAX_MS} ms` };
    }
    laps.push(value);
  }

  return {
    value: {
      playerName,
      carName,
      track,
      mode,
      laps,
      lapsCount: laps.length,
      bestLapMs: Math.min(...laps),
      totalMs: laps.reduce((sum, v) => sum + v, 0),
    },
  };
}

// ---------- HTTP helpers ----------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ failed: true }));
  });
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      resultsCount: readResults().length,
      storage: DATA_FILE,
    });
  }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const trackFilter = url.searchParams.get('track');
    const modeFilter = url.searchParams.get('mode');
    const all = readResults();
    const counts = {};
    const modeCounts = { training: 0, bots: 0, multiplayer: 0, legacy: 0 };
    for (const rec of all) {
      const key = rec.track || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      modeCounts[normalizeMode(rec.mode)] += 1;
      if (!RESULT_MODES.has(rec.mode)) modeCounts.legacy += 1;
    }
    let filtered = all;
    if (trackFilter && trackFilter !== 'all') filtered = filtered.filter((rec) => rec.track === trackFilter);
    if (modeFilter && modeFilter !== 'all') {
      // 'bots' also covers legacy records with no mode — those were vs-bots races too
      filtered = filtered.filter((rec) => normalizeMode(rec.mode) === modeFilter);
    }
    const list = sortedByBest(filtered);
    return sendJson(res, 200, {
      total: list.length,
      totalAll: all.length,
      track: trackFilter || 'all',
      mode: modeFilter || 'all',
      counts,
      modeCounts,
      items: list.slice(0, MAX_TOP).map((rec, index) => publicRecord(rec, index + 1)),
    });
  }

  if (pathname === '/api/results' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.tooLarge) return sendJson(res, 413, { error: 'Request body is too large' });
    if (body.failed || typeof body.raw !== 'string') {
      return sendJson(res, 400, { error: 'Failed to read request body' });
    }

    let parsed;
    try {
      parsed = JSON.parse(body.raw || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Malformed JSON' });
    }

    const { error, value } = validateResult(parsed);
    if (error) return sendJson(res, 400, { error });

    const record = {
      id: crypto.randomUUID(),
      playerName: value.playerName,
      mode: value.mode || undefined, // older clients omit it — reported as bots
      track: value.track || null,
      bestLapMs: value.bestLapMs,
      lapsCount: value.lapsCount,
      totalMs: value.totalMs,
      laps: value.laps,
      createdAt: new Date().toISOString(),
    };

    let rank = null;
    let total = 0;
    try {
      const list = readResults();
      list.push(record);
      writeResults(list);
      const sorted = sortedByBest(list);
      total = sorted.length;
      rank = sorted.findIndex((item) => item.id === record.id) + 1;
    } catch (err) {
      console.error('[retro-rally] failed to store the result:', err.message);
      return sendJson(res, 500, { error: 'Failed to save the result' });
    }

    return sendJson(res, 201, {
      saved: publicRecord(record, rank),
      rank,
      total,
    });
  }

  return sendJson(res, 404, { error: 'Unknown API method' });
}

// ---------- Static ----------

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  let relative = pathname === '/' ? '/index.html' : pathname;
  relative = relative.replace(/\\/g, '/');
  const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendText(
      res,
      404,
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>404 — RETRO RALLY</title>' +
        '<body style="background:#F7EBD3;color:#2B2118;font-family:Arial Black,Segoe UI,sans-serif;padding:48px">' +
        '<h1>404 — not found</h1><p>Check the URL. Game: <a href="/">/</a>, API: <a href="/api/health">/api/health</a></p></body></html>',
      'text/html; charset=utf-8'
    );
  }

  if (stat.isDirectory()) {
    const indexPath = path.join(filePath, 'index.html');
    try {
      stat = fs.statSync(indexPath);
      return streamFile(res, indexPath, stat);
    } catch {
      return sendText(res, 404, 'Not Found');
    }
  }

  return streamFile(res, filePath, stat);
}

function streamFile(res, filePath, stat) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- Multiplayer: storage integration ----------

// The server writes multiplayer finishes itself: clients only send lap times,
// and the shared leaderboard write happens at the end of the race.
function storeMultiplayerResults(records) {
  const list = readResults();
  const saved = [];
  for (const rec of records || []) {
    const { error, value } = validateResult({ playerName: rec.playerName, track: rec.track, laps: rec.laps });
    if (error) {
      console.warn(`[retro-rally] mp result rejected (${rec.playerName}): ${error}`);
      continue;
    }
    const record = {
      id: crypto.randomUUID(),
      playerName: value.playerName,
      mode: 'multiplayer',
      track: value.track || null,
      bestLapMs: value.bestLapMs,
      lapsCount: value.lapsCount,
      totalMs: value.totalMs,
      laps: value.laps,
      createdAt: new Date().toISOString(),
    };
    list.push(record);
    saved.push({ playerName: record.playerName, id: record.id, rank: null, total: 0 });
  }
  if (saved.length) {
    writeResults(list);
    const sorted = sortedByBest(list);
    for (const item of saved) {
      item.rank = sorted.findIndex((i) => i.id === item.id) + 1;
      item.total = sorted.length;
    }
  }
  return saved;
}

function resultsInfo() {
  const list = readResults();
  const byMode = { training: 0, bots: 0, multiplayer: 0, legacy: 0 };
  const tracks = {};
  for (const rec of list) {
    byMode[normalizeMode(rec.mode)] += 1;
    if (!RESULT_MODES.has(rec.mode)) byMode.legacy += 1;
    const key = rec.track || 'unknown';
    tracks[key] = (tracks[key] || 0) + 1;
  }
  return { total: list.length, byMode, tracks };
}

const multiplayer = createMultiplayer({
  sendJson,
  readBody,
  saveResults: storeMultiplayerResults,
  log: (line) => console.log(line),
});

// Pilot registry and admin API (key from ADMIN_KEY, or generated on start)
const registry = createRegistry({
  file: PILOTS_FILE,
  log: (line) => console.log(line),
});

const admin = createAdmin({
  key: resolveAdminKey(),
  registry,
  multiplayer,
  resultsInfo,
  storageFile: DATA_FILE,
  version: APP_VERSION,
  log: (line) => console.log(line),
});

// ---------- Pilots ----------

async function handlePilotApi(req, res, pathname) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });

  const body = await readBody(req);
  if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'Request body is too large' });
  if (body.failed || typeof body.raw !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Failed to read request body' });
  }
  let parsed;
  try {
    parsed = JSON.parse(body.raw || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Malformed JSON' });
  }

  let result;
  if (pathname === '/api/pilot/register') result = registry.register(parsed);
  else if (pathname === '/api/pilot/login') {
    result = registry.login({ ...parsed, allowImport: parsed.allowImport === true });
  } else if (pathname === '/api/pilot/seen') result = registry.seen(parsed.name, parsed.hash);
  else return sendJson(res, 404, { ok: false, error: 'Unknown pilot method' });

  const status = result.status || (result.error ? 400 : 200);
  return sendJson(res, status, result);
}

// ---------- Startup ----------

const server = http.createServer((req, res) => {
  let url;
  let pathname = '/';
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  if (pathname.startsWith('/api/pilot/')) {
    handlePilotApi(req, res, pathname).catch((err) => {
      console.error('[retro-rally] pilot registry error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
    return;
  }

  if (pathname === '/api/admin/summary') {
    admin
      .handleApi(req, res, pathname, url, sendJson)
      .catch((err) => {
        console.error('[retro-rally] admin API error:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      });
    return;
  }

  if (pathname.startsWith('/api/mp/')) {
    multiplayer
      .handleApi(req, res, pathname, url)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { ok: false, error: 'Unknown multiplayer method' });
      })
      .catch((err) => {
        console.error('[retro-rally] multiplayer error:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error('[retro-rally] API error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[retro-rally] listening on http://${HOST}:${PORT}`);
  console.log(`[retro-rally] static: ${PUBLIC_DIR}`);
  console.log(`[retro-rally] storage: ${DATA_FILE}`);
  console.log(`[retro-rally] pilots: ${PILOTS_FILE}`);
  console.log('[retro-rally] multiplayer: /api/mp/events (SSE), /api/mp/action, /api/mp/rooms');
  console.log(`[retro-rally] admin: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/admin.html`);
  console.log(`[retro-rally] admin key: ${admin.key}${process.env.ADMIN_KEY ? ' (from ADMIN_KEY)' : ` (in file ${ADMIN_KEY_FILE})`}`);
});
