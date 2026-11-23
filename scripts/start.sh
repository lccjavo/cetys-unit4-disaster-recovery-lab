#!/usr/bin/env bash
# Starts the environment. Usage: ./scripts/start.sh [base|lab1]
#   base : postgres-primary + key-vault + hotel-app (default)
#   lab1 : also postgres-standby (streaming replication)
source "$(dirname "$0")/lib/common.sh"

MODE="${1:-base}"
require_docker
require_env_file

case "$MODE" in
  base) DC_PROFILES="" ;;
  lab1) DC_PROFILES="lab1" ;;
  *) fail "Unknown mode: $MODE (use base or lab1)" ;;
esac

info "Starting services ($MODE)..."
if [ "$MODE" = "lab1" ]; then
  dc up -d postgres-primary key-vault hotel-app postgres-standby
else
  dc up -d postgres-primary key-vault hotel-app
fi

for svc in postgres-primary key-vault hotel-app; do
  if [ "$svc" = "postgres-primary" ] && [ "$(current_target)" != "postgres-primary" ]; then continue; fi
  wait_healthy "$svc" 180 && ok "$svc healthy"
done
[ "$MODE" = "lab1" ] && { wait_healthy postgres-standby 180 && ok "postgres-standby healthy"; }

echo
echo "  Hotel Management : http://localhost:${HOTEL_APP_PORT}"
echo "  Key Vault        : http://localhost:${KEY_VAULT_APP_PORT}"
echo "  PostgreSQL       : 127.0.0.1:${POSTGRES_HOST_PORT} (DBeaver, user ${DB_READER_USER:-lab_reader})"
[ "$MODE" = "lab1" ] && echo "  Standby          : 127.0.0.1:${POSTGRES_STANDBY_HOST_PORT}"
echo "  Verify with      : ./scripts/verify-setup.sh"
exit 0
