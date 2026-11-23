#!/usr/bin/env bash
# Pruebas de integracion completas del laboratorio.
#
# Se ejecutan en un proyecto Docker Compose AISLADO (cetys-dr-test) con puertos distintos
# (13000, 13001, 15433-15435) y su propio archivo de entorno temporal, por lo que NO tocan
# el entorno de clase (cetys-disaster-recovery) ni su .env. Al terminar se eliminan
# unicamente los contenedores y volumenes del proyecto de prueba.
#
# Uso: ./scripts/test-all.sh            (tarda de 4 a 8 minutos)
#      KEEP_TEST_ENV=true ./scripts/test-all.sh   (conserva el entorno de prueba al final)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cetys-dr-test.XXXXXX")"
export LAB_ENV_FILE="$TEST_DIR/test.env"
export COMPOSE_PROJECT_NAME="cetys-dr-test"
export HOTEL_APP_PORT=13000 KEY_VAULT_APP_PORT=13001
export POSTGRES_HOST_PORT=15433 POSTGRES_STANDBY_HOST_PORT=15434 POSTGRES_RECOVERY_HOST_PORT=15435
export ASSUME_YES=true

source "$ROOT/scripts/lib/common.sh"
set +e
set +o pipefail   # 'grep -q' cierra la tuberia antes; no debe contar como falla

case "$COMPOSE_PROJECT_NAME" in cetys-dr-test*) ;; *) echo "Proyecto de prueba invalido"; exit 2 ;; esac

H="http://127.0.0.1:${HOTEL_APP_PORT}"
V="http://127.0.0.1:${KEY_VAULT_APP_PORT}"
RESULTS="$TEST_DIR/results.txt"
mkdir -p "$ROOT/test-results"
PASSN=0; FAILN=0
STARTED="$(now_epoch)"

t() {
  local name="$1" rc="$2" detail="${3:-}"
  if [ "$rc" = "0" ]; then PASSN=$((PASSN + 1)); printf '%sPASS%s  %s%s\n' "$C_GRN" "$C_OFF" "$name" "${detail:+  ($detail)}" | tee -a "$RESULTS"
  else FAILN=$((FAILN + 1)); printf '%sFAIL%s  %s%s\n' "$C_RED" "$C_OFF" "$name" "${detail:+  ($detail)}" | tee -a "$RESULTS"; fi
}
section() { echo | tee -a "$RESULTS"; echo "${C_BLD}== $* ==${C_OFF}" | tee -a "$RESULTS"; }
log() { echo "    $*" >> "$TEST_DIR/detail.log"; }

cleanup() {
  if [ "${KEEP_TEST_ENV:-false}" = "true" ]; then
    echo "Entorno de prueba conservado (proyecto $COMPOSE_PROJECT_NAME, archivo $LAB_ENV_FILE)."
  else
    docker compose --profile lab1 --profile lab2 down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# Utilidad: ejecuta node en un contenedor desechable con la imagen del hotel (no requiere Node en el anfitrion).
js() { local code="$1"; shift; docker run --rm -i cetys-dr/hotel-app:1.0 node -e "$code" "$@"; }
jget() { js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v='$1'.split('.').reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?'':String(v))}catch{process.stdout.write('')}})"; }

