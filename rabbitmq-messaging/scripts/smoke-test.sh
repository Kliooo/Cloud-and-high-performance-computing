#!/usr/bin/env bash
# End-to-end check of the compose stack. Needs docker only — no jq, no python on the host.
#
#   ./scripts/smoke-test.sh           # build, start, check, tear down
#   ./scripts/smoke-test.sh --keep    # leave the stack running afterwards
#   ./scripts/smoke-test.sh --full    # also restart the broker and check durability
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# The stack is described in deploy/docker-compose.yml; its build context is the project root.
COMPOSE="docker compose -f deploy/docker-compose.yml"
WORK_QUEUE="${QUEUE_NAME:-calc.jobs}"
DLQ="${DLQ_NAME:-calc.jobs.dlq}"
KEEP=0
FULL=0

for arg in "$@"; do
  case "${arg}" in
    --keep) KEEP=1 ;;
    --full) FULL=1 ;;
    *) echo "unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

failures=0
check() {
  if [[ "$2" == "0" ]]; then
    green "PASS  $1"
  else
    red "FAIL  $1"
    failures=$((failures + 1))
  fi
}

# Poll a predicate until it succeeds or the deadline passes.
wait_for() {
  local description="$1" timeout="$2" predicate="$3"
  local waited=0
  while (( waited < timeout )); do
    if eval "${predicate}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  dim "timed out after ${timeout}s: ${description}"
  return 1
}

# Question the broker itself: `rabbitmqctl list_queues` prints "<name> <value>" per queue.
queue_value() {
  local queue="$1" column="$2"
  ${COMPOSE} exec -T rabbitmq rabbitmqctl list_queues -q name messages consumers \
    | awk -v q="${queue}" -v c="${column}" '$1 == q { if (c == "messages") print $2; else print $3 }'
}

cleanup() {
  local status=$?
  if [[ "${KEEP}" -eq 0 ]]; then
    dim "tearing down (${COMPOSE} down -v)"
    ${COMPOSE} down -v --remove-orphans >/dev/null 2>&1 || true
  else
    dim "stack left running: ${COMPOSE} logs -f"
  fi
  exit "${status}"
}
trap cleanup EXIT

dim "starting the stack (fast producer: 0.5 s interval, every 3rd job is invalid)"
export PRODUCER_INTERVAL_SECONDS=0.5
export POISON_EVERY=3
${COMPOSE} up -d --build || { red "docker compose up failed"; exit 1; }

echo
wait_for "rabbitmq is healthy" 90 \
  '[[ "$(${COMPOSE} ps --status running --services | grep -c .)" -ge 3 ]]'
check "three services are running" "$?"

wait_for "the broker accepts connections" 60 \
  '${COMPOSE} exec -T rabbitmq rabbitmqctl -q await_startup'
check "broker answers rabbitmqctl" "$?"

# --- routing -------------------------------------------------------------------------
wait_for "the work queue exists" 60 "[[ -n \"\$(queue_value ${WORK_QUEUE} messages)\" ]]"
check "queue ${WORK_QUEUE} exists" "$?"

wait_for "the consumer subscribes to the queue" 60 "[[ \"\$(queue_value ${WORK_QUEUE} consumers)\" -ge 1 ]]"
check "queue ${WORK_QUEUE} has at least one consumer" "$?"

# --- message flow --------------------------------------------------------------------
published() { ${COMPOSE} logs --no-color producer 2>/dev/null | grep -c '"event": "published"'; }
results() { ${COMPOSE} logs --no-color consumer 2>/dev/null | grep -c '"event": "result"'; }
rejections() { ${COMPOSE} logs --no-color consumer 2>/dev/null | grep -c '"event": "rejected"'; }

wait_for "the producer publishes" 60 "[[ \"\$(published)\" -ge 3 ]]"
check "producer published at least 3 jobs" "$?"

wait_for "the consumer computes" 60 "[[ \"\$(results)\" -ge 3 ]]"
check "consumer logged at least 3 results" "$?"

# Every operation has its own routing key; the topic binding must accept all of them.
# The log is captured once: piping `docker compose logs` into `grep -q` would kill the
# writer with SIGPIPE, and `set -o pipefail` would report that as a failed check.
producer_logs="$(${COMPOSE} logs --no-color producer 2>/dev/null || true)"
routing_keys="$(printf '%s\n' "${producer_logs}" | grep -o '"routing_key": "[^"]*"' | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
dim "routing keys seen: ${routing_keys}"

case "${routing_keys}" in
  *"calc."*) check "jobs are published with a calc.<operation> routing key" 0 ;;
  *) check "jobs are published with a calc.<operation> routing key (none seen)" 1 ;;
esac

case "${producer_logs}" in
  *'"event": "unroutable"'*) check "no job was left unroutable" 1 ;;
  *) check "no job was left unroutable" 0 ;;
esac

# --- dead-letter path ----------------------------------------------------------------
wait_for "a failed job reaches the dead-letter queue" 90 "[[ \"\$(queue_value ${DLQ} messages)\" -ge 1 ]]"
check "queue ${DLQ} received at least one message" "$?"

[[ "$(rejections)" -ge 1 ]]
check "consumer logged at least one rejection with a reason" "$?"

dim "dead letters: $(queue_value "${DLQ}" messages), waiting to be processed: $(queue_value "${WORK_QUEUE}" messages)"

# --- durability (optional) -----------------------------------------------------------
if [[ "${FULL}" -eq 1 ]]; then
  echo
  dim "restarting the broker to check that durable queues survive"
  ${COMPOSE} restart rabbitmq >/dev/null 2>&1
  wait_for "the broker is back" 90 \
    '${COMPOSE} exec -T rabbitmq rabbitmqctl -q await_startup'
  check "broker restarted" "$?"

  wait_for "the queue is still declared" 60 "[[ -n \"\$(queue_value ${WORK_QUEUE} messages)\" ]]"
  check "queue ${WORK_QUEUE} survived the restart" "$?"

  wait_for "the services reconnect" 90 "[[ \"\$(queue_value ${WORK_QUEUE} consumers)\" -ge 1 ]]"
  check "a consumer reconnected after the restart" "$?"
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  green "all checks passed"
else
  red "${failures} check(s) failed"
  dim "next: ${COMPOSE} logs --tail=50 producer consumer rabbitmq"
fi

exit "${failures}"
