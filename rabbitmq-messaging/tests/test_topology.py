"""The AMQP contract: exchanges, queues, bindings and the dead-letter arguments."""

from __future__ import annotations

import unittest

from app.config import Settings
from app.topology import DEAD_LETTER_ROUTING_KEY, ROUTING_KEY_PATTERN, declare_topology, routing_key
from tests.fakes import FakeChannel


def make_settings(**overrides) -> Settings:
    base = dict(
        host="rabbitmq",
        port=5672,
        user="calc",
        password="calc",
        vhost="/",
        exchange="calc.exchange",
        dead_letter_exchange="calc.dlx",
        queue="calc.jobs",
        dead_letter_queue="calc.jobs.dlq",
        prefetch=10,
        interval=2.5,
        poison_every=5,
        health_port=8080,
        log_level="INFO",
    )
    base.update(overrides)
    return Settings(**base)


class RoutingKeyTest(unittest.TestCase):
    def test_every_operation_gets_its_own_key(self):
        self.assertEqual(routing_key("add"), "calc.add")
        self.assertEqual(routing_key("div"), "calc.div")

    def test_pattern_matches_one_word(self):
        # `calc.*` must match `calc.add`, but not a nested key — that is what `#` is for.
        self.assertEqual(ROUTING_KEY_PATTERN, "calc.*")


class DeclareTopologyTest(unittest.TestCase):
    def setUp(self):
        self.channel = FakeChannel()
        self.settings = make_settings()
        declare_topology(self.channel, self.settings)

    def test_two_exchanges_with_the_right_types(self):
        exchanges = {call["exchange"]: call for call in self.channel.named("exchange_declare")}
        self.assertEqual(exchanges["calc.exchange"]["exchange_type"], "topic")
        self.assertEqual(exchanges["calc.dlx"]["exchange_type"], "direct")
        for call in exchanges.values():
            self.assertTrue(call["durable"], "queues and messages must survive a restart")

    def test_work_queue_dead_letters_into_the_dlq(self):
        declared = {call["queue"]: call for call in self.channel.named("queue_declare")}
        arguments = declared["calc.jobs"]["arguments"]
        self.assertEqual(arguments["x-dead-letter-exchange"], "calc.dlx")
        self.assertEqual(arguments["x-dead-letter-routing-key"], DEAD_LETTER_ROUTING_KEY)
        self.assertTrue(declared["calc.jobs"]["durable"])

    def test_work_queue_is_bound_with_the_topic_pattern(self):
        bindings = self.channel.named("queue_bind")
        self.assertIn(
            {"queue": "calc.jobs", "exchange": "calc.exchange", "routing_key": "calc.*"},
            bindings,
        )

    def test_dlq_is_bound_to_the_dead_letter_exchange(self):
        bindings = self.channel.named("queue_bind")
        self.assertIn(
            {"queue": "calc.jobs.dlq", "exchange": "calc.dlx", "routing_key": DEAD_LETTER_ROUTING_KEY},
            bindings,
        )

    def test_topology_is_fully_declared(self):
        self.assertEqual(
            sorted(self.channel.names()),
            sorted(["exchange_declare"] * 2 + ["queue_declare"] * 2 + ["queue_bind"] * 2),
        )


if __name__ == "__main__":
    unittest.main()
