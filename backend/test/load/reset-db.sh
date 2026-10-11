#!/usr/bin/env bash
# Restores the seeded dataset from the template database (fast alternative to re-running seed.mjs).
# Usage: CONTAINER=safry-g5-pg ./reset-db.sh   (stop the API first: no open connections allowed)
set -euo pipefail
CONTAINER="${CONTAINER:-safry-g5-pg}"
docker exec "$CONTAINER" psql -U safry -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS safry" -c "CREATE DATABASE safry TEMPLATE safry_seed"
# Sessions in the template are older than the idle timeout by now: make them fresh again.
docker exec "$CONTAINER" psql -U safry -d safry -v ON_ERROR_STOP=1 -c "UPDATE refresh_sessions SET \"lastUsedAt\" = now(), \"revokedAt\" = NULL, \"expiresAt\" = now() + interval '1 day'"
