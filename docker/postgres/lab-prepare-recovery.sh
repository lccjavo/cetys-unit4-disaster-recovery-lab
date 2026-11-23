#!/bin/bash
# Prepara el volumen de la instancia postgres-recovery para Point-in-Time Recovery.
# Solo opera sobre el volumen desechable de recuperacion; nunca toca el primario,
# los respaldos ni el archivo WAL (ambos se montan en solo lectura).
#
# Uso: lab-prepare-recovery.sh --name <restore_point> | --time "<timestamp>" [--backup <base-...>]
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
    *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

if [ "${LAB_PG_ROLE:-}" != "recovery" ]; then
  echo "ERROR: este script solo se ejecuta en el servicio postgres-recovery" >&2
  exit 1
fi
if [ -z "$TARGET_NAME" ] && [ -z "$TARGET_TIME" ]; then
  echo "ERROR: indique --name o --time" >&2
  exit 2
fi

# Momento de referencia del objetivo, para elegir un respaldo anterior a el.
TARGET_EPOCH=""
if [ -n "$TARGET_NAME" ]; then
  if [ -f /lab-control/restore-points.log ]; then
    LINE=$(grep -F "|$TARGET_NAME|" /lab-control/restore-points.log | tail -1 || true)
    if [ -n "$LINE" ]; then
      TARGET_EPOCH=$(date -u -d "$(echo "$LINE" | cut -d'|' -f1)" +%s)
    fi
  fi
  if [ -z "$TARGET_EPOCH" ]; then
    echo "AVISO: el punto '$TARGET_NAME' no aparece en /lab-control/restore-points.log;"
    echo "       se usara el respaldo mas reciente."
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
  echo "ERROR: no hay un respaldo base verificado anterior al objetivo de recuperacion." >&2
  echo "       Cree uno con ./scripts/backup.sh db ANTES de crear el punto de restauracion." >&2
  exit 1
fi

echo "Respaldo base seleccionado: $BACKUP"
echo "Limpiando el volumen desechable de recuperacion: $PGDATA"
mkdir -p "$PGDATA"
find "$PGDATA" -mindepth 1 -delete

echo "Copiando el respaldo base..."
cp -a "/backups/$BACKUP/." "$PGDATA/"
rm -f "$PGDATA/standby.signal" "$PGDATA/postmaster.pid" "$PGDATA/backup_manifest"
touch "$PGDATA/recovery.signal"

{
  echo ""
  echo "# ---- Configuracion de PITR escrita por lab-prepare-recovery.sh ----"
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
echo "PREPARADO=$BACKUP"
