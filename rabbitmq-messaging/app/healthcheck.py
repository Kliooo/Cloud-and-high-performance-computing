"""Container healthcheck: exit 0 when this service reports itself as connected.

Used by `HEALTHCHECK` in the Dockerfile and by the compose healthcheck. Keeping it in a
module avoids passing a python one-liner through YAML/Docker argument splitting, which
breaks as soon as the code contains a space.
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    port = os.getenv("HEALTH_PORT", "8080")
    url = f"http://127.0.0.1:{port}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            print(response.read().decode("utf-8", "replace"))
            return 0 if response.status == 200 else 1
    except urllib.error.HTTPError as exc:  # 503 while the broker is unreachable
        print(f"{url} -> {exc.code} {exc.reason}")
        return 1
    except OSError as exc:
        print(f"{url} -> {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
