#!/usr/bin/env bash
# Simulates an accidental deletion of customers in the DISPOSABLE lab environment.
# Usage: ./scripts/lab2-simulate-deletion.sh [--yes] [--country "Mexico"]
source "$(dirname "$0")/lib/common.sh"

require_docker
COUNTRY="Mexico"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --country) COUNTRY="$2"; shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$COUNTRY" in *"'"*|*"\\"*|"") fail "Invalid country" ;; esac

PRIMARY="$(current_primary)" || fail "No writable primary is running."
n="$(pg_sql "$PRIMARY" "SELECT count(*) FROM customers WHERE country = '$COUNTRY'")"
[ "$n" -gt 0 ] || fail "There are no customers from '$COUNTRY' on $PRIMARY: the deletion was already simulated. To repeat the lab use ./scripts/reset-lab.sh all"

cat <<MSG

Scenario: an operator wanted to delete ONE test customer with
    DELETE FROM users WHERE id = (SELECT user_id FROM customers WHERE customer_code = 'CUS-0151');
but by mistake ran an incomplete condition:
    DELETE FROM users WHERE id IN (SELECT user_id FROM customers WHERE country = '$COUNTRY');

Server: $PRIMARY   Affected customers: $n (with their encrypted data, wrapped keys and reservations)
MSG
confirm "This deletion is real in the lab database." DELETE

before="$(pg_sql "$PRIMARY" "SELECT count(*) || ' customers / ' || (SELECT count(*) FROM reservations) || ' reservations' FROM customers")"
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pg_sql "$PRIMARY" "INSERT INTO audit_events (actor_username, action, target_type, outcome, details) VALUES ('lab-operator', 'lab.simulated_deletion', 'customers', 'success', jsonb_build_object('country', '$COUNTRY', 'customers', $n)); DELETE FROM users WHERE id IN (SELECT user_id FROM customers WHERE country = '$COUNTRY');" >/dev/null
after="$(pg_sql "$PRIMARY" "SELECT count(*) || ' customers / ' || (SELECT count(*) FROM reservations) || ' reservations' FROM customers")"
ok "Deletion simulated at $AT"
echo "    Before: $before"
echo "    After:  $after"
echo "    See the loss at http://localhost:${HOTEL_APP_PORT}/customers and recover with ./scripts/restore.sh pitr"
