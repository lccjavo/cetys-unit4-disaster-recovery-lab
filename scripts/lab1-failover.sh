#!/usr/bin/env bash
# Laboratorio 1: promueve manualmente el standby a primario y redirige la aplicacion.
# Proteccion contra split brain:
#   1. Se niega a promover si el primario sigue aceptando conexiones.
#   2. Cerca (fence) al primario original: no podra arrancar como primario despues.
# Uso: ./scripts/lab1-failover.sh [--stop-primary]
source "$(dirname "$0")/lib/common.sh"

require_docker
STOP_PRIMARY=false
[ "${1:-}" = "--stop-primary" ] && STOP_PRIMARY=true

service_running postgres-standby || fail "postgres-standby no esta en ejecucion. Inicie el laboratorio 1: ./scripts/start.sh lab1"
[ "$(in_recovery postgres-standby)" = "t" ] || fail "postgres-standby ya no esta en modo standby (¿ya fue promovido?)."

primary_alive=false
if service_running postgres-primary && docker compose exec -T postgres-primary pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  primary_alive=true
fi
if [ "$primary_alive" = "true" ]; then
  if [ "$STOP_PRIMARY" = "true" ]; then
    info "Deteniendo postgres-primary antes de promover (--stop-primary)"
    docker compose stop postgres-primary >/dev/null
  else
    fail "postgres-primary sigue aceptando conexiones. Promover ahora crearia SPLIT BRAIN.
       Detengalo primero:  docker compose stop postgres-primary"
  fi
fi

# Momento en que se detuvo el primario (para medir el tiempo total de recuperacion).
PID="$(docker compose ps -a -q postgres-primary | head -1)"
STOPPED_AT=""
if [ -n "$PID" ]; then
  STOPPED_AT="$(docker inspect -f '{{.State.FinishedAt}}' "$PID" 2>/dev/null)"
fi

T0="$(now_epoch)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "Cercando el primario original (lab-control/primary.fenced)"
control_write postgres-standby primary.fenced "fenced_at=$NOW
reason=failover manual: postgres-standby promovido
reset=./scripts/reset-lab.sh lab1
"

info "Promoviendo postgres-standby con pg_promote()"
res="$(pg_sql postgres-standby "SELECT pg_promote(true, 60)")"
[ "$res" = "t" ] || fail "pg_promote no confirmo la promocion (resultado: $res)"
for i in $(seq 1 30); do
  [ "$(in_recovery postgres-standby)" = "f" ] && break
  sleep 1
done
[ "$(in_recovery postgres-standby)" = "f" ] || fail "El standby sigue en recuperacion."
T1="$(now_epoch)"
TL="$(pg_sql postgres-standby "SELECT timeline_id FROM pg_control_checkpoint()")"
ok "postgres-standby es el nuevo primario (timeline $TL) en $((T1 - T0)) s"

PREV="$(current_target)"
control_write postgres-standby db-target "postgres-standby"
control_append postgres-standby db-target.log "$NOW|$PREV|postgres-standby|lab1-failover.sh|failover"

info "Esperando a que la aplicacion del hotel se reconecte..."
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
if [ -n "$RECONNECTED" ]; then ok "La aplicacion del hotel ya usa postgres-standby"; else warn "La aplicacion aun no confirma la reconexion; revise http://localhost:${HOTEL_APP_PORT}/dr"; fi
echo "    Promocion: $((T1 - T0)) s"
[ -n "$OUTAGE" ] && echo "    Tiempo total desde que se detuvo el primario hasta la reconexion (RTO medido): ${OUTAGE} s"
echo "    El primario original queda cercado. Para reconstruir el laboratorio: ./scripts/reset-lab.sh lab1"