# Sesiones HTTP con cookie + token CSRF
login_hotel() {
  local jar="$TEST_DIR/$1.jar" tok code
  rm -f "$jar"
  tok="$(curl -s -c "$jar" -b "$jar" "$H/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p' | head -1)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" --data-urlencode "_csrf=$tok" --data-urlencode "username=$2" --data-urlencode "password=$3" "$H/login")"
  curl -s -c "$jar" -b "$jar" "$H/" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p' | head -1 > "$jar.csrf"
  echo "$code"
}
reveal() { # jar customer_id fields_json -> imprime "CODIGO CUERPO"
  local jar="$TEST_DIR/$1.jar"
  curl -s -w '\n%{http_code}' -b "$jar" -H "x-csrf-token: $(cat "$jar.csrf")" -H 'content-type: application/json' -d "{\"fields\":$3}" "$H/customers/$2/reveal" | awk 'NR==1{b=$0} NR==2{print $0" "b}'
}
get_code() { curl -s -o /dev/null -w '%{http_code}' -b "$TEST_DIR/$1.jar" "$H$2"; }
create_customer() { # jar -> imprime el id del cliente creado
  local jar="$TEST_DIR/$1.jar" json form loc
  json="$(curl -s -b "$jar" "$H/customers/generate")"
  form="$(printf '%s' "$json" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);for(const k of Object.keys(o)){if(o[k]===true)o[k]='on';if(o[k]===false)delete o[k]}o.password='PruebaIntegracion2026';o._csrf=process.argv[1];process.stdout.write(new URLSearchParams(o).toString())})" "$(cat "$jar.csrf")")"
  loc="$(curl -s -o /dev/null -w '%{redirect_url}' -b "$jar" -c "$jar" --data "$form" "$H/customers")"
  echo "$loc" | sed -n 's#.*/customers/\([0-9]*\).*#\1#p'
}
create_reservation() { # jar customer_id -> imprime codigo HTTP
  local jar="$TEST_DIR/$1.jar"
  curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" --data-urlencode "_csrf=$(cat "$jar.csrf")" \
    --data-urlencode "customer_id=$2" --data-urlencode "room_type=Suite Junior" --data-urlencode "guests_count=2" \
    --data-urlencode "check_in=2027-03-10" --data-urlencode "check_out=2027-03-14" "$H/reservations"
}
db() { pg_sql "$(current_target)" "$1" 2>/dev/null; }
reader_sql() { # servicio sql -> salida (como lab_reader por TCP)
  printf '%s\n' "$2" | docker compose --profile lab1 --profile lab2 exec -T -e PGPASSWORD="$DB_READER_PASSWORD" "$1" \
    psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_READER_USER" -d "$POSTGRES_DB" 2>&1
}
fingerprints() { vault_cli status 2>/dev/null | grep -E '"(kek_id|fingerprint)"' | tr -d ' \n'; }
wait_health_target() { # destino estado segundos
  for i in $(seq 1 "$3"); do
    h="$(curl -s -m 2 "$H/health")"
    echo "$h" | grep -q "\"status\":\"$2\",\"target\":\"$1\"" && return 0
    sleep 1
  done
  return 1
}

echo "${C_BLD}Pruebas de integracion CETYS Unidad 4${C_OFF}  (proyecto aislado $COMPOSE_PROJECT_NAME, detalle en $TEST_DIR)" | tee "$RESULTS"
require_docker
docker compose --profile lab1 --profile lab2 down -v --remove-orphans >/dev/null 2>&1

# ------------------------------------------------------------------ unidad
section "Pruebas unitarias"
out="$(docker compose --env-file /dev/null build -q 2>&1)"; rc=$?
t "docker compose build sin archivo .env" $rc
out="$(docker run --rm cetys-dr/hotel-app:1.0 sh -c 'node --test test/*.test.js' 2>&1)"; rc=$?
t "Unitarias hotel-app (AES-256-GCM, AAD, generador, autorizacion)" $rc "$(echo "$out" | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')"
out="$(docker run --rm cetys-dr/key-vault:1.0 sh -c 'node --test test/*.test.js' 2>&1)"; rc=$?
t "Unitarias key-vault (wrap, rotacion, respaldo, perdida, conflicto)" $rc "$(echo "$out" | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')"

