#!/usr/bin/env bash
# Full lab integration tests.
#
# They run in an ISOLATED Docker Compose project (cetys-dr-test) with different ports
# (13000, 13001, 15433-15435) and their own temporary env file, so they do NOT touch the
# class environment (cetys-disaster-recovery) or its .env. At the end only the test
# project's containers and volumes are removed.
#
# Usage: ./scripts/test-all.sh            (takes 2 to 5 minutes)
#        KEEP_TEST_ENV=true ./scripts/test-all.sh   (keeps the test environment afterwards)

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
set +o pipefail   # 'grep -q' closes the pipe early; that must not count as a failure

case "$COMPOSE_PROJECT_NAME" in cetys-dr-test*) ;; *) echo "Invalid test project"; exit 2 ;; esac

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
    echo "Test environment kept (project $COMPOSE_PROJECT_NAME, file $LAB_ENV_FILE)."
  else
    docker compose --profile lab1 --profile lab2 down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# Helper: runs node in a throwaway container from the hotel image (no Node needed on the host).
js() { local code="$1"; shift; docker run --rm -i cetys-dr/hotel-app:1.0 node -e "$code" "$@"; }
jget() { js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v='$1'.split('.').reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?'':String(v))}catch{process.stdout.write('')}})"; }

# HTTP sessions with cookie + CSRF token
login_hotel() {
  local jar="$TEST_DIR/$1.jar" tok code
  rm -f "$jar"
  tok="$(curl -s -c "$jar" -b "$jar" "$H/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p' | head -1)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" --data-urlencode "_csrf=$tok" --data-urlencode "username=$2" --data-urlencode "password=$3" "$H/login")"
  curl -s -c "$jar" -b "$jar" "$H/" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p' | head -1 > "$jar.csrf"
  echo "$code"
}
reveal() { # jar customer_id fields_json -> prints "CODE BODY"
  local jar="$TEST_DIR/$1.jar"
  curl -s -w '\n%{http_code}' -b "$jar" -H "x-csrf-token: $(cat "$jar.csrf")" -H 'content-type: application/json' -d "{\"fields\":$3}" "$H/customers/$2/reveal" | awk 'NR==1{b=$0} NR==2{print $0" "b}'
}
get_code() { curl -s -o /dev/null -w '%{http_code}' -b "$TEST_DIR/$1.jar" "$H$2"; }
create_customer() { # jar -> prints the id of the created customer
  local jar="$TEST_DIR/$1.jar" json form loc
  json="$(curl -s -b "$jar" "$H/customers/generate")"
  form="$(printf '%s' "$json" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);for(const k of Object.keys(o)){if(o[k]===true)o[k]='on';if(o[k]===false)delete o[k]}o.password='PruebaIntegracion2026';o._csrf=process.argv[1];process.stdout.write(new URLSearchParams(o).toString())})" "$(cat "$jar.csrf")")"
  loc="$(curl -s -o /dev/null -w '%{redirect_url}' -b "$jar" -c "$jar" --data "$form" "$H/customers")"
  echo "$loc" | sed -n 's#.*/customers/\([0-9]*\).*#\1#p'
}
create_reservation() { # jar customer_id -> prints the HTTP code
  local jar="$TEST_DIR/$1.jar"
  curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" --data-urlencode "_csrf=$(cat "$jar.csrf")" \
    --data-urlencode "customer_id=$2" --data-urlencode "room_type=Junior Suite" --data-urlencode "guests_count=2" \
    --data-urlencode "check_in=2027-03-10" --data-urlencode "check_out=2027-03-14" "$H/reservations"
}
db() { pg_sql "$(current_target)" "$1" 2>/dev/null; }
reader_sql() { # service sql -> output (as lab_reader over TCP)
  printf '%s\n' "$2" | docker compose --profile lab1 --profile lab2 exec -T -e PGPASSWORD="$DB_READER_PASSWORD" "$1" \
    psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_READER_USER" -d "$POSTGRES_DB" 2>&1
}
fingerprints() { vault_cli status 2>/dev/null | grep -E '"(kek_id|fingerprint)"' | tr -d ' \n'; }
wait_health_target() { # target status seconds
  for i in $(seq 1 "$3"); do
    h="$(curl -s -m 2 "$H/health")"
    echo "$h" | grep -q "\"status\":\"$2\",\"target\":\"$1\"" && return 0
    sleep 1
  done
  return 1
}

