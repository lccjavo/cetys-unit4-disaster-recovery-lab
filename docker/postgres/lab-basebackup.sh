#!/bin/bash
# Physical backup with pg_basebackup into the /backups volume.
# Runs inside the current primary server container, as the postgres user:
#   docker compose exec -u postgres postgres-primary lab-basebackup.sh
set -euo pipefail

NAME="base-$(date -u +%Y%m%dT%H%M%SZ)"
DEST="/backups/$NAME"
CATALOG="/backups/catalog"
mkdir -p "$CATALOG"

if [ -e "$DEST" ]; then
  echo "ERROR: $DEST already exists" >&2
  exit 1
fi

IN_RECOVERY=$(psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_is_in_recovery()")
if [ "$IN_RECOVERY" != "f" ]; then
  echo "ERROR: this server is in recovery mode (standby). Back up the primary." >&2
  exit 1
fi

CLUSTER=$(psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW cluster_name")
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "Starting pg_basebackup of $CLUSTER into $DEST"

pg_basebackup -h /var/run/postgresql -U "$POSTGRES_USER" -D "$DEST" \
  -Fp -X stream --checkpoint=fast --label="$NAME" --manifest-checksums=SHA256 --progress

FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Verifying the backup with pg_verifybackup"
VERIFIED=false
if pg_verifybackup "$DEST" >/tmp/verify.log 2>&1; then
  VERIFIED=true
  cat /tmp/verify.log
else
  cat /tmp/verify.log >&2
fi

SYSID=$(pg_controldata "$DEST" | awk -F': *' '/Database system identifier/ {print $2}')
TLI=$(awk '/START TIMELINE/ {print $3}' "$DEST/backup_label")
START_WAL=$(awk -F'[()]' '/START WAL LOCATION/ {print $2}' "$DEST/backup_label" | sed 's/file //')
SIZE=$(du -sb "$DEST" | awk '{print $1}')
CUSTOMERS=$(psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM customers" 2>/dev/null || echo 0)

cat > "$CATALOG/$NAME.json" <<JSON
{
  "name": "$NAME",
  "path": "$DEST",
  "source_cluster": "$CLUSTER",
  "started_at": "$STARTED_AT",
  "finished_at": "$FINISHED_AT",
  "system_identifier": "$SYSID",
  "timeline": ${TLI:-1},
  "start_wal": "$START_WAL",
  "size_bytes": $SIZE,
  "customers_at_backup": $CUSTOMERS,
  "verified": $VERIFIED,
  "method": "pg_basebackup -Fp -X stream"
}
JSON
chmod 0644 "$CATALOG/$NAME.json"

echo "BACKUP=$NAME"
echo "VERIFIED=$VERIFIED"
[ "$VERIFIED" = true ]