# --------------------------------------------------------------- arranque
section "Primer arranque"
"$ROOT/scripts/setup-env.sh" --output "$LAB_ENV_FILE" >/dev/null 2>&1; rc=$?
perm="$(ls -l "$LAB_ENV_FILE" | cut -c1-10)"
! grep -qE "^[A-Z_][A-Z0-9_]*=CHANGE_ME$" "$LAB_ENV_FILE" && [ "$rc" = 0 ] && [ "$perm" = "-rw-------" ]; t "setup-env.sh genera un .env valido sin CHANGE_ME (permisos 600)" $? "$perm"
sum1="$(cksum < "$LAB_ENV_FILE")"
"$ROOT/scripts/setup-env.sh" --output "$LAB_ENV_FILE" </dev/null >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && [ "$sum1" = "$(cksum < "$LAB_ENV_FILE")" ]; t "setup-env.sh no sobrescribe un .env existente sin confirmacion" $?
load_env
docker compose up -d postgres-primary key-vault >/dev/null 2>&1
wait_healthy postgres-primary 120 && wait_healthy key-vault 60; t "PostgreSQL primario y Key Vault inician (healthy)" $?
"$ROOT/scripts/migrate.sh" > "$TEST_DIR/migrate1.log" 2>&1; rc1=$?
"$ROOT/scripts/migrate.sh" > "$TEST_DIR/migrate2.log" 2>&1; rc2=$?
tables="$(pg_sql postgres-primary "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
[ $rc1 = 0 ] && [ $rc2 = 0 ] && grep -q "Migraciones nuevas: 0" "$TEST_DIR/migrate2.log"; t "migrate.sh crea el esquema y es idempotente" $? "$tables tablas"
"$ROOT/scripts/seed.sh" > "$TEST_DIR/seed1.log" 2>&1; rc=$?
cust="$(pg_sql postgres-primary "SELECT count(*) FROM customers")"
[ $rc = 0 ] && [ "$cust" = 150 ]; t "seed.sh crea exactamente 150 clientes ficticios" $? "clientes=$cust; $(grep -c 'clientes cifrados' "$TEST_DIR/seed1.log") lotes"
keysum1="$(pg_sql postgres-primary "SELECT md5(string_agg(wrapped_dek || dek_ref, ',' ORDER BY customer_id)) FROM customer_keys")"
"$ROOT/scripts/seed.sh" > "$TEST_DIR/seed2.log" 2>&1; rc=$?
keysum2="$(pg_sql postgres-primary "SELECT md5(string_agg(wrapped_dek || dek_ref, ',' ORDER BY customer_id)) FROM customer_keys")"
[ $rc = 0 ] && grep -q "No se regenera nada" "$TEST_DIR/seed2.log" && [ "$keysum1" = "$keysum2" ] && [ "$(pg_sql postgres-primary 'SELECT count(*) FROM customers')" = 150 ]
t "seed.sh es idempotente (no regenera DEKs ni datos)" $?
docker compose up -d >/dev/null 2>&1
wait_healthy hotel-app 120; t "docker compose up -d inicia la aplicacion del hotel" $?
"$ROOT/scripts/verify-setup.sh" > "$TEST_DIR/verify.log" 2>&1; rc=$?
t "verify-setup.sh reporta PASS en todas las comprobaciones" $rc "$(grep -c '^.*PASS' "$TEST_DIR/verify.log") PASS"
[ "$(http_code "$H/login")" = 200 ] && [ "$(http_code "$V/login")" = 200 ]; t "Ambas GUIs accesibles (hotel y Key Vault)" $?
! docker compose port key-vault 8200 >/dev/null 2>&1; t "La API criptografica del Key Vault (8200) no se publica al anfitrion" $?
(exec 3<>"/dev/tcp/127.0.0.1/${POSTGRES_HOST_PORT}") 2>/dev/null; t "Puerto de PostgreSQL para DBeaver accesible en 127.0.0.1" $?

