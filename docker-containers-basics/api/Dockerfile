# Container #2 — the entry point: HTTP API on top of PostgreSQL running in the neighbouring container.
FROM python:3.12-slim

LABEL org.opencontainers.image.title="containers-basics-api" \
      org.opencontainers.image.description="Entry point: HTTP API on top of PostgreSQL from the neighbouring container"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies in a separate layer — cached until requirements.txt changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# The process does not run as root.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# 0.0.0.0 is required: otherwise the service is reachable only inside the container.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
