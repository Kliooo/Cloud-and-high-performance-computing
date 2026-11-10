"""The consumer: acknowledge what was computed, dead-letter what cannot be."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from app.consumer import Consumer
from app.health import State
from app.jobs import Job
from tests.fakes import FakeChannel, FakeMethod
from tests.test_topology import make_settings


class ConsumerTestBase(unittest.TestCase):
    def setUp(self):
        self.channel = FakeChannel()
        self.settings = make_settings()
        self.state = State(role="consumer")
        self.consumer = Consumer(self.channel, self.settings, self.state)
        self.method = FakeMethod(delivery_tag=42, routing_key="calc.add")

    def deliver(self, body: bytes, method: FakeMethod | None = None) -> None:
        self.consumer.on_message(self.channel, method or self.method, None, body)

    def logged_event(self, logs) -> dict:
        """The services log one JSON object per message; parse the captured record."""
        return json.loads(logs.records[0].getMessage())

    def logged_event_last(self, logs) -> dict:
        return json.loads(logs.records[-1].getMessage())


class SuccessTest(ConsumerTestBase):
    def test_result_is_logged_and_acknowledged(self):
        job = Job(job_id="job-42", operation="add", operands=(2, 3))

        with self.assertLogs("consumer", level="INFO") as logs:
            self.deliver(job.to_bytes())

        self.assertEqual(self.channel.last("basic_ack")["delivery_tag"], 42)
        self.assertEqual(self.channel.named("basic_reject"), [])
        self.assertEqual(self.state.counters, {"processed": 1})

        event = self.logged_event(logs)
        self.assertEqual(event["event"], "result")
        self.assertEqual(event["id"], "job-42")
        self.assertEqual(event["result"], 5)
        self.assertIn("duration_ms", event)

    def test_message_without_created_at_is_still_processed(self):
        body = json.dumps({"id": "job-7", "op": "mul", "operands": [3, 4]}).encode()

        self.deliver(body)

        self.assertEqual(self.channel.last("basic_ack")["delivery_tag"], 42)
        self.assertEqual(self.state.counters, {"processed": 1})

    def test_every_successful_message_is_acknowledged_separately(self):
        for tag in (1, 2, 3):
            self.deliver(Job(job_id=f"job-{tag}", operation="add", operands=(tag, 1)).to_bytes(), FakeMethod(tag))

        self.assertEqual([call["delivery_tag"] for call in self.channel.named("basic_ack")], [1, 2, 3])


class RejectionTest(ConsumerTestBase):
    def assert_dead_lettered(self, reason_part: str, reason_type: str) -> dict:
        reject = self.channel.last("basic_reject")
        self.assertEqual(reject["delivery_tag"], 42)
        self.assertFalse(reject["requeue"], "requeue=True would loop on a job that cannot succeed")
        self.assertEqual(self.channel.named("basic_ack"), [])
        self.assertEqual(self.state.counters, {"dead_lettered": 1})

        event = self.last_rejection
        self.assertEqual(event["event"], "rejected")
        self.assertEqual(event["reason_type"], reason_type)
        self.assertIn(reason_part, event["reason"])
        self.assertEqual(event["next"], "calc.jobs.dlq")
        return event

    def reject(self, body: bytes) -> dict:
        with self.assertLogs("consumer", level="WARNING") as logs:
            self.deliver(body)
        self.last_rejection = self.logged_event(logs)
        return self.last_rejection

    def test_division_by_zero_goes_to_the_dlq(self):
        body = Job(job_id="job-1", operation="div", operands=(1, 0)).to_bytes()

        self.reject(body)

        self.assert_dead_lettered("division by zero", "OperationError")

    def test_unknown_operation_goes_to_the_dlq(self):
        body = Job(job_id="job-2", operation="sqrt", operands=(16, 2)).to_bytes()

        self.reject(body)

        self.assert_dead_lettered("unknown operation", "OperationError")

    def test_malformed_json_goes_to_the_dlq(self):
        self.reject(b"{not json")

        self.assert_dead_lettered("not valid JSON", "InvalidMessage")

    def test_missing_fields_go_to_the_dlq(self):
        self.reject(b'{"id": "job-3", "op": "add"}')

        self.assert_dead_lettered("operands", "InvalidMessage")

    def test_unexpected_error_also_lands_in_the_dlq(self):
        body = Job(job_id="job-4", operation="add", operands=(1, 1)).to_bytes()

        with mock.patch("app.consumer.calculate", side_effect=RuntimeError("boom")):
            with self.assertLogs("consumer", level="WARNING") as logs:
                self.deliver(body)

        reject = self.channel.last("basic_reject")
        self.assertFalse(reject["requeue"])
        self.assertEqual(self.state.counters["dead_lettered"], 1)
        # The traceback is logged as ERROR, then the machine-readable rejection as WARNING.
        self.assertEqual([record.levelname for record in logs.records], ["ERROR", "WARNING"])
        self.assertEqual(self.logged_event_last(logs)["reason_type"], "unexpected")

    def test_rejection_log_names_the_original_routing_key(self):
        body = Job(job_id="job-5", operation="div", operands=(9, 0)).to_bytes()

        self.reject(body)

        self.assertEqual(self.last_rejection["routing_key"], "calc.add")
        # The id is kept, so a rejected job can be matched with its "published" line.
        self.assertEqual(self.last_rejection["id"], "job-5")

    def test_unparsable_message_has_no_id_but_still_a_reason(self):
        self.reject(b"not json at all")

        self.assertIsNone(self.last_rejection["id"])
        self.assertIn("not valid JSON", self.last_rejection["reason"])


if __name__ == "__main__":
    unittest.main()
