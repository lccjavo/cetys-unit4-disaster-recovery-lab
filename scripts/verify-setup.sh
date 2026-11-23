#!/usr/bin/env bash
# Full installation check. Prints PASS/FAIL for every check.
# Exit code: 0 if everything passes, 1 if any check fails.
source "$(dirname "$0")/lib/common.sh"
set +e

PASS=0; FAILN=0
check() {
  local name="$1" result="$2" detail="${3:-}"
  if [ "$result" = "0" ]; then PASS=$((PASS + 1)); echo "${C_GRN}PASS${C_OFF}  $name${detail:+  ($detail)}"
  else FAILN=$((FAILN + 1)); echo "${C_RED}FAIL${C_OFF}  $name${detail:+  ($detail)}"; fi
}

title "CETYS Unit 4 environment check (project: $COMPOSE_PROJECT_NAME)"

docker info >/dev/null 2>&1; check "Docker daemon running" $?
docker compose version >/dev/null 2>&1; check "Docker Compose available" $?
[ -f "$ENV_FILE" ]; check "Configuration file $ENV_FILE" $?

for svc in postgres-primary key-vault hotel-app; do
  st="$(service_health "$svc")"
  [ "$st" = "healthy" ]; check "Service $svc" $? "$st"
done

TARGET="$(current_target)"
(exec 3<>"/dev/tcp/127.0.0.1/${POSTGRES_HOST_PORT}") 2>/dev/null; check "PostgreSQL port for DBeaver 127.0.0.1:${POSTGRES_HOST_PORT}" $?

if service_running "$TARGET"; then
  out="$(printf 'SELECT count(*) FROM customers;\n' | docker compose exec -T -e PGPASSWORD="${DB_READER_PASSWORD:-lab_reader_default}" "$TARGET" \
        psql -X -At -h 127.0.0.1 -U "${DB_READER_USER:-lab_reader}" -d "${POSTGRES_DB:-hotel_lab}" 2>&1)"
  [[ "$out" =~ ^[0-9]+$ ]]; check "Read-only account ${DB_READER_USER:-lab_reader} can query" $? "customers: $out"
  out="$(printf "INSERT INTO lab_metadata (key, value) VALUES ('prueba_escritura', 'x');\n" | docker compose exec -T -e PGPASSWORD="${DB_READER_PASSWORD:-lab_reader_default}" "$TARGET" \
        psql -X -At -h 127.0.0.1 -U "${DB_READER_USER:-lab_reader}" -d "${POSTGRES_DB:-hotel_lab}" 2>&1)"
  echo "$out" | grep -qiE "permission denied|read-only transaction"; check "Read-only account CANNOT modify data" $? "$(echo "$out" | head -1)"
fi

echo
info "Application internal checks (PostgreSQL, schema, Key Vault, encryption):"
if service_running hotel-app; then
  docker compose exec -T hotel-app node src/cli/verify.js
else
  dc run --rm --no-deps -T hotel-app node src/cli/verify.js
fi
check "Database, key and encryption checks" $?

echo
code="$(http_code "http://127.0.0.1:${HOTEL_APP_PORT}/health")"; [ "$code" = "200" ]; check "Hotel GUI health http://localhost:${HOTEL_APP_PORT}/health" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${HOTEL_APP_PORT}/login")"; [ "$code" = "200" ]; check "Hotel GUI sign-in page" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${KEY_VAULT_APP_PORT}/healthz")"; [ "$code" = "200" ]; check "Key Vault GUI health http://localhost:${KEY_VAULT_APP_PORT}/healthz" $? "HTTP $code"
code="$(http_code "http://127.0.0.1:${KEY_VAULT_APP_PORT}/login")"; [ "$code" = "200" ]; check "Key Vault GUI sign-in page" $? "HTTP $code"

echo
if [ "$FAILN" -eq 0 ]; then
  echo "${C_GRN}${C_BLD}RESULT: PASS ($PASS checks passed)${C_OFF}"
  exit 0
fi
echo "${C_RED}${C_BLD}RESULT: FAIL ($FAILN failed, $PASS passed)${C_OFF}  See 'Troubleshooting' in README.md"
exit 1
