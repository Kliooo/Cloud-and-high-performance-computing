"""Job payloads: what the producer puts on the wire and what the consumer accepts.

Wire format (JSON, one job per message):

    {"id": "5f0c1e5a-…", "op": "div", "operands": [17, 4], "created_at": "2026-11-09T13:41:02Z"}

`id` is the natural idempotency key: the consumer logs it with every result, so a duplicate
delivery (at-least-once) is visible in the log instead of being silently recomputed.
"""

from __future__ import annotations

import datetime as dt
import json
import random
import uuid
from dataclasses import dataclass, field
from typing import Sequence

from .operations import OPERATIONS

OPERAND_RANGE = 100


class InvalidMessage(Exception):
    """The body is not a job at all — a permanent failure, the message goes to the DLQ."""


@dataclass(frozen=True)
class Job:
    """A validated job. Built either by the producer or by `parse_job`."""

    job_id: str
    operation: str
    operands: tuple[float, ...]
    created_at: str = field(
        default_factory=lambda: dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )

    def payload(self) -> dict:
        return {
            "id": self.job_id,
            "op": self.operation,
            "operands": list(self.operands),
            "created_at": self.created_at,
        }

    def to_bytes(self) -> bytes:
        return json.dumps(self.payload(), separators=(",", ":")).encode("utf-8")


def new_job(rng: random.Random | None = None, operation: str | None = None) -> Job:
    """A job that the consumer is expected to compute successfully."""
    rng = rng or random.Random()
    operation = operation or rng.choice(sorted(OPERATIONS))

    left = rng.randint(-OPERAND_RANGE, OPERAND_RANGE)
    right = rng.randint(-OPERAND_RANGE, OPERAND_RANGE)

    if operation == "div" and right == 0:
        right = 7  # keep the intended job valid: division by zero is injected on purpose
    if operation == "pow":
        right = rng.randint(-3, 3)  # 100**100 is not an interesting demo
        if left == 0 and right < 0:
            right = abs(right)  # 0**-3 is undefined: the job must stay computable

    return Job(job_id=str(uuid.uuid4()), operation=operation, operands=(left, right))


def poison_job(kind: int = 0) -> Job:
    """A job that must fail, so the dead-letter path can be demonstrated on purpose.

    The producer injects these every `POISON_EVERY` messages, cycling through three
    different failure modes: a division by zero, an unknown operation and a payload
    with the wrong number of operands.
    """
    job_id = str(uuid.uuid4())
    if kind % 3 == 0:
        return Job(job_id=job_id, operation="div", operands=(42, 0))
    if kind % 3 == 1:
        return Job(job_id=job_id, operation="sqrt", operands=(16, 2))
    return Job(job_id=job_id, operation="add", operands=(1,))


def _require(payload: dict, key: str, expected: type, description: str):
    value = payload.get(key)
    if not isinstance(value, expected) or isinstance(value, bool):
        raise InvalidMessage(f"field {key!r} must be {description}, got {value!r}")
    return value


def parse_job(body: bytes) -> Job:
    """Turn a raw message body into a `Job`, or raise `InvalidMessage`.

    Only the envelope is validated here; the values are checked by `operations.calculate`,
    so both failures end up in the same place but with different reasons in the log.
    """
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidMessage(f"body is not valid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise InvalidMessage(f"body must be a JSON object, got {type(payload).__name__}")

    job_id = _require(payload, "id", str, "a non-empty string")
    if not job_id:
        raise InvalidMessage("field 'id' must be a non-empty string")
    operation = _require(payload, "op", str, "a string")
    operands: Sequence[object] = _require(payload, "operands", list, "a list")

    created_at = payload.get("created_at")
    return Job(
        job_id=job_id,
        operation=operation,
        operands=tuple(operands),
        created_at=created_at if isinstance(created_at, str) else "",
    )