echo "${C_BLD}CETYS Unit 4 integration tests${C_OFF}  (isolated project $COMPOSE_PROJECT_NAME, details in $TEST_DIR)" | tee "$RESULTS"
require_docker
docker compose --profile lab1 --profile lab2 down -v --remove-orphans >/dev/null 2>&1

# -------------------------------------------------------------------- unit
section "Unit tests"
out="$(docker compose --env-file /dev/null build -q 2>&1)"; rc=$?
t "docker compose build without an .env file" $rc
out="$(docker run --rm cetys-dr/hotel-app:1.0 sh -c 'node --test test/*.test.js' 2>&1)"; rc=$?
t "hotel-app unit tests (AES-256-GCM, AAD, generator, authorization)" $rc "$(echo "$out" | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')"
out="$(docker run --rm cetys-dr/key-vault:1.0 sh -c 'node --test test/*.test.js' 2>&1)"; rc=$?
t "key-vault unit tests (per-customer KEK, owner check, rotation, shred, backup, loss)" $rc "$(echo "$out" | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')"

# ------------------------------------------------------------- first run
section "First run"
"$ROOT/scripts/setup-env.sh" --output "$LAB_ENV_FILE" >/dev/null 2>&1; rc=$?
perm="$(ls -l "$LAB_ENV_FILE" | cut -c1-10)"
! grep -qE "^[A-Z_][A-Z0-9_]*=CHANGE_ME$" "$LAB_ENV_FILE" && [ "$rc" = 0 ] && [ "$perm" = "-rw-------" ]; t "setup-env.sh generates a valid .env without CHANGE_ME (mode 600)" $? "$perm"
sum1="$(cksum < "$LAB_ENV_FILE")"
"$ROOT/scripts/setup-env.sh" --output "$LAB_ENV_FILE" </dev/null >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && [ "$sum1" = "$(cksum < "$LAB_ENV_FILE")" ]; t "setup-env.sh does not overwrite an existing .env without confirmation" $?
load_env
docker compose up -d postgres-primary key-vault >/dev/null 2>&1
wait_healthy postgres-primary 120 && wait_healthy key-vault 60; t "PostgreSQL primary and Key Vault start (healthy)" $?
"$ROOT/scripts/migrate.sh" > "$TEST_DIR/migrate1.log" 2>&1; rc1=$?
"$ROOT/scripts/migrate.sh" > "$TEST_DIR/migrate2.log" 2>&1; rc2=$?
tables="$(pg_sql postgres-primary "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
[ $rc1 = 0 ] && [ $rc2 = 0 ] && grep -q "New migrations: 0" "$TEST_DIR/migrate2.log"; t "migrate.sh creates the schema and is idempotent" $? "$tables tables"
"$ROOT/scripts/seed.sh" > "$TEST_DIR/seed1.log" 2>&1; rc=$?
cust="$(pg_sql postgres-primary "SELECT count(*) FROM customers")"
[ $rc = 0 ] && [ "$cust" = 150 ]; t "seed.sh creates exactly 150 fictional customers" $? "customers=$cust; $(grep -c 'customers encrypted' "$TEST_DIR/seed1.log") batches"
keysum1="$(pg_sql postgres-primary "SELECT md5(string_agg(wrapped_dek || dek_ref, ',' ORDER BY customer_id)) FROM customer_keys")"
"$ROOT/scripts/seed.sh" > "$TEST_DIR/seed2.log" 2>&1; rc=$?
keysum2="$(pg_sql postgres-primary "SELECT md5(string_agg(wrapped_dek || dek_ref, ',' ORDER BY customer_id)) FROM customer_keys")"
[ $rc = 0 ] && grep -q "Nothing is regenerated" "$TEST_DIR/seed2.log" && [ "$keysum1" = "$keysum2" ] && [ "$(pg_sql postgres-primary 'SELECT count(*) FROM customers')" = 150 ]
t "seed.sh is idempotent (does not regenerate DEKs or data)" $?
docker compose up -d >/dev/null 2>&1
wait_healthy hotel-app 120; t "docker compose up -d starts the hotel application" $?
"$ROOT/scripts/verify-setup.sh" > "$TEST_DIR/verify.log" 2>&1; rc=$?
t "verify-setup.sh reports PASS on every check" $rc "$(grep -c '^.*PASS' "$TEST_DIR/verify.log") PASS"
[ "$(http_code "$H/login")" = 200 ] && [ "$(http_code "$V/login")" = 200 ]; t "Both GUIs reachable (hotel and Key Vault)" $?
! docker compose port key-vault 8200 >/dev/null 2>&1; t "The Key Vault cryptographic API (8200) is not published to the host" $?
(exec 3<>"/dev/tcp/127.0.0.1/${POSTGRES_HOST_PORT}") 2>/dev/null; t "PostgreSQL port for DBeaver reachable on 127.0.0.1" $?

