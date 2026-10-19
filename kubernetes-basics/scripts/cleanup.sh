#!/usr/bin/env bash
# Remove everything created by the demo.
#
#   ./scripts/cleanup.sh local
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="${1:-cloud}"

read -r -p "Delete the k8s-demo namespace and all its objects (${OVERLAY})? [y/N] " answer
if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
  echo "cancelled"
  exit 0
fi

kubectl delete -k "${ROOT_DIR}/k8s/overlays/${OVERLAY}" --ignore-not-found --wait=true
echo "done"
