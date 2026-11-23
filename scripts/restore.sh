#!/usr/bin/env bash
# Restauraciones del laboratorio.
#
#   ./scripts/restore.sh pitr [--name PUNTO | --time "AAAA-MM-DD HH:MM:SS+00"] [--backup base-...] [--no-switch]
#       Point-in-Time Recovery en la instancia separada postgres-recovery (perfil lab2):
#       copia el respaldo base, reproduce el WAL archivado hasta el objetivo y promueve.
#       El primario original y los respaldos NO se modifican.
#
#   ./scripts/restore.sh keys [archivo|latest]
#       Restaura KEKs faltantes desde un respaldo independiente del Key Vault.
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-}"; shift || true

restore_keys() {
  service_running key-vault || fail "El Key Vault no esta corriendo: docker compose up -d key-vault"
  local file="${1:-latest}"
  info "Restaurando KEKs desde el respaldo: $file"
  vault_cli restore "$file" | sed 's/^/    /'
  ok "KEKs restaurados. Los KEK existentes nunca se reemplazan; solo se agregan los faltantes."
}

restore_pitr() {
  local name="" time="" backup="" switch=true
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --time) time="$2"; shift 2 ;;
      --backup) backup="$2"; shift 2 ;;
      --no-switch) switch=false; shift ;;
      *) fail "Opcion desconocida: $1" ;;
    esac
  done
  local reader
  reader="$(current_primary 2>/dev/null || echo hotel-app)"
  if [ -z "$name" ] && [ -z "$time" ]; then
    name="$(control_read "$reader" restore-points.log | tail -1 | cut -d'|' -f2)"
    [ -n "$name" ] || fail "No hay puntos de restauracion. Cree uno con ./scripts/lab2-recovery-point.sh antes_borrado"
    info "Usando el punto de restauracion mas reciente: $name"
  fi
  [ -z "$name" ] || [[ "$name" =~ ^[a-z0-9_]{3,40}$ ]] || fail "Nombre de punto invalido"

  local args=()
  [ -n "$name" ] && args+=(--name "$name")
  [ -n "$time" ] && args+=(--time "$time")
  [ -n "$backup" ] && args+=(--backup "$backup")

  info "Deteniendo y limpiando solo la instancia desechable postgres-recovery"
  docker compose --profile lab2 rm -sf postgres-recovery >/dev/null 2>&1 || true

  info "Preparando el volumen de recuperacion (respaldo base + configuracion de PITR)"
  docker compose --profile lab2 run --rm --no-deps -T --entrypoint lab-prepare-recovery.sh postgres-recovery "${args[@]}" \
    || fail "No se pudo preparar la recuperacion."

  local t0 t1
  t0="$(now_epoch)"
  info "Iniciando postgres-recovery: reproduciendo WAL archivado hasta '${name:-$time}'..."
  docker compose --profile lab2 up -d --no-deps postgres-recovery >/dev/null

  local done_ok=false
  for i in $(seq 1 150); do
    if ! service_running postgres-recovery; then
      docker compose --profile lab2 logs --tail 30 postgres-recovery
      fail "postgres-recovery se detuvo durante la recuperacion (vea el registro anterior)."
    fi
    if [ "$(in_recovery postgres-recovery 2>/dev/null)" = "f" ]; then done_ok=true; break; fi
    sleep 2
  done
  [ "$done_ok" = "true" ] || { docker compose --profile lab2 logs --tail 30 postgres-recovery; fail "La recuperacion no termino a tiempo."; }
  t1="$(now_epoch)"

  docker compose --profile lab2 logs postgres-recovery 2>/dev/null | grep -E "recovery stopping|starting point-in-time|redo done|archive recovery complete|selected new timeline" | sed 's/^/    /' | tail -6
  local customers reservations
  customers="$(pg_sql postgres-recovery "SELECT count(*) FROM customers")"
  reservations="$(pg_sql postgres-recovery "SELECT count(*) FROM reservations")"
  ok "PITR completado en $((t1 - t0)) s: $customers clientes y $reservations reservaciones en postgres-recovery"

  local prepared
  prepared="$(control_read postgres-recovery last-restore.json)"
  local bk
  bk="$(echo "$prepared" | sed -n 's/.*"backup": *"\([^"]*\)".*/\1/p')"
  control_write postgres-recovery last-restore.json "{
  \"prepared_at\": \"$(echo "$prepared" | sed -n 's/.*"prepared_at": *"\([^"]*\)".*/\1/p')\",
  \"completed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
  \"backup\": \"$bk\",
  \"target_name\": \"$name\",
  \"target_time\": \"$time\",
  \"status\": \"completed\",
  \"duration_s\": $((t1 - t0)),
  \"customers\": $customers,
  \"reservations\": $reservations
}"

  if [ "$switch" = "true" ]; then
    local prev
    prev="$(current_target)"
    control_write postgres-recovery db-target "postgres-recovery"
    control_append postgres-recovery db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$prev|postgres-recovery|restore.sh|pitr"
    ok "La aplicacion del hotel ahora usa postgres-recovery (se reconecta en ~2 s)."
  fi
  echo "    Inspeccione con DBeaver: 127.0.0.1:${POSTGRES_RECOVERY_HOST_PORT} (usuario ${DB_READER_USER:-lab_reader})"
  echo "    El primario original (127.0.0.1:${POSTGRES_HOST_PORT}) conserva el estado posterior al borrado."
}

case "$MODE" in
  pitr) restore_pitr "$@" ;;
  keys) restore_keys "$@" ;;
  *) fail "Uso: ./scripts/restore.sh pitr [--name PUNTO|--time TS] | keys [archivo|latest]" ;;
esac