# ------------------------------------------------------- authN and BOLA
section "Authentication and authorization"
[ "$(login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD")" = 302 ]; t "Hotel administrator login" $?
[ "$(login_hotel bad admin@hotel-lab.test 'incorrecta')" = 401 ]; t "Wrong password rejected (401)" $?
[ "$(login_hotel staff frontdesk@hotel-lab.test "$HOTEL_DEMO_STAFF_PASSWORD")" = 302 ] && [ "$(login_hotel c1 customer001@hotel-lab.test "$HOTEL_DEMO_CUSTOMER_PASSWORD")" = 302 ]; t "Staff and customer login" $?
vault_login() {
  vjar="$TEST_DIR/vault.jar"; rm -f "$vjar"
  vt="$(curl -s -c "$vjar" -b "$vjar" "$V/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
  curl -s -o /dev/null -w '%{http_code}' -c "$vjar" -b "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "username=$VAULT_ADMIN_USER" --data-urlencode "password=$VAULT_ADMIN_PASSWORD" "$V/login"
}
vjar="$TEST_DIR/vault.jar"
vt="$(curl -s -c "$vjar" -b "$vjar" "$V/login" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
vcode="$(curl -s -o /dev/null -w '%{http_code}' -c "$vjar" -b "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "username=$VAULT_ADMIN_USER" --data-urlencode "password=$VAULT_ADMIN_PASSWORD" "$V/login")"
vbad="$(curl -s -o /dev/null -w '%{http_code}' --data "username=x&password=y" "$V/login")"
[ "$vcode" = 302 ] && [ "$vbad" != 302 ]; t "Separate Key Vault login" $? "ok=$vcode bad=$vbad"
r="$(reveal c1 2 '["phone_number"]')"; [ "${r%% *}" = 403 ]; t "BOLA/IDOR: customer 1 cannot reveal customer 2 data" $? "${r%% *}"
[ "$(get_code c1 /customers/2)" = 403 ] && [ "$(get_code c1 /api/customers/2)" = 403 ] && [ "$(get_code c1 /customers)" = 403 ]; t "BOLA/IDOR: customer 1 cannot see the profile or the directory" $?
[ "$(curl -s -b "$TEST_DIR/c1.jar" "$H/reservations?customer_id=2" | grep -o 'CUS-0002' | wc -l | tr -d ' ')" = 0 ]; t "BOLA/IDOR: the customer_id filter does not expose other reservations" $?
r="$(reveal staff 1 '["card_number"]')"; r2="$(reveal staff 1 '["phone_number"]')"
[ "${r%% *}" = 403 ] && [ "${r2%% *}" = 200 ]; t "Staff: can reveal contact data but not financial data" $?
r="$(curl -s -o /dev/null -w '%{http_code}' -b "$TEST_DIR/admin.jar" -H 'content-type: application/json' -d '{"fields":["phone_number"]}' "$H/customers/1/reveal")"
[ "$r" = 403 ]; t "CSRF protection on the reveal action" $?

