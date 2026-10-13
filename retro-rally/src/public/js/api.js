// api.js — fetch wrapper with a timeout and readable errors,
// plus thin multiplayer helpers (the SSE stream lives in mp-client.js).

const TIMEOUT_MS = 5000;
// Multiplayer actions are short, but racing state bursts need headroom.
const MP_TIMEOUT_MS = 8000;

async function request(path, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `Server error (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.code = (data && data.error) || null;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Server is not responding (${Math.round(timeoutMs / 1000)} s timeout)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function getHealth() {
  return request('/api/health');
}

// track/mode: 'all' | a value; empty means no filter
export function getLeaderboard(track = 'all', mode = 'all') {
  const params = new URLSearchParams();
  if (track && track !== 'all') params.set('track', track);
  if (mode && mode !== 'all') params.set('mode', mode);
  const query = params.toString();
  return request(`/api/leaderboard${query ? `?${query}` : ''}`);
}

export function postResult(payload) {
  return request('/api/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------- Multiplayer ----------

export function mpAction(playerId, action, payload = {}) {
  return request(
    '/api/mp/action',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, action, ...payload }),
    },
    MP_TIMEOUT_MS
  );
}

export function getMpRooms() {
  return request('/api/mp/rooms');
}

export function mpEventsUrl(playerId, name) {
  const params = new URLSearchParams({ playerId, name: name || 'Pilot' });
  return `/api/mp/events?${params.toString()}`;
}
