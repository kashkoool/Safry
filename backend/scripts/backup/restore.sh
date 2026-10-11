#!/bin/sh
# Restore a dump made by backup.sh into an EMPTY database.
#
#   restore.sh <dump-file> <target-connection-string> [roles-file]
#
# Refuses to run against a database that already has tables, so a typo cannot overwrite production.
set -eu
dump="${1:?dump file}"
target="${2:?target connection string}"
roles="${3:-}"

( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" )
existing="$(psql "$target" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[ "$existing" = "0" ] || { echo "target database is not empty ($existing tables): restore into a new database" >&2; exit 1; }

[ -z "$roles" ] || psql "$target" -q -f "$roles" >/dev/null 2>&1 || true
pg_restore --exit-on-error --no-owner --dbname="$target" "$dump"
echo "restore finished"
