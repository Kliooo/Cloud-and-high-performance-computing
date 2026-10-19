'use strict';

/* Demo UI: talks to the backend only through the frontend's /api proxy. */

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  frontendPod: document.getElementById('frontendPod'),
  podCount: document.getElementById('podCount'),
  reqCount: document.getElementById('reqCount'),
  p95: document.getElementById('p95'),
  bars: document.getElementById('bars'),
  logBody: document.getElementById('logBody'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  loadBtn: document.getElementById('loadBtn'),
  resetBtn: document.getElementById('resetBtn'),
  autoToggle: document.getElementById('autoToggle'),
  buildInfo: document.getElementById('buildInfo'),
};

const state = {
  perPod: new Map(),
  latencies: [],
  sent: 0,
  failed: 0,
  frontendPod: null,
  version: null,
  busy: false,
  autoTimer: null,
  loadController: null,
  hideProgressTimer: null,
};

const LOAD_SECONDS = 30;
const LOG_LIMIT = 8;

function setStatus(kind, text) {
  els.status.dataset.state = kind;
  els.statusText.textContent = text;
}

function showProgress(ratio, text) {
  els.progress.hidden = false;
  els.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  els.progressText.textContent = text;
}

function hideProgressSoon() {
  clearTimeout(state.hideProgressTimer);
  state.hideProgressTimer = setTimeout(() => {
    els.progress.hidden = true;
  }, 1600);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('[data-send]').forEach((button) => {
    button.disabled = busy;
  });
  els.resetBtn.disabled = busy;
}

async function pingOnce(signal) {
  const startedAt = performance.now();
  const response = await fetch('api/ping', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  const ms = performance.now() - startedAt;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  data.ms = ms;
  data.frontendPod = response.headers.get('x-frontend-pod');
  return data;
}

function addRow(data) {
  const empty = els.logBody.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('tr');
  row.className = 'flash';

  const time = document.createElement('td');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });

  const pod = document.createElement('td');
  pod.className = 'pod';
  pod.textContent = data.pod;
  pod.title = data.pod;

  const node = document.createElement('td');
  node.className = 'node';
  node.textContent = data.node;

  const ms = document.createElement('td');
  ms.className = 'num';
  ms.textContent = data.ms.toFixed(1);

  row.append(time, pod, node, ms);
  els.logBody.prepend(row);

  const rows = els.logBody.querySelectorAll('tr');
  for (let i = LOG_LIMIT; i < rows.length; i += 1) rows[i].remove();
}

function renderFacts() {
  els.frontendPod.textContent = state.frontendPod || '—';
  els.podCount.textContent = String(state.perPod.size);
  els.reqCount.textContent = state.sent.toLocaleString('en-US');

  const p95 = percentile(state.latencies, 95);
  els.p95.textContent = p95 === null ? '—' : `${p95.toFixed(0)} ms`;
  els.buildInfo.textContent = state.version ? `backend v${state.version}` : 'backend';
}

