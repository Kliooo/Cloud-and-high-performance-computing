#!/usr/bin/env bash
# End-to-end check of the deployed system. Uses curl only, no jq.
#
#   ./scripts/smoke-test.sh                       # URL is discovered from the Service
#   ./scripts/smoke-test.sh http://1.2.3.4:8081
set -uo pipefail

NAMESPACE="k8s-demo"
URL="${1:-}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

failures=0

check() {
  local name="$1"
  local result="$2"
  if [[ "${result}" == "0" ]]; then
    green "PASS  ${name}"
  else
    red "FAIL  ${name}"
    failures=$((failures + 1))
  fi
}

if [[ -z "${URL}" ]]; then
  IP="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  PORT="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)"
  if [[ -z "${IP}" ]]; then
    IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}')"
    [[ -z "${IP}" ]] && IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
    PORT="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.spec.ports[0].nodePort}')"
  fi
  URL="http://${IP}:${PORT}"
fi

dim "frontend URL: ${URL}"
echo

# 1. Frontend serves the static page.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${URL}/" || echo 000)"
if [[ "${code}" == "200" ]]; then
  check "frontend / returns 200" 0
else
  check "frontend / returns 200 (got ${code})" 1
fi

# 2. Frontend health endpoint (used by probes).
body="$(curl -fsS --max-time 5 "${URL}/healthz" 2>/dev/null || true)"
if [[ "${body}" == "ok" ]]; then
  check "frontend /healthz returns ok" 0
else
  check "frontend /healthz returns ok (got '${body}')" 1
fi

# 3. nginx adds its pod name, so frontend replication is observable.
headers="$(curl -sS -D - -o /dev/null --max-time 5 "${URL}/api/ping" 2>/dev/null || true)"
echo "${headers}" | grep -qi '^x-frontend-pod:'; check "response carries X-Frontend-Pod header" "$?"

# 4. The proxy reaches the backend and the answer is JSON with a pod name.
ping="$(curl -fsS --max-time 5 "${URL}/api/ping" 2>/dev/null || true)"
echo "${ping}" | grep -q '"pod":"'; check "GET /api/ping returns a backend pod name" "$?"
echo "${ping}" | grep -q '"node":"'; check "GET /api/ping returns the node name" "$?"

# 5. Twenty requests must hit more than one backend replica (Service load balancing).
pods="$(for _ in $(seq 1 20); do
  curl -fsS --max-time 5 "${URL}/api/ping" 2>/dev/null | grep -o '"pod":"[^"]*"' | cut -d'"' -f4
done | sort -u)"
unique="$(printf '%s\n' "${pods}" | grep -c . || true)"
dim "backend replicas that answered: ${unique}"
if [[ "${unique}" -ge 2 ]]; then
  check "traffic is spread over at least 2 replicas" 0
else
  check "traffic is spread over at least 2 replicas (only ${unique} seen)" 1
fi

# 6. CPU work endpoint is deterministic: pi(200000) = 17984.
work="$(curl -fsS --max-time 30 "${URL}/api/work?n=200000" 2>/dev/null || true)"
echo "${work}" | grep -q '"primes":17984'; check "GET /api/work returns the expected result" "$?"

# 7. All expected replicas are Ready and the Service has endpoints.
expected="$(kubectl -n "${NAMESPACE}" get hpa backend -o jsonpath='{.spec.minReplicas}' 2>/dev/null || true)"
[[ -z "${expected}" ]] && expected=3
ready="$(kubectl -n "${NAMESPACE}" get pods -l app=backend --no-headers 2>/dev/null | grep -c 'Running' || true)"
dim "backend pods in Running state: ${ready} (expected at least ${expected})"
if [[ "${ready}" -ge "${expected}" ]]; then
  check "${expected}+ backend pods are Running" 0
else
  check "${expected}+ backend pods are Running (got ${ready})" 1
fi

endpoints="$(kubectl -n "${NAMESPACE}" get endpoints backend -o jsonpath='{range .subsets[*].addresses[*]}{.ip}{"\n"}{end}' 2>/dev/null | grep -c . || true)"
dim "backend Service endpoints: ${endpoints}"
if [[ "${endpoints}" -ge "${expected}" ]]; then
  check "backend Service has ${expected}+ endpoints" 0
else
  check "backend Service has ${expected}+ endpoints (got ${endpoints})" 1
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  green "all checks passed"
else
  red "${failures} check(s) failed"
  dim "next: kubectl -n ${NAMESPACE} get pods; kubectl -n ${NAMESPACE} logs -l app=backend --tail=50"
fi

exit "${failures}"
