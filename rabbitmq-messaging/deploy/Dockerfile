# One image, three entry points: producer, consumer and the dead-letter viewer.
# The command decides the role — see docker-compose.yml and k8s/base/.
FROM python:3.12-slim

LABEL org.opencontainers.image.title="rabbitmq-messaging" \
      org.opencontainers.image.description="Producer/consumer pair over RabbitMQ with routing and a dead-letter queue"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies in a separate layer — cached until requirements.txt changes.
# Paths are relative to the build context, which is the project root (see docker-compose.yml).
COPY deploy/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# The unit tests ride along: `docker compose run --rm producer python -m unittest` works
# without a separate test image or a Python installation on the host.
COPY tests ./tests

# The process does not run as root.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# Health endpoints (/healthz, /readyz, /stats), not the AMQP port.
EXPOSE 8080

# The same check docker-compose.yml uses; keeps the image self-describing.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-m", "app.healthcheck"]

CMD ["python", "-m", "app.producer"]
