"""Tiny HTTP endpoint used by Docker and Kubernetes probes.

The services have no HTTP API of their own, but both need to tell the outside world
"my broker connection is alive". One thread, three routes:

    /healthz   200 when the broker connection is open, 503 otherwise (liveness)
    /readyz    200 when the service has started and is connected (readiness)
    /stats     counters as JSON — handy during the demo and in the smoke test
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger(__name__)


@dataclass
class State:
    """What the services report about themselves. Reads and writes are cheap and atomic."""

    role: str
    connected: bool = False
    ready: bool = False
    counters: dict[str, int] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def count(self, name: str, amount: int = 1) -> None:
        with self.lock:
            self.counters[name] = self.counters.get(name, 0) + amount

    def snapshot(self) -> dict:
        with self.lock:
            counters = dict(self.counters)
        return {
            "role": self.role,
            "connected": self.connected,
            "ready": self.ready,
            "uptime_seconds": round(time.time() - self.started_at, 1),
            "counters": counters,
        }


class _Handler(BaseHTTPRequestHandler):
    server_version = "calc-health/1.0"

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
        state: State = self.server.state  # type: ignore[attr-defined]
        path = self.path.split("?", 1)[0]

        if path == "/healthz":
            self._json(200 if state.connected else 503, {"status": "ok" if state.connected else "no broker"})
        elif path == "/readyz":
            ready = state.connected and state.ready
            self._json(200 if ready else 503, {"status": "ready" if ready else "not ready"})
        elif path == "/stats":
            self._json(200, state.snapshot())
        else:
            self._json(404, {"error": "not found", "paths": ["/healthz", "/readyz", "/stats"]})

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 — BaseHTTPRequestHandler API
        log.debug("health: " + fmt, *args)


class HealthServer:
    """Runs the HTTP server on a daemon thread; daemon threads never block the exit."""

    def __init__(self, state: State, port: int) -> None:
        self._server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
        self._server.state = state  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, name="health", daemon=True)
        self.port = port

    def start(self) -> None:
        self._thread.start()
        log.info("health endpoints on :%s (/healthz, /readyz, /stats)", self.port)

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
