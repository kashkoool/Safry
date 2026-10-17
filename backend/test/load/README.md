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

## Reduced run and gate (CI)

`seed.mjs` takes its size from environment variables (defaults above): `LOAD_TENANTS`, `LOAD_TRAVELERS_PER_TENANT`,
`LOAD_ORGS_PER_TENANT`, `LOAD_SERVICES_PER_ORG`, `LOAD_BOOKINGS_PER_TENANT`, `LOAD_HOT_BOOKINGS`, `LOAD_TOKENS_PER_TENANT`.
The CI workflow (`.github/workflows/load-test.yml`) uses 2 tenants, ~600 users and 4k bookings, 12 s per scenario.

`node check.mjs --label ci` then fails (exit 1) when any scenario has an error-response rate above 0.5 % or a p99 above its limit in
`thresholds.json`. The limits are about 3x the "after" p99 in the table above (rounded up; at least 250 ms for the health checks), because
shared CI runners are slower than the machine that produced it. Tighten them when the measured numbers on the runner are stable.

## Soak

`node soak.mjs --url http://127.0.0.1:3100 --minutes 30 --rate 20 --pid <API process id>` holds a constant low rate (mixed traveler requests) and
prints one JSON line per minute (p50, p95, p99, bad responses, API resident memory). Verdict (limits in `thresholds.json`, block `soak`): fails when
p95 of the last third of the run is more than 1.5x the first third (after a 3-minute warm-up), memory grew by more than 25 %, the error rate is above 0.5 %,
or a window completed no request. Result: `.data/soak-<label>.json`. CI: `.github/workflows/soak.yml` (manual only).

## Capacity scenarios (rate limiter on)

The ten scenarios above answer "does a code change make a request slower". These answer "how many users can one API process
carry". They run with the rate limiter ON (`NODE_ENV=development`, `TRUST_PROXY=1`), and every simulated client sends its own
address in `X-Forwarded-For`, as the reverse proxy does in the real deployment, so each client has its own per-address bucket.

```
# seed (the backend must be built: the seed hashes passwords with dist/common/security/password.js; one password per run,
# written to .data/tokens.json, which is git-ignored)
LOAD_DATABASE_URL=<superuser url> LOAD_JWT_SECRET=<32+ chars> node seed.mjs
# start the API with the limiter on (from backend/, runtime login in LOAD_DATABASE_URL)
LOAD_LIMITER=on LOAD_JWT_SECRET=<same> LOAD_DATABASE_URL=<runtime url> PORT=3100 bash test/load/start-api.sh
```

| scenario | how | what it shows |
|---|---|---|
| `login_storm` | `node run.mjs --only login_storm` (10 connections; `--steps 5,10,25,50,100,200` to find the knee) | distinct seeded users sign in at once, real argon2 behind the gate (4 running, 64 queued): queueing, p95, error rate |
| `registration_storm` | `node run.mjs --only registration_storm` (5 connections) | new accounts, a fresh address each, console mail transport |
| `booking_contention` | `LOAD_DATABASE_URL=<superuser url> node run.mjs --only booking_contention` | 500 travelers book the last seats of 10 services (capacity 20, one date). Asserts by SQL that no service is oversold and that created bookings equal taken seats; exits 1 otherwise |
| `limiter_single_ip` | `node run.mjs --only limiter_single_ip` | one address far above its per-minute ceiling: 200 until the ceiling, then 429; measures the 429 path and requires 0 server errors |
| `mixed_users` | `node vu.mjs --users 200 --seconds 120 --ramp 60 --think 4000 --label mixed_users` | N people, not N connections: each signs in, then picks marketplace 40 %, services 15 %, own bookings 25 %, me 12 %, refresh 8 % with an exponential think time |
| `steady_state` | `node vu.mjs --users 200 --seconds 600 --label steady_state --pid <API pid>` | the same workload for 10+ minutes: p95 drift (last third / first third) and API memory growth |

`node run.mjs --profile limiter` runs the first four with their default connection counts (below the knee, so the run is gateable).
Knobs: `--connections`, `--steps`, `--duration` (run.mjs); `--users`, `--seconds`, `--ramp` (seconds over which users sign in), `--think` (mean ms), `--label`,
`--pid` (vu.mjs); seed sizes `LOAD_CONTENDERS`, `LOAD_CONTENTION_SERVICES`, `LOAD_CONTENTION_CAPACITY` besides those listed above; API side `DATABASE_POOL_MAX`,
`HASH_CONCURRENCY`, `HASH_QUEUE`, `RATE_LIMIT_*`. Gate: `node check.mjs --label <label> --set limiter|users|steady` (limits in `thresholds.json`;
they are regression guards set well above what a laptop measures, not capacity targets). Seeded access tokens go stale after the idle timeout: re-seed
or set `refresh_sessions."lastUsedAt"` to now() when a scenario returns only 401.

