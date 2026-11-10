"""One logging configuration for all three entry points.

Results are logged as single-line JSON (`{"event": "result", ...}`): the smoke test and
`docker compose logs` can be filtered with grep, and the lines stay readable in a terminal.
"""

from __future__ import annotations

import logging
import sys


def configure(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-12s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )
    # pika dumps a traceback for every failed connect attempt; our own retry message says
    # the same in one line, so the library's I/O chatter is muted.
    logging.getLogger("pika").setLevel(logging.CRITICAL)
