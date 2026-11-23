#!/bin/bash
# Prepares the postgres-recovery instance volume for Point-in-Time Recovery.
# It only touches the disposable recovery volume; it never touches the primary,
# the backups or the WAL archive (both are mounted read-only).
#
# Usage: lab-prepare-recovery.sh --name <restore_point> | --time "<timestamp>" [--backup <base-...>]
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
TARGET_NAME=""
TARGET_TIME=""
BACKUP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name) TARGET_NAME="$2"; shift 2 ;;
    --time) TARGET_TIME="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "${LAB_PG_ROLE:-}" != "recovery" ]; then
  echo "ERROR: this script only runs in the postgres-recovery service" >&2
  exit 1
fi
if [ -z "$TARGET_NAME" ] && [ -z "$TARGET_TIME" ]; then
  echo "ERROR: specify --name or --time" >&2
  exit 2
fi

# Reference time of the target, used to pick a backup taken before it.
TARGET_EPOCH=""
if [ -n "$TARGET_NAME" ]; then
  if [ -f /lab-control/restore-points.log ]; then
    LINE=$(grep -F "|$TARGET_NAME|" /lab-control/restore-points.log | tail -1 || true)
    if [ -n "$LINE" ]; then
      TARGET_EPOCH=$(date -u -d "$(echo "$LINE" | cut -d'|' -f1)" +%s)
    fi
  fi
  if [ -z "$TARGET_EPOCH" ]; then
    echo "WARNING: restore point '$TARGET_NAME' is not in /lab-control/restore-points.log;"
    echo "         the most recent backup will be used."
  fi
else
  TARGET_EPOCH=$(date -u -d "$TARGET_TIME" +%s)
fi

if [ -z "$BACKUP" ]; then
  for f in $(ls -1 /backups/catalog/*.json 2>/dev/null | sort -r); do
    fin=$(sed -n 's/.*"finished_at": *"\([^"]*\)".*/\1/p' "$f")
    ok=$(sed -n 's/.*"verified": *\([a-z]*\).*/\1/p' "$f")
    [ "$ok" = "true" ] || continue
    if [ -z "$TARGET_EPOCH" ] || [ "$(date -u -d "$fin" +%s)" -lt "$TARGET_EPOCH" ]; then
      BACKUP=$(basename "$f" .json)
      break
    fi
  done
fi

if [ -z "$BACKUP" ] || [ ! -f "/backups/$BACKUP/backup_label" ]; then
  echo "ERROR: there is no verified base backup taken before the recovery target." >&2
  echo "       Create one with ./scripts/backup.sh db BEFORE creating the restore point." >&2
  exit 1
fi

echo "Selected base backup: $BACKUP"
echo "Cleaning the disposable recovery volume: $PGDATA"
mkdir -p "$PGDATA"
find "$PGDATA" -mindepth 1 -delete

echo "Copying the base backup..."
cp -a "/backups/$BACKUP/." "$PGDATA/"
rm -f "$PGDATA/standby.signal" "$PGDATA/postmaster.pid" "$PGDATA/backup_manifest"
touch "$PGDATA/recovery.signal"

{
  echo ""
  echo "# ---- PITR configuration written by lab-prepare-recovery.sh ----"
  echo "restore_command = 'cp /wal-archive/%f %p'"
  echo "primary_conninfo = ''"
  echo "primary_slot_name = ''"
  echo "recovery_target_timeline = 'current'"
  if [ -n "$TARGET_NAME" ]; then
    echo "recovery_target_name = '$TARGET_NAME'"
  else
    echo "recovery_target_time = '$TARGET_TIME'"
  fi
  echo "recovery_target_action = 'promote'"
} >> "$PGDATA/postgresql.auto.conf"

chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

cat > /lab-control/last-restore.json <<JSON
{
  "prepared_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup": "$BACKUP",
  "target_name": "$TARGET_NAME",
  "target_time": "$TARGET_TIME",
  "status": "prepared"
}
JSON
chmod 0644 /lab-control/last-restore.json
echo "PREPARED=$BACKUP"
