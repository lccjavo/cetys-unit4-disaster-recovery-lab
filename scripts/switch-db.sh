#!/usr/bin/env bash
# Switches the PostgreSQL server used by the hotel application (without restarting it).
# Usage: ./scripts/switch-db.sh postgres-primary|postgres-standby|postgres-recovery
source "$(dirname "$0")/lib/common.sh"
require_docker
HOST="${1:-}"
case "$HOST" in postgres-primary|postgres-standby|postgres-recovery) ;; *) fail "Usage: ./scripts/switch-db.sh postgres-primary|postgres-standby|postgres-recovery" ;; esac
service_running "$HOST" || fail "$HOST is not running."
[ "$(in_recovery "$HOST")" = "f" ] || fail "$HOST is in standby/recovery mode (read-only) or not responding. Not switching."
PREV="$(current_target)"
control_write "$HOST" db-target "$HOST"
control_append "$HOST" db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$PREV|$HOST|switch-db.sh|manual"
ok "The application will use $HOST (previously: $PREV). It reconnects in about 2 seconds."
