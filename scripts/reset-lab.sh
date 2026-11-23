#!/usr/bin/env bash
# Resets parts of the lab in a controlled way. Always asks for confirmation
# (or --yes) and lists exactly which volumes are removed.
#
#   ./scripts/reset-lab.sh lab1   rebuilds the primary/standby pair after a failover
#   ./scripts/reset-lab.sh lab2   removes the PITR recovery instance and returns the app to the primary
#   ./scripts/reset-lab.sh all    fresh database (150 customers again); KEEPS keys and their backups
#   ./scripts/reset-lab.sh all --include-keys   also deletes KEKs and KEK backups (start from zero)
#
# It never uses 'docker system prune' and never touches other projects' resources.
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-}"; shift || true
INCLUDE_KEYS=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --include-keys) INCLUDE_KEYS=true; shift ;;
    *) fail "Unknown option: $1" ;;
  esac
done

P="$COMPOSE_PROJECT_NAME"
vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
remove_volumes() {
  for v in "$@"; do
    if vol_exists "$v"; then docker volume rm "$v" >/dev/null && ok "Volume removed: $v"; else info "Did not exist: $v"; fi
  done
}
set_target_primary() {
  local prev
  prev="$(current_target)"
  control_write postgres-primary db-target "postgres-primary"
  control_append postgres-primary db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$prev|postgres-primary|reset-lab.sh|reset"
}

case "$MODE" in
  lab1)
    cat <<MSG
Lab 1 rebuild:
  - Removes the postgres-standby container and the ${P}_pg-standby-data volume
  - Removes the fence on the original primary and returns the application to postgres-primary
  - Clones the standby again from the primary with pg_basebackup
  Changes written to the standby AFTER the promotion are discarded.
  Kept: primary, backups, WAL archive, keys and key backups.
MSG
    confirm "" REBUILD
    docker compose --profile lab1 rm -sf postgres-standby >/dev/null 2>&1 || true
    remove_volumes "${P}_pg-standby-data"
    docker compose up -d --no-deps postgres-primary >/dev/null
    docker compose exec -T postgres-primary sh -c 'rm -f /lab-control/primary.fenced' 2>/dev/null || true
    docker compose up -d --no-deps --force-recreate postgres-primary >/dev/null
    wait_healthy postgres-primary 120 || fail "postgres-primary did not start."
    ok "postgres-primary online"
    set_target_primary
    docker compose --profile lab1 up -d --no-deps postgres-standby >/dev/null
    wait_healthy postgres-standby 180 || fail "postgres-standby did not start. Check: docker compose logs postgres-standby"
    ok "postgres-standby cloned and replicating"
    docker compose up -d hotel-app >/dev/null
    ok "Lab 1 rebuilt."
    ;;
  lab2)
    cat <<MSG
Lab 2 cleanup:
  - Removes the postgres-recovery container and the ${P}_pg-recovery-data volume
  - The application returns to postgres-primary (which keeps the simulated deletion)
  Kept: primary, physical backups, WAL archive, keys and key backups.
  To repeat the whole Lab 2 from 150 customers use: ./scripts/reset-lab.sh all
MSG
    confirm "" CLEAN
    docker compose --profile lab2 rm -sf postgres-recovery >/dev/null 2>&1 || true
    remove_volumes "${P}_pg-recovery-data"
    service_running postgres-primary || docker compose up -d postgres-primary >/dev/null
    wait_healthy postgres-primary 120 || true
    set_target_primary
    ok "Recovery instance removed; the application uses postgres-primary."
    ;;
  all)
    VOLS=("${P}_pg-primary-data" "${P}_pg-standby-data" "${P}_pg-recovery-data" "${P}_pg-wal-archive" "${P}_pg-backups" "${P}_lab-control")
    [ "$INCLUDE_KEYS" = "true" ] && VOLS+=("${P}_vault-keys" "${P}_vault-backups")
    echo "Full database reset of project $P. These volumes will be removed:"
    for v in "${VOLS[@]}"; do echo "  - $v"; done
    if [ "$INCLUDE_KEYS" = "true" ]; then
      echo "  WARNING: the KEKs and their backups are also deleted. Earlier copies will no longer be decryptable."
      confirm "" DELETE-ALL-AND-KEYS
    else
      echo "KEPT: ${P}_vault-keys and ${P}_vault-backups (the current KEKs are reused)."
      confirm "" RESET
    fi
    docker compose --profile lab1 --profile lab2 down --remove-orphans
    remove_volumes "${VOLS[@]}"
    info "Starting a clean environment (the app generates the 150 customers when it finds an empty database)..."
    docker compose up -d >/dev/null
    for svc in postgres-primary key-vault hotel-app; do wait_healthy "$svc" 180 || fail "$svc did not start"; done
    for i in $(seq 1 90); do
      n="$(pg_sql postgres-primary "SELECT count(*) FROM customers" 2>/dev/null || echo 0)"
      seeded="$(pg_sql postgres-primary "SELECT count(*) FROM lab_metadata WHERE key = 'seed_completed_at'" 2>/dev/null || echo 0)"
      [ "${seeded:-0}" = "1" ] && break
      sleep 2
    done
    [ "${seeded:-0}" = "1" ] || fail "Initialization did not finish. Check: docker compose logs hotel-app"
    ok "Environment reset: $n fictional customers."
    ;;
  *)
    fail "Usage: ./scripts/reset-lab.sh lab1|lab2|all [--yes] [--include-keys]"
    ;;
esac
