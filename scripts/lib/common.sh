#!/usr/bin/env bash
# Shared functions for the lab scripts.
# Usage: source "$(dirname "$0")/lib/common.sh"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'; C_BLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_BLD=""; C_OFF=""
fi

info()  { echo "${C_CYN}==>${C_OFF} $*"; }
ok()    { echo "${C_GRN}OK${C_OFF}  $*"; }
warn()  { echo "${C_YEL}WARNING${C_OFF} $*" >&2; }
fail()  { echo "${C_RED}ERROR${C_OFF} $*" >&2; exit 1; }
title() { echo; echo "${C_BLD}$*${C_OFF}"; }

# Loads .env without overriding variables already set in the environment
# (so the tests can use another COMPOSE_PROJECT_NAME and other ports).
# LAB_ENV_FILE selects a different file (test-all.sh uses it for an isolated project).
ENV_FILE="${LAB_ENV_FILE:-$REPO_ROOT/.env}"
if [ -n "${LAB_ENV_FILE:-}" ]; then export COMPOSE_ENV_FILES="$LAB_ENV_FILE"; fi

load_env() {
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      local key="${line%%=*}"
      local value="${line#*=}"
      [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
      if [ -z "${!key+x}" ]; then export "$key=$value"; fi
    done < "$ENV_FILE"
  fi
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cetys-disaster-recovery}"
  HOTEL_APP_PORT="${HOTEL_APP_PORT:-3000}"
  KEY_VAULT_APP_PORT="${KEY_VAULT_APP_PORT:-3001}"
  POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5433}"
  POSTGRES_STANDBY_HOST_PORT="${POSTGRES_STANDBY_HOST_PORT:-5434}"
  POSTGRES_RECOVERY_HOST_PORT="${POSTGRES_RECOVERY_HOST_PORT:-5435}"
}

require_env_file() {
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE does not exist. Run first: ./scripts/setup-env.sh"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed or not on the PATH."
  docker info >/dev/null 2>&1 || fail "The Docker daemon is not running. Open Docker Desktop (or 'sudo systemctl start docker') and retry."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available ('docker compose version' failed)."
}

# Docker Compose with the lab profiles listed in DC_PROFILES.
dc() {
  local args=()
  for p in ${DC_PROFILES:-}; do args+=(--profile "$p"); done
  docker compose ${args[@]+"${args[@]}"} "$@"
}

service_running() {
  [ -n "$(docker compose --profile lab1 --profile lab2 ps --status running -q "$1" 2>/dev/null)" ]
}

service_health() {
  local id
  id="$(docker compose --profile lab1 --profile lab2 ps -q "$1" 2>/dev/null | head -1)"
  [ -n "$id" ] || { echo "absent"; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo "absent"
}

wait_healthy() {
  local svc="$1" timeout="${2:-120}" waited=0 st
  while true; do
    st="$(service_health "$svc")"
    [ "$st" = "healthy" ] && return 0
    if [ "$waited" -ge "$timeout" ]; then
      warn "$svc is not healthy after ${timeout}s (status: $st). Check: docker compose logs $svc"
      return 1
    fi
    sleep 2; waited=$((waited + 2))
  done
}

# Runs SQL as the administrator inside the given container (local socket).
# Usage: pg_sql <service> "<sql>"
pg_sql() {
  local svc="$1"; shift
  printf '%s\n' "$*" | docker compose --profile lab1 --profile lab2 exec -T -u postgres "$svc" \
    sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

in_recovery() {
  pg_sql "$1" "SELECT pg_is_in_recovery()" 2>/dev/null | tr -d '[:space:]'
}

# Writes to the lab-control volume through a running container.
control_write() {
  local svc="$1" file="$2" content="$3"
  printf '%s' "$content" | docker compose --profile lab1 --profile lab2 exec -T "$svc" sh -c "cat > /lab-control/$file && chmod 0666 /lab-control/$file"
}
control_append() {
  local svc="$1" file="$2" content="$3"
  printf '%s\n' "$content" | docker compose --profile lab1 --profile lab2 exec -T "$svc" sh -c "cat >> /lab-control/$file && chmod 0666 /lab-control/$file"
}
control_read() {
  local svc="$1" file="$2"
  docker compose --profile lab1 --profile lab2 exec -T "$svc" sh -c "cat /lab-control/$file 2>/dev/null" || true
}

# Server the application points to (file /lab-control/db-target, or postgres-primary).
current_target() {
  local svc t=""
  for svc in hotel-app postgres-primary postgres-standby postgres-recovery; do
    if service_running "$svc"; then
      t="$(control_read "$svc" db-target | tr -d '[:space:]')"
      break
    fi
  done
  echo "${t:-postgres-primary}"
}

# Current writable primary (the app target if it is writable).
current_primary() {
  local t
  t="$(current_target)"
  if service_running "$t" && [ "$(in_recovery "$t")" = "f" ]; then echo "$t"; return 0; fi
  for svc in postgres-primary postgres-standby; do
    if service_running "$svc" && [ "$(in_recovery "$svc")" = "f" ]; then echo "$svc"; return 0; fi
  done
  return 1
}

vault_cli() {
  docker compose exec -T key-vault node src/cli/admin.js "$@"
}

http_code() {
  curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || echo "000"
}

confirm() {
  local prompt="$1" word="$2" answer
  if [ "${ASSUME_YES:-false}" = "true" ]; then return 0; fi
  if [ ! -t 0 ]; then fail "Interactive confirmation is required (or use --yes)."; fi
  read -r -p "$prompt Type $word to continue: " answer
  [ "$answer" = "$word" ] || fail "Operation cancelled."
}

now_epoch() { date +%s; }

load_env
