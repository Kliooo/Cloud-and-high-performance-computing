"""AMQP objects used by every service.

The topology is declared by whoever connects first — declarations in AMQP are idempotent,
and both producer and consumer call this function on start-up:

    producer ──calc.<op>──▶ exchange calc.exchange (topic)
                                   │ binding calc.*
                                   ▼
                            queue calc.jobs ──x-dead-letter-exchange──▶ calc.dlx (direct)
                                                                              │ binding "dead"
                                                                              ▼
                                                                      queue calc.jobs.dlq

Routing: the producer publishes with one routing key per operation (`calc.add`, `calc.div`, …),
the work queue is bound with the topic pattern `calc.*`, so a new operation needs no new queue.
"""

from __future__ import annotations

import logging
from typing import Any

from .config import Settings

log = logging.getLogger(__name__)

ROUTING_KEY_PREFIX = "calc."

# One wildcard word: `calc.add`, `calc.mul`, … — but not `calc.add.fast`.
ROUTING_KEY_PATTERN = "calc.*"

# The dead-letter exchange is direct: the queue name is not used as a key, so renames
# of the work queue do not break the dead-letter path.
DEAD_LETTER_ROUTING_KEY = "dead"


def routing_key(operation: str) -> str:
    """`add` -> `calc.add`."""
    return f"{ROUTING_KEY_PREFIX}{operation}"


def declare_topology(channel: Any, settings: Settings) -> None:
    """Create exchanges, queues and bindings. Safe to call on every start-up."""
    channel.exchange_declare(
        exchange=settings.exchange,
        exchange_type="topic",
        durable=True,
        auto_delete=False,
    )
    channel.exchange_declare(
        exchange=settings.dead_letter_exchange,
        exchange_type="direct",
        durable=True,
        auto_delete=False,
    )

    # The dead-letter arguments are fixed when the queue is first created: changing them
    # later requires deleting the queue (the README explains how).
    channel.queue_declare(
        queue=settings.queue,
        durable=True,
        arguments={
            "x-dead-letter-exchange": settings.dead_letter_exchange,
            "x-dead-letter-routing-key": DEAD_LETTER_ROUTING_KEY,
        },
    )
    channel.queue_bind(
        queue=settings.queue,
        exchange=settings.exchange,
        routing_key=ROUTING_KEY_PATTERN,
    )

    channel.queue_declare(queue=settings.dead_letter_queue, durable=True)
    channel.queue_bind(
        queue=settings.dead_letter_queue,
        exchange=settings.dead_letter_exchange,
        routing_key=DEAD_LETTER_ROUTING_KEY,
    )

    log.info(
        "topology is ready: %s (topic) -[%s]-> %s -[x-dead-letter]-> %s -> %s",
        settings.exchange,
        ROUTING_KEY_PATTERN,
        settings.queue,
        settings.dead_letter_exchange,
        settings.dead_letter_queue,
    )
