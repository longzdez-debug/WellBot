#!/usr/bin/env sh
set -eu

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must be set}"
BACKUP_FILE="${BACKUP_FILE:-}"
[ -n "$BACKUP_FILE" ] || { echo "BACKUP_FILE must point to a .dump file" >&2; exit 2; }
[ -s "$BACKUP_FILE" ] || { echo "Backup file is missing or empty: $BACKUP_FILE" >&2; exit 2; }

pg_restore --clean --if-exists --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"

psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 1;
SELECT to_regclass('public.links') IS NOT NULL AS links_table_present;
SELECT to_regclass('public.notification_outbox') IS NOT NULL AS outbox_table_present;
SQL

echo "restore_drill=passed"
