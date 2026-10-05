#!/usr/bin/env sh
set -eu

required_files="
docs/operations.md
monitoring/prometheus.yml
monitoring/prometheus/alerts.yml
monitoring/alertmanager.yml.example
scripts/backup-postgres.sh
scripts/restore-drill.sh
"

for file in $required_files; do
  test -s "$file" || { echo "missing: $file" >&2; exit 1; }
done

sh -n scripts/backup-postgres.sh
sh -n scripts/restore-drill.sh
echo "operations_check=passed"
