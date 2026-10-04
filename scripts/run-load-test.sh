#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE="${CONTROL_PLANE:-camillej@192.168.122.10}"
SCENARIO="${SCENARIO:-catalog}"
USER_POOL_SIZE="${USER_POOL_SIZE:-5}"
if [[ -n "${CONCURRENCY:-}" ]]; then
  CONCURRENCY="$CONCURRENCY"
elif [[ "$SCENARIO" == "booking" ]]; then
  CONCURRENCY="$USER_POOL_SIZE"
else
  CONCURRENCY=500
fi
DURATION_SECONDS="${DURATION_SECONDS:-100}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
LOAD_URL="${LOAD_URL:-http://192.168.122.1:8080}"
LOADTEST_CLEANUP_CANCELLED="${LOADTEST_CLEANUP_CANCELLED:-1}"
AUTH_CONCURRENCY="${AUTH_CONCURRENCY:-3}"
THINK_TIME_MS="${THINK_TIME_MS:-1000}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${LOAD_RESULTS_DIR:-/tmp/reservation-load-${STAMP}}"
WATCH_PID=""
AUTH_RATE_LIMIT_TEMPORARY=0
AUTH_RATE_LIMIT_ORIGINAL=10

mkdir -p "$OUT"
if [[ "$SCENARIO" == "booking" ]]; then
  [[ "$USER_POOL_SIZE" =~ ^[0-9]+$ && "$CONCURRENCY" =~ ^[0-9]+$ && "$AUTH_CONCURRENCY" =~ ^[0-9]+$ ]] || { echo 'USER_POOL_SIZE, CONCURRENCY et AUTH_CONCURRENCY doivent etre numeriques.' >&2; exit 2; }
  (( USER_POOL_SIZE >= 1 && USER_POOL_SIZE <= 500 && CONCURRENCY >= 1 && CONCURRENCY <= USER_POOL_SIZE && AUTH_CONCURRENCY >= 1 && AUTH_CONCURRENCY <= 20 )) || { echo 'Limites booking: pool 1..500, concurrence <= pool, AUTH_CONCURRENCY 1..20.' >&2; exit 2; }
fi
ssh -o BatchMode=yes "$CONTROL_PLANE" 'kubectl get nodes >/dev/null && kubectl get hpa -n app-reservation >/dev/null'

if [[ "$SCENARIO" == "booking" && -z "${LOADTEST_PASSWORD:-}" ]]; then
  PASSWORD_FILE="${LOADTEST_PASSWORD_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/reservation-app/loadtest-password}"
  mkdir -p "$(dirname "$PASSWORD_FILE")"
  chmod 700 "$(dirname "$PASSWORD_FILE")"
  if [[ ! -s "$PASSWORD_FILE" ]]; then
    (umask 077; openssl rand -hex 32 >"$PASSWORD_FILE")
  fi
  chmod 600 "$PASSWORD_FILE"
  LOADTEST_PASSWORD="$(<"$PASSWORD_FILE")"
fi

restore_auth_limit() {
  if [[ "$AUTH_RATE_LIMIT_TEMPORARY" == "1" ]]; then
    printf 'Restauration de AUTH_RATE_LIMIT a %s...\n' "$AUTH_RATE_LIMIT_ORIGINAL"
    if ssh -o BatchMode=yes "$CONTROL_PLANE" "kubectl set env deployment/backend-deployment -n app-reservation AUTH_RATE_LIMIT=${AUTH_RATE_LIMIT_ORIGINAL} && kubectl rollout status deployment/backend-deployment -n app-reservation --timeout=180s" >>"$OUT/auth-limit.log" 2>&1; then
      AUTH_RATE_LIMIT_TEMPORARY=0
    else
      echo 'ECHEC: limite d authentification non restauree. Executer kubectl set env deployment/backend-deployment -n app-reservation AUTH_RATE_LIMIT=10' >&2
    fi
  fi
}

cleanup() {
  if [[ -n "$WATCH_PID" ]]; then
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
    WATCH_PID=""
  fi
  restore_auth_limit
}
trap cleanup EXIT
trap 'exit 130' INT TERM

