#!/usr/bin/env bash
# Inicializa el primer KEK (si el Key Vault nunca se inicializo) y genera los 150 clientes ficticios.
# Idempotente: si la base ya fue inicializada, no cambia nada.
source "$(dirname "$0")/lib/common.sh"

require_docker
require_env_file

service_running key-vault || fail "El Key Vault no esta corriendo. Ejecute: docker compose up -d postgres-primary key-vault"
TARGET="$(current_target)"
service_running "$TARGET" || fail "$TARGET no esta corriendo. Ejecute: docker compose up -d postgres-primary key-vault"

info "Verificando PostgreSQL ($TARGET)..."
wait_healthy "$TARGET" 120 || fail "PostgreSQL no esta listo."
ok "PostgreSQL responde"

info "Verificando Key Vault..."
wait_healthy key-vault 60 || fail "El Key Vault no esta listo. Diagnostico: docker compose logs key-vault"
ok "Key Vault responde"

migrated="$(pg_sql "$TARGET" "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)"
[ "${migrated:-0}" -ge 1 ] || fail "El esquema no existe. Ejecute primero: ./scripts/migrate.sh"

info "Ejecutando inicializacion de llaves y datos (puede tardar unos segundos)..."
if dc run --rm --no-deps -T hotel-app node src/cli/seed.js; then
  ok "Seed completado."
  echo "    Siguiente paso: docker compose up -d"
else
  fail "El seed fallo. Revise el mensaje anterior."
fi
