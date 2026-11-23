#!/bin/bash
# Se ejecuta una sola vez, cuando el volumen del primario esta vacio.
# Crea el rol de replicacion y permite conexiones de replicacion desde la red de Docker.
# Los roles de la aplicacion (hotel_app, lab_reader) los crea ./scripts/migrate.sh.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v repl_user="${REPLICATION_USER:-replicator}" -v repl_pass="$REPLICATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L', :'repl_user', :'repl_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'repl_user') \gexec
SQL

echo "host replication ${REPLICATION_USER:-replicator} all scram-sha-256" >> "$PGDATA/pg_hba.conf"
echo "[initdb] Rol de replicacion creado y pg_hba.conf actualizado"
