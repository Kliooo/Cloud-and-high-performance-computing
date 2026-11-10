"""End-to-end flow with a toy broker instead of RabbitMQ.

The unit tests above check one component each; this one checks that the *declared* topology
actually routes: a valid job is computed and acknowledged, a broken one is rejected and lands
in `calc.jobs.dlq` through `calc.dlx`. Only the network and RabbitMQ itself are replaced.
"""

from __future__ import annotations

import random
import unittest
from unittest import mock

import pika

from app.consumer import Consumer
from app.health import State
from app.jobs import Job, new_job
from app.producer import publish_job
from app.topology import declare_topology
from tests.fakes import FakeChannel, FakeMethod
from tests.test_topology import make_settings


def topic_matches(pattern: str, routing_key: str) -> bool:
    """AMQP topic semantics for the two wildcards (`*` one word, `#` zero or more)."""
    pattern_parts = pattern.split(".")
    key_parts = routing_key.split(".")

    def match(pi: int, ki: int) -> bool:
        if pi == len(pattern_parts):
            return ki == len(key_parts)
        if pattern_parts[pi] == "#":
            return any(match(pi + 1, candidate) for candidate in range(ki, len(key_parts) + 1))
        if ki == len(key_parts):
            return False
        if pattern_parts[pi] == "*" or pattern_parts[pi] == key_parts[ki]:
            return match(pi + 1, ki + 1)
        return False

    return match(0, 0)


class Message:
    def __init__(self, queue: str, exchange: str, routing_key: str, body: bytes) -> None:
        self.queue = queue
        self.exchange = exchange
        self.routing_key = routing_key
        self.body = body


class ToyBroker:
    """Just enough AMQP: exchanges, queues, bindings, dead-lettering, ack and reject."""

    def __init__(self) -> None:
        self.exchanges: dict[str, str] = {}
        self.bindings: list[tuple[str, str, str]] = []  # (queue, exchange, pattern)
        self.queue_arguments: dict[str, dict] = {}
        self.queues: dict[str, list[Message]] = {}
        self.in_flight: dict[int, Message] = {}

    # -- declarations ---------------------------------------------------------
    def declare_exchange(self, name: str, exchange_type: str) -> None:
        self.exchanges[name] = exchange_type

    def declare_queue(self, name: str, arguments: dict | None = None) -> None:
        self.queues.setdefault(name, [])
        self.queue_arguments[name] = arguments or {}

    def bind(self, queue: str, exchange: str, pattern: str) -> None:
        self.bindings.append((queue, exchange, pattern))

    # -- routing --------------------------------------------------------------
    def route(self, exchange: str, routing_key: str) -> list[str]:
        return [
            queue
            for queue, bound_exchange, pattern in self.bindings
            if bound_exchange == exchange and topic_matches(pattern, routing_key)
        ]

    def publish(self, exchange: str, routing_key: str, body: bytes, mandatory: bool) -> None:
        targets = self.route(exchange, routing_key)
        if not targets:
            if mandatory:
                raise pika.exceptions.UnroutableError([])
            return
        for queue in targets:
            self.queues[queue].append(Message(queue, exchange, routing_key, body))

    # -- delivery -------------------------------------------------------------
    def get(self, queue: str, delivery_tag: int) -> Message | None:
        if not self.queues.get(queue):
            return None
        message = self.queues[queue].pop(0)
        self.in_flight[delivery_tag] = message
        return message

    def ack(self, delivery_tag: int) -> None:
        self.in_flight.pop(delivery_tag, None)

    def reject(self, delivery_tag: int, requeue: bool) -> None:
        message = self.in_flight.pop(delivery_tag)
        if requeue:
            self.queues[message.queue].insert(0, message)
            return
        # RabbitMQ dead-letters a rejected message using the queue's arguments.
        arguments = self.queue_arguments[message.queue]
        dead_exchange = arguments.get("x-dead-letter-exchange")
        if not dead_exchange:
            return  # no dead-letter policy: the message is simply dropped
        dead_key = arguments.get("x-dead-letter-routing-key", message.routing_key)
        self.publish(dead_exchange, dead_key, message.body, mandatory=False)

    def depth(self, queue: str) -> int:
        return len(self.queues.get(queue, []))


