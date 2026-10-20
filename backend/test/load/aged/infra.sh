#!/usr/bin/env bash
# Aged-database run infrastructure (local Docker only). Usage: bash infra.sh <a|b> <command> [db]
#   up        start a PostgreSQL 17 container (1 CPU, 1 GB, like docker-compose.yml), create the databases safry (aged) and safry_fresh
#   migrate   prisma migrate deploy on both databases with the run's migrate image, prints the time per database
#   roles     create the restricted runtime login (create-runtime-role.sql) for both databases
#   api <db>  start the real API container (runtime image, 1 CPU, 768 MB) against database <db> (safry or safry_fresh); port 3201 (a) / 3202 (b)
#   stop-api  stop the API container
#   down      remove the containers and the volume
# Secrets are generated into backend/test/load/.data/aged/<run>.env (git-ignored) and never printed.
# API_EXTRA_ENV="KEY=VALUE KEY2=VALUE2" adds environment variables to the API container.
set -euo pipefail
RUN="${1:?run a|b}"
CMD="${2:?command}"
DB="${3:-safry}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/../.data/aged"
mkdir -p "$DATA"
ENVF="$DATA/$RUN.env"
NET=safry-aged-net
PG="safry-aged-$RUN-pg"
API="safry-aged-$RUN-api"
if [ "$RUN" = a ]; then PGPORT=55621; APIPORT=3201; else PGPORT=55622; APIPORT=3202; fi
if [ ! -f "$ENVF" ]; then
  {
    echo "OWNER_PW=$(openssl rand -hex 16)"
    echo "RUNTIME_PW=$(openssl rand -hex 16)"
    echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\r\n')"
    echo "MFA_KEY=$(openssl rand -base64 48 | tr -d '\r\n')"
    echo "METRICS_TOKEN=$(openssl rand -base64 48 | tr -d '/+=\r\n')"
  } > "$ENVF"
fi
# shellcheck disable=SC1090
. "$ENVF"
case "$CMD" in
  up)
    docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
    docker run -d --name "$PG" --network $NET -p 127.0.0.1:$PGPORT:5432 --memory 1g --cpus 1.0 --shm-size 256m \
      -e POSTGRES_DB=safry -e POSTGRES_USER=safry -e POSTGRES_PASSWORD="$OWNER_PW" -v "safry-aged-$RUN-data:/var/lib/postgresql/data" postgres:17.11-alpine >/dev/null
    for i in $(seq 1 60); do docker exec "$PG" pg_isready -U safry -d safry >/dev/null 2>&1 && break; sleep 1; done
    sleep 3
    docker exec "$PG" psql -U safry -d safry -c "CREATE DATABASE safry_fresh OWNER safry" >/dev/null
    echo "pg up on $PGPORT" ;;
  migrate)
    for d in safry safry_fresh; do
      s=$(date +%s)
      docker run --rm --network $NET -e NODE_ENV=production -e DATABASE_URL="postgresql://safry:$OWNER_PW@$PG:5432/$d?schema=public" "safry-aged-$RUN-migrate" 2>&1 | tail -2
      e=$(date +%s)
      echo "migrate $d: $((e - s)) s (includes container start)"
    done ;;
  roles)
    for d in safry safry_fresh; do
      docker exec -i -e PGPASSWORD="$OWNER_PW" "$PG" psql -U safry -d "$d" -v runtime_password="$RUNTIME_PW" -f - < "$HERE/../../../scripts/db/create-runtime-role.sql" > /dev/null
    done
    echo roles ok ;;
  api)
    docker rm -f "$API" >/dev/null 2>&1 || true
    EXTRA=()
    for kv in ${API_EXTRA_ENV:-}; do EXTRA+=(-e "$kv"); done
    docker run -d --name "$API" --network $NET -p 127.0.0.1:$APIPORT:3000 --memory 768m --cpus 1.0 --pids-limit 200 \
      --log-opt max-size=2g --log-opt max-file=2 --log-opt compress=false \
      -e NODE_ENV=staging -e ALLOW_NON_PRODUCTION_DEFAULTS=true -e PORT=3000 -e API_PREFIX=api/v1 -e MAIL_TRANSPORT=console \
      -e DATABASE_URL="postgresql://safry_runtime:$RUNTIME_PW@$PG:5432/$DB?schema=public" \
      -e JWT_ACCESS_SECRET="$JWT_SECRET" -e MFA_ENCRYPTION_KEY="$MFA_KEY" -e METRICS_TOKEN="$METRICS_TOKEN" \
      -e TRUST_PROXY=1 -e CORS_ORIGINS= -e APP_BASE_URL=http://localhost:3001 -e SWAGGER_ENABLED=false \
      "${EXTRA[@]}" \
      "safry-aged-$RUN-runtime" >/dev/null
    for i in $(seq 1 90); do
      if curl -fs "http://127.0.0.1:$APIPORT/api/v1/health/ready" >/dev/null 2>&1; then echo "api ready on $APIPORT (db $DB)"; exit 0; fi
      sleep 1
    done
    docker logs --tail 30 "$API"
    exit 1 ;;
  stop-api) docker rm -f "$API" >/dev/null 2>&1 || true ;;
  down)
    docker rm -f "$API" "$PG" >/dev/null 2>&1 || true
    docker volume rm "safry-aged-$RUN-data" >/dev/null 2>&1 || true ;;
  *) echo "unknown command"; exit 2 ;;
esac
