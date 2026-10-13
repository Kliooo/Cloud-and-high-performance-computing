# Container #1 — the database (PostgreSQL 16, Alpine variant of the image).
FROM postgres:16-alpine

LABEL org.opencontainers.image.title="containers-basics-db" \
      org.opencontainers.image.description="PostgreSQL with a starter schema for the containerization basics assignment"

# Scripts from this directory run once, on the first initialization of an empty data directory.
COPY init/ /docker-entrypoint-initdb.d/

# Data directory: a volume from docker-compose.yml is mounted here, otherwise data would die with the container.
VOLUME ["/var/lib/postgresql/data"]

EXPOSE 5432

# Compose waits for the healthy state before starting the entry point.
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=10 \
  CMD pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" || exit 1