class ToyChannel(FakeChannel):
    """A pika-like channel whose calls land in the toy broker (and are still recorded)."""

    def __init__(self, broker: ToyBroker) -> None:
        super().__init__()
        self.broker = broker

    def exchange_declare(self, exchange, exchange_type="direct", **kwargs) -> None:
        super().exchange_declare(exchange, exchange_type, **kwargs)
        self.broker.declare_exchange(exchange, exchange_type)

    def queue_declare(self, queue, durable=False, arguments=None, **kwargs):
        result = super().queue_declare(queue, durable=durable, arguments=arguments, **kwargs)
        self.broker.declare_queue(queue, arguments)
        return result

    def queue_bind(self, queue, exchange, routing_key="", **kwargs) -> None:
        super().queue_bind(queue, exchange, routing_key, **kwargs)
        self.broker.bind(queue, exchange, routing_key)

    def basic_publish(self, exchange, routing_key, body, properties=None, mandatory=False) -> bool:
        super().basic_publish(exchange, routing_key, body, properties, mandatory)
        self.broker.publish(exchange, routing_key, body, mandatory)
        return True

    def basic_ack(self, delivery_tag=0, multiple=False) -> None:
        super().basic_ack(delivery_tag, multiple)
        if multiple:
            for tag in [tag for tag in self.broker.in_flight if tag <= delivery_tag]:
                self.broker.ack(tag)
        else:
            self.broker.ack(delivery_tag)

    def basic_reject(self, delivery_tag=0, requeue=True) -> None:
        super().basic_reject(delivery_tag, requeue)
        self.broker.reject(delivery_tag, requeue)


class TopicMatchingTest(unittest.TestCase):
    def test_patterns(self):
        self.assertTrue(topic_matches("calc.*", "calc.add"))
        self.assertFalse(topic_matches("calc.*", "calc.add.fast"))
        self.assertFalse(topic_matches("calc.*", "other.add"))
        self.assertTrue(topic_matches("calc.#", "calc.add.fast"))
        self.assertTrue(topic_matches("dead", "dead"))


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.broker = ToyBroker()
        self.channel = ToyChannel(self.broker)
        self.settings = make_settings()
        declare_topology(self.channel, self.settings)
        self.state = State(role="consumer")
        self.consumer = Consumer(self.channel, self.settings, self.state)
        self.tag = 0

    def deliver_next(self) -> None:
        """Behave like the broker: hand the consumer the first message of the work queue."""
        self.tag += 1
        message = self.broker.get(self.settings.queue, self.tag)
        assert message is not None, "work queue is empty"
        method = FakeMethod(delivery_tag=self.tag, routing_key=message.routing_key)
        with mock.patch("app.consumer.log"):  # keep the test output readable
            self.consumer.on_message(self.channel, method, None, message.body)

    def test_valid_job_is_computed_and_leaves_the_queue(self):
        job = new_job(random.Random(1), operation="mul")
        self.assertTrue(publish_job(self.channel, self.settings, job))

        self.assertEqual(self.broker.depth(self.settings.queue), 1)
        self.deliver_next()

        self.assertEqual(self.broker.depth(self.settings.queue), 0)
        self.assertEqual(self.broker.depth(self.settings.dead_letter_queue), 0)
        self.assertEqual(self.state.counters, {"processed": 1})

    def test_every_operation_is_routable(self):
        for operation in ("add", "sub", "mul", "div", "pow"):
            self.assertTrue(publish_job(self.channel, self.settings, new_job(random.Random(2), operation)))
            self.deliver_next()

        self.assertEqual(self.broker.depth(self.settings.queue), 0)
        self.assertEqual(self.broker.depth(self.settings.dead_letter_queue), 0)
        self.assertEqual(self.state.counters["processed"], 5)

    def test_rejected_job_reaches_the_dlq_through_the_dead_letter_exchange(self):
        job = Job(job_id="poison", operation="div", operands=(42, 0))
        publish_job(self.channel, self.settings, job)

        self.deliver_next()

        self.assertEqual(self.broker.depth(self.settings.queue), 0, "a rejected job must not stay in the work queue")
        self.assertEqual(self.broker.depth(self.settings.dead_letter_queue), 1)
        self.assertEqual(self.state.counters, {"dead_lettered": 1})

    def test_invalid_payload_reaches_the_dlq_too(self):
        self.broker.publish(self.settings.exchange, "calc.add", b"{not json", mandatory=True)

        self.deliver_next()

        self.assertEqual(self.broker.depth(self.settings.dead_letter_queue), 1)

    def test_unroutable_key_is_refused(self):
        with self.assertRaises(pika.exceptions.UnroutableError):
            self.broker.publish(self.settings.exchange, "other.add", b"{}", mandatory=True)

    def test_dead_lettered_message_keeps_its_body(self):
        job = Job(job_id="poison-2", operation="sqrt", operands=(4, 2))
        publish_job(self.channel, self.settings, job)

        self.deliver_next()

        dead = self.broker.queues[self.settings.dead_letter_queue][0]
        self.assertEqual(dead.body, job.to_bytes())
        self.assertEqual(dead.routing_key, "dead", "the DLX uses its own key, not the original one")


if __name__ == "__main__":
    unittest.main()
