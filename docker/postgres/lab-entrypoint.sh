#!/bin/bash
# Shared entrypoint for the three PostgreSQL roles in the lab.
#   LAB_PG_ROLE=primary   -> primary server (initializes the database the first time)
#   LAB_PG_ROLE=standby   -> cloned from the primary with pg_basebackup, streaming replication
#   LAB_PG_ROLE=recovery  -> PITR instance; its data is prepared by scripts/restore.sh
set -euo pipefail

ROLE="${LAB_PG_ROLE:-primary}"
CLUSTER_NAME="${LAB_CLUSTER_NAME:-pg-$ROLE}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${LAB_PRIMARY_HOST:-postgres-primary}"

log() { echo "[lab-entrypoint:$ROLE] $*"; }

# Permissions on the shared volumes.
for d in /wal-archive /backups /backups/catalog; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    chown postgres:postgres "$d" 2>/dev/null || true
    chmod 0755 "$d" 2>/dev/null || true
  fi
done
mkdir -p /lab-control && chmod 1777 /lab-control 2>/dev/null || true

if [ "${1:-postgres}" != "postgres" ]; then
  exec "$@"
fi
shift || true

# Split-brain protection: a primary "fenced" after a promotion does not start.
if [ "$ROLE" = "primary" ] && [ -f /lab-control/primary.fenced ]; then
  log "======================================================================"
  log "THIS NODE WAS FENCED DURING A FAILOVER."
  log "The standby was promoted; starting this primary would cause split brain."
  log "To rebuild the lab run: ./scripts/reset-lab.sh lab1"
  log "Fence contents:"
  cat /lab-control/primary.fenced || true
  log "======================================================================"
  exec sleep infinity
fi

if [ "$ROLE" = "standby" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "Empty data directory: cloning from $PRIMARY_HOST with pg_basebackup"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  export PGPASSWORD="${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -q; do
    log "Waiting for primary $PRIMARY_HOST..."
    sleep 2
  done
  if ! gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U "${REPLICATION_USER:-replicator}" \
        -D "$PGDATA" -X stream -R -C -S standby_slot --checkpoint=fast; then
    log "Slot standby_slot already exists; retrying without creating it"
    find "$PGDATA" -mindepth 1 -delete
    gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U "${REPLICATION_USER:-replicator}" \
        -D "$PGDATA" -X stream -R -S standby_slot --checkpoint=fast
  fi
  unset PGPASSWORD
  log "Clone complete; standby.signal created"
fi

if [ "$ROLE" = "recovery" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "There is no restored data in this volume."
  log "Prepare the recovery with: ./scripts/restore.sh pitr --name <restore_point>"
  exec sleep infinity
fi

ARCHIVE_MODE=on
if [ "$ROLE" = "recovery" ]; then
  # The recovery instance does not write to the shared WAL archive, so recovery
  # stays repeatable and timelines are never mixed.
  ARCHIVE_MODE=off
fi

exec docker-entrypoint.sh postgres \
  -c listen_addresses='*' \
  -c cluster_name="$CLUSTER_NAME" \
  -c wal_level=replica \
  -c max_wal_senders=10 \
  -c max_replication_slots=10 \
  -c wal_keep_size=256MB \
  -c max_slot_wal_keep_size=2GB \
  -c hot_standby=on \
  -c hot_standby_feedback=on \
  -c wal_log_hints=on \
  -c archive_mode="$ARCHIVE_MODE" \
  -c archive_command='/usr/local/bin/archive-wal.sh %p %f' \
  -c archive_timeout=60 \
  -c log_line_prefix='%m [%p] %q%u@%d ' \
  "$@"