# ---------------------------------------------------- autenticacion y BOLA
section "Autenticacion y autorizacion"
[ "$(login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD")" = 302 ]; t "Login de administrador del hotel" $?
[ "$(login_hotel bad admin@hotel-lab.test 'incorrecta')" = 401 ]; t "Contrasena incorrecta rechazada (401)" $?
[ "$(login_hotel staff recepcion@hotel-lab.test "$HOTEL_DEMO_STAFF_PASSWORD")" = 302 ] && [ "$(login_hotel c1 cliente001@hotel-lab.test "$HOTEL_DEMO_CUSTOMER_PASSWORD")" = 302 ]; t "Login de personal y de cliente" $?
vault_login() {
  vjar="$TEST_DIR/vault.jar"; rm -f "$vjar"
  vt="$(curl -s -c "$vjar" -b "$vjar" "$V/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
  curl -s -o /dev/null -w '%{http_code}' -c "$vjar" -b "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "username=$VAULT_ADMIN_USER" --data-urlencode "password=$VAULT_ADMIN_PASSWORD" "$V/login"
}
vjar="$TEST_DIR/vault.jar"
vt="$(curl -s -c "$vjar" -b "$vjar" "$V/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
vcode="$(curl -s -o /dev/null -w '%{http_code}' -c "$vjar" -b "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "username=$VAULT_ADMIN_USER" --data-urlencode "password=$VAULT_ADMIN_PASSWORD" "$V/login")"
vbad="$(curl -s -o /dev/null -w '%{http_code}' --data "username=x&password=y" "$V/login")"
[ "$vcode" = 302 ] && [ "$vbad" != 302 ]; t "Login independiente del Key Vault" $? "ok=$vcode malo=$vbad"
r="$(reveal c1 2 '["phone_number"]')"; [ "${r%% *}" = 403 ]; t "BOLA/IDOR: cliente 1 no puede revelar datos del cliente 2" $? "${r%% *}"
[ "$(get_code c1 /customers/2)" = 403 ] && [ "$(get_code c1 /api/customers/2)" = 403 ] && [ "$(get_code c1 /customers)" = 403 ]; t "BOLA/IDOR: cliente 1 no ve el perfil ni el directorio" $?
[ "$(curl -s -b "$TEST_DIR/c1.jar" "$H/reservations?customer_id=2" | grep -o 'CUS-0002' | wc -l | tr -d ' ')" = 0 ]; t "BOLA/IDOR: el filtro customer_id no expone reservaciones ajenas" $?
r="$(reveal staff 1 '["card_number"]')"; r2="$(reveal staff 1 '["phone_number"]')"
[ "${r%% *}" = 403 ] && [ "${r2%% *}" = 200 ]; t "Personal: puede revelar contacto pero no datos financieros" $?
r="$(curl -s -o /dev/null -w '%{http_code}' -b "$TEST_DIR/admin.jar" -H 'content-type: application/json' -d '{"fields":["phone_number"]}' "$H/customers/1/reveal")"
[ "$r" = 403 ]; t "Proteccion CSRF en la accion de revelar" $?

# --------------------------------------------------------------- cifrado
section "Cifrado de sobre"
ALL='["phone_number","personal_email","home_address","billing_address","date_of_birth","tax_id_rfc","passport_number","card_number","cardholder_name","card_expiration","bank_account_number","clabe","annual_income_range","outstanding_balance","employer_name","company_legal_name","room_guests","accompanying_children","emergency_contact_name","emergency_contact_phone"]'
r="$(reveal admin 1 "$ALL")"; body="${r#* }"
nvals="$(printf '%s' "$body" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(Object.keys(JSON.parse(s).values||{}).length)))")"
[ "${r%% *}" = 200 ] && [ "$nvals" = 20 ]; t "Cifrado/descifrado: el administrador revela los 20 campos del cliente 1" $?
phone="$(printf '%s' "$body" | jget values.phone_number)"; email="$(printf '%s' "$body" | jget values.personal_email)"; rfc="$(printf '%s' "$body" | jget values.tax_id_rfc)"; clabe="$(printf '%s' "$body" | jget values.clabe)"
docker compose exec -T -u postgres postgres-primary sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only' > "$TEST_DIR/dump.sql" 2>/dev/null
hits=0; for v in "$phone" "$email" "$rfc" "$clabe"; do [ -n "$v" ] && grep -qF "$v" "$TEST_DIR/dump.sql" && hits=$((hits + 1)); done
[ -n "$phone" ] && [ "$hits" = 0 ]; t "Ningun valor sensible aparece en claro en un pg_dump completo" $? "valores buscados: 4, encontrados: $hits"
v="$(db "SELECT count(*) FROM customer_sensitive_data WHERE (SELECT count(*) FROM jsonb_object_keys(encrypted_fields)) = 20")"
[ "$v" = 150 ]; t "Los 20 campos sensibles estan cifrados en los 150 perfiles" $?
v="$(db "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('display_nickname','city','country','preferred_language','time_zone','preferred_currency','preferred_room_category','preferred_bed_type','preferred_floor','preferred_room_view','preferred_pillow_type','preferred_checkin_time','preferred_checkout_time','breakfast_preference','parking_required','wifi_usage_preference','newsletter_opt_in','loyalty_tier','preferred_contact_channel','favorite_amenity')")"
[ "$v" = 20 ]; t "Los 20 campos operativos se guardan como columnas separadas" $?
v="$(db "SELECT count(DISTINCT wrapped_dek) || '/' || count(DISTINCT dek_ref) || '/' || count(*) || '/' || string_agg(DISTINCT kek_id, ',') FROM customer_keys")"
[ "$v" = "150/150/150/kek-v1" ]; t "Cada cliente tiene un DEK unico envuelto con kek-v1" $? "$v"
v="$(db "SELECT count(*) FROM customer_keys WHERE length(decode(wrapped_dek,'base64')) <> 32 OR length(decode(dek_wrap_nonce,'base64')) <> 12 OR length(decode(dek_wrap_tag,'base64')) <> 16")"
[ "$v" = 0 ]; t "DEKs envueltos con formato AES-256-GCM correcto (32 B, nonce 12 B, tag 16 B)" $?