# ------------------------------------------------------------ encryption
section "Envelope encryption"
ALL='["phone_number","personal_email","home_address","billing_address","date_of_birth","tax_id_rfc","passport_number","card_number","cardholder_name","card_expiration","bank_account_number","clabe","annual_income_range","outstanding_balance","employer_name","company_legal_name","room_guests","accompanying_children","emergency_contact_name","emergency_contact_phone"]'
r="$(reveal admin 1 "$ALL")"; body="${r#* }"
nvals="$(printf '%s' "$body" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(Object.keys(JSON.parse(s).values||{}).length)))")"
[ "${r%% *}" = 200 ] && [ "$nvals" = 20 ]; t "Encryption/decryption: the administrator reveals all 20 fields of customer 1" $?
phone="$(printf '%s' "$body" | jget values.phone_number)"; email="$(printf '%s' "$body" | jget values.personal_email)"; rfc="$(printf '%s' "$body" | jget values.tax_id_rfc)"; clabe="$(printf '%s' "$body" | jget values.clabe)"
docker compose exec -T -u postgres postgres-primary sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only' > "$TEST_DIR/dump.sql" 2>/dev/null
hits=0; for v in "$phone" "$email" "$rfc" "$clabe"; do [ -n "$v" ] && grep -qF "$v" "$TEST_DIR/dump.sql" && hits=$((hits + 1)); done
[ -n "$phone" ] && [ "$hits" = 0 ]; t "No sensitive value appears in plaintext in a full pg_dump" $? "values searched: 4, found: $hits"
v="$(db "SELECT count(*) FROM customer_sensitive_data WHERE (SELECT count(*) FROM jsonb_object_keys(encrypted_fields)) = 20")"
[ "$v" = 150 ]; t "The 20 sensitive fields are encrypted in all 150 profiles" $?
v="$(db "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('display_nickname','city','country','preferred_language','time_zone','preferred_currency','preferred_room_category','preferred_bed_type','preferred_floor','preferred_room_view','preferred_pillow_type','preferred_checkin_time','preferred_checkout_time','breakfast_preference','parking_required','wifi_usage_preference','newsletter_opt_in','loyalty_tier','preferred_contact_channel','favorite_amenity')")"
[ "$v" = 20 ]; t "The 20 operational fields are stored as separate columns" $?
v="$(db "SELECT count(DISTINCT k.wrapped_dek) || '/' || count(DISTINCT k.dek_ref) || '/' || count(DISTINCT k.kek_id) || '/' || count(*) FILTER (WHERE k.kek_id = 'kek-' || lower(c.customer_code) || '-v1') || '/' || count(*) FROM customer_keys k JOIN customers c ON c.id = k.customer_id")"
[ "$v" = "150/150/150/150/150" ]; t "Every customer has a unique DEK wrapped with its OWN KEK (kek-cus-NNNN-v1)" $? "dek/ref/distinct kek/own kek/total=$v"
v="$(vault_cli status 2>/dev/null | grep -E '^  "owner_count"' | tr -dc '0-9')"
[ "$v" = 150 ]; t "The Key Vault holds one KEK per customer (150 owners)" $? "owners=$v"
v="$(db "SELECT count(*) FROM customer_keys WHERE length(decode(wrapped_dek,'base64')) <> 32 OR length(decode(dek_wrap_nonce,'base64')) <> 12 OR length(decode(dek_wrap_tag,'base64')) <> 16")"
[ "$v" = 0 ]; t "Wrapped DEKs use the correct AES-256-GCM format (32 B, 12 B nonce, 16 B tag)" $?

# ------------------------------------------------------- DBeaver account
section "Read-only account (DBeaver)"
out="$(docker compose exec -T -e PGPASSWORD="$DB_READER_PASSWORD" postgres-primary psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_READER_USER" -d "$POSTGRES_DB" -f - < docs/sql/dbeaver-queries.sql 2>&1)"; rc=$?
t "All documented queries (docs/sql/dbeaver-queries.sql) run as lab_reader" $rc "$(echo "$out" | grep -m1 ERROR)"
denied=0
for sql in "INSERT INTO lab_metadata VALUES ('x','y')" "UPDATE customers SET city='X' WHERE id=1" "DELETE FROM reservations WHERE id=1" "DROP TABLE audit_events" "CREATE TABLE intruso(id int)"; do
  o="$(reader_sql postgres-primary "$sql")"; echo "$o" | grep -qiE "permission denied|read-only|must be owner" && denied=$((denied + 1))
