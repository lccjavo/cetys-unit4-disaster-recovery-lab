#!/usr/bin/env bash
# Independent backups:
#   ./scripts/backup.sh db     physical PostgreSQL backup with pg_basebackup (pg-backups volume)
#   ./scripts/backup.sh keys   encrypted backup of the Key Vault KEKs (vault-backups volume)
#   ./scripts/backup.sh all    both
#   ./scripts/backup.sh list   lists both kinds of backup
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-db}"

backup_db() {
  local primary
  primary="$(current_primary)" || fail "No writable PostgreSQL primary is running."
  info "Physical backup of $primary with pg_basebackup (includes the required WAL, -X stream)"
  local out
  out="$(docker compose exec -T -u postgres "$primary" lab-basebackup.sh 2>&1)" || { echo "$out"; fail "pg_basebackup or pg_verifybackup failed."; }
  echo "$out" | grep -vE '^[0-9]+/[0-9]+ kB' | sed 's/^/    /'
  local name
  name="$(echo "$out" | sed -n 's/^BACKUP=//p')"
  ok "Base backup created and verified: $name"
  echo "    Location: volume ${COMPOSE_PROJECT_NAME}_pg-backups, path /backups/$name"
  echo "    Later WAL is archived continuously in volume ${COMPOSE_PROJECT_NAME}_pg-wal-archive"
}

backup_keys() {
  service_running key-vault || fail "The Key Vault is not running."
  info "Independent KEK backup (encrypted with VAULT_BACKUP_PASSPHRASE)"
  vault_cli backup manual-cli | sed 's/^/    /'
  ok "KEK backup created in volume ${COMPOSE_PROJECT_NAME}_vault-backups (/vault/backups)"
}

list_backups() {
  local primary
  title "PostgreSQL physical backups"
  if primary="$(current_primary 2>/dev/null)"; then
    docker compose exec -T "$primary" sh -c 'for f in /backups/catalog/*.json; do [ -f "$f" ] || { echo "  (none)"; break; }; sed -n "s/.*\"\(name\|finished_at\|customers_at_backup\|verified\)\": *\"*\([^\",]*\)\"*.*/\1=\2/p" "$f" | tr "\n" " "; echo; done' | sed 's/^/  /'
  else
    echo "  (no running primary to read the catalog from)"
  fi
  title "KEK backups"
  if service_running key-vault; then
    vault_cli backups | grep -E '"(file|created_at|kek_ids)"|kek-v' | sed 's/^ */  /'
  else
    echo "  (Key Vault stopped)"
  fi
}

case "$MODE" in
  db) backup_db ;;
  keys) backup_keys ;;
  all) backup_db; backup_keys ;;
  list) list_backups ;;
  *) fail "Usage: ./scripts/backup.sh db|keys|all|list" ;;
esac
