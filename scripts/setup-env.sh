#!/usr/bin/env bash
# Generates the .env file from .env.example with random local secrets.
# Never overwrites an existing .env without explicit confirmation.
#
# Usage: ./scripts/setup-env.sh [--force] [--output FILE]
#   --force        overwrite without asking (saves a .env.bak-<date> copy)
#   --output FILE  write to another file (used by the automated tests)

source "$(dirname "$0")/lib/common.sh"

FORCE=false
OUT=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --output) OUT="$2"; shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[ -f .env.example ] || fail ".env.example not found in $REPO_ROOT"

if [ -f "$OUT" ]; then
  if [ "$FORCE" != "true" ]; then
    warn "The file $OUT already exists."
    warn "If you regenerate it, the new passwords will NOT match existing PostgreSQL volumes"
    warn "or KEK backups encrypted with the previous passphrase."
    if [ ! -t 0 ]; then fail "Not overwriting .env without confirmation. Use --force if you really want to."; fi
    read -r -p "Type OVERWRITE to replace it (a copy will be saved): " answer
    [ "$answer" = "OVERWRITE" ] || { info "Keeping the current .env. Nothing was changed."; exit 0; }
  fi
  backup="${OUT}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$OUT" "$backup"
  chmod 600 "$backup"
  info "Copy of the previous .env: $backup"
fi

# Warn if project volumes already exist (the PostgreSQL passwords are already fixed).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  existing="$(docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${existing:-0}" -gt 0 ]; then
    warn "$existing volumes of project ${COMPOSE_PROJECT_NAME} already exist."
    warn "PostgreSQL only applies POSTGRES_PASSWORD when its volume is created. If the volumes were created"
    warn "with another .env, use ./scripts/reset-lab.sh all to start clean (see 'Troubleshooting' in the README)."
  fi
fi

secret() {
  # 32 hex characters (128 bits) from /dev/urandom; no openssl dependency.
  od -An -tx1 -N16 /dev/urandom | tr -d ' \n'
}

tmp="$(mktemp)"
generated=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=CHANGE_ME$ ]]; then
    key="${BASH_REMATCH[1]}"
    echo "${key}=lab_$(secret)" >> "$tmp"
    generated=$((generated + 1))
  else
    echo "$line" >> "$tmp"
  fi
done < .env.example

mv "$tmp" "$OUT"
chmod 600 "$OUT"

# Minimal validation of the generated file.
for required in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DB_HOST DB_USER DB_PASSWORD DB_READER_USER DB_READER_PASSWORD KEY_VAULT_URL KEY_VAULT_SERVICE_TOKEN HOTEL_SESSION_SECRET VAULT_SESSION_SECRET VAULT_BACKUP_PASSPHRASE; do
  grep -q "^${required}=." "$OUT" || fail "$OUT was generated without $required"
done
if grep -qE "^[A-Z_][A-Z0-9_]*=CHANGE_ME$" "$OUT"; then fail "CHANGE_ME values remain in $OUT"; fi

get() { grep "^$1=" "$OUT" | head -1 | cut -d= -f2-; }

title "File $OUT generated successfully ($generated random secrets)"
cat <<EOF
  Docker Compose project : $(get COMPOSE_PROJECT_NAME)
  Database               : $(get POSTGRES_DB)
  Host inside Docker     : $(get DB_HOST):$(get DB_PORT)
  Host for DBeaver       : 127.0.0.1:$(get POSTGRES_HOST_PORT)  (standby: $(get POSTGRES_STANDBY_HOST_PORT), recovery: $(get POSTGRES_RECOVERY_HOST_PORT))
  Application user       : $(get DB_USER)
  Read-only user         : $(get DB_READER_USER)  (password in DB_READER_PASSWORD)
  Hotel Management       : http://localhost:$(get HOTEL_APP_PORT)
  Key Vault (GUI)        : http://localhost:$(get KEY_VAULT_APP_PORT)
  Key Vault internal API : $(get KEY_VAULT_URL)  (not published to the host)

Passwords and tokens are NOT printed. To look them up:
  cat .env                              (whole file)
  grep DB_READER_PASSWORD .env          (DBeaver password)

Next step:
  docker compose up -d postgres-primary key-vault
EOF
