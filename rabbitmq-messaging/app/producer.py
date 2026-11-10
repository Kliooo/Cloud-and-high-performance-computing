"""Producer: periodically publishes calculation jobs to the topic exchange.

Every job is published with its own routing key (`calc.<op>`), so the broker — not the
producer — decides which queue receives it. Every `POISON_EVERY`-th message is a deliberate
failure: without them the dead-letter queue would never get anything to show.
"""

from __future__ import annotations

import json
import logging
import random
import signal
import threading
import time

import pika

from .broker import close_quietly, connect, open_channel
from .config import Settings
from .health import HealthServer, State
from .jobs import Job, new_job, poison_job
from .logs import configure
from .operations import supported_operations
from .topology import declare_topology, routing_key

log = logging.getLogger("producer")


def build_properties(job: Job) -> pika.BasicProperties:
    """Persistent, typed, identifiable — everything the consumer needs for tracing."""
    return pika.BasicProperties(
        delivery_mode=2,  # 2 = persistent: the message survives a broker restart
        content_type="application/json",
        message_id=job.job_id,
        type=job.operation,
        app_id="calc-producer",
        timestamp=int(time.time()),
    )


def publish_job(channel: pika.adapters.blocking_connection.BlockingChannel, settings: Settings, job: Job) -> bool:
    """Publish one job. Returns False when the broker could not route it."""
    try:
        confirmed = channel.basic_publish(
            exchange=settings.exchange,
            routing_key=routing_key(job.operation),
            body=job.to_bytes(),
            properties=build_properties(job),
            # mandatory: an unroutable message comes back instead of being dropped silently.
            mandatory=True,
        )
    except pika.exceptions.UnroutableError:
        log.error(
            json.dumps(
                {
                    "event": "unroutable",
                    "id": job.job_id,
                    "op": job.operation,
                    "routing_key": routing_key(job.operation),
                    "reason": "no queue is bound to this routing key",
                }
            )
        )
        return False

    # publisher confirms are enabled, so basic_publish returns True/False for the ack.
    return confirmed is not False


def next_job(settings: Settings, index: int, rng: random.Random) -> Job:
    """Every `POISON_EVERY`-th job is invalid on purpose, cycling through the failure modes."""
    if settings.poison_every > 0 and (index + 1) % settings.poison_every == 0:
        return poison_job(kind=index // settings.poison_every)
    return new_job(rng=rng)


def publish_loop(
    connection: pika.BlockingConnection,
    channel: pika.adapters.blocking_connection.BlockingChannel,
    settings: Settings,
    state: State,
    stop_event: threading.Event,
) -> None:
    rng = random.Random()
    index = 0

    while not stop_event.is_set():
        job = next_job(settings, index, rng)
        index += 1

        if publish_job(channel, settings, job):
            state.count("published")
            log.info(
                json.dumps(
                    {
                        "event": "published",
                        "id": job.job_id,
                        "op": job.operation,
                        "operands": list(job.operands),
                        "routing_key": routing_key(job.operation),
                    }
                )
            )
        else:
            state.count("unroutable")

        # Wait for the next tick, but keep the connection's heartbeat running:
        # a bare time.sleep() would starve the I/O loop and the broker would drop us.
        deadline = time.monotonic() + settings.interval
        while not stop_event.is_set() and time.monotonic() < deadline:
            connection.process_data_events(time_limit=0.2)

    log.info("stopping: %s jobs published", state.snapshot()["counters"].get("published", 0))


def main() -> int:
    settings = Settings.from_env()
    configure(settings.log_level)

    state = State(role="producer")
    health = HealthServer(state, settings.health_port)
    health.start()

    stop_event = threading.Event()
    _install_signal_handlers(stop_event)
    connection: pika.BlockingConnection | None = None

    log.info("operations: %s", ", ".join(supported_operations()))

    try:
        connection = connect(settings, stop_event)
        channel = open_channel(connection)
        declare_topology(channel, settings)
        channel.confirm_delivery()

        state.connected = True
        state.ready = True
        log.info("publishing every %.1fs; every %s-th job is invalid", settings.interval, settings.poison_every)

        publish_loop(connection, channel, settings, state, stop_event)
    except KeyboardInterrupt:
        log.info("interrupted")
    except (pika.exceptions.AMQPError, OSError) as exc:
        # No reconnect loop on purpose: Docker (restart: unless-stopped) or the kubelet
        # restarts the process, and the unacknowledged message returns to the queue.
        log.error("connection to the broker was lost: %s", exc)
        return 1
    finally:
        state.ready = False
        state.connected = False
        close_quietly(connection)
        health.stop()

    return 0


def _install_signal_handlers(stop_event: threading.Event) -> None:
    def handler(signum, _frame):
        log.info("signal %s received, shutting down", signum)
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