WATCH_SECONDS=$((DURATION_SECONDS + 600))
ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$WATCH_SECONDS" "$INTERVAL_SECONDS" <<'REMOTE' >"$OUT/cluster-watch.log" 2>&1 &
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

if [[ "$SCENARIO" == "booking" && "$USER_POOL_SIZE" -gt 10 ]]; then
  AUTH_RATE_LIMIT_ORIGINAL="$(ssh -o BatchMode=yes "$CONTROL_PLANE" "kubectl get deployment backend-deployment -n app-reservation -o jsonpath='{.spec.template.spec.containers[?(@.name==\"backend\")].env[?(@.name==\"AUTH_RATE_LIMIT\")].value}'")"
  AUTH_RATE_LIMIT_ORIGINAL="${AUTH_RATE_LIMIT_ORIGINAL:-10}"
  AUTH_RATE_LIMIT_TEMPORARY=1
  if ! ssh -o BatchMode=yes "$CONTROL_PLANE" 'kubectl set env deployment/backend-deployment -n app-reservation AUTH_RATE_LIMIT=1000 && kubectl rollout status deployment/backend-deployment -n app-reservation --timeout=180s' >"$OUT/auth-limit.log" 2>&1; then
    echo 'Impossible d appliquer la limite temporaire AUTH_RATE_LIMIT=1000; tentative de restauration.' >&2
    restore_auth_limit
    exit 1
  fi
fi

printf 'Scenario %s: %s clients pendant %ss vers %s\nResultats: %s\n' "$SCENARIO" "$CONCURRENCY" "$DURATION_SECONDS" "$LOAD_URL" "$OUT"
if [[ "$SCENARIO" == "booking" ]]; then
  printf 'Pool fixe: %s comptes, provisionnement/authentification par lots de %s; pause parcours %sms.\n' "$USER_POOL_SIZE" "$AUTH_CONCURRENCY" "$THINK_TIME_MS"
fi
set +e
LOAD_URL="$LOAD_URL" SCENARIO="$SCENARIO" CONCURRENCY="$CONCURRENCY" \
  USER_POOL_SIZE="$USER_POOL_SIZE" DURATION_SECONDS="$DURATION_SECONDS" \
  AUTH_CONCURRENCY="$AUTH_CONCURRENCY" THINK_TIME_MS="$THINK_TIME_MS" \
  LOADTEST_PASSWORD="${LOADTEST_PASSWORD:-}" LOADTEST_BOOTSTRAP="${LOADTEST_BOOTSTRAP:-0}" \
  node "$ROOT/scripts/load-test.mjs" 2>&1 | tee "$OUT/load.log"
LOAD_STATUS=${PIPESTATUS[0]}
set -e

if [[ -n "$WATCH_PID" ]]; then
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
  WATCH_PID=""
fi
if [[ "$SCENARIO" == "booking" ]]; then
  ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$((DURATION_SECONDS + 600))" <<'REMOTE' >"$OUT/cluster-load-end.log" 2>&1
set -u
LOG_SECONDS="$1"
kubectl get hpa -n app-reservation
kubectl top nodes
kubectl top pods -n app-reservation --containers
kubectl get pods -n app-reservation -o wide
echo '===== backend application logs before restoring auth limit ====='
kubectl logs -n app-reservation -l app=backend-api --all-containers --prefix --since="${LOG_SECONDS}s" --max-log-requests=10 2>&1 | tail -n 5000
echo '===== PostgreSQL waits and counters before restoring auth limit ====='
kubectl exec -n app-reservation deployment/postgres-deployment -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT state, wait_event_type, wait_event, count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY state, wait_event_type, wait_event ORDER BY count(*) DESC; SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, deadlocks FROM pg_stat_database WHERE datname=current_database();"' || true
echo '===== Redis counters before restoring auth limit ====='
for pod in $(kubectl get pods -n app-reservation -l app=redis -o name); do
  kubectl exec -n app-reservation "$pod" -- sh -c 'redis-cli INFO memory; redis-cli INFO stats; redis-cli INFO clients' || true
