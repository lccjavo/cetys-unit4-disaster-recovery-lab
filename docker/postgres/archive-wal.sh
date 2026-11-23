#!/bin/sh
# archive_command del laboratorio: copia un segmento WAL al volumen /wal-archive.
# Uso (lo invoca PostgreSQL): archive-wal.sh %p %f
# - Nunca sobrescribe un archivo existente con contenido distinto.
# - Si el archivo ya existe y es identico, responde exito (reintento seguro).
set -eu
src="$1"
name="$2"
dest="/wal-archive/$name"

if [ -f "$dest" ]; then
  if cmp -s "$src" "$dest"; then
    exit 0
  fi
  echo "archive-wal: $name ya existe en el archivo con contenido distinto; no se sobrescribe" >&2
  exit 1
fi

tmp="$dest.tmp.$$"
cp "$src" "$tmp"
mv "$tmp" "$dest"
