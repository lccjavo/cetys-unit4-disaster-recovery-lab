#!/usr/bin/env bash
# Simula un borrado accidental de clientes en el entorno DESECHABLE del laboratorio.
# Uso: ./scripts/lab2-simulate-deletion.sh [--yes] [--country "México"]
source "$(dirname "$0")/lib/common.sh"

require_docker
COUNTRY="México"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --country) COUNTRY="$2"; shift 2 ;;
    *) fail "Opcion desconocida: $1" ;;
  esac
done
case "$COUNTRY" in *"'"*|*"\\"*|"") fail "Pais invalido" ;; esac

PRIMARY="$(current_primary)" || fail "No hay un primario escribible en ejecucion."
n="$(pg_sql "$PRIMARY" "SELECT count(*) FROM customers WHERE country = '$COUNTRY'")"
[ "$n" -gt 0 ] || fail "No hay clientes de '$COUNTRY' en $PRIMARY: el borrado ya se simulo. Para repetir el laboratorio use ./scripts/reset-lab.sh all"

cat <<MSG

Escenario: un operador queria borrar UN cliente de prueba con
    DELETE FROM users WHERE id = (SELECT user_id FROM customers WHERE customer_code = 'CUS-0151');
pero ejecuto por error una condicion incompleta:
    DELETE FROM users WHERE id IN (SELECT user_id FROM customers WHERE country = '$COUNTRY');

Servidor: $PRIMARY   Clientes afectados: $n (con sus datos cifrados, llaves envueltas y reservaciones)
MSG
confirm "Este borrado es real en la base del laboratorio." BORRAR

before="$(pg_sql "$PRIMARY" "SELECT count(*) || ' clientes / ' || (SELECT count(*) FROM reservations) || ' reservaciones' FROM customers")"
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pg_sql "$PRIMARY" "INSERT INTO audit_events (actor_username, action, target_type, outcome, details) VALUES ('operador-lab', 'lab.simulated_deletion', 'customers', 'success', jsonb_build_object('country', '$COUNTRY', 'customers', $n)); DELETE FROM users WHERE id IN (SELECT user_id FROM customers WHERE country = '$COUNTRY');" >/dev/null
after="$(pg_sql "$PRIMARY" "SELECT count(*) || ' clientes / ' || (SELECT count(*) FROM reservations) || ' reservaciones' FROM customers")"
ok "Borrado simulado a las $AT"
echo "    Antes:   $before"
echo "    Despues: $after"
echo "    Observe la perdida en http://localhost:${HOTEL_APP_PORT}/customers y recupere con ./scripts/restore.sh pitr"