done
REMOTE
fi
restore_auth_limit
if [[ "$SCENARIO" == "booking" && "$LOADTEST_CLEANUP_CANCELLED" == "1" ]]; then
  printf '\nNettoyage des commandes de test deja annulees...\n'
  if ! ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s <<'REMOTE' >"$OUT/cleanup.log" 2>&1
kubectl exec -i -n app-reservation deployment/postgres-deployment -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
DO $loadtest$
DECLARE
  order_row RECORD;
  item_row RECORD;
  recovered_orders INTEGER := 0;
BEGIN
  FOR order_row IN
    SELECT o.id
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE u.email LIKE 'k8s-loadtest-%@reservation.invalid'
      AND o.status = 'confirmed'
    ORDER BY o.id
    FOR UPDATE OF o
  LOOP
    FOR item_row IN
      SELECT event_id, seats FROM order_items
      WHERE order_id = order_row.id ORDER BY event_id
    LOOP
      UPDATE events
      SET available_seats = LEAST(total_seats, available_seats + item_row.seats)
      WHERE id = item_row.event_id;
    END LOOP;
    UPDATE orders SET status = 'cancelled' WHERE id = order_row.id;
    recovered_orders := recovered_orders + 1;
  END LOOP;
  RAISE NOTICE 'stranded_test_orders_cancelled=%', recovered_orders;
END
$loadtest$;
WITH deleted AS (DELETE FROM orders o
USING users u
WHERE o.user_id = u.id
  AND u.email LIKE 'k8s-loadtest-%@reservation.invalid'
  AND o.status = 'cancelled'
RETURNING 1)
SELECT count(*) AS cancelled_test_orders_removed FROM deleted;
COMMIT;
SQL
REMOTE
  then
    echo 'Nettoyage SQL impossible; les commandes annulees sont conservees. Voir cluster-final.log.' >&2
    LOAD_STATUS=1
  fi
fi
ssh -o BatchMode=yes "$CONTROL_PLANE" bash -s -- "$DURATION_SECONDS" <<'REMOTE' >"$OUT/cluster-final.log" 2>&1
set -u
SECONDS_BACK="$1"
LOG_SECONDS=$((SECONDS_BACK + 600))
kubectl get nodes -o wide
kubectl get deployments,hpa -n app-reservation
kubectl get pods -n app-reservation -o wide
kubectl describe hpa backend-hpa -n app-reservation
kubectl top nodes
kubectl top pods -n app-reservation --containers
kubectl get events -n app-reservation --sort-by=.lastTimestamp | tail -n 80
echo '===== backend cgroup cpu.stat ====='
for selector in app=backend-api app=postgres app=redis; do
  for pod in $(kubectl get pods -n app-reservation -l "$selector" -o name); do
    echo "--- $pod ---"
    kubectl exec -n app-reservation "$pod" -- cat /sys/fs/cgroup/cpu.stat || true
  done
done
echo '===== PostgreSQL load-test/database stats ====='
kubectl exec -n app-reservation deployment/postgres-deployment -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS persistent_loadtest_users FROM users WHERE email LIKE '\''k8s-loadtest-%@reservation.invalid'\''; SELECT status, count(*) FROM orders o JOIN users u ON u.id=o.user_id WHERE u.email LIKE '\''k8s-loadtest-%@reservation.invalid'\'' GROUP BY status; SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, deadlocks FROM pg_stat_database WHERE datname=current_database();"' || true
echo '===== Redis INFO ====='
for pod in $(kubectl get pods -n app-reservation -l app=redis -o name); do
  kubectl exec -n app-reservation "$pod" -- sh -c 'redis-cli INFO memory; redis-cli INFO stats; redis-cli INFO clients' || true
done
for selector in app=backend-api app=frontend-web; do
  echo "===== logs selector=$selector ====="
  kubectl logs -n app-reservation -l "$selector" --all-containers --prefix --since="${LOG_SECONDS}s" --max-log-requests=10 || true
done
REMOTE

printf '\nCollecte terminee. Charge: %s (0 signifie sans erreur HTTP/reseau).\n' "$LOAD_STATUS"
printf '  %s\n  %s\n  %s\n' "$OUT/load.log" "$OUT/cluster-watch.log" "$OUT/cluster-final.log"
exit "$LOAD_STATUS"
