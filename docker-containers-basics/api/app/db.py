"""Database connection — the database itself lives in a separate container."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg import Connection
from psycopg.rows import dict_row


def build_dsn() -> str:
    """Connection string built from environment variables (defaults match docker-compose.yml)."""
    return (
        f"host={os.getenv('DB_HOST', 'db')} "
        f"port={os.getenv('DB_PORT', '5432')} "
        f"dbname={os.getenv('DB_NAME', 'appdb')} "
        f"user={os.getenv('DB_USER', 'appuser')} "
        # empty by default: the compose setup runs the database with "trust" auth
        f"password={os.getenv('DB_PASSWORD') or os.getenv('POSTGRES_PASSWORD', '')} "
        f"application_name=containers-basics-api "
        f"connect_timeout=5"
    )


@contextmanager
def get_connection() -> Iterator[Connection]:
    """Yield a database connection; COMMIT on success, ROLLBACK on error."""
    with psycopg.connect(build_dsn()) as conn:
        conn.row_factory = dict_row
        yield conn


def wait_for_db(attempts: int = 30, delay: float = 1.0) -> None:
    """Wait until the database container starts accepting connections."""
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            with get_connection() as conn:
                conn.execute("SELECT 1")
            print(f"[db] connected (attempt {attempt})", flush=True)
            return
        except Exception as exc:
            last_error = exc
            print(f"[db] attempt {attempt}/{attempts}: database is not ready yet ({exc})", flush=True)
            time.sleep(delay)

    raise RuntimeError(f"could not connect to the database: {last_error}")
