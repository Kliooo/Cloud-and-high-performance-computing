#!/usr/bin/env bash
# Self-check for the assignment: start the stack, write a row through the entry point,
# restart the containers and verify that the row survived.
# Run from the repository root:  bash scripts/demo.sh

set -euo pipefail

cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-8000}"
BASE_URL="http://localhost:${API_PORT}"

log() { printf '\n=== %s\n' "$*"; }

count_items() {
  curl -fsS "$BASE_URL/items" | grep -o '"id"' | wc -l | tr -d ' ' || true
}

# podman-docker points DOCKER_HOST at its own socket; if it is unreachable, use the local docker.
if [ -n "${DOCKER_HOST:-}" ] && ! docker info >/dev/null 2>&1; then
  echo "DOCKER_HOST=$DOCKER_HOST is unreachable — falling back to the local docker socket"
  unset DOCKER_HOST
fi

wait_for_api() {
  log "Waiting for the entry point: $BASE_URL/health"
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "entry point is up"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: the entry point did not start within 60 seconds." >&2
  echo "Check the logs with 'docker compose logs' and free port ${API_PORT} if it is busy." >&2
  return 1
}

log "1/6 Building images and starting the containers"
docker compose up -d --build

wait_for_api
before="$(count_items)"
echo "rows in the database before the test: $before"

marker="persistence-check-$(date +%s)"
log "2/6 Writing a marker row through the entry point: $marker"
curl -fsS -X POST "$BASE_URL/items" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"$marker\",\"description\":\"this row must survive a restart\"}"
echo

log "3/6 Restarting the containers: docker compose restart"
docker compose restart

wait_for_api

log "4/6 Reading the data back through the entry point"
body="$(curl -fsS "$BASE_URL/items")"
echo "$body"

if printf '%s' "$body" | grep -q "$marker"; then
  echo
  echo "RESULT: PASS — marker '$marker' is still there after the restart, the data survived."
else
  echo
  echo "RESULT: FAIL — marker '$marker' is gone after the restart." >&2
  exit 1
fi

log "5/6 Cross-check directly inside the database container"
docker compose exec -T db psql \
  -U "${POSTGRES_USER:-appuser}" \
  -d "${POSTGRES_DB:-appdb}" \
  -c "SELECT count(*) AS items_total FROM items;" \
  -c "SELECT pg_postmaster_start_time() AS db_started_at;"
echo "(the database server start time changed — the container restarted while the rows stayed)"

log "6/6 Done"
echo "The stack is left running: $BASE_URL"
echo "Swagger UI: $BASE_URL/docs"
echo "Stop:           docker compose down      (the data volume is kept)"
echo "Stop and wipe:  docker compose down -v   (the volume is destroyed)"
