#!/usr/bin/env bash
# Stops every lab container WITHOUT deleting volumes (data, backups and keys are preserved).
source "$(dirname "$0")/lib/common.sh"
require_docker
info "Stopping the containers of project $COMPOSE_PROJECT_NAME (volumes are preserved)..."
docker compose --profile lab1 --profile lab2 stop
ok "Containers stopped. To start again: ./scripts/start.sh"
