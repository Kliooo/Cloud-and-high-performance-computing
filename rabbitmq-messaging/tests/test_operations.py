"""The calculation layer: every operation, and every reason a job can never succeed."""

from __future__ import annotations

import unittest

from app.operations import MAX_ABS_OPERAND, MAX_EXPONENT, OperationError, calculate, supported_operations


class CalculateTest(unittest.TestCase):
    def test_all_operations_are_computed(self):
        cases = {
            ("add", (2, 3)): 5,
            ("sub", (2, 3)): -1,
            ("mul", (-4, 2.5)): -10,
            ("div", (7, 2)): 3.5,
            ("pow", (2, 10)): 1024,
        }
        for (operation, operands), expected in cases.items():
            with self.subTest(operation=operation):
                self.assertEqual(calculate(operation, operands), expected)

    def test_result_is_rounded_to_avoid_float_noise(self):
        self.assertEqual(calculate("add", (0.1, 0.2)), 0.3)

    def test_supported_operations_are_listed(self):
        self.assertEqual(supported_operations(), ["add", "div", "mul", "pow", "sub"])

    def test_division_by_zero_is_a_permanent_failure(self):
        with self.assertRaises(OperationError) as ctx:
            calculate("div", (1, 0))
        self.assertIn("division by zero", str(ctx.exception))

    def test_unknown_operation_is_a_permanent_failure(self):
        with self.assertRaises(OperationError) as ctx:
            calculate("sqrt", (16, 2))
        self.assertIn("unknown operation", str(ctx.exception))

    def test_wrong_number_of_operands(self):
        with self.assertRaises(OperationError) as ctx:
            calculate("add", (1,))
        self.assertIn("expects 2 operands", str(ctx.exception))

    def test_operands_must_be_numbers(self):
        for bad in ("2", None, True, [1]):
            with self.subTest(operand=bad):
                with self.assertRaises(OperationError):
                    calculate("add", (1, bad))

    def test_operands_must_be_finite(self):
        with self.assertRaises(OperationError):
            calculate("add", (1, float("inf")))
        with self.assertRaises(OperationError):
            calculate("add", (1, float("nan")))

    def test_operand_range_is_enforced(self):
        with self.assertRaises(OperationError):
            calculate("mul", (MAX_ABS_OPERAND * 10, 1))

    def test_exponent_range_is_enforced(self):
        with self.assertRaises(OperationError):
            calculate("pow", (2, MAX_EXPONENT + 1))

    def test_overflow_becomes_an_operation_error(self):
        with self.assertRaises(OperationError):
            calculate("pow", (1e6, 64))


if __name__ == "__main__":
    unittest.main()
