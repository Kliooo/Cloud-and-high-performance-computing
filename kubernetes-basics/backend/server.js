'use strict';

/**
 * Demo backend for the "Kubernetes basics" assignment.
 *
 * Zero runtime dependencies: only Node.js built-ins.
 *
 * Endpoints
 *   GET /api/ping            identity of the pod that served the request
 *   GET /api/work?n=&repeat= CPU-bound work, used to trigger the HPA
 *   GET /api/stats           in-memory counters of this replica
 *   GET /healthz             liveness probe
 *   GET /readyz              readiness probe
 */

const http = require('node:http');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const POD_NAME = process.env.POD_NAME || os.hostname();
const NODE_NAME = process.env.NODE_NAME || 'unknown';
const VERSION = process.env.APP_VERSION || 'dev';

const MIN_WORK = 1_000;
const MAX_WORK_CEILING = 50_000_000;
const MAX_WORK = clamp(Number(process.env.MAX_WORK_LIMIT) || 5_000_000, MIN_WORK, MAX_WORK_CEILING);
const READY_DELAY_MS = clamp(Number(process.env.READY_DELAY_MS) || 0, 0, 60_000);
const STARTED_AT = Date.now();

const stats = {
  requests: 0,
  workRequests: 0,
  errors: 0,
  totalMs: 0,
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function countPrimes(limit) {
  if (limit < 2) return 0;
  const sieve = new Uint8Array(limit + 1);
  let count = 0;
  for (let i = 2; i <= limit; i += 1) {
    if (sieve[i] === 1) continue;
    count += 1;
    for (let j = i * i; j <= limit; j += i) sieve[j] = 1;
  }
  return count;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function identity() {
  return {
    pod: POD_NAME,
    node: NODE_NAME,
    version: VERSION,
    pid: process.pid,
  };
}

const server = http.createServer((req, res) => {
  const startedAtNs = process.hrtime.bigint();
  let url;

  res.setHeader('X-Pod-Name', POD_NAME);
  res.setHeader('X-Node-Name', NODE_NAME);

  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
    stats.requests += 1;
    stats.totalMs += durationMs;
    if (res.statusCode >= 500) stats.errors += 1;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        pod: POD_NAME,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      }),
    );
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/ping') {
    sendJson(res, 200, {
      ...identity(),
      requestId: randomUUID(),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      requestsServed: stats.requests,
    });
    return;
  }

  if (path === '/api/work') {
    const limit = clamp(Number(url.searchParams.get('n') ?? 1_000_000), MIN_WORK, MAX_WORK);
    const repeat = clamp(Number(url.searchParams.get('repeat') ?? 1), 1, 25);

    const workStartedAtNs = process.hrtime.bigint();
    let primes = 0;
    for (let i = 0; i < repeat; i += 1) primes = countPrimes(limit);
    const computeMs = Number(process.hrtime.bigint() - workStartedAtNs) / 1e6;

    stats.workRequests += repeat;
    sendJson(res, 200, {
      ...identity(),
      limit,
      repeat,
      primes,
      computeMs: Math.round(computeMs * 10) / 10,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (path === '/api/stats') {
    sendJson(res, 200, {
      ...identity(),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      requests: stats.requests,
      workRequests: stats.workRequests,
      errors: stats.errors,
      averageMs: stats.requests === 0 ? 0 : Math.round((stats.totalMs / stats.requests) * 10) / 10,
    });
    return;
  }

  if (path === '/healthz') {
    sendText(res, 200, 'ok\n');
    return;
  }

  if (path === '/readyz') {
    // A replica is ready as soon as the HTTP server accepts connections. READY_DELAY_MS
    // exists to demonstrate the readiness gate: set it to a few seconds to see the pod
    // stay out of the Service endpoints until it has warmed up.
    const ready = Date.now() - STARTED_AT >= READY_DELAY_MS;
    sendText(res, ready ? 200 : 503, ready ? 'ready\n' : 'starting\n');
    return;
  }

  if (path === '/') {
    sendJson(res, 200, {
      service: 'k8s-demo-backend',
      ...identity(),
      endpoints: ['/api/ping', '/api/work?n=1000000', '/api/stats', '/healthz', '/readyz'],
    });
    return;
  }

  sendJson(res, 404, { error: 'not found', path });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal, pod: POD_NAME }));
  server.close(() => process.exit(0));
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  // Hard stop for in-flight connections; keeps rolling updates predictable.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ event: 'listening', pod: POD_NAME, node: NODE_NAME, port: PORT, version: VERSION }));
});
