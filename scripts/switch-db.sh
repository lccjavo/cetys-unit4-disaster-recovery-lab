#!/usr/bin/env bash
# Cambia el servidor PostgreSQL que usa la aplicacion del hotel (sin reiniciarla).
# Uso: ./scripts/switch-db.sh postgres-primary|postgres-standby|postgres-recovery
source "$(dirname "$0")/lib/common.sh"
require_docker
HOST="${1:-}"
case "$HOST" in postgres-primary|postgres-standby|postgres-recovery) ;; *) fail "Uso: ./scripts/switch-db.sh postgres-primary|postgres-standby|postgres-recovery" ;; esac
service_running "$HOST" || fail "$HOST no esta en ejecucion."
[ "$(in_recovery "$HOST")" = "f" ] || fail "$HOST esta en modo standby/recuperacion (solo lectura) o no responde. No se cambia."
PREV="$(current_target)"
control_write "$HOST" db-target "$HOST"
control_append "$HOST" db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$PREV|$HOST|switch-db.sh|manual"
ok "La aplicacion usara $HOST (antes: $PREV). Se reconecta en unos 2 segundos."
