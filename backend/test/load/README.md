# Load test (autocannon)

Seeded dataset: 4 tenants, ~9.7k users, 50k bookings, 1.6k services, 800 pre-minted access tokens.

```
docker run -d --name safry-g5-pg -p 55505:5432 -e POSTGRES_PASSWORD=<pw> postgres:17-alpine
# owner role without superuser; it must be a member of the RLS app role after migrate:
psql -c "CREATE ROLE safry LOGIN PASSWORD '<pw2>' CREATEDB" -c "CREATE DATABASE safry OWNER safry"
DATABASE_URL=postgresql://safry:<pw2>@127.0.0.1:55505/safry npx prisma migrate deploy
psql -c "GRANT safry_app TO safry"
LOAD_DATABASE_URL=<superuser url> LOAD_JWT_SECRET=<32+ chars> node seed.mjs
LOAD_JWT_SECRET=<same> PORT=55517 bash start-api.sh      # from backend/, after nest build
node run.mjs --url http://127.0.0.1:55517 --duration 15 --label after
```

Results (JSON) live in `results/`. Same machine, 15 s per scenario, NODE_ENV=test (throttler off), pool 10, one API process.
`baseline` = code before the performance work, `after` = merged branch (auth/authz/database hardening included).

| scenario | conns | RPS before -> after | p50 ms | p95 ms | p99 ms | errors before -> after |
|---|---|---|---|---|---|---|
| health_live | 64 | 3141 -> 5041 | 18 -> 12 | 36 -> 18 | 57 -> 22 | 0 -> 0 |
| health_ready | 32 | 1206 -> 1662 | 24 -> 18 | 48 -> 28 | 72 -> 36 | 0 -> 0 |
| auth/me | 64 | 68 -> 447 | 906 -> 18 | 1225 -> 614 | 1648 -> 987 | 0 -> 0 |
| auth/activity | 64 | 65 -> 345 | 935 -> 33 | 1274 -> 503 | 1525 -> 764 | 0 -> 0 |
| bookings (traveler) | 32 | 35 -> 65 | 817 -> 488 | 1324 -> 628 | 1478 -> 676 | 0 -> 0 |
| bookings (admin) | 8 | 1 -> 68 | 6739 -> 105 | 9469 -> 194 | 9469 -> 291 | 18% -> 0 |
| marketplace | 16 | 12 -> 64 | 891 -> 234 | 5148 -> 410 | 5963 -> 480 | 3.9% -> 0 |
| services (provider) | 16 | 19 -> 170 | 704 -> 85 | 2442 -> 173 | 2706 -> 201 | 0 -> 0 |
| booking create (hot) | 16 | 7 -> 47 | 2179 -> 349 | 3084 -> 393 | 3604 -> 418 | 0 -> 0 |
| mixed traveler | 48 | 29 -> 96 | 1559 -> 498 | 2721 -> 854 | 3059 -> 1147 | 0 -> 0 |

After the hot-booking scenario no (service, date) exceeded capacity (SQL check, 0 rows).
Caveat: the two runs were taken on different days on a shared dev laptop; treat ratios, not absolute numbers.
