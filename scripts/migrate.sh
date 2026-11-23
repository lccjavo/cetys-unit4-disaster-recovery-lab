#!/usr/bin/env bash
# Crea o actualiza el esquema de la base de datos (idempotente, no borra datos).
# Requiere: docker compose up -d postgres-primary key-vault
source "$(dirname "$0")/lib/common.sh"

require_docker
require_env_file

service_running postgres-primary || service_running postgres-standby || fail "PostgreSQL no esta corriendo. Ejecute: docker compose up -d postgres-primary key-vault"
TARGET="$(current_target)"
info "Esperando a que $TARGET este listo..."
wait_healthy "$TARGET" 120 || fail "$TARGET no responde. Diagnostico: docker compose logs $TARGET"

info "Aplicando migraciones SQL en $TARGET (rol administrador ${POSTGRES_USER:-hotel_admin})"
if dc run --rm --no-deps -T hotel-app node src/cli/migrate.js; then
  ok "Migraciones completadas. Tablas, indices, restricciones, vistas y roles listos."
  echo "    Siguiente paso: ./scripts/seed.sh"
else
  fail "La migracion fallo. Revise el mensaje anterior."
fi