done
[ "$denied" = 5 ]; t "lab_reader cannot insert, update, delete, drop or create tables" $? "$denied/5 rejected"

# ------------------------------------------------------------- Key Vault
section "Key Vault: availability, rotation and KEK recovery"
FP0="$(fingerprints)"
docker compose restart key-vault >/dev/null 2>&1; wait_healthy key-vault 60
r="$(reveal admin 1 '["phone_number"]')"
[ "$(fingerprints)" = "$FP0" ] && [ "${r%% *}" = 200 ]; t "The Key Vault survives a restart without regenerating keys" $?
vault_cli access disable >/dev/null 2>&1; sleep 4
r="$(reveal admin 1 '["phone_number"]')"; pc="$(get_code admin /customers/1)"
[ "${r%% *}" = 403 ] && echo "$r" | grep -q KEY_ACCESS_DISABLED && [ "$pc" = 200 ]; t "Disabled access: controlled failure (KEY_ACCESS_DISABLED) and operational data visible" $?
vault_cli access enable >/dev/null 2>&1; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Restoring access restores decryption" $?
docker compose stop key-vault >/dev/null 2>&1; sleep 4
r="$(reveal admin 1 '["phone_number"]')"; pc="$(get_code admin /customers/1)"
ct="$(reader_sql postgres-primary "SELECT count(*) FROM customer_sensitive_data WHERE encrypted_fields ? 'phone_number'")"
[ "${r%% *}" = 503 ] && echo "$r" | grep -q VAULT_UNAVAILABLE && [ "$pc" = 200 ] && [ "$ct" = 150 ]; t "Key Vault stopped: VAULT_UNAVAILABLE, GUI online and ciphertext intact in PostgreSQL" $? "reveal=${r%% *} profile=$pc ciphertext=$ct"
docker compose start key-vault >/dev/null 2>&1; wait_healthy key-vault 60; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Restarting the Key Vault brings decryption back" $?
vault_cli outage enable >/dev/null 2>&1; r="$(reveal admin 1 '["phone_number"]')"; vault_cli outage disable >/dev/null 2>&1
[ "${r%% *}" = 503 ]; t "Simulated Key Vault outage produces a controlled 503" $?
vault_cli rotate CUS-0001 >/dev/null 2>&1
act="$(vault_cli status 2>/dev/null | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const a=o.keks.filter(k=>k.status==='active');process.stdout.write(a.find(k=>k.owner==='CUS-0001').kek_id+'/'+a.find(k=>k.owner==='CUS-0002').kek_id)})")"
r="$(reveal admin 1 '["clabe"]')"
[ "$act" = "kek-cus-0001-v2/kek-cus-0002-v1" ] && [ "${r%% *}" = 200 ]; t "Rotating one customer: CUS-0001 gets v2, CUS-0002 untouched, v1 still unwraps" $? "active=$act"
NEWC="$(create_customer admin)"
k="$(db "SELECT k.kek_id = 'kek-' || lower(c.customer_code) || '-v1' FROM customer_keys k JOIN customers c ON c.id = k.customer_id WHERE c.id = ${NEWC:-0}")"
r2="$(reveal admin "${NEWC:-0}" '["clabe"]')"
[ "$k" = "t" ] && [ "${r2%% *}" = 200 ]; t "A new customer gets its own new KEK and decrypts" $? "new=$NEWC own=$k"
orig="$(db "SELECT kek_id FROM customer_keys WHERE customer_id = 2")"
db "UPDATE customer_keys SET kek_id = 'kek-cus-0001-v1' WHERE customer_id = 2" >/dev/null
r="$(reveal admin 2 '["phone_number"]')"
db "UPDATE customer_keys SET kek_id = '$orig' WHERE customer_id = 2" >/dev/null
r2="$(reveal admin 2 '["phone_number"]')"
[ "${r%% *}" = 403 ] && echo "$r" | grep -q KEK_OWNER_MISMATCH && [ "${r2%% *}" = 200 ]; t "A customer's DEK cannot be unwrapped with another customer's KEK (KEK_OWNER_MISMATCH)" $? "tampered=${r%% *} restored=${r2%% *}"
vault_cli shred CUS-0003 >/dev/null 2>&1
r="$(reveal admin 3 '["phone_number"]')"; r2="$(reveal admin 4 '["phone_number"]')"
[ "${r%% *}" = 404 ] && echo "$r" | grep -q KEK_NOT_FOUND && [ "${r2%% *}" = 200 ]; t "Shredding CUS-0003's KEK only makes CUS-0003 unreadable" $? "cus3=${r%% *} cus4=${r2%% *}"
vault_login >/dev/null   # GUI sessions live in memory; the earlier restart invalidated them
vt="$(curl -s -b "$vjar" "$V/disaster" | sed -n 's/.*name="csrf-token" content="\([a-f0-9]*\)".*/\1/p')"
curl -s -o /dev/null -b "$vjar" -c "$vjar" --data-urlencode "_csrf=$vt" --data-urlencode "confirm=LOSE-KEYSTORE" "$V/disaster/storage-loss"
sleep 1; r="$(reveal admin 1 '["phone_number"]')"
init="$(docker compose exec -T hotel-app node -e "require('./src/vaultClient').initialize().then(()=>console.log('CREADO')).catch(e=>console.log(e.code))")"
[ "${r%% *}" = 404 ] && echo "$r" | grep -q KEK_NOT_FOUND && [ "$init" = "KEYSTORE_MISSING" ]; t "Keystore loss: KEK_NOT_FOUND and the Key Vault refuses to generate replacement keys" $? "init=$init"
"$ROOT/scripts/restore.sh" keys latest > "$TEST_DIR/restore-keys.log" 2>&1; rc=$?
r="$(reveal admin 1 '["phone_number"]')"; r2="$(reveal admin "${NEWC:-0}" '["phone_number"]')"; r3="$(reveal admin 3 '["phone_number"]')"
[ $rc = 0 ] && [ "${r%% *}" = 200 ] && [ "${r2%% *}" = 200 ] && [ "${r3%% *}" = 200 ]; t "Restoring KEKs from the backup restores every customer (rotated, new and shredded)" $?

