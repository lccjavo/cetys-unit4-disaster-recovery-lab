#!/usr/bin/env bash
# Lab 1: manually promotes the standby to primary and redirects the application.
# Split-brain protection:
#   1. Refuses to promote while the primary still accepts connections.
#   2. Fences the original primary: it cannot start as a primary afterwards.
# Usage: ./scripts/lab1-failover.sh [--stop-primary]
source "$(dirname "$0")/lib/common.sh"

require_docker
STOP_PRIMARY=false
[ "${1:-}" = "--stop-primary" ] && STOP_PRIMARY=true

service_running postgres-standby || fail "postgres-standby is not running. Start Lab 1: ./scripts/start.sh lab1"
[ "$(in_recovery postgres-standby)" = "t" ] || fail "postgres-standby is no longer in standby mode (was it already promoted?)."

primary_alive=false
if service_running postgres-primary && docker compose exec -T postgres-primary pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  primary_alive=true
fi
if [ "$primary_alive" = "true" ]; then
  if [ "$STOP_PRIMARY" = "true" ]; then
    info "Stopping postgres-primary before promoting (--stop-primary)"
    docker compose stop postgres-primary >/dev/null
  else
    fail "postgres-primary is still accepting connections. Promoting now would cause SPLIT BRAIN.
       Stop it first:  docker compose stop postgres-primary"
  fi
fi

# When the primary was stopped (to measure the total recovery time).
PID="$(docker compose ps -a -q postgres-primary | head -1)"
STOPPED_AT=""
if [ -n "$PID" ]; then
  STOPPED_AT="$(docker inspect -f '{{.State.FinishedAt}}' "$PID" 2>/dev/null)"
fi

T0="$(now_epoch)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "Fencing the original primary (lab-control/primary.fenced)"
control_write postgres-standby primary.fenced "fenced_at=$NOW
reason=manual failover: postgres-standby promoted
reset=./scripts/reset-lab.sh lab1
"

info "Promoting postgres-standby with pg_promote()"
res="$(pg_sql postgres-standby "SELECT pg_promote(true, 60)")"
[ "$res" = "t" ] || fail "pg_promote did not confirm the promotion (result: $res)"
for i in $(seq 1 30); do
  [ "$(in_recovery postgres-standby)" = "f" ] && break
  sleep 1
done
[ "$(in_recovery postgres-standby)" = "f" ] || fail "The standby is still in recovery."
T1="$(now_epoch)"
TL="$(pg_sql postgres-standby "SELECT timeline_id FROM pg_control_checkpoint()")"
ok "postgres-standby is the new primary (timeline $TL) after $((T1 - T0)) s"

PREV="$(current_target)"
control_write postgres-standby db-target "postgres-standby"
control_append postgres-standby db-target.log "$NOW|$PREV|postgres-standby|lab1-failover.sh|failover"

info "Waiting for the hotel application to reconnect..."
RECONNECTED=""
for i in $(seq 1 30); do
  h="$(curl -s -m 3 "http://127.0.0.1:${HOTEL_APP_PORT}/health" || true)"
  if echo "$h" | grep -q '"status":"up","target":"postgres-standby"'; then RECONNECTED="$(now_epoch)"; break; fi
  sleep 1
done

OUTAGE=""
if [ -n "$STOPPED_AT" ] && [ "${STOPPED_AT:0:4}" != "0001" ] && [ -n "$RECONNECTED" ]; then
  STOP_EPOCH="$(docker compose exec -T postgres-standby date -u -d "$STOPPED_AT" +%s 2>/dev/null || echo "")"
  [ -n "$STOP_EPOCH" ] && OUTAGE=$((RECONNECTED - STOP_EPOCH))
fi
control_append postgres-standby failover.log "{\"promoted\":\"postgres-standby\",\"promoted_at\":\"$NOW\",\"promote_seconds\":$((T1 - T0)),\"timeline\":$TL,\"primary_stopped_at\":\"$STOPPED_AT\",\"outage_seconds\":${OUTAGE:-null}}"

echo
if [ -n "$RECONNECTED" ]; then ok "The hotel application now uses postgres-standby"; else warn "The application has not confirmed the reconnection yet; check http://localhost:${HOTEL_APP_PORT}/dr"; fi
echo "    Promotion: $((T1 - T0)) s"
[ -n "$OUTAGE" ] && echo "    Total time from primary stop to application reconnect (measured RTO): ${OUTAGE} s"
echo "    The original primary stays fenced. To rebuild the lab: ./scripts/reset-lab.sh lab1"
