#!/bin/sh
# Lab archive_command: copies one WAL segment to the /wal-archive volume.
# Usage (called by PostgreSQL): archive-wal.sh %p %f
# - Never overwrites an existing file that has different content.
# - If the file already exists and is identical, it reports success (safe retry).
set -eu
src="$1"
name="$2"
dest="/wal-archive/$name"

if [ -f "$dest" ]; then
  if cmp -s "$src" "$dest"; then
    exit 0
  fi
  echo "archive-wal: $name already exists in the archive with different content; not overwriting" >&2
  exit 1
fi

tmp="$dest.tmp.$$"
cp "$src" "$tmp"
mv "$tmp" "$dest"
