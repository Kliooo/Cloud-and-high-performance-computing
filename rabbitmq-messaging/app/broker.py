"""Broker connection and channel helpers.

Two things matter here:

* the container may start before RabbitMQ is ready, so connecting retries with a backoff
  instead of crash-looping;
* both entry points declare the same topology — declarations are idempotent in AMQP.
"""

from __future__ import annotations

import logging
import threading

import pika

from .config import Settings

log = logging.getLogger(__name__)

INITIAL_RETRY_DELAY = 1.0
MAX_RETRY_DELAY = 30.0
HEARTBEAT_SECONDS = 30


def build_parameters(settings: Settings) -> pika.ConnectionParameters:
    return pika.ConnectionParameters(
        host=settings.host,
        port=settings.port,
        virtual_host=settings.vhost,
        credentials=pika.PlainCredentials(settings.user, settings.password),
        heartbeat=HEARTBEAT_SECONDS,
        blocked_connection_timeout=30,
        # One attempt per call: the retry loop below owns the backoff and the log messages.
        connection_attempts=1,
        retry_delay=0,
        client_properties={"connection_name": "calc-service"},
    )


def connect(settings: Settings, stop_event: threading.Event) -> pika.BlockingConnection:
    """Block until the broker accepts a connection or `stop_event` is set."""
    parameters = build_parameters(settings)
    delay = INITIAL_RETRY_DELAY

    while not stop_event.is_set():
        try:
            connection = pika.BlockingConnection(parameters)
        except (pika.exceptions.AMQPConnectionError, OSError) as exc:
            log.warning(
                "broker %s:%s is not ready yet (%s); retrying in %.0fs",
                settings.host,
                settings.port,
                exc.__class__.__name__,
                delay,
            )
            stop_event.wait(delay)
            delay = min(delay * 2, MAX_RETRY_DELAY)
            continue

        log.info("connected to %s", settings.amqp_url)
        return connection

    raise SystemExit("stopped before the broker became reachable")


def open_channel(connection: pika.BlockingConnection) -> pika.adapters.blocking_connection.BlockingChannel:
    """One channel per process: channels are not thread-safe, connections are multiplexed."""
    return connection.channel()


def close_quietly(connection: pika.BlockingConnection | None) -> None:
    if connection is None or connection.is_closed:
        return
    try:
        connection.close()
    except Exception:  # noqa: BLE001 — closing a broken connection must not mask the exit code
        log.debug("connection close failed", exc_info=True)