# ----------------------------------------------------------------- Lab 1
section "Lab 1: replication and manual failover"
"$ROOT/scripts/start.sh" lab1 > "$TEST_DIR/start-lab1.log" 2>&1
st="$(pg_sql postgres-primary "SELECT state FROM pg_stat_replication WHERE application_name = 'pg-standby'")"
[ "$st" = "streaming" ] && [ "$(in_recovery postgres-standby)" = "t" ]; t "Standby cloned with pg_basebackup and streaming" $? "state=$st"
login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD" >/dev/null
rc="$(create_reservation admin 3)"
code="$(pg_sql postgres-primary "SELECT max(reservation_code) FROM reservations")"
rep=1; [ "$rc" = 302 ] && for i in $(seq 1 20); do [ "$(pg_sql postgres-standby "SELECT count(*) FROM reservations WHERE reservation_code = '$code'")" = 1 ] && { rep=0; break; }; sleep 1; done
t "A reservation created in the GUI appears on the standby (physical replication)" $rep "$code after ${i}s"
o="$(reader_sql postgres-standby "SELECT 1")"; w="$(pg_sql postgres-standby "INSERT INTO lab_metadata VALUES ('x','y')" 2>&1)"
echo "$w" | grep -qi "read-only"; t "The standby accepts reads and rejects writes" $?
"$ROOT/scripts/lab1-failover.sh" > "$TEST_DIR/failover-refused.log" 2>&1; rc=$?
[ $rc != 0 ] && grep -q "SPLIT BRAIN" "$TEST_DIR/failover-refused.log"; t "Failover refused while the primary is alive (split-brain guard)" $?
BEFORE="$(pg_sql postgres-primary "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
docker compose stop postgres-primary >/dev/null 2>&1
wait_health_target postgres-primary down 20; rc=$?
pc="$(get_code admin /customers)"
[ $rc = 0 ] && [ "$pc" = 503 ] && [ "$(http_code "$H/health")" = 200 ]; t "Primary stopped: the GUI reports the database as unavailable without crashing" $? "/customers=$pc"
"$ROOT/scripts/lab1-failover.sh" > "$TEST_DIR/failover.log" 2>&1; rc=$?
wait_health_target postgres-standby up 20; rc2=$?
AFTER="$(pg_sql postgres-standby "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
[ $rc = 0 ] && [ $rc2 = 0 ] && [ "$BEFORE" = "$AFTER" ]; t "Manual standby promotion and application reconnect" $? "before=$BEFORE after=$AFTER; $(grep -o 'measured RTO): [0-9]* s' "$TEST_DIR/failover.log")"
r="$(reveal admin 2 '["phone_number","clabe"]')"; rc="$(create_reservation admin 4)"
[ "${r%% *}" = 200 ] && [ "$rc" = 302 ]; t "After failover: encrypted data readable and writes accepted" $?
docker compose up -d --no-deps postgres-primary >/dev/null 2>&1; sleep 6
! docker compose exec -T postgres-primary pg_isready -h 127.0.0.1 -q 2>/dev/null && docker compose logs postgres-primary 2>/dev/null | grep -q "FENCED"
t "The fenced primary does not start as primary even after docker compose up" $?
"$ROOT/scripts/reset-lab.sh" lab1 --yes > "$TEST_DIR/reset-lab1.log" 2>&1; rc=$?
sleep 3; st="$(pg_sql postgres-primary "SELECT state FROM pg_stat_replication WHERE application_name = 'pg-standby'")"
wait_health_target postgres-primary up 20; rc2=$?
[ $rc = 0 ] && [ $rc2 = 0 ] && [ "$st" = "streaming" ]; t "reset-lab.sh lab1 rebuilds primary + standby" $?
docker compose --profile lab1 stop postgres-standby >/dev/null 2>&1

