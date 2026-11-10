"""Dead-letter queue tool: show what was rejected and why.

    python -m app.dlq                # peek at up to 10 messages, leave them in the queue
    python -m app.dlq --drain        # read them and remove them (acknowledge)
    python -m app.dlq --limit 50 --drain

RabbitMQ adds an `x-death` header to dead-lettered messages: the original queue, the
reason (`rejected`, `expired`, `maxlen`) and how many times the message was dead-lettered.
"""

from __future__ import annotations

import argparse
import json
import threading
from typing import Callable

from .broker import close_quietly, connect, open_channel
from .config import Settings
from .logs import configure
from .topology import declare_topology


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect the dead-letter queue")
    parser.add_argument("--drain", action="store_true", help="acknowledge messages instead of peeking")
    parser.add_argument("--limit", type=int, default=10, help="how many messages to read (default: 10)")
    return parser.parse_args(argv)


def death_reason(properties) -> dict:
    """The first `x-death` entry, reduced to what is interesting in a log line."""
    headers = getattr(properties, "headers", None) or {}
    deaths = headers.get("x-death") or []
    if not deaths:
        return {}
    first = deaths[0]
    return {
        "queue": first.get("queue"),
        "reason": first.get("reason"),
        "count": first.get("count"),
    }


def read_dead_letters(
    channel,
    settings: Settings,
    *,
    limit: int,
    drain: bool,
    emit: Callable[[str], None] = print,
) -> list[int]:
    """Read up to `limit` messages from the DLQ. Returns the delivery tags that were handled.

    Peeking is done by holding the messages unacknowledged until the whole batch has been
    read, and only then requeueing them: requeueing right after each `basic_get` would hand
    the same message back to the next read, and the tool would print it `limit` times.
    """
    depth = channel.queue_declare(queue=settings.dead_letter_queue, durable=True).method
    emit(json.dumps({"event": "dlq_depth", "queue": settings.dead_letter_queue, "messages": depth.message_count}))

    delivery_tags: list[int] = []
    for index in range(limit):
        method, properties, body = channel.basic_get(queue=settings.dead_letter_queue, auto_ack=False)
        if method is None:
            break
        delivery_tags.append(method.delivery_tag)
        emit(
            json.dumps(
                {
                    "event": "dead_letter",
                    "n": index + 1,
                    "body": body.decode("utf-8", "replace"),
                    "x_death": death_reason(properties),
                }
            )
        )

    if drain:
        for delivery_tag in delivery_tags:
            channel.basic_ack(delivery_tag=delivery_tag)
    else:
        # Reversed order: nack puts a message back at the head of the queue.
        for delivery_tag in reversed(delivery_tags):
            channel.basic_nack(delivery_tag=delivery_tag, requeue=True)

    return delivery_tags


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = Settings.from_env()
    configure(settings.log_level)

    connection = connect(settings, threading.Event())
    try:
        channel = open_channel(connection)
        declare_topology(channel, settings)
        read_dead_letters(channel, settings, limit=args.limit, drain=args.drain)
    finally:
        close_quietly(connection)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
