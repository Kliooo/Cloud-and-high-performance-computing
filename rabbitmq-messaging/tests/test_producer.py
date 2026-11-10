"""The producer: routing keys, message properties and the deliberate failures."""

from __future__ import annotations

import json
import random
import unittest

import pika

from app.jobs import Job, parse_job
from app.operations import OPERATIONS, calculate
from app.producer import build_properties, next_job, publish_job
from tests.fakes import FakeChannel
from tests.test_topology import make_settings


class PropertiesTest(unittest.TestCase):
    def test_message_is_persistent_and_identifiable(self):
        job = Job(job_id="job-1", operation="add", operands=(1, 2))
        properties = build_properties(job)

        self.assertEqual(properties.delivery_mode, 2, "messages must survive a broker restart")
        self.assertEqual(properties.content_type, "application/json")
        self.assertEqual(properties.message_id, "job-1")
        self.assertEqual(properties.type, "add")
        self.assertEqual(properties.app_id, "calc-producer")
        self.assertIsInstance(properties.timestamp, int)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.channel = FakeChannel()
        self.settings = make_settings()
        self.job = Job(job_id="job-2", operation="mul", operands=(6, 7))

    def test_job_goes_to_the_exchange_with_the_operation_as_routing_key(self):
        self.assertTrue(publish_job(self.channel, self.settings, self.job))

        call = self.channel.last("basic_publish")
        self.assertEqual(call["exchange"], "calc.exchange")
        self.assertEqual(call["routing_key"], "calc.mul")
        self.assertTrue(call["mandatory"], "an unroutable job must not disappear silently")

        payload = json.loads(call["body"])
        self.assertEqual(payload["id"], "job-2")
        self.assertEqual(payload["op"], "mul")
        self.assertEqual(payload["operands"], [6, 7])

    def test_unroutable_message_is_reported_not_raised(self):
        self.channel.publish_result = pika.exceptions.UnroutableError([])

        with self.assertLogs("producer", level="ERROR") as logs:
            self.assertFalse(publish_job(self.channel, self.settings, self.job))

        self.assertIn("unroutable", logs.output[0])

    def test_unconfirmed_publish_returns_false(self):
        self.channel.publish_result = False
        self.assertFalse(publish_job(self.channel, self.settings, self.job))


class JobGenerationTest(unittest.TestCase):
    def test_generated_jobs_are_computable(self):
        rng = random.Random(1234)
        settings = make_settings(poison_every=0)

        for index in range(200):
            job = next_job(settings, index, rng)
            self.assertIn(job.operation, OPERATIONS)
            self.assertEqual(len(job.operands), 2)
            # The producer must never emit a job the consumer would have to reject...
            calculate(job.operation, job.operands)

    def test_every_nth_job_is_invalid_on_purpose(self):
        settings = make_settings(poison_every=5)
        rng = random.Random(7)
        jobs = [next_job(settings, index, rng) for index in range(15)]

        poison = [job for index, job in enumerate(jobs) if (index + 1) % 5 == 0]
        self.assertEqual(len(poison), 3)
        for job in poison:
            with self.assertRaises(Exception):
                calculate(job.operation, job.operands)

    def test_injection_covers_three_failure_modes(self):
        settings = make_settings(poison_every=1)
        rng = random.Random(3)
        reasons = []
        for index in range(3):
            job = next_job(settings, index, rng)
            with self.assertRaises(Exception) as ctx:
                calculate(job.operation, job.operands)
            reasons.append(str(ctx.exception))

        self.assertTrue(any("division by zero" in reason for reason in reasons))
        self.assertTrue(any("unknown operation" in reason for reason in reasons))
        self.assertTrue(any("expects 2 operands" in reason for reason in reasons))

    def test_injection_can_be_disabled(self):
        settings = make_settings(poison_every=0)
        rng = random.Random(11)
        for index in range(50):
            job = next_job(settings, index, rng)
            calculate(job.operation, job.operands)  # must not raise

    def test_serialised_job_round_trips(self):
        job = Job(job_id="job-3", operation="pow", operands=(2, 8))
        self.assertEqual(parse_job(job.to_bytes()), job)


if __name__ == "__main__":
    unittest.main()
