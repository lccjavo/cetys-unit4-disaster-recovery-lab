#!/usr/bin/env bash
# Respaldos independientes:
#   ./scripts/backup.sh db     respaldo fisico de PostgreSQL con pg_basebackup (volumen pg-backups)
#   ./scripts/backup.sh keys   respaldo cifrado de los KEK del Key Vault (volumen vault-backups)
#   ./scripts/backup.sh list   lista ambos tipos de respaldo
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-db}"

backup_db() {
  local primary
  primary="$(current_primary)" || fail "No hay un servidor PostgreSQL primario (escribible) en ejecucion."
  info "Respaldo fisico de $primary con pg_basebackup (incluye el WAL necesario, -X stream)"
  local out
  out="$(docker compose exec -T -u postgres "$primary" lab-basebackup.sh 2>&1)" || { echo "$out"; fail "pg_basebackup o pg_verifybackup fallo."; }
  echo "$out" | grep -vE '^[0-9]+/[0-9]+ kB' | sed 's/^/    /'
  local name
  name="$(echo "$out" | sed -n 's/^RESPALDO=//p')"
  ok "Respaldo base creado y verificado: $name"
  echo "    Ubicacion: volumen ${COMPOSE_PROJECT_NAME}_pg-backups, ruta /backups/$name"
  echo "    El WAL posterior se archiva continuamente en el volumen ${COMPOSE_PROJECT_NAME}_pg-wal-archive"
}

backup_keys() {
  service_running key-vault || fail "El Key Vault no esta corriendo."
  info "Respaldo independiente de KEKs (cifrado con VAULT_BACKUP_PASSPHRASE)"
  vault_cli backup manual-cli | sed 's/^/    /'
  ok "Respaldo de KEK creado en el volumen ${COMPOSE_PROJECT_NAME}_vault-backups (/vault/backups)"
}

list_backups() {
  local primary
  title "Respaldos fisicos de PostgreSQL"
  if primary="$(current_primary 2>/dev/null)"; then
    docker compose exec -T "$primary" sh -c 'for f in /backups/catalog/*.json; do [ -f "$f" ] || { echo "  (ninguno)"; break; }; sed -n "s/.*\"\(name\|finished_at\|customers_at_backup\|verified\)\": *\"*\([^\",]*\)\"*.*/\1=\2/p" "$f" | tr "\n" " "; echo; done' | sed 's/^/  /'
  else
    echo "  (no hay primario en ejecucion para leer el catalogo)"
  fi
  title "Respaldos de KEK"
  if service_running key-vault; then
    vault_cli backups | grep -E '"(file|created_at|kek_ids)"|kek-v' | sed 's/^ */  /'
  else
    echo "  (Key Vault detenido)"
  fi
}

case "$MODE" in
  db) backup_db ;;
  keys) backup_keys ;;
  all) backup_db; backup_keys ;;
  list) list_backups ;;
  *) fail "Uso: ./scripts/backup.sh db|keys|all|list" ;;
esac
