"""Settings read from the environment.

Every default matches `docker-compose.yml` and `k8s/base/configmap.yaml`, so all three
entry points (producer, consumer, dead-letter viewer) start without extra flags.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_str(name: str, default: str) -> str:
    value = os.getenv(name)
    return default if not value else value


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    """Everything the services need to find the broker and build the topology."""

    # connection
    host: str
    port: int
    user: str
    password: str
    vhost: str

    # topology
    exchange: str
    dead_letter_exchange: str
    queue: str
    dead_letter_queue: str

    # behaviour
    prefetch: int
    interval: float
    poison_every: int
    health_port: int
    log_level: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            host=_env_str("RABBITMQ_HOST", "localhost"),
            port=_env_int("RABBITMQ_PORT", 5672),
            user=_env_str("RABBITMQ_USER", "123"),
            password=_env_str("RABBITMQ_PASSWORD", "123"),
            vhost=_env_str("RABBITMQ_VHOST", "/"),
            exchange=_env_str("EXCHANGE_NAME", "calc.exchange"),
            dead_letter_exchange=_env_str("DEAD_LETTER_EXCHANGE", "calc.dlx"),
            queue=_env_str("QUEUE_NAME", "calc.jobs"),
            dead_letter_queue=_env_str("DLQ_NAME", "calc.jobs.dlq"),
            prefetch=_env_int("PREFETCH_COUNT", 10),
            interval=_env_float("PRODUCER_INTERVAL_SECONDS", 2.5),
            poison_every=_env_int("POISON_EVERY", 5),
            health_port=_env_int("HEALTH_PORT", 8080),
            log_level=_env_str("LOG_LEVEL", "INFO"),
        )

    @property
    def amqp_url(self) -> str:
        """Only used in log messages, so the password is never printed."""
        return f"amqp://{self.user}@{self.host}:{self.port}/{self.vhost}"
