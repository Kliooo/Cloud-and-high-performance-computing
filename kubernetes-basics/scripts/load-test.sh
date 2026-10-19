#!/usr/bin/env bash
# Generate CPU load through the frontend and watch the HPA add replicas.
#
#   ./scripts/load-test.sh                      # 45 s, 4 workers, URL discovered
#   ./scripts/load-test.sh 60 6 http://1.2.3.4:8081
set -euo pipefail

DURATION="${1:-45}"
WORKERS="${2:-4}"
URL="${3:-}"
NAMESPACE="k8s-demo"

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

echo "target:   ${URL}/api/work"
echo "duration: ${DURATION}s, workers: ${WORKERS}"
echo

deadline=$(( $(date +%s) + DURATION ))

worker() {
  while [[ $(date +%s) -lt ${deadline} ]]; do
    curl -s -o /dev/null --max-time 30 "${URL}/api/work?n=1500000" || true
  done
}

for _ in $(seq 1 "${WORKERS}"); do
  worker &
done

while [[ $(date +%s) -lt ${deadline} ]]; do
  printf '%s  ' "$(date +%H:%M:%S)"
  kubectl -n "${NAMESPACE}" get hpa backend --no-headers 2>/dev/null \
    | awk '{printf "hpa=%s/%s cpu=%s  ", $5, $6, $4}' || true
  kubectl -n "${NAMESPACE}" get pods -l app=backend --no-headers 2>/dev/null | grep -c 'Running' \
    | awk '{printf "running=%s\n", $1}' || true
  sleep 10
done

wait
echo
echo "load finished; watching the scale-down window"
sleep 20
kubectl -n "${NAMESPACE}" get hpa backend
kubectl -n "${NAMESPACE}" get pods -l app=backend
