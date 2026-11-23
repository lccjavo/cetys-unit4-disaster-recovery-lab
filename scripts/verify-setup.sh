#!/usr/bin/env bash
# Verificacion completa de la instalacion. Imprime PASS/FAIL por cada comprobacion.
# Codigo de salida: 0 si todo pasa, 1 si alguna comprobacion falla.
source "$(dirname "$0")/lib/common.sh"
set +e

PASS=0; FAILN=0
check() {
  local name="$1" result="$2" detail="${3:-}"
  if [ "$result" = "0" ]; then PASS=$((PASS + 1)); echo "${C_GRN}PASS${C_OFF}  $name${detail:+  ($detail)}"
  else FAILN=$((FAILN + 1)); echo "${C_RED}FAIL${C_OFF}  $name${detail:+  ($detail)}"; fi
}

title "Verificacion del entorno CETYS Unidad 4 (proyecto: $COMPOSE_PROJECT_NAME)"

docker info >/dev/null 2>&1; check "Docker daemon en ejecucion" $?
docker compose version >/dev/null 2>&1; check "Docker Compose disponible" $?
[ -f "$ENV_FILE" ]; check "Archivo de configuracion $ENV_FILE" $?

for svc in postgres-primary key-vault hotel-app; do
  st="$(service_health "$svc")"
  [ "$st" = "healthy" ]; check "Servicio $svc" $? "$st"
done

TARGET="$(current_target)"
(exec 3<>"/dev/tcp/127.0.0.1/${POSTGRES_HOST_PORT}") 2>/dev/null; check "Puerto de PostgreSQL para DBeaver 127.0.0.1:${POSTGRES_HOST_PORT}" $?

if service_running "$TARGET"; then
  out="$(printf 'SELECT count(*) FROM customers;\n' | docker compose exec -T -e PGPASSWORD="${DB_READER_PASSWORD:-lab_reader_default}" "$TARGET" \
        psql -X -At -h 127.0.0.1 -U "${DB_READER_USER:-lab_reader}" -d "${POSTGRES_DB:-hotel_lab}" 2>&1)"
  [[ "$out" =~ ^[0-9]+$ ]]; check "Cuenta de solo lectura ${DB_READER_USER:-lab_reader} puede consultar" $? "clientes: $out"
  out="$(printf "INSERT INTO lab_metadata (key, value) VALUES ('prueba_escritura', 'x');\n" | docker compose exec -T -e PGPASSWORD="${DB_READER_PASSWORD:-lab_reader_default}" "$TARGET" \
        psql -X -At -h 127.0.0.1 -U "${DB_READER_USER:-lab_reader}" -d "${POSTGRES_DB:-hotel_lab}" 2>&1)"
  echo "$out" | grep -qiE "permission denied|read-only transaction"; check "Cuenta de solo lectura NO puede modificar datos" $? "$(echo "$out" | head -1)"
fi

echo
info "Comprobaciones internas de la aplicacion (PostgreSQL, esquema, Key Vault, cifrado):"
if service_running hotel-app; then
  docker compose exec -T hotel-app node src/cli/verify.js
else
  dc run --rm --no-deps -T hotel-app node src/cli/verify.js
fi
check "Comprobaciones de base de datos, llaves y cifrado" $?

echo
code="$(http_code "http://127.0.0.1:${HOTEL_APP_PORT}/health")"; [ "$code" = "200" ]; check "Hotel GUI salud http://localhost:${HOTEL_APP_PORT}/health" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${HOTEL_APP_PORT}/login")"; [ "$code" = "200" ]; check "Hotel GUI pagina de acceso" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${KEY_VAULT_APP_PORT}/healthz")"; [ "$code" = "200" ]; check "Key Vault GUI salud http://localhost:${KEY_VAULT_APP_PORT}/healthz" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${KEY_VAULT_APP_PORT}/login")"; [ "$code" = "200" ]; check "Key Vault GUI pagina de acceso" $? "HTTP $code"

echo
if [ "$FAILN" -eq 0 ]; then
  echo "${C_GRN}${C_BLD}RESULTADO: PASS ($PASS comprobaciones correctas)${C_OFF}"
  exit 0
fi
echo "${C_RED}${C_BLD}RESULTADO: FAIL ($FAILN fallidas, $PASS correctas)${C_OFF}  Consulte 'Problemas comunes' en README.md"
exit 1