function renderBars() {
  const entries = [...state.perPod.entries()].sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    els.bars.innerHTML = '<li class="empty">No requests yet.</li>';
    return;
  }

  const max = entries[0][1].count;
  const fragment = document.createDocumentFragment();

  entries.forEach(([pod, info]) => {
    const item = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'bar-head';

    const name = document.createElement('span');
    name.className = 'bar-name';
    name.textContent = pod;
    name.title = pod;

    const node = document.createElement('span');
    node.className = 'bar-node';
    node.textContent = info.node;

    const count = document.createElement('span');
    count.className = 'bar-count';
    count.textContent = String(info.count);

    const left = document.createElement('div');
    left.className = 'bar-meta';
    left.append(name, node);
    head.append(left, count);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.round((info.count / max) * 100)}%`;
    track.append(fill);

    item.append(head, track);
    fragment.append(item);
  });

  els.bars.replaceChildren(fragment);
}

function record(data) {
  state.sent += 1;
  state.latencies.push(data.ms);
  if (state.latencies.length > 500) state.latencies.shift();

  if (data.frontendPod) state.frontendPod = data.frontendPod;
  if (data.version) state.version = data.version;

  const entry = state.perPod.get(data.pod) || { count: 0, node: data.node };
  entry.count += 1;
  entry.node = data.node;
  state.perPod.set(data.pod, entry);

  addRow(data);
  renderFacts();
  renderBars();
}

function recordFailure() {
  state.failed += 1;
}

async function sendBurst(count) {
  if (state.busy) return;
  setBusy(true);
  setStatus('ok', 'sending requests…');
  showProgress(0, `0 / ${count}`);

  const batchSize = 5;
  let done = 0;

  try {
    while (done < count) {
      const size = Math.min(batchSize, count - done);
      const results = await Promise.allSettled(
        Array.from({ length: size }, () => pingOnce()),
      );

      results.forEach((result) => {
        if (result.status === 'fulfilled') record(result.value);
        else recordFailure();
      });

      done += size;
      showProgress(done / count, `${done} / ${count}`);
    }

    if (state.failed > 0) {
      setStatus('error', `${count} sent · ${state.failed} failed`);
    } else {
      setStatus('ok', `${count} requests answered`);
    }
  } catch (error) {
    setStatus('error', 'backend unreachable');
  } finally {
    setBusy(false);
    // The pill already says how many requests were answered; an empty progress
    // track afterwards only adds noise.
    els.progress.hidden = true;
  }
}

function stopLoad() {
  if (!state.loadController) return;
  state.loadController.abort();
  state.loadController = null;
  els.loadBtn.textContent = 'Load CPU · 30 s';
  els.loadBtn.classList.remove('running');
}

async function startLoad() {
  if (state.loadController) {
    stopLoad();
    setStatus('ok', 'load stopped');
    return;
  }

  const controller = new AbortController();
  state.loadController = controller;
  const deadline = Date.now() + LOAD_SECONDS * 1000;
  let requests = 0;

  els.loadBtn.textContent = 'Stop load';
  setStatus('ok', 'CPU load in progress…');
  showProgress(0, '0 requests');

  const worker = async () => {
    while (Date.now() < deadline && !controller.signal.aborted) {
      try {
        const response = await fetch('api/work?n=1500000', {
          cache: 'no-store',
          signal: controller.signal,
        });
        await response.arrayBuffer();
        requests += 1;
      } catch (error) {
        if (controller.signal.aborted) return;
      }
    }
  };

  const ticker = setInterval(() => {
    const left = Math.max(0, deadline - Date.now());
    showProgress(1 - left / (LOAD_SECONDS * 1000), `${requests} CPU requests · ${Math.ceil(left / 1000)} s left`);
  }, 500);

  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    clearInterval(ticker);
    if (state.loadController === controller) {
      state.loadController = null;
      els.loadBtn.textContent = 'Load CPU · 30 s';
      setStatus('ok', `CPU load finished · ${requests} requests`);
      hideProgressSoon();
    }
  }
}

function resetAll() {
  stopLoad();
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  els.autoToggle.checked = false;

  state.perPod.clear();
  state.latencies.length = 0;
  state.sent = 0;
  state.failed = 0;
  state.frontendPod = null;

  els.logBody.innerHTML = '<tr class="empty"><td colspan="4">Waiting for traffic…</td></tr>';
  renderFacts();
  renderBars();
  hideProgressSoon();
  setStatus('pending', 'checking backend…');
  bootstrap();
}

async function bootstrap() {
  try {
    const data = await pingOnce();
    // The page-load health check is not counted as traffic: the counters must
    // match what the buttons actually sent.
    state.frontendPod = data.frontendPod || state.frontendPod;
    state.version = data.version || state.version;
    renderFacts();
    setStatus('ok', `backend ${data.version} · ${data.pod}`);
  } catch (error) {
    setStatus('error', 'backend unreachable — check pods');
  }
}

document.querySelectorAll('[data-send]').forEach((button) => {
  button.addEventListener('click', () => sendBurst(Number(button.dataset.send)));
});

els.loadBtn.addEventListener('click', startLoad);
els.resetBtn.addEventListener('click', resetAll);

els.autoToggle.addEventListener('change', () => {
  clearInterval(state.autoTimer);
  state.autoTimer = null;

  if (!els.autoToggle.checked) return;

  state.autoTimer = setInterval(async () => {
    if (state.busy || state.loadController) return;
    try {
      record(await pingOnce());
      setStatus('ok', 'auto ping running');
    } catch (error) {
      setStatus('error', 'backend unreachable — check pods');
    }
  }, 2000);
});

async function start() {
  await bootstrap();

  // Demo helper: /k8s-demo/?burst=12 preloads the page with traffic, which is
  // handy for screenshots and for a quick load-balancing check.
  const burst = Number(new URLSearchParams(window.location.search).get('burst'));
  if (Number.isFinite(burst) && burst > 0) {
    await sendBurst(Math.min(Math.trunc(burst), 200));
  }
}

start();
