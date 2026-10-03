#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE="${CONTROL_PLANE:-camillej@192.168.122.10}"
CONCURRENCY="${CONCURRENCY:-500}"
DURATION_SECONDS="${DURATION_SECONDS:-100}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
LOAD_URL="${LOAD_URL:-http://192.168.122.1:8080}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${LOAD_RESULTS_DIR:-/tmp/reservation-load-${STAMP}}"
WATCH_PID=""

mkdir -p "$OUT"
ssh -o BatchMode=yes "$CONTROL_PLANE" 'kubectl get nodes >/dev/null && kubectl get hpa -n app-reservation >/dev/null'

cleanup() {
  if [[ -n "$WATCH_PID" ]]; then
    kill "$WATCH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$DURATION_SECONDS" "$INTERVAL_SECONDS" <<'REMOTE' >"$OUT/cluster-watch.log" 2>&1 &
set -u
DURATION="$1"
INTERVAL="$2"
for ((elapsed = 0; elapsed <= DURATION; elapsed += INTERVAL)); do
  printf '\n===== %s elapsed=%ss =====\n' "$(date --iso-8601=seconds)" "$elapsed"
  kubectl get hpa -n app-reservation || true
  kubectl top nodes || true
  kubectl top pods -n app-reservation --containers || true
  kubectl get pods -n app-reservation -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,PHASE:.status.phase,NODE:.spec.nodeName' || true
  sleep "$INTERVAL"
done
REMOTE
WATCH_PID=$!

printf 'Charge: %s clients pendant %ss vers %s\nResultats: %s\n' "$CONCURRENCY" "$DURATION_SECONDS" "$LOAD_URL" "$OUT"
set +e
LOAD_URL="$LOAD_URL" CONCURRENCY="$CONCURRENCY" DURATION_SECONDS="$DURATION_SECONDS" \
  node "$ROOT/scripts/load-test.mjs" 2>&1 | tee "$OUT/load.log"
LOAD_STATUS=${PIPESTATUS[0]}
set -e

wait "$WATCH_PID"
WATCH_PID=""
ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$DURATION_SECONDS" <<'REMOTE' >"$OUT/cluster-final.log" 2>&1
set -u
SECONDS_BACK="$1"
kubectl get nodes -o wide
kubectl get deployments,hpa -n app-reservation
kubectl get pods -n app-reservation -o wide
kubectl describe hpa backend-hpa -n app-reservation
kubectl top nodes
kubectl top pods -n app-reservation --containers
kubectl get events -n app-reservation --sort-by=.lastTimestamp | tail -n 80
echo '===== backend cgroup cpu.stat ====='
for pod in $(kubectl get pods -n app-reservation -l app=backend-api -o name); do
  echo "--- $pod ---"
  kubectl exec -n app-reservation "$pod" -- cat /sys/fs/cgroup/cpu.stat || true
done
for selector in app=backend-api app=frontend-web; do
  echo "===== logs selector=$selector ====="
  kubectl logs -n app-reservation -l "$selector" --all-containers --prefix --since="${SECONDS_BACK}s" --max-log-requests=10 || true
done
REMOTE

printf '\nCollecte terminee. Charge: %s (0 signifie sans erreur HTTP/reseau).\n' "$LOAD_STATUS"
printf '  %s\n  %s\n  %s\n' "$OUT/load.log" "$OUT/cluster-watch.log" "$OUT/cluster-final.log"
exit "$LOAD_STATUS"