Reading a result: `rps` is what the API completed, `p50/p95/p99` are client-side latency in ms, `count429` and `count5xx` are in the JSON next to the rate. A closed-loop
run (autocannon) can never offer more than `connections` requests at once, so latency grows linearly with connections once the API is saturated (Little's law);
the knee is the step before p95 jumps or errors appear, and the throughput plateau is the capacity. The user runs (`vu.mjs`) offer a fixed rate (users / think time),
so a latency jump means the offered rate is above capacity.

### Measured on the development machine (2026-10-17)

Docker Desktop on Windows 11: 16 logical CPUs and about 11.6 GB RAM visible to Docker; PostgreSQL 17 in a container; the API a single Node 22 process on the
Windows host (not in a container, not pinned), the load generator on the same host, so the three compete for the same CPUs. Pool 10, argon2 gate 4 + 64 queued,
dataset 3.5k users, 12k bookings, limiter on. **These are Docker Desktop laptop numbers, not production numbers.**

| scenario | connections / users | requests/s | p50 ms | p95 ms | p99 ms | errors | 429 |
|---|---|---|---|---|---|---|---|
| login_storm | 5 | 4 | 1070 | 2199 | 2350 | 0 | 0 |
| login_storm | 10 | 8 | 1151 | 1360 | 1847 | 0 | 0 |
| login_storm | 25 | 8 | 2955 | 3820 | 4331 | 0 | 0 |
| login_storm | 50 | 7 | 5482 | 8526 | 8747 | 0 | 0 |
| login_storm | 100 | 6 | 8359 | 14500 | 14905 | 35 % (HTTP 500) | 0 |
| login_storm | 200 | 21 | 6380 | 13450 | 14465 | 95 % (HTTP 500) | 0 |
| registration_storm | 5 / 10 / 20 / 50 | 9 / 9 / 8 / 8 | 520 / 1088 / 2077 / 5319 | 594 / 1214 / 2742 / 5541 | 631 / 1614 / 2971 / 5563 | 0 / 0 / 0 / 17 % | 0 |
| mixed (autocannon) | 10 | 76 | 125 | 194 | 254 | 0 | 0 |
| mixed (autocannon) | 25 | 77 | 329 | 447 | 520 | 0 | 0 |
| mixed (autocannon) | 50 | 75 | 648 | 1017 | 1113 | 0 | 0 |
| mixed (autocannon) | 100 | 76 | 1354 | 1840 | 1920 | 0 | 0 |
| mixed (autocannon) | 200 | 80 | 2459 | 3415 | 3663 | 0 | 0 |
| mixed (autocannon) | 400 | 97 | 3252 | 5625 | 5827 | 6 % (HTTP 500) | 0 |
| booking_contention (500 attempts, 200 seats) | 25 / 100 / 200 | 63 | 376 / 1387 / 2734 | 489 / 1659 / 3495 | 517 / 1716 / 3734 | 0 (200 x 201, 300 x 409) | 0 |
| limiter_single_ip (10 s) | 32 | 2265 | 14 | 19 | 29 | 0 | 22348 (300 x 200 first) |
| mixed_users (150 s) | 200 users | 50 | 46 | 142 | 439 | 0 | 0 |
| mixed_users | 300 users | 68 | 327 | 1373 | 4401 | 62 x HTTP 500 and 10 failed sign-ins | 0 |
| mixed_users | 400 users | 65 | 2562 | 3951 | 5327 | 0 | 0 |
| steady_state (10 min) | 200 users | 50 | 44 | 125 | 333 | 0; p95 drift 0.96x; API memory +0.5 % | 0 |

Knees: **sign-in** about 10 at a time (8 sign-ins/s; beyond that latency is pure queueing, and from about 100 at a time the API answers HTTP 500 instead of waiting: the
database transaction wait times out before the argon2 queue limit is reached). **Mixed reads**: about 25 connections for p95 under 500 ms, throughput plateau about 76
requests/s. **Users**: 200 users at a 4 s think time (50 requests/s) are comfortable (p95 142 ms); 300 users (68 requests/s) are at the plateau, and 400 users are past it.
During a sign-in wave faster than the sign-in capacity (300 users in 60 s) other users' reads failed with HTTP 500 too, because sign-ins and reads share the database pool.
No booking was ever oversold.

Rerun on the real deployment (CPU size, `DATABASE_POOL_MAX` times replicas against the Postgres connection budget, the real reverse proxy and its `TRUST_PROXY` value,
Redis limiter if used, a separate load generator): everything in the table, above all the sign-in knee (argon2 cost scales with CPU count), the registration path with real mail,
and a 30+ minute steady run.

### Proposed targets for a small product (proposals for the owner to adjust)

| measure | proposal | measured here |
|---|---|---|
| concurrent mixed users (4 s think time) | 200 users, p95 under 500 ms, p99 under 1.5 s, errors under 0.5 % | 200 users: p95 142 ms, p99 439 ms, 0 errors |
| sustained sign-ins | 20 per second | 8 per second (argon2-bound on this machine): not met |
| registration | 5 per second, 0 server errors | 9 per second |
| booking contention | 0 oversold, p95 under 2 s with 100 concurrent attempts | 0 oversold, p95 1.7 s |
| 429 answer | p99 under 100 ms, 0 server errors | p99 29 ms |
| 10-minute steady run | p95 drift under 1.5x, memory growth under 25 % | 0.96x, +0.5 % |
