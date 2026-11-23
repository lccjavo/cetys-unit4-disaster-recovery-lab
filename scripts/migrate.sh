#!/usr/bin/env bash
# Creates or updates the database schema (idempotent, never deletes data).
# Requires: docker compose up -d postgres-primary key-vault
source "$(dirname "$0")/lib/common.sh"

require_docker
require_env_file

service_running postgres-primary || service_running postgres-standby || fail "PostgreSQL is not running. Run: docker compose up -d postgres-primary key-vault"
TARGET="$(current_target)"
info "Waiting for $TARGET to be ready..."
wait_healthy "$TARGET" 120 || fail "$TARGET is not responding. Diagnose with: docker compose logs $TARGET"

info "Applying SQL migrations on $TARGET (administrator role ${POSTGRES_USER:-hotel_admin})"
if dc run --rm --no-deps -T hotel-app node src/cli/migrate.js; then
  ok "Migrations completed. Tables, indexes, constraints, views and roles are ready."
  echo "    Next step: ./scripts/seed.sh"
else
  fail "The migration failed. Check the message above."
fi
