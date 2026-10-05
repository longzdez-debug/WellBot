#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$BACKUP_DIR/.wellbot-$timestamp.dump"
out="$BACKUP_DIR/wellbot-$timestamp.dump"

umask 077
trap 'rm -f "$tmp"' EXIT INT TERM

pg_dump --format=custom --no-owner --no-acl --file="$tmp" "$DATABASE_URL"
test -s "$tmp"
mv "$tmp" "$out"

find "$BACKUP_DIR" -type f -name 'wellbot-*.dump' -mtime "+$RETENTION_DAYS" -delete

echo "backup=$out"
echo "size_bytes=$(wc -c < "$out" | tr -d ' ')"
