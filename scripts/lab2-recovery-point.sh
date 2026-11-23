#!/usr/bin/env bash
# Creates a named restore point (pg_create_restore_point) and forces its WAL to be archived.
# Usage: ./scripts/lab2-recovery-point.sh [name]   (default: before_deletion)
source "$(dirname "$0")/lib/common.sh"

require_docker
NAME="${1:-before_deletion}"
[[ "$NAME" =~ ^[a-z0-9_]{3,40}$ ]] || fail "Invalid name. Use lowercase letters, digits and underscores (3 to 40)."

PRIMARY="$(current_primary)" || fail "No writable primary is running."
nb="$(docker compose exec -T "$PRIMARY" sh -c 'ls /backups/catalog/*.json 2>/dev/null | wc -l' | tr -d '[:space:]')"
[ "${nb:-0}" -gt 0 ] || warn "No base backup exists. Create one BEFORE the restore point: ./scripts/backup.sh db"

counts="$(pg_sql "$PRIMARY" "SELECT (SELECT count(*) FROM customers) || ' customers, ' || (SELECT count(*) FROM reservations) || ' reservations'")"
LSN="$(pg_sql "$PRIMARY" "SELECT pg_create_restore_point('$NAME')")"
WALFILE="$(pg_sql "$PRIMARY" "SELECT pg_walfile_name(pg_switch_wal())")"
info "Restore point '$NAME' created at LSN $LSN (state: $counts). Waiting for $WALFILE to be archived..."

for i in $(seq 1 60); do
  last="$(pg_sql "$PRIMARY" "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")"
  if [ -n "$last" ] && [[ ! "$last" < "$WALFILE" ]]; then break; fi
  sleep 1
done
[ -n "${last:-}" ] && [[ ! "$last" < "$WALFILE" ]] || fail "Segment $WALFILE was not archived in time. Check: docker compose logs $PRIMARY"

AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
control_append "$PRIMARY" restore-points.log "$AT|$NAME|$LSN"
ok "Restore point '$NAME' is ready and archived (WAL $last)."
echo "    Log: /lab-control/restore-points.log"
echo "    Recover with: ./scripts/restore.sh pitr --name $NAME"
