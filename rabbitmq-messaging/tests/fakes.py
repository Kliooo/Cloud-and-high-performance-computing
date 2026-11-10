"""A recording stand-in for a pika channel.

The method signatures follow `pika.adapters.blocking_connection.BlockingChannel` (keyword
names included), so a call that works here is a call that works against a real broker.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


class FakeDeclareOk:
    """What `queue_declare` returns in pika: an object with a `.method`."""

    def __init__(self, queue: str, message_count: int = 0) -> None:
        self.method = SimpleNamespace(queue=queue, message_count=message_count, consumer_count=0)


class FakeMethod:
    """The delivery info pika passes as `method`."""

    def __init__(
        self,
        delivery_tag: int = 1,
        routing_key: str = "calc.add",
        exchange: str = "calc.exchange",
        redelivered: bool = False,
    ) -> None:
        self.delivery_tag = delivery_tag
        self.routing_key = routing_key
        self.exchange = exchange
        self.redelivered = redelivered


class FakeChannel:
    """Records every call as (name, kwargs) and returns plausible objects."""

    is_open = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.queue_depths: dict[str, int] = {}
        self.publish_result: bool | Exception = True

    # -- helpers used by the tests -------------------------------------------------
    def _record(self, name: str, **kwargs: Any) -> None:
        self.calls.append((name, kwargs))

    def named(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for call_name, kwargs in self.calls if call_name == name]

    def last(self, name: str) -> dict[str, Any]:
        matches = self.named(name)
        assert matches, f"no {name} call was recorded; recorded: {[c for c, _ in self.calls]}"
        return matches[-1]

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    # -- pika API ------------------------------------------------------------------
    def exchange_declare(
        self,
        exchange: str,
        exchange_type: str = "direct",
        passive: bool = False,
        durable: bool = False,
        auto_delete: bool = False,
        internal: bool = False,
        arguments: dict | None = None,
        callback=None,
    ) -> None:
        self._record(
            "exchange_declare",
            exchange=exchange,
            exchange_type=exchange_type,
            durable=durable,
            auto_delete=auto_delete,
        )

    def queue_declare(
        self,
        queue: str,
        passive: bool = False,
        durable: bool = False,
        exclusive: bool = False,
        auto_delete: bool = False,
        arguments: dict | None = None,
        callback=None,
    ) -> FakeDeclareOk:
        self._record("queue_declare", queue=queue, durable=durable, arguments=arguments)
        return FakeDeclareOk(queue, message_count=self.queue_depths.get(queue, 0))

    def queue_bind(
        self,
        queue: str,
        exchange: str,
        routing_key: str = "",
        arguments: dict | None = None,
        callback=None,
    ) -> None:
        self._record("queue_bind", queue=queue, exchange=exchange, routing_key=routing_key)

    def basic_qos(self, prefetch_size: int = 0, prefetch_count: int = 0, global_qos: bool = False, callback=None) -> None:
        self._record("basic_qos", prefetch_count=prefetch_count)

    def confirm_delivery(self, callback=None) -> None:
        self._record("confirm_delivery")

    def basic_publish(
        self,
        exchange: str,
        routing_key: str,
        body: bytes,
        properties: Any = None,
        mandatory: bool = False,
    ) -> bool:
        self._record(
            "basic_publish",
            exchange=exchange,
            routing_key=routing_key,
            body=body,
            properties=properties,
            mandatory=mandatory,
        )
        if isinstance(self.publish_result, Exception):
            raise self.publish_result
        return self.publish_result

    def basic_consume(
        self,
        queue: str,
        on_message_callback,
        auto_ack: bool = False,
        exclusive: bool = False,
        consumer_callback=None,
        arguments: dict | None = None,
        inactivity_timeout=None,
        callback=None,
    ) -> str:
        self._record("basic_consume", queue=queue, auto_ack=auto_ack, on_message_callback=on_message_callback)
        return "ctag-1"

    def basic_ack(self, delivery_tag: int = 0, multiple: bool = False) -> None:
        self._record("basic_ack", delivery_tag=delivery_tag, multiple=multiple)

    def basic_reject(self, delivery_tag: int = 0, requeue: bool = True) -> None:
        self._record("basic_reject", delivery_tag=delivery_tag, requeue=requeue)

    def basic_nack(self, delivery_tag: int = 0, multiple: bool = False, requeue: bool = True) -> None:
        self._record("basic_nack", delivery_tag=delivery_tag, requeue=requeue)

    def basic_get(self, queue: str, auto_ack: bool = False):
        self._record("basic_get", queue=queue, auto_ack=auto_ack)
        return None, None, None

    def close(self, reply_code: int = 200, reply_text: str = "Normal shutdown") -> None:
        self.is_open = False
        self._record("close")
