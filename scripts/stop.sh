#!/usr/bin/env bash
# Detiene todos los contenedores del laboratorio SIN borrar volumenes (datos, respaldos y llaves se conservan).
source "$(dirname "$0")/lib/common.sh"
require_docker
info "Deteniendo contenedores del proyecto $COMPOSE_PROJECT_NAME (los volumenes se conservan)..."
docker compose --profile lab1 --profile lab2 stop
ok "Contenedores detenidos. Para volver a iniciar: ./scripts/start.sh"