# ------------------------------------------------------- cuenta DBeaver
section "Cuenta de solo lectura (DBeaver)"
out="$(docker compose exec -T -e PGPASSWORD="$DB_READER_PASSWORD" postgres-primary psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_READER_USER" -d "$POSTGRES_DB" -f - < docs/sql/consultas-dbeaver.sql 2>&1)"; rc=$?
t "Todas las consultas documentadas (docs/sql/consultas-dbeaver.sql) se ejecutan con lab_reader" $rc "$(echo "$out" | grep -m1 ERROR)"
denied=0
for sql in "INSERT INTO lab_metadata VALUES ('x','y')" "UPDATE customers SET city='X' WHERE id=1" "DELETE FROM reservations WHERE id=1" "DROP TABLE audit_events" "CREATE TABLE intruso(id int)"; do
  o="$(reader_sql postgres-primary "$sql")"; echo "$o" | grep -qiE "permission denied|read-only|must be owner" && denied=$((denied + 1))
done
[ "$denied" = 5 ]; t "lab_reader no puede insertar, actualizar, borrar, eliminar tablas ni crearlas" $? "$denied/5 rechazadas"

# ------------------------------------------------------------- Key Vault
section "Key Vault: disponibilidad, rotacion y recuperacion de KEK"
FP0="$(fingerprints)"
docker compose restart key-vault >/dev/null 2>&1; wait_healthy key-vault 60
r="$(reveal admin 1 '["phone_number"]')"
[ "$(fingerprints)" = "$FP0" ] && [ "${r%% *}" = 200 ]; t "El Key Vault sobrevive a un reinicio sin regenerar llaves" $?
vault_cli access disable >/dev/null 2>&1; sleep 4
r="$(reveal admin 1 '["phone_number"]')"; pc="$(get_code admin /customers/1)"
[ "${r%% *}" = 403 ] && echo "$r" | grep -q KEY_ACCESS_DISABLED && [ "$pc" = 200 ]; t "Acceso deshabilitado: falla controlada (KEY_ACCESS_DISABLED) y datos operativos visibles" $?
vault_cli access enable >/dev/null 2>&1; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Restablecer el acceso restaura el descifrado" $?
docker compose stop key-vault >/dev/null 2>&1; sleep 4
r="$(reveal admin 1 '["phone_number"]')"; pc="$(get_code admin /customers/1)"
ct="$(reader_sql postgres-primary "SELECT count(*) FROM customer_sensitive_data WHERE encrypted_fields ? 'phone_number'")"
[ "${r%% *}" = 503 ] && echo "$r" | grep -q VAULT_UNAVAILABLE && [ "$pc" = 200 ] && [ "$ct" = 150 ]; t "Key Vault detenido: VAULT_UNAVAILABLE, GUI en linea y ciphertext intacto en PostgreSQL" $? "reveal=${r%% *} perfil=$pc ciphertext=$ct"
docker compose start key-vault >/dev/null 2>&1; wait_healthy key-vault 60; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Al reiniciar el Key Vault el descifrado vuelve" $?
vault_cli outage enable >/dev/null 2>&1; r="$(reveal admin 1 '["phone_number"]')"; vault_cli outage disable >/dev/null 2>&1
[ "${r%% *}" = 503 ]; t "Interrupcion simulada del Key Vault produce 503 controlado" $?
vault_cli rotate >/dev/null 2>&1
NEWC="$(create_customer admin)"
k="$(db "SELECT kek_id FROM customer_keys WHERE customer_id = ${NEWC:-0}")"
r="$(reveal admin 1 '["clabe"]')"; r2="$(reveal admin "${NEWC:-0}" '["clabe"]')"
[ "$k" = "kek-v2" ] && [ "${r%% *}" = 200 ] && [ "${r2%% *}" = 200 ]; t "Rotacion: cliente nuevo usa kek-v2 y los de kek-v1 siguen descifrables" $? "nuevo=$NEWC kek=$k"
vault_login >/dev/null   # las sesiones de la GUI viven en memoria; el reinicio previo las invalido
vt="$(curl -s -b "$vjar" "$V/disaster" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
curl -s -o /dev/null -b "$vjar" -c "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "confirm=PERDER-KEYSTORE" "$V/disaster/storage-loss"
sleep 1; r="$(reveal admin 1 '["phone_number"]')"
init="$(docker compose exec -T hotel-app node -e "require('./src/vaultClient').initialize().then(()=>console.log('CREADO')).catch(e=>console.log(e.code))")"
[ "${r%% *}" = 404 ] && echo "$r" | grep -q KEK_NOT_FOUND && [ "$init" = "KEYSTORE_MISSING" ]; t "Perdida del keystore: KEK_NOT_FOUND y el Key Vault se niega a generar llaves de reemplazo" $? "init=$init"
"$ROOT/scripts/restore.sh" keys latest > "$TEST_DIR/restore-keys.log" 2>&1; rc=$?
r="$(reveal admin 1 '["phone_number"]')"; r2="$(reveal admin "${NEWC:-0}" '["phone_number"]')"
[ $rc = 0 ] && [ "${r%% *}" = 200 ] && [ "${r2%% *}" = 200 ]; t "Restaurar KEKs desde el respaldo independiente devuelve el acceso (kek-v1 y kek-v2)" $?
FP1="$(fingerprints)"

