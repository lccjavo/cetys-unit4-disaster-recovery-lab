#!/usr/bin/env bash
# Crea un punto de restauracion con nombre (pg_create_restore_point) y fuerza el archivado del WAL.
# Uso: ./scripts/lab2-recovery-point.sh [nombre]   (por defecto: antes_borrado)
source "$(dirname "$0")/lib/common.sh"

require_docker
NAME="${1:-antes_borrado}"
[[ "$NAME" =~ ^[a-z0-9_]{3,40}$ ]] || fail "Nombre invalido. Use minusculas, numeros y guion bajo (3 a 40)."

PRIMARY="$(current_primary)" || fail "No hay un primario escribible en ejecucion."
nb="$(docker compose exec -T "$PRIMARY" sh -c 'ls /backups/catalog/*.json 2>/dev/null | wc -l' | tr -d '[:space:]')"
[ "${nb:-0}" -gt 0 ] || warn "No existe ningun respaldo base. Cree uno ANTES del punto de restauracion: ./scripts/backup.sh db"

counts="$(pg_sql "$PRIMARY" "SELECT (SELECT count(*) FROM customers) || ' clientes, ' || (SELECT count(*) FROM reservations) || ' reservaciones'")"
LSN="$(pg_sql "$PRIMARY" "SELECT pg_create_restore_point('$NAME')")"
WALFILE="$(pg_sql "$PRIMARY" "SELECT pg_walfile_name(pg_switch_wal())")"
info "Punto '$NAME' creado en LSN $LSN (estado: $counts). Esperando el archivado de $WALFILE..."

for i in $(seq 1 60); do
  last="$(pg_sql "$PRIMARY" "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")"
  if [ -n "$last" ] && [[ ! "$last" < "$WALFILE" ]]; then break; fi
  sleep 1
done
[ -n "${last:-}" ] && [[ ! "$last" < "$WALFILE" ]] || fail "El segmento $WALFILE no se archivo a tiempo. Revise: docker compose logs $PRIMARY"

AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
control_append "$PRIMARY" restore-points.log "$AT|$NAME|$LSN"
ok "Punto de restauracion '$NAME' listo y archivado (WAL $last)."
echo "    Registro: /lab-control/restore-points.log"
echo "    Recuperar con: ./scripts/restore.sh pitr --name $NAME"
