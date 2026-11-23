#!/usr/bin/env bash
# Initializes the first KEK (if the Key Vault was never initialized) and generates the 150 fictional customers.
# Idempotent: if the database was already initialized, nothing changes.
source "$(dirname "$0")/lib/common.sh"

require_docker
require_env_file

service_running key-vault || fail "The Key Vault is not running. Run: docker compose up -d postgres-primary key-vault"
TARGET="$(current_target)"
service_running "$TARGET" || fail "$TARGET is not running. Run: docker compose up -d postgres-primary key-vault"

info "Checking PostgreSQL ($TARGET)..."
wait_healthy "$TARGET" 120 || fail "PostgreSQL is not ready."
ok "PostgreSQL is responding"

info "Checking the Key Vault..."
wait_healthy key-vault 60 || fail "The Key Vault is not ready. Diagnose with: docker compose logs key-vault"
ok "Key Vault is responding"

migrated="$(pg_sql "$TARGET" "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)"
[ "${migrated:-0}" -ge 1 ] || fail "The schema does not exist. Run first: ./scripts/migrate.sh"

info "Initializing keys and data (this can take a few seconds)..."
if dc run --rm --no-deps -T hotel-app node src/cli/seed.js; then
  ok "Seed completed."
  echo "    Next step: docker compose up -d"
else
  fail "The seed failed. Check the message above."
fi
