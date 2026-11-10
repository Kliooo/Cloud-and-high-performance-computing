"""Calculation services over RabbitMQ: one image, three entry points.

    python -m app.producer   publishes jobs with a per-operation routing key
    python -m app.consumer   computes them, rejects failures into the dead-letter queue
    python -m app.dlq        shows what ended up in the dead-letter queue
"""

__version__ = "1.0.0"
