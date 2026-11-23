#!/usr/bin/env bash
# Muestra el estado del laboratorio: contenedores, servidor de la app, replicacion, WAL, respaldos y llaves.
source "$(dirname "$0")/lib/common.sh"
require_docker
set +e

title "Contenedores ($COMPOSE_PROJECT_NAME)"
docker compose --profile lab1 --profile lab2 ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

TARGET="$(current_target)"
title "Servidor que usa la aplicacion del hotel: $TARGET"
for svc in postgres-primary postgres-standby postgres-recovery; do
  if service_running "$svc"; then
    row="$(pg_sql "$svc" "SELECT current_setting('cluster_name') || ' | ' || CASE WHEN pg_is_in_recovery() THEN 'standby/recuperacion' ELSE 'primario' END || ' | timeline ' || (SELECT timeline_id FROM pg_control_checkpoint()) || ' | clientes: ' || (SELECT count(*) FROM customers) || ' | reservaciones: ' || (SELECT count(*) FROM reservations)" 2>/dev/null)"
    echo "  $svc: ${row:-sin respuesta (posible cerco o arranque en curso)}"
  else
    echo "  $svc: detenido / no creado"
  fi
done

P="$(current_primary 2>/dev/null)"
if [ -n "$P" ]; then
  title "Replicacion (desde $P)"
  r="$(pg_sql "$P" "SELECT application_name || ' ' || state || ' ' || sync_state || ' atraso_bytes=' || coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint::text, '?') FROM pg_stat_replication")"
  echo "  ${r:-sin standbys conectados}"
  title "Archivado de WAL (pg_stat_archiver en $P)"
  pg_sql "$P" "SELECT 'archive_mode=' || current_setting('archive_mode') || '  archivados=' || archived_count || '  ultimo=' || coalesce(last_archived_wal, 'ninguno') || '  fallidos=' || failed_count FROM pg_stat_archiver" | sed 's/^/  /'
  title "Respaldos fisicos"
  docker compose exec -T "$P" sh -c 'ls -1 /backups/catalog/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed "s/.json$//"' | sed 's/^/  /'
  title "Puntos de restauracion"
  docker compose exec -T "$P" sh -c 'cat /lab-control/restore-points.log 2>/dev/null || echo ninguno' | sed 's/^/  /'
fi

if service_running key-vault; then
  title "Key Vault"
  vault_cli status 2>/dev/null | grep -E '"(vault_status|active_kek_id|kek_count|access_disabled|simulated_outage|wrap|unwrap)"' | sed 's/^ */  /'
fi
echo
echo "Hotel: http://localhost:${HOTEL_APP_PORT}   Key Vault: http://localhost:${KEY_VAULT_APP_PORT}"
exit 0
