#!/bin/bash
# Runs only once, when the primary volume is empty.
# Creates the replication role and allows replication connections from the Docker network.
# The application roles (hotel_app, lab_reader) are created by ./scripts/migrate.sh.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v repl_user="${REPLICATION_USER:-replicator}" -v repl_pass="$REPLICATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L', :'repl_user', :'repl_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'repl_user') \gexec
SQL

echo "host replication ${REPLICATION_USER:-replicator} all scram-sha-256" >> "$PGDATA/pg_hba.conf"
echo "[initdb] Replication role created and pg_hba.conf updated"