# ----------------------------------------------------------------- Lab 2
section "Lab 2: physical backup, WAL and PITR"
"$ROOT/scripts/backup.sh" db > "$TEST_DIR/backup.log" 2>&1; rc=$?
[ $rc = 0 ] && grep -q "VERIFIED=true" "$TEST_DIR/backup.log"; t "pg_basebackup creates a backup and pg_verifybackup validates it" $?
login_hotel admin admin@hotel-lab.test "$HOTEL_DEMO_ADMIN_PASSWORD" >/dev/null
POSTC="$(create_customer admin)"
"$ROOT/scripts/lab2-recovery-point.sh" before_deletion > "$TEST_DIR/rp.log" 2>&1; rc=$?
arch="$(pg_sql postgres-primary "SELECT archived_count || '/' || failed_count FROM pg_stat_archiver")"
[ $rc = 0 ] && [ "${arch%/*}" -gt 0 ] && [ "${arch#*/}" = 0 ]; t "WAL archiving active and restore point archived" $? "archived/failed=$arch"
C1="$(pg_sql postgres-primary "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
"$ROOT/scripts/lab2-simulate-deletion.sh" --yes > "$TEST_DIR/delete.log" 2>&1; rc=$?
C2="$(pg_sql postgres-primary "SELECT count(*) FROM customers")"
sleep 1; api="$(curl -s -b "$TEST_DIR/admin.jar" "$H/api/status" | jget counts.customers)"
[ $rc = 0 ] && [ "$C2" -lt "${C1%/*}" ] && [ "$api" = "$C2" ]; t "Accidental deletion simulated and visible in the application" $? "before=${C1%/*} after=$C2"
FP1="$(fingerprints)"
"$ROOT/scripts/restore.sh" pitr --name before_deletion > "$TEST_DIR/pitr.log" 2>&1; rc=$?
C3="$(pg_sql postgres-recovery "SELECT count(*) || '/' || (SELECT count(*) FROM reservations) FROM customers")"
has="$(pg_sql postgres-recovery "SELECT count(*) FROM customers WHERE id = ${POSTC:-0}")"
[ $rc = 0 ] && [ "$C3" = "$C1" ] && [ "$has" = 1 ]; t "PITR restores exactly the restore-point state" $? "expected=$C1 recovered=$C3; customer created after the backup present=$has"
wait_health_target postgres-recovery up 20; rc=$?
r="$(reveal admin 1 "$ALL")"; r2="$(reveal admin "${POSTC:-0}" '["card_number","clabe"]')"
[ $rc = 0 ] && [ "${r%% *}" = 200 ] && [ "${r2%% *}" = 200 ]; t "After PITR the application uses the recovered instance and decrypts data" $?
[ "$(fingerprints)" = "$FP1" ]; t "Database recovery does not overwrite or regenerate the KEKs" $?
[ "$(get_code admin /dr)" = 200 ] && curl -s -b "$TEST_DIR/admin.jar" "$H/dr" | grep -q "pg-recovery"; t "Recovery page shows the recovered server" $?
vault_cli access disable >/dev/null 2>&1; sleep 1
r="$(reveal admin 1 '["phone_number"]')"; ct="$(reader_sql postgres-recovery "SELECT count(*) FROM customer_sensitive_data")"
[ "${r%% *}" = 403 ] && [ "$ct" = "${C1%/*}" ]; t "With the Key Vault disabled there is ciphertext but no decryption" $?
vault_cli access enable >/dev/null 2>&1
r="$(reveal admin 1 '["phone_number"]')"; [ "${r%% *}" = 200 ]; t "Restoring KEK access makes the recovered data readable" $?
tok="$(cat "$TEST_DIR/admin.jar.csrf")"
curl -s -o /dev/null -b "$TEST_DIR/admin.jar" --data-urlencode "_csrf=$tok" "$H/security/rewrap"
v="$(pg_sql postgres-recovery "SELECT (SELECT kek_id FROM customer_keys WHERE customer_id = 1) || '/' || (SELECT kek_id FROM customer_keys WHERE customer_id = 2) || '/' || count(DISTINCT kek_id) || '/' || count(*) FROM customer_keys")"; r="$(reveal admin 1 '["clabe"]')"
[ "${v%%/*}" = "kek-cus-0001-v2" ] && [ "$(echo "$v" | cut -d/ -f2)" = "kek-cus-0002-v1" ] && [ "$(echo "$v" | cut -d/ -f3)" = "$(echo "$v" | cut -d/ -f4)" ] && [ "${r%% *}" = 200 ]; t "Optional re-wrap moves each DEK to its own customer's active KEK" $? "$v"
U1="$(pg_sql postgres-recovery "SELECT count(*) FROM users")"
docker compose restart hotel-app >/dev/null 2>&1; wait_healthy hotel-app 60; sleep 3
[ "$(pg_sql postgres-recovery "SELECT count(*) FROM users")" = "$U1" ] && docker compose logs --since 30s hotel-app 2>/dev/null | grep -q "Nothing is regenerated"; t "Restarting the app on a restored database does not re-run the seed" $?
"$ROOT/scripts/reset-lab.sh" lab2 --yes > "$TEST_DIR/reset-lab2.log" 2>&1; rc=$?
wait_health_target postgres-primary up 20; t "reset-lab.sh lab2 returns the application to the primary" $?

# ---------------------------------------------------------------- summary
ELAPSED=$(( $(now_epoch) - STARTED ))
echo | tee -a "$RESULTS"
if [ "$FAILN" = 0 ]; then echo "${C_GRN}${C_BLD}RESULT: $PASSN tests PASS, 0 FAIL (${ELAPSED}s)${C_OFF}" | tee -a "$RESULTS"
else echo "${C_RED}${C_BLD}RESULT: $PASSN PASS, $FAILN FAIL (${ELAPSED}s)${C_OFF}  Details: $TEST_DIR" | tee -a "$RESULTS"; fi
cp "$RESULTS" "$ROOT/test-results/latest-results.txt"
cp "$TEST_DIR"/*.log "$ROOT/test-results/" 2>/dev/null
[ "$FAILN" = 0 ]
