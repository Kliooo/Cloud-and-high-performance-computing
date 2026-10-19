#!/usr/bin/env bash
# Build the two images and make them available to the local k3s containerd.
#
#   ./scripts/build-images.sh                 # build + import into k3s
#   PUSH=yes ./scripts/build-images.sh        # build + docker push (Docker Hub)
#
# REGISTRY/TAG must match the image names in k8s/base/*-deployment.yaml.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REGISTRY:-k1io}"
TAG="${TAG:-1.0.0}"
PUSH="${PUSH:-no}"

BACKEND_IMAGE="${REGISTRY}/k8s-demo-backend:${TAG}"
FRONTEND_IMAGE="${REGISTRY}/k8s-demo-frontend:${TAG}"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to build the images" >&2
  exit 1
}

echo "==> building ${BACKEND_IMAGE}"
docker build -t "${BACKEND_IMAGE}" "${ROOT_DIR}/backend"

echo "==> building ${FRONTEND_IMAGE}"
docker build -t "${FRONTEND_IMAGE}" "${ROOT_DIR}/frontend"

if [[ "${PUSH}" == "yes" ]]; then
  echo "==> pushing images"
  docker push "${BACKEND_IMAGE}"
  docker push "${FRONTEND_IMAGE}"
fi

if command -v k3s >/dev/null 2>&1; then
  SUDO=""
  if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi
  echo "==> importing images into the k3s containerd"
  docker save "${BACKEND_IMAGE}" "${FRONTEND_IMAGE}" | ${SUDO} k3s ctr images import -
  ${SUDO} k3s ctr images list | grep 'k8s-demo' || true
else
  echo "k3s not found: images are only in the local docker daemon"
  echo "for kind use: kind load docker-image ${BACKEND_IMAGE} ${FRONTEND_IMAGE}"
fi
