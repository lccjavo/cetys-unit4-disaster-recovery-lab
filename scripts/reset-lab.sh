#!/usr/bin/env bash
# Restablece partes del laboratorio de forma controlada. Siempre pide confirmacion
# (o --yes) y lista exactamente los volumenes que se eliminan.
#
#   ./scripts/reset-lab.sh lab1   reconstruye la pareja primario/standby despues de un failover
#   ./scripts/reset-lab.sh lab2   elimina la instancia de recuperacion PITR y regresa la app al primario
#   ./scripts/reset-lab.sh all    base de datos nueva (150 clientes otra vez); CONSERVA llaves y sus respaldos
#   ./scripts/reset-lab.sh all --include-keys   tambien borra KEKs y respaldos de KEK (empezar de cero)
#
# Nunca usa 'docker system prune' ni toca recursos de otros proyectos.
source "$(dirname "$0")/lib/common.sh"

require_docker
MODE="${1:-}"; shift || true
INCLUDE_KEYS=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --include-keys) INCLUDE_KEYS=true; shift ;;
    *) fail "Opcion desconocida: $1" ;;
  esac
done

P="$COMPOSE_PROJECT_NAME"
vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
remove_volumes() {
  for v in "$@"; do
    if vol_exists "$v"; then docker volume rm "$v" >/dev/null && ok "Volumen eliminado: $v"; else info "No existia: $v"; fi
  done
}
set_target_primary() {
  local prev
  prev="$(current_target)"
  control_write postgres-primary db-target "postgres-primary"
  control_append postgres-primary db-target.log "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$prev|postgres-primary|reset-lab.sh|reset"
}

case "$MODE" in
  lab1)
    cat <<MSG
Reconstruccion del laboratorio 1:
  - Se elimina el contenedor postgres-standby y el volumen ${P}_pg-standby-data
  - Se retira el cerco del primario original y la aplicacion vuelve a postgres-primary
  - Se vuelve a clonar el standby desde el primario con pg_basebackup
  Los cambios escritos en el standby DESPUES de la promocion se descartan.
  Se conservan: primario, respaldos, archivo WAL, llaves y respaldos de llaves.
MSG
    confirm "" RECONSTRUIR
    docker compose --profile lab1 rm -sf postgres-standby >/dev/null 2>&1 || true
    remove_volumes "${P}_pg-standby-data"
    docker compose up -d --no-deps postgres-primary >/dev/null
    docker compose exec -T postgres-primary sh -c 'rm -f /lab-control/primary.fenced' 2>/dev/null || true
    docker compose up -d --no-deps --force-recreate postgres-primary >/dev/null
    wait_healthy postgres-primary 120 || fail "postgres-primary no arranco."
    ok "postgres-primary en linea"
    set_target_primary
    docker compose --profile lab1 up -d --no-deps postgres-standby >/dev/null
    wait_healthy postgres-standby 180 || fail "postgres-standby no arranco. Revise: docker compose logs postgres-standby"
    ok "postgres-standby clonado y replicando"
    docker compose up -d hotel-app >/dev/null
    ok "Laboratorio 1 reconstruido."
    ;;
  lab2)
    cat <<MSG
Limpieza del laboratorio 2:
  - Se elimina el contenedor postgres-recovery y el volumen ${P}_pg-recovery-data
  - La aplicacion vuelve a postgres-primary (que conserva el borrado simulado)
  Se conservan: primario, respaldos fisicos, archivo WAL, llaves y respaldos de llaves.
  Para repetir el laboratorio 2 completo desde 150 clientes use: ./scripts/reset-lab.sh all
MSG
    confirm "" LIMPIAR
    docker compose --profile lab2 rm -sf postgres-recovery >/dev/null 2>&1 || true
    remove_volumes "${P}_pg-recovery-data"
    service_running postgres-primary || docker compose up -d postgres-primary >/dev/null
    wait_healthy postgres-primary 120 || true
    set_target_primary
    ok "Instancia de recuperacion eliminada; la aplicacion usa postgres-primary."
    ;;
  all)
    VOLS=("${P}_pg-primary-data" "${P}_pg-standby-data" "${P}_pg-recovery-data" "${P}_pg-wal-archive" "${P}_pg-backups" "${P}_lab-control")
    [ "$INCLUDE_KEYS" = "true" ] && VOLS+=("${P}_vault-keys" "${P}_vault-backups")
    echo "Reinicio completo de la base de datos del proyecto $P. Se eliminaran estos volumenes:"
    for v in "${VOLS[@]}"; do echo "  - $v"; done
    if [ "$INCLUDE_KEYS" = "true" ]; then
      echo "  ATENCION: tambien se borran los KEK y sus respaldos. No podra descifrar copias anteriores."
      confirm "" BORRAR-TODO-Y-LLAVES
    else
      echo "Se CONSERVAN: ${P}_vault-keys y ${P}_vault-backups (los KEK actuales se reutilizan)."
      confirm "" REINICIAR
    fi
    docker compose --profile lab1 --profile lab2 down --remove-orphans
    remove_volumes "${VOLS[@]}"
    info "Iniciando un entorno limpio (la app genera los 150 clientes al detectar la base vacia)..."
    docker compose up -d >/dev/null
    for svc in postgres-primary key-vault hotel-app; do wait_healthy "$svc" 180 || fail "$svc no arranco"; done
    for i in $(seq 1 90); do
      n="$(pg_sql postgres-primary "SELECT count(*) FROM customers" 2>/dev/null || echo 0)"
      seeded="$(pg_sql postgres-primary "SELECT count(*) FROM lab_metadata WHERE key = 'seed_completed_at'" 2>/dev/null || echo 0)"
      [ "${seeded:-0}" = "1" ] && break
      sleep 2
    done
    [ "${seeded:-0}" = "1" ] || fail "La inicializacion no termino. Revise: docker compose logs hotel-app"
    ok "Entorno reiniciado: $n clientes ficticios."
    ;;
  *)
    fail "Uso: ./scripts/reset-lab.sh lab1|lab2|all [--yes] [--include-keys]"
    ;;
esac
