#!/usr/bin/env bash
# Install a single-node k3s cluster on a fresh VM.
#
#   ./scripts/bootstrap-k3s.sh                 # internal IP only
#   ./scripts/bootstrap-k3s.sh 203.0.113.10    # advertise a public IP as well
#
# Traefik is disabled on purpose: it would bind host ports 80/443, and this VM
# already serves another site on port 80. ServiceLB (klipper-lb) stays enabled,
# so Service type=LoadBalancer keeps working.
set -euo pipefail

PUBLIC_IP="${1:-}"
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi

FLAGS="server --disable=traefik --write-kubeconfig-mode=0644"
if [[ -n "${PUBLIC_IP}" ]]; then
  FLAGS="${FLAGS} --node-external-ip=${PUBLIC_IP} --tls-san=${PUBLIC_IP}"
fi

echo "==> installing k3s: ${FLAGS}"
curl -sfL https://get.k3s.io | ${SUDO} INSTALL_K3S_EXEC="${FLAGS}" sh -

echo "==> waiting for the node"
for _ in $(seq 1 30); do
  ${SUDO} k3s kubectl get nodes >/dev/null 2>&1 && break
  sleep 2
done

${SUDO} k3s kubectl get nodes -o wide

if [[ ! -e /usr/local/bin/kubectl ]]; then
  ${SUDO} ln -s /usr/local/bin/k3s /usr/local/bin/kubectl || true
fi

echo
echo "kubeconfig: /etc/rancher/k3s/k3s.yaml"
echo "copy it to your workstation:"
echo "  scp <user>@<host>:/etc/rancher/k3s/k3s.yaml ~/.kube/k8s-demo.yaml"
echo "  # then replace 127.0.0.1 with the VM address in the server: line"
