"""The dead-letter queue tool: peek without showing the same message twice, drain on demand."""

from __future__ import annotations

import json
import unittest

from app.dlq import read_dead_letters
from tests.fakes import FakeChannel, FakeMethod
from tests.test_topology import make_settings


class FakeProperties:
    def __init__(self, deaths):
        self.headers = {"x-death": deaths} if deaths else {}


class GetChannel(FakeChannel):
    """A channel whose basic_get returns a prepared list of messages."""

    def __init__(self, messages):
        super().__init__()
        self.pending = list(messages)

    def basic_get(self, queue, auto_ack=False):
        self._record("basic_get", queue=queue, auto_ack=auto_ack)
        if not self.pending:
            return None, None, None
        return self.pending.pop(0)


def message(tag: int, job_id: str) -> tuple:
    body = json.dumps({"id": job_id, "op": "div", "operands": [1, 0]}).encode()
    deaths = [{"queue": "calc.jobs", "reason": "rejected", "count": 1}]
    return FakeMethod(delivery_tag=tag), FakeProperties(deaths), body


class ReadDeadLettersTest(unittest.TestCase):
    def setUp(self):
        self.settings = make_settings()
        self.lines: list[str] = []

    def run_tool(self, messages, *, limit=10, drain=False):
        channel = GetChannel(messages)
        tags = read_dead_letters(
            channel,
            self.settings,
            limit=limit,
            drain=drain,
            emit=self.lines.append,
        )
        return channel, tags

    def printed(self) -> list[dict]:
        return [json.loads(line) for line in self.lines]

    def test_peek_prints_every_message_once(self):
        channel, tags = self.run_tool([message(1, "job-1"), message(2, "job-2"), message(3, "job-3")])

        bodies = [event["body"] for event in self.printed() if event["event"] == "dead_letter"]
        self.assertEqual(len(bodies), 3)
        self.assertIn("job-1", bodies[0])
        self.assertIn("job-3", bodies[2])
        self.assertEqual(tags, [1, 2, 3])

        # Nothing is acknowledged when peeking; everything goes back, in reverse order,
        # because a nack requeues at the head.
        self.assertEqual(channel.named("basic_ack"), [])
        self.assertEqual([call["delivery_tag"] for call in channel.named("basic_nack")], [3, 2, 1])
        self.assertTrue(all(call["requeue"] for call in channel.named("basic_nack")))

    def test_all_reads_happen_before_any_requeue(self):
        channel, _ = self.run_tool([message(1, "job-1"), message(2, "job-2")], limit=2)

        names = channel.names()
        self.assertLess(names.index("basic_get"), names.index("basic_nack"))
        self.assertEqual(names.count("basic_get"), 2)

    def test_drain_acknowledges_instead_of_requeueing(self):
        channel, tags = self.run_tool([message(1, "job-1"), message(2, "job-2")], drain=True)

        self.assertEqual([call["delivery_tag"] for call in channel.named("basic_ack")], [1, 2])
        self.assertEqual(channel.named("basic_nack"), [])
        self.assertEqual(tags, [1, 2])

    def test_limit_stops_at_the_requested_count(self):
        channel, tags = self.run_tool([message(1, "job-1"), message(2, "job-2")], limit=1)

        self.assertEqual(tags, [1])
        self.assertEqual(len(channel.named("basic_get")), 1)

    def test_empty_queue_prints_only_the_depth(self):
        _, tags = self.run_tool([])

        self.assertEqual(tags, [])
        events = self.printed()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "dlq_depth")

    def test_x_death_is_reported(self):
        self.run_tool([message(1, "job-1")])

        event = [e for e in self.printed() if e["event"] == "dead_letter"][0]
        self.assertEqual(event["x_death"], {"queue": "calc.jobs", "reason": "rejected", "count": 1})


if __name__ == "__main__":
    unittest.main()
