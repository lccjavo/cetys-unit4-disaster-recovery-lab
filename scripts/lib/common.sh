#!/usr/bin/env bash
# Funciones comunes para los scripts del laboratorio.
# Uso: source "$(dirname "$0")/lib/common.sh"

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
warn()  { echo "${C_YEL}AVISO${C_OFF} $*" >&2; }
fail()  { echo "${C_RED}ERROR${C_OFF} $*" >&2; exit 1; }
title() { echo; echo "${C_BLD}$*${C_OFF}"; }

# Carga .env sin sobrescribir variables ya definidas en el entorno
# (asi las pruebas pueden usar otro COMPOSE_PROJECT_NAME y otros puertos).
# LAB_ENV_FILE permite usar otro archivo (lo usa test-all.sh para un proyecto aislado).
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
  [ -f "$ENV_FILE" ] || fail "No existe $ENV_FILE. Ejecute primero: ./scripts/setup-env.sh"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker no esta instalado o no esta en el PATH."
  docker info >/dev/null 2>&1 || fail "El daemon de Docker no esta corriendo. Abra Docker Desktop (o 'sudo systemctl start docker') y reintente."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 no esta disponible ('docker compose version' fallo)."
}

# Docker Compose siempre con los perfiles de laboratorio que se indiquen en DC_PROFILES.
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
      warn "$svc no esta healthy despues de ${timeout}s (estado: $st). Revise: docker compose logs $svc"
      return 1
    fi
    sleep 2; waited=$((waited + 2))
  done
}

# Ejecuta SQL como administrador dentro del contenedor indicado (por socket local).
# Uso: pg_sql <servicio> "<sql>"
pg_sql() {
  local svc="$1"; shift
  printf '%s\n' "$*" | docker compose --profile lab1 --profile lab2 exec -T -u postgres "$svc" \
    sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

in_recovery() {
  pg_sql "$1" "SELECT pg_is_in_recovery()" 2>/dev/null | tr -d '[:space:]'
}

# Escribe en el volumen lab-control a traves de un contenedor en ejecucion.
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

# Servidor al que apunta la aplicacion (archivo /lab-control/db-target o postgres-primary).
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

# Servidor primario escribible actual (el objetivo de la app si es escribible).
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
  if [ ! -t 0 ]; then fail "Se requiere confirmacion interactiva (o use --yes)."; fi
  read -r -p "$prompt Escriba $word para continuar: " answer
  [ "$answer" = "$word" ] || fail "Operacion cancelada."
}

now_epoch() { date +%s; }

load_env
