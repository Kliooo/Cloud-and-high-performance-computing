"""Consumer: computes jobs, logs results, and rejects anything it cannot compute.

Delivery is manual (`auto_ack=False`), so a message is acknowledged only after the result
has been written to the log. A failure is rejected with `requeue=False`: the broker sends
it through `calc.dlx` to `calc.jobs.dlq` instead of handing the same broken job back to us
in an endless loop.
"""

from __future__ import annotations

import json
import logging
import signal
import threading
import time

import pika

from .broker import close_quietly, connect, open_channel
from .config import Settings
from .health import HealthServer, State
from .jobs import InvalidMessage, Job, parse_job
from .logs import configure
from .operations import OperationError, calculate
from .topology import declare_topology

log = logging.getLogger("consumer")


class Consumer:
    """Message handling, separated from the connection so it can be tested directly."""

    def __init__(
        self,
        channel: pika.adapters.blocking_connection.BlockingChannel,
        settings: Settings,
        state: State,
    ) -> None:
        self.channel = channel
        self.settings = settings
        self.state = state

    def on_message(self, channel, method, properties, body: bytes) -> None:
        started = time.perf_counter()
        job: Job | None = None

        try:
            job = parse_job(body)
            result = calculate(job.operation, job.operands)
        except (InvalidMessage, OperationError) as exc:
            self._reject(method, body, job=job, reason=str(exc), reason_type=exc.__class__.__name__)
            return
        except Exception as exc:  # noqa: BLE001 — a bug must not become an infinite redelivery
            log.exception("unexpected error while handling a job")
            self._reject(method, body, job=job, reason=f"{exc.__class__.__name__}: {exc}", reason_type="unexpected")
            return

        # The callback receives the channel it was registered on; using self.channel keeps the
        # success and the failure paths symmetrical (and testable with the same fake).
        self.channel.basic_ack(delivery_tag=method.delivery_tag)
        self.state.count("processed")
        log.info(
            json.dumps(
                {
                    "event": "result",
                    "id": job.job_id,
                    "op": job.operation,
                    "operands": list(job.operands),
                    "result": result,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                }
            )
        )

    def _reject(self, method, body: bytes, *, job: Job | None, reason: str, reason_type: str) -> None:
        self.state.count("dead_lettered")
        log.warning(
            json.dumps(
                {
                    "event": "rejected",
                    # The id survives the failure whenever the envelope could be parsed,
                    # so a rejected job can be traced back to the producer line.
                    "id": job.job_id if job else None,
                    "delivery_tag": method.delivery_tag,
                    "routing_key": getattr(method, "routing_key", ""),
                    "reason_type": reason_type,
                    "reason": reason,
                    "body": body.decode("utf-8", "replace")[:200],
                    "next": self.settings.dead_letter_queue,
                }
            )
        )
        # requeue=False is what makes the broker dead-letter the message.
        self.channel.basic_reject(delivery_tag=method.delivery_tag, requeue=False)


def main() -> int:
    settings = Settings.from_env()
    configure(settings.log_level)

    state = State(role="consumer")
    health = HealthServer(state, settings.health_port)
    health.start()

    stop_event = threading.Event()
    connection: pika.BlockingConnection | None = None
    channel = None

    try:
        connection = connect(settings, stop_event)
        channel = open_channel(connection)
        # Bounded prefetch: a worker takes at most N unacknowledged messages at a time,
        # which keeps the load even when several consumers share one queue.
        channel.basic_qos(prefetch_count=settings.prefetch)
        declare_topology(channel, settings)

        consumer = Consumer(channel, settings, state)
        channel.basic_consume(
            queue=settings.queue,
            on_message_callback=consumer.on_message,
            auto_ack=False,
        )

        _install_signal_handlers(stop_event, connection, channel)
        state.connected = True
        state.ready = True
        log.info("consuming from %s with prefetch=%s", settings.queue, settings.prefetch)

        # Blocks until the queue is cancelled or the connection dies; pika runs the I/O loop.
        channel.start_consuming()
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
        if channel is not None and channel.is_open:
            channel.close()
        close_quietly(connection)
        health.stop()

    counters = state.snapshot()["counters"]
    log.info("stopped: %s processed, %s dead-lettered", counters.get("processed", 0), counters.get("dead_lettered", 0))
    return 0


def _install_signal_handlers(stop_event, connection, channel) -> None:
    """SIGTERM must not kill a message halfway: stop consuming, then close in main()."""

    def handler(signum, _frame):
        log.info("signal %s received, stopping the consumer", signum)
        stop_event.set()
        try:
            if connection.is_open and channel.is_open:
                # The I/O loop owns the channel: touching it from this thread is unsafe.
                connection.add_callback_threadsafe(channel.stop_consuming)
        except Exception:  # noqa: BLE001 — shutdown must not raise
            log.debug("could not stop consuming gracefully", exc_info=True)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
