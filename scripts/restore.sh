#!/usr/bin/env bash
# Lab restores.
#
#   ./scripts/restore.sh pitr [--name POINT | --time "YYYY-MM-DD HH:MM:SS+00"] [--backup base-...] [--no-switch]
#       Point-in-Time Recovery into the separate postgres-recovery instance (lab2 profile):
#       copies the base backup, replays the archived WAL up to the target and promotes.
#       The original primary and the backups are NOT modified.
#
#   ./scripts/restore.sh keys [file|latest]
#       Restores missing KEKs from an independent Key Vault backup.
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-}"; shift || true

restore_keys() {
  service_running key-vault || fail "The Key Vault is not running: docker compose up -d key-vault"
  local file="${1:-latest}"
  info "Restoring KEKs from backup: $file"
  vault_cli restore "$file" | sed 's/^/    /'
  ok "KEKs restored. Existing KEKs are never replaced; only missing ones are added."
}

restore_pitr() {
  local name="" time="" backup="" switch=true
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --time) time="$2"; shift 2 ;;
      --backup) backup="$2"; shift 2 ;;
      --no-switch) switch=false; shift ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  local reader
  reader="$(current_primary 2>/dev/null || echo hotel-app)"
  if [ -z "$name" ] && [ -z "$time" ]; then
    name="$(control_read "$reader" restore-points.log | tail -1 | cut -d'|' -f2)"
    [ -n "$name" ] || fail "There are no restore points. Create one with ./scripts/lab2-recovery-point.sh before_deletion"
    info "Using the most recent restore point: $name"
  fi
  [ -z "$name" ] || [[ "$name" =~ ^[a-z0-9_]{3,40}$ ]] || fail "Invalid restore point name"

  local args=()
  [ -n "$name" ] && args+=(--name "$name")
  [ -n "$time" ] && args+=(--time "$time")
  [ -n "$backup" ] && args+=(--backup "$backup")

  info "Stopping and cleaning only the disposable postgres-recovery instance"
  docker compose --profile lab2 rm -sf postgres-recovery >/dev/null 2>&1 || true

  info "Preparing the recovery volume (base backup + PITR configuration)"
  docker compose --profile lab2 run --rm --no-deps -T --entrypoint lab-prepare-recovery.sh postgres-recovery "${args[@]}" \
    || fail "The recovery could not be prepared."

  local t0 t1
  t0="$(now_epoch)"
  info "Starting postgres-recovery: replaying archived WAL up to '${name:-$time}'..."
  docker compose --profile lab2 up -d --no-deps postgres-recovery >/dev/null

  local done_ok=false
  for i in $(seq 1 150); do
    if ! service_running postgres-recovery; then
      docker compose --profile lab2 logs --tail 30 postgres-recovery
      fail "postgres-recovery stopped during recovery (see the log above)."
    fi
    if [ "$(in_recovery postgres-recovery 2>/dev/null)" = "f" ]; then done_ok=true; break; fi
    sleep 2
  done
  [ "$done_ok" = "true" ] || { docker compose --profile lab2 logs --tail 30 postgres-recovery; fail "The recovery did not finish in time."; }
  t1="$(now_epoch)"

  docker compose --profile lab2 logs postgres-recovery 2>/dev/null | grep -E "recovery stopping|starting point-in-time|redo done|archive recovery complete|selected new timeline" | sed 's/^/    /' | tail -6
  local customers reservations
  customers="$(pg_sql postgres-recovery "SELECT count(*) FROM customers")"
  reservations="$(pg_sql postgres-recovery "SELECT count(*) FROM reservations")"
  ok "PITR completed in $((t1 - t0)) s: $customers customers and $reservations reservations on postgres-recovery"

  local prepared
  prepared="$(control_read postgres-recovery last-restore.json)"
  local bk
  bk="$(echo "$prepared" | sed -n 's/.*"backup": *"\([^"]*\)".*/\1/p')"
  control_write postgres-recovery last-restore.json "{
  \"prepared_at\": \"$(echo "$prepared" | sed -n 's/.*"prepared_at": *"\([^"]*\)".*/\1/p')\",
  \"completed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
  \"backup\": \"$bk\",
  \"target_name\": \"$name\",
  \"target_time\": \"$time\",
  \"status\": \"completed\",
  \"duration_s\": $((t1 - t0)),
  \"customers\": $customers,
  \"reservations\": $reservations
}"

  if [ "$switch" = "true" ]; then
    local prev
    prev="$(current_target)"
    control_write postgres-recovery db-target "postgres-recovery"
    control_append postgres-recovery db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$prev|postgres-recovery|restore.sh|pitr"
    ok "The hotel application now uses postgres-recovery (it reconnects in ~2 s)."
  fi
  echo "    Inspect with DBeaver: 127.0.0.1:${POSTGRES_RECOVERY_HOST_PORT} (user ${DB_READER_USER:-lab_reader})"
  echo "    The original primary (127.0.0.1:${POSTGRES_HOST_PORT}) keeps the post-deletion state."
}

case "$MODE" in
  pitr) restore_pitr "$@" ;;
  keys) restore_keys "$@" ;;
  *) fail "Usage: ./scripts/restore.sh pitr [--name POINT|--time TS] | keys [file|latest]" ;;
esac
