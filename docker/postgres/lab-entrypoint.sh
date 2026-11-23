#!/bin/bash
# Punto de entrada comun para los tres roles de PostgreSQL del laboratorio.
#   LAB_PG_ROLE=primary   -> servidor primario (inicializa la base la primera vez)
#   LAB_PG_ROLE=standby   -> se clona del primario con pg_basebackup y replica por streaming
#   LAB_PG_ROLE=recovery  -> instancia de PITR; sus datos los prepara scripts/restore.sh
set -euo pipefail

ROLE="${LAB_PG_ROLE:-primary}"
CLUSTER_NAME="${LAB_CLUSTER_NAME:-pg-$ROLE}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${LAB_PRIMARY_HOST:-postgres-primary}"

log() { echo "[lab-entrypoint:$ROLE] $*"; }

# Permisos de los volumenes compartidos.
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

# Proteccion contra split brain: un primario "cercado" despues de una promocion no arranca.
if [ "$ROLE" = "primary" ] && [ -f /lab-control/primary.fenced ]; then
  log "======================================================================"
  log "ESTE NODO FUE CERCADO (fenced) DURANTE UNA CONMUTACION POR ERROR."
  log "El standby fue promovido; arrancar este primario crearia split brain."
  log "Para reconstruir el laboratorio ejecute: ./scripts/reset-lab.sh lab1"
  log "Contenido del cerco:"
  cat /lab-control/primary.fenced || true
  log "======================================================================"
  exec sleep infinity
fi

if [ "$ROLE" = "standby" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "Directorio de datos vacio: clonando desde $PRIMARY_HOST con pg_basebackup"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  export PGPASSWORD="${REPLICATION_PASSWORD:?REPLICATION_PASSWORD requerido}"
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -q; do
    log "Esperando al primario $PRIMARY_HOST..."
    sleep 2
  done
  if ! gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U "${REPLICATION_USER:-replicator}" \
        -D "$PGDATA" -X stream -R -C -S standby_slot --checkpoint=fast; then
    log "El slot standby_slot ya existe; reintentando sin crearlo"
    find "$PGDATA" -mindepth 1 -delete
    gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U "${REPLICATION_USER:-replicator}" \
        -D "$PGDATA" -X stream -R -S standby_slot --checkpoint=fast
  fi
  unset PGPASSWORD
  log "Clonacion completa; standby.signal creado"
fi

if [ "$ROLE" = "recovery" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "No hay datos restaurados en este volumen."
  log "Prepare la recuperacion con: ./scripts/restore.sh pitr --name <punto>"
  exec sleep infinity
fi

ARCHIVE_MODE=on
if [ "$ROLE" = "recovery" ]; then
  # La instancia de recuperacion no escribe en el archivo WAL compartido, para que
  # la recuperacion sea repetible y no se mezclen lineas de tiempo.
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
