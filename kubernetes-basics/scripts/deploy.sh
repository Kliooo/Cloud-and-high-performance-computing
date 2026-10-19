#!/usr/bin/env bash
# Deploy the demo to the current kubectl context.
#
#   ./scripts/deploy.sh            # cloud overlay (LoadBalancer on 8081)
#   ./scripts/deploy.sh local      # kind/minikube overlay (NodePort 30080)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="${1:-cloud}"
NAMESPACE="k8s-demo"

command -v kubectl >/dev/null 2>&1 || {
  echo "kubectl is not installed" >&2
  exit 1
}

echo "==> context: $(kubectl config current-context)"
echo "==> applying overlay: ${OVERLAY}"

kubectl apply -k "${ROOT_DIR}/k8s/overlays/${OVERLAY}"

echo "==> waiting for backend rollout"
kubectl -n "${NAMESPACE}" rollout status deployment/backend --timeout=240s

echo "==> waiting for frontend rollout"
kubectl -n "${NAMESPACE}" rollout status deployment/frontend --timeout=240s

echo
kubectl -n "${NAMESPACE}" get pods -o wide
echo
kubectl -n "${NAMESPACE}" get svc
echo
kubectl -n "${NAMESPACE}" get hpa

# Resolve a URL to hand to the smoke test.
IP="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
PORT="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.spec.ports[0].port}')"

if [[ -z "${IP}" ]]; then
  IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}')"
  [[ -z "${IP}" ]] && IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
  PORT="$(kubectl -n "${NAMESPACE}" get svc frontend -o jsonpath='{.spec.ports[0].nodePort}')"
fi

echo
echo "frontend: http://${IP}:${PORT}"
echo "next:     ./scripts/smoke-test.sh http://${IP}:${PORT}"
