// mp-client.js — lobby transport: EventSource (SSE) for receive + POST actions for send.
// Self-contained client with no external dependencies; the UI lives in mp-screen.js.

import { mpAction, mpEventsUrl } from './api.js';

const PING_INTERVAL_MS = 10000;

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'mp_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The player id lives in sessionStorage: a reload keeps the identity (so the
// room can be rejoined), but a second tab is a different player.
function loadPlayerId() {
  let id = null;
  try {
    id = sessionStorage.getItem('retro-rally:mp-id');
  } catch {
    id = null;
  }
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = randomId();
    try {
      sessionStorage.setItem('retro-rally:mp-id', id);
    } catch {
      /* private mode — play with a temporary id */
    }
  }
  return id;
}

export class MpClient {
  constructor({ name, onEvent, onStatus }) {
    this.playerId = loadPlayerId();
    this.name = name || 'Racer';
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.es = null;
    this.status = 'offline';
    this.offsetMs = 0; // serverTime - localTime
    this.latencyMs = null;
    this.pingTimer = 0;
    this.closedByUs = false;
  }

  // ---------- Connection ----------

  connect() {
    if (this.es) return;
    this.closedByUs = false;
    this._setStatus('connecting');
    const es = new EventSource(mpEventsUrl(this.playerId, this.name));
    this.es = es;

    // every server event gets one handler: mp-screen.js does the parsing
    const names = [
      'hello',
      'rooms',
      'room',
      'chat',
      'race_start',
      'peer',
      'results',
      'finished',
      'phase',
      'kicked',
      'room_closed',
      'error',
    ];
    for (const event of names) {
      es.addEventListener(event, (e) => {
        let data = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          data = null;
        }
        this._syncClock(data);
        this.onEvent(event, data);
      });
    }

    es.onopen = () => {
      this._setStatus('online');
      this._startPing();
    };
    es.onerror = () => {
      // EventSource reconnects on its own; only report a permanent close
      this._setStatus(es.readyState === 2 ? 'offline' : 'reconnecting');
    };

    this.helloPromise = null;
  }

  disconnect() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this._setStatus('offline');
  }

  // ---------- Actions ----------

  async action(action, payload = {}) {
    return mpAction(this.playerId, action, payload);
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status, { latencyMs: this.latencyMs, playerId: this.playerId });
  }

  // ---------- Clock and latency ----------

  // The server stamps every event with its time — that gives the clock offset.
  _syncClock(data) {
    if (!data || typeof data.t !== 'number') return;
    const offset = data.t - Date.now();
    this.offsetMs = this.offsetMs === 0 ? offset : this.offsetMs * 0.7 + offset * 0.3;
  }

  serverNow() {
    return Date.now() + this.offsetMs;
  }

  // Milliseconds left until a server timestamp (used to start off startAt).
  msUntil(serverTimeMs) {
    return Math.max(0, serverTimeMs - this.serverNow());
  }

  _startPing() {
    clearInterval(this.pingTimer);
    const ping = async () => {
      const sent = Date.now();
      try {
        const res = await this.action('ping', { echo: sent });
        const rtt = Date.now() - sent;
        this.latencyMs = rtt;
        if (res && typeof res.pong === 'number') {
          this.offsetMs = res.pong - (sent + rtt / 2);
        }
        this.onStatus(this.status, { latencyMs: rtt, playerId: this.playerId });
      } catch {
        /* the server may have blinked — the SSE status will report it */
      }
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }
}