# ----------------------------------------------------------------- Lab 1
section "Laboratorio 1: replicacion y failover manual"
"$ROOT/scripts/start.sh" lab1 > "$TEST_DIR/start-lab1.log" 2>&1
st="$(pg_sql postgres-primary "SELECT state FROM pg_stat_replication WHERE application_name = 'pg-standby'")"
[ "$st" = "streaming" ] && [ "$(in_recovery postgres-standby)" = "t" ]; t "Standby clonado con pg_basebackup y replicando por streaming" $? "state=$st"
login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD" >/dev/null
rc="$(create_reservation admin 3)"
code="$(pg_sql postgres-primary "SELECT max(reservation_code) FROM reservations")"
rep=1; for i in $(seq 1 20); do [ "$(pg_sql postgres-standby "SELECT count(*) FROM reservations WHERE reservation_code = '$code'")" = 1 ] && { rep=0; break; }; sleep 1; done
t "Reservacion creada en la GUI aparece en el standby (replicacion fisica)" $rep "$code tras ${i}s"
o="$(reader_sql postgres-standby "SELECT 1")"; w="$(pg_sql postgres-standby "INSERT INTO lab_metadata VALUES ('x','y')" 2>&1)"
echo "$w" | grep -qi "read-only"; t "El standby acepta lecturas y rechaza escrituras" $?
"$ROOT/scripts/lab1-failover.sh" > "$TEST_DIR/failover-refused.log" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "SPLIT BRAIN" "$TEST_DIR/failover-refused.log"; t "Failover rechazado mientras el primario sigue vivo (anti split brain)" $?
BEFORE="$(pg_sql postgres-primary "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
docker compose stop postgres-primary >/dev/null 2>&1
wait_health_target postgres-primary down 20; rc=$?
pc="$(get_code admin /customers)"
[ $rc = 0 ] && [ "$pc" = 503 ] && [ "$(http_code "$H/health")" = 200 ]; t "Primario detenido: la GUI informa BD no disponible sin caerse" $? "/customers=$pc"
"$ROOT/scripts/lab1-failover.sh" > "$TEST_DIR/failover.log" 2>&1; rc=$?
wait_health_target postgres-standby up 20; rc2=$?
AFTER="$(pg_sql postgres-standby "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
[ $rc = 0 ] && [ $rc2 = 0 ] && [ "$BEFORE" = "$AFTER" ]; t "Promocion manual del standby y reconexion de la aplicacion" $? "antes=$BEFORE despues=$AFTER; $(grep -o 'RTO medido): [0-9]* s' "$TEST_DIR/failover.log")"
r="$(reveal admin 2 '["phone_number","clabe"]')"; rc="$(create_reservation admin 4)"
[ "${r%% *}" = 200 ] && [ "$rc" = 302 ]; t "Tras el failover: datos cifrados legibles y escrituras aceptadas" $?
docker compose up -d --no-deps postgres-primary >/dev/null 2>&1; sleep 6
! docker compose exec -T postgres-primary pg_isready -h 127.0.0.1 -q 2>/dev/null && docker compose logs postgres-primary 2>/dev/null | grep -q "CERCADO"
t "El primario cercado no arranca como primario aunque se ejecute docker compose up" $?
"$ROOT/scripts/reset-lab.sh" lab1 --yes > "$TEST_DIR/reset-lab1.log" 2>&1; rc=$?
sleep 3; st="$(pg_sql postgres-primary "SELECT state FROM pg_stat_replication WHERE application_name = 'pg-standby'")"
wait_health_target postgres-primary up 20; rc2=$?
[ $rc = 0 ] && [ $rc2 = 0 ] && [ "$st" = "streaming" ]; t "reset-lab.sh lab1 reconstruye primario + standby" $?
docker compose --profile lab1 stop postgres-standby >/dev/null 2>&1

