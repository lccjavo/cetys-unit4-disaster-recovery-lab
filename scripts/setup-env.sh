#!/usr/bin/env bash
# Genera el archivo .env a partir de .env.example con secretos locales aleatorios.
# Nunca sobrescribe un .env existente sin confirmacion explicita.
#
# Uso: ./scripts/setup-env.sh [--force] [--output ARCHIVO]
#   --force           sobrescribe sin preguntar (guarda una copia .env.bak-<fecha>)
#   --output ARCHIVO  escribe en otro archivo (lo usan las pruebas automatizadas)

source "$(dirname "$0")/lib/common.sh"

FORCE=false
OUT=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --output) OUT="$2"; shift 2 ;;
    *) fail "Opcion desconocida: $1" ;;
  esac
done

[ -f .env.example ] || fail "No se encontro .env.example en $REPO_ROOT"

if [ -f "$OUT" ]; then
  if [ "$FORCE" != "true" ]; then
    warn "Ya existe el archivo $OUT."
    warn "Si lo regenera, las contrasenas nuevas NO coincidiran con volumenes de PostgreSQL ya creados"
    warn "ni con respaldos de KEK cifrados con la frase de paso anterior."
    if [ ! -t 0 ]; then fail "No se sobrescribe .env sin confirmacion. Use --force si realmente lo desea."; fi
    read -r -p "Escriba SOBRESCRIBIR para reemplazarlo (se guardara una copia): " answer
    [ "$answer" = "SOBRESCRIBIR" ] || { info "Se conserva el .env actual. No se hizo ningun cambio."; exit 0; }
  fi
  backup="${OUT}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$OUT" "$backup"
  chmod 600 "$backup"
  info "Copia del .env anterior: $backup"
fi

# Advertir si ya existen volumenes del proyecto (las contrasenas de PostgreSQL ya quedaron fijadas).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  existing="$(docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${existing:-0}" -gt 0 ]; then
    warn "Ya existen $existing volumenes del proyecto ${COMPOSE_PROJECT_NAME}."
    warn "PostgreSQL solo aplica POSTGRES_PASSWORD al crear su volumen. Si los volumenes se crearon con otro .env,"
    warn "use ./scripts/reset-lab.sh all para empezar limpio (vea 'Problemas comunes' en el README)."
  fi
fi

secret() {
  # 32 caracteres hexadecimales (128 bits) desde /dev/urandom; sin dependencias de openssl.
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

# Validacion minima del archivo generado.
for required in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DB_HOST DB_USER DB_PASSWORD DB_READER_USER DB_READER_PASSWORD KEY_VAULT_URL KEY_VAULT_SERVICE_TOKEN HOTEL_SESSION_SECRET VAULT_SESSION_SECRET VAULT_BACKUP_PASSPHRASE; do
  grep -q "^${required}=." "$OUT" || fail "$OUT generado sin $required"
done
if grep -qE "^[A-Z_][A-Z0-9_]*=CHANGE_ME$" "$OUT"; then fail "Quedaron valores CHANGE_ME en $OUT"; fi

get() { grep "^$1=" "$OUT" | head -1 | cut -d= -f2-; }

title "Archivo $OUT generado correctamente ($generated secretos aleatorios)"
cat <<EOF
  Proyecto Docker Compose : $(get COMPOSE_PROJECT_NAME)
  Base de datos           : $(get POSTGRES_DB)
  Host dentro de Docker   : $(get DB_HOST):$(get DB_PORT)
  Host para DBeaver       : 127.0.0.1:$(get POSTGRES_HOST_PORT)  (standby: $(get POSTGRES_STANDBY_HOST_PORT), recuperacion: $(get POSTGRES_RECOVERY_HOST_PORT))
  Usuario de la app       : $(get DB_USER)
  Usuario solo lectura    : $(get DB_READER_USER)  (contrasena en DB_READER_PASSWORD)
  Hotel Management        : http://localhost:$(get HOTEL_APP_PORT)
  Key Vault (GUI)         : http://localhost:$(get KEY_VAULT_APP_PORT)
  API interna Key Vault   : $(get KEY_VAULT_URL)  (no se publica al anfitrion)

Las contrasenas y tokens NO se imprimen. Para consultarlas:
  cat .env                              (todo el archivo)
  grep DB_READER_PASSWORD .env          (contrasena de DBeaver)

Siguiente paso:
  docker compose up -d postgres-primary key-vault
EOF
