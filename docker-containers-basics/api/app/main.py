"""Entry point: HTTP API that reads and writes data in the database.

The service keeps no data of its own — every query goes to the `db` container.
"""

from __future__ import annotations

import datetime as dt
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field

from .db import get_connection, wait_for_db


@asynccontextmanager
async def lifespan(_app: FastAPI):
    wait_for_db()  # the database container may start slower — wait instead of crashing
    yield


app = FastAPI(
    title="Containers basics — entry point API",
    description="Demonstrates querying a database that runs in a separate container.",
    version="1.0.0",
    lifespan=lifespan,
)


class ItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200, examples=["persistence check"])
    description: str = Field(default="", max_length=1000)


class Item(ItemCreate):
    id: int
    created_at: dt.datetime


@app.get("/", summary="Service information")
def root() -> dict:
    return {
        "service": "containers-basics-api",
        "role": "entry point",
        "db_host": os.getenv("DB_HOST", "db"),
        "endpoints": ["/health", "/items", "/items/{id}", "/db-info", "/docs"],
    }


@app.get("/health", summary="API and database health")
def health() -> dict:
    try:
        with get_connection() as conn:
            conn.execute("SELECT 1")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database is unavailable: {exc}",
        ) from exc
    return {"status": "ok", "database": "reachable"}


@app.get("/items", response_model=list[Item], summary="List rows from the database")
def list_items(limit: int = Query(default=100, ge=1, le=1000)) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, title, description, created_at FROM items ORDER BY id LIMIT %s",
            (limit,),
        ).fetchall()
    return rows


@app.get("/items/{item_id}", response_model=Item, summary="Single row by id")
def get_item(item_id: int) -> dict:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, title, description, created_at FROM items WHERE id = %s",
            (item_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Row id={item_id} not found",
        )
    return row


@app.post(
    "/items",
    response_model=Item,
    status_code=status.HTTP_201_CREATED,
    summary="Create a row",
)
def create_item(payload: ItemCreate) -> dict:
    with get_connection() as conn:
        row = conn.execute(
            """
            INSERT INTO items (title, description)
            VALUES (%s, %s)
            RETURNING id, title, description, created_at
            """,
            (payload.title, payload.description),
        ).fetchone()
    return row


@app.delete(
    "/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,  # 204 has no response body, so the response model is disabled
    summary="Delete a row",
)
def delete_item(item_id: int) -> None:
    with get_connection() as conn:
        row = conn.execute(
            "DELETE FROM items WHERE id = %s RETURNING id",
            (item_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Row id={item_id} not found",
        )


@app.get(
    "/db-info",
    summary="Database server information (start time changes, data does not)",
)
def db_info() -> dict:
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT current_database()                                   AS database,
                   current_user                                         AS db_user,
                   version()                                            AS version,
                   pg_postmaster_start_time()                           AS db_started_at,
                   pg_size_pretty(pg_database_size(current_database()))  AS database_size,
                   (SELECT count(*) FROM items)                          AS items_total
            """
        ).fetchone()
    return row