# ----------------------------------------------------------------- Lab 2
section "Laboratorio 2: respaldo fisico, WAL y PITR"
"$ROOT/scripts/backup.sh" db > "$TEST_DIR/backup.log" 2>&1; rc=$?
[ $rc = 0 ] && grep -q "VERIFICADO=true" "$TEST_DIR/backup.log"; t "pg_basebackup crea un respaldo y pg_verifybackup lo valida" $?
login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD" >/dev/null
POSTC="$(create_customer admin)"
"$ROOT/scripts/lab2-recovery-point.sh" antes_borrado > "$TEST_DIR/rp.log" 2>&1; rc=$?
arch="$(pg_sql postgres-primary "SELECT archived_count || '/' || failed_count FROM pg_stat_archiver")"
[ $rc = 0 ] && [ "${arch%/*}" -gt 0 ] && [ "${arch#*/}" = 0 ]; t "Archivado de WAL activo y punto de restauracion archivado" $? "archivados/fallidos=$arch"
C1="$(pg_sql postgres-primary "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
"$ROOT/scripts/lab2-simulate-deletion.sh" --yes > "$TEST_DIR/delete.log" 2>&1; rc=$?
C2="$(pg_sql postgres-primary "SELECT count(*) FROM customers")"
sleep 1; api="$(curl -s -b "$TEST_DIR/admin.jar" "$H/api/status" | jget counts.customers)"
[ $rc = 0 ] && [ "$C2" -lt "${C1%/*}" ] && [ "$api" = "$C2" ]; t "Borrado accidental simulado y visible en la aplicacion" $? "antes=${C1%/*} despues=$C2"
"$ROOT/scripts/restore.sh" pitr --name antes_borrado > "$TEST_DIR/pitr.log" 2>&1; rc=$?
C3="$(pg_sql postgres-recovery "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
has="$(pg_sql postgres-recovery "SELECT count(*) FROM customers WHERE id = ${POSTC:-0}")"
[ $rc = 0 ] && [ "$C3" = "$C1" ] && [ "$has" = 1 ]; t "PITR restaura exactamente el estado del punto de restauracion" $? "esperado=$C1 recuperado=$C3; cliente posterior al respaldo presente=$has"
wait_health_target postgres-recovery up 20; rc=$?
r="$(reveal admin 1 "$ALL")"; r2="$(reveal admin "${POSTC:-0}" '["card_number","clabe"]')"
[ $rc = 0 ] && [ "${r%% *}" = 200 ] && [ "${r2%% *}" = 200 ]; t "Tras PITR la aplicacion usa la instancia recuperada y descifra los datos" $?
[ "$(fingerprints)" = "$FP1" ]; t "La recuperacion de la base no sobrescribe ni regenera los KEK" $?
[ "$(get_code admin /dr)" = 200 ] && curl -s -b "$TEST_DIR/admin.jar" "$H/dr" | grep -q "pg-recovery"; t "Panel de recuperacion muestra el servidor recuperado" $?
vault_cli access disable >/dev/null 2>&1; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; ct="$(reader_sql postgres-recovery "SELECT count(*) FROM customer_sensitive_data")"
[ "${r%% *}" = 403 ] && [ "$ct" = "${C1%/*}" ]; t "Con el Key Vault deshabilitado hay ciphertext pero no descifrado" $?
vault_cli access enable >/dev/null 2>&1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Restaurar el acceso a KEK hace legibles los datos recuperados" $?
tok="$(cat "$TEST_DIR/admin.jar.csrf")"
curl -s -o /dev/null -b "$TEST_DIR/admin.jar" --data-urlencode "_csrf=$tok" "$H/security/rewrap"
v="$(pg_sql postgres-recovery "SELECT string_agg(DISTINCT kek_id, ',') FROM customer_keys")"; r="$(reveal admin 1 '["clabe"]')"
[ "$v" = "kek-v2" ] && [ "${r%% *}" = 200 ]; t "Re-envoltura opcional migra todos los DEK al KEK activo" $? "$v"
U1="$(pg_sql postgres-recovery "SELECT count(*) FROM users")"
docker compose restart hotel-app >/dev/null 2>&1; wait_healthy hotel-app 60; sleep 3
[ "$(pg_sql postgres-recovery "SELECT count(*) FROM users")" = "$U1" ] && docker compose logs --since 30s hotel-app 2>/dev/null | grep -q "No se regenera nada"; t "Reiniciar la app sobre una base restaurada no vuelve a ejecutar el seed" $?
"$ROOT/scripts/reset-lab.sh" lab2 --yes > "$TEST_DIR/reset-lab2.log" 2>&1; rc=$?
wait_health_target postgres-primary up 20; t "reset-lab.sh lab2 devuelve la aplicacion al primario" $?

# ---------------------------------------------------------------- resumen
ELAPSED=$(( $(now_epoch) - STARTED ))
echo | tee -a "$RESULTS"
if [ "$FAILN" = 0 ]; then echo "${C_GRN}${C_BLD}RESULTADO: $PASSN pruebas PASS, 0 FAIL (${ELAPSED}s)${C_OFF}" | tee -a "$RESULTS"
else echo "${C_RED}${C_BLD}RESULTADO: $PASSN PASS, $FAILN FAIL (${ELAPSED}s)${C_OFF}  Detalle: $TEST_DIR" | tee -a "$RESULTS"; fi
cp "$RESULTS" "$ROOT/test-results/ultimo-resultado.txt"
cp "$TEST_DIR"/*.log "$ROOT/test-results/" 2>/dev/null
[ "$FAILN" = 0 ]
