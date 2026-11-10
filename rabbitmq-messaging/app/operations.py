"""The calculations a job asks for, and the errors that mean "never retry this".

`OperationError` is a *permanent* failure: repeating the same calculation cannot succeed,
so the consumer rejects the message and the broker moves it to the dead-letter queue.
Anything else (a dropped connection, a bug) is handled separately.
"""

from __future__ import annotations

import math
from typing import Callable, Sequence

# Guards against jobs that would keep a worker busy or produce absurd numbers.
MAX_ABS_OPERAND = 1_000_000.0
MAX_EXPONENT = 64
MAX_ABS_RESULT = 1e12
RESULT_PRECISION = 6


class OperationError(Exception):
    """The job cannot be computed — it belongs in the dead-letter queue."""


def _validate(operation: str, operands: Sequence[object], arity: int) -> list[float]:
    if len(operands) != arity:
        raise OperationError(f"{operation} expects {arity} operands, got {len(operands)}")

    numbers: list[float] = []
    for value in operands:
        # bool is a subclass of int: `true` in JSON is not a number here.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise OperationError(f"{operation} operands must be numbers, got {value!r}")
        if not math.isfinite(value):
            raise OperationError(f"{operation} operands must be finite, got {value!r}")
        if abs(value) > MAX_ABS_OPERAND:
            raise OperationError(f"{operation} operands must be ≤ {MAX_ABS_OPERAND:g}, got {value!r}")
        numbers.append(float(value))
    return numbers


def _add(left: float, right: float) -> float:
    return left + right


def _sub(left: float, right: float) -> float:
    return left - right


def _mul(left: float, right: float) -> float:
    return left * right


def _div(left: float, right: float) -> float:
    if right == 0:
        raise OperationError("division by zero")
    return left / right


def _pow(left: float, right: float) -> float:
    if abs(right) > MAX_EXPONENT:
        raise OperationError(f"exponent is limited to ±{MAX_EXPONENT}, got {right:g}")
    if left == 0 and right < 0:
        raise OperationError("zero cannot be raised to a negative power")
    try:
        return left**right
    except OverflowError as exc:
        raise OperationError(f"{left:g}^{right:g} overflows") from exc


# name -> (arity, function). The producer picks names from here, the consumer looks them up.
OPERATIONS: dict[str, tuple[int, Callable[[float, float], float]]] = {
    "add": (2, _add),
    "sub": (2, _sub),
    "mul": (2, _mul),
    "div": (2, _div),
    "pow": (2, _pow),
}


def supported_operations() -> list[str]:
    return sorted(OPERATIONS)


def calculate(operation: object, operands: Sequence[object]) -> float | int:
    """Apply one operation or raise `OperationError` with a human-readable reason."""
    if not isinstance(operation, str):
        raise OperationError(f"operation must be a string, got {operation!r}")

    entry = OPERATIONS.get(operation)
    if entry is None:
        raise OperationError(
            f"unknown operation {operation!r}, supported: {', '.join(supported_operations())}"
        )

    arity, function = entry
    numbers = _validate(operation, operands, arity)

    try:
        result = function(*numbers)
    except OverflowError as exc:  # e.g. 1e6 ** 64
        raise OperationError(f"{operation} overflowed for {numbers}") from exc

    if not math.isfinite(result):
        raise OperationError(f"{operation} produced a non-finite result for {numbers}")
    if abs(result) > MAX_ABS_RESULT:
        raise OperationError(f"{operation} result {result:g} is out of range")

    # 0.1 + 0.2 should be logged as 0.3, not 0.30000000000000004.
    return round(result, RESULT_PRECISION)
