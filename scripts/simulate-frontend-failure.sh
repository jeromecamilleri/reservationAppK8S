#!/usr/bin/env bash
set -euo pipefail

NODE_TO_TEST="${1:-k8s-worker1}"
CONTROL_PLANE="${CONTROL_PLANE:-camillej@192.168.122.10}"

ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$NODE_TO_TEST" <<'REMOTE'
set -euo pipefail
NODE_TO_TEST="$1"
NAMESPACE=app-reservation
CORDONED=0
cleanup() {
  if [[ "$CORDONED" == 1 ]]; then
    kubectl uncordon "$NODE_TO_TEST" >/dev/null || true
  fi
}
trap cleanup EXIT

kubectl get node "$NODE_TO_TEST" >/dev/null
kubectl cordon "$NODE_TO_TEST"
CORDONED=1
POD="$(kubectl get pods -n "$NAMESPACE" -o wide --no-headers | awk -v node="$NODE_TO_TEST" '$1 ~ /^frontend-deployment-/ && $7 == node && !found {pod=$1; found=1} END {if (found) print pod}')"
if [[ -z "$POD" ]]; then
  echo "Aucun pod frontend sur $NODE_TO_TEST; aucun pod n'a ete supprime."
  exit 1
fi
echo "Suppression du pod sans etat $POD sur $NODE_TO_TEST"
kubectl delete pod "$POD" -n "$NAMESPACE" --wait=true
kubectl rollout status deployment/frontend-deployment -n "$NAMESPACE" --timeout=180s
kubectl wait --for=condition=Ready pod -l app=frontend-web -n "$NAMESPACE" --timeout=120s
kubectl get pods -n "$NAMESPACE" -l app=frontend-web -o wide
kubectl uncordon "$NODE_TO_TEST"
CORDONED=0
REMOTE

curl --fail --silent --show-error http://192.168.122.1:8080/health >/dev/null
printf 'Service stable OK: http://192.168.122.1:8080\n'
