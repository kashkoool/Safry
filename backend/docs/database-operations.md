# Database operations runbook

Scope: PostgreSQL 17 behind the Safry API (Prisma 7, row-level security). Everything here was exercised
against a throwaway Docker PostgreSQL; commands are copy-pasteable from `backend/`.

## 1. Two connections, two roles

| Variable | Used by | Role | Needs |
|---|---|---|---|
| `DATABASE_MIGRATE_URL` | `prisma migrate deploy`, `db:seed`, `bootstrap-platform-admin`, `backup.sh`, retention jobs | owner of the schema | DDL, `BYPASSRLS` not required: the purge procedures and the operator scripts (`db:bootstrap`, `db:seed`, `admin:bootstrap`) set the transaction-local bypass flag themselves; proven against a CREATEROLE, non-superuser owner in `test/bootstrap.int.spec.ts` |
| `DATABASE_URL` | the running API | `safry_runtime` (LOGIN, non-owner, non-superuser, NOBYPASSRLS), member of `safry_app` | DML only |

If `DATABASE_MIGRATE_URL` is unset, everything falls back to `DATABASE_URL` (the old single-URL setup keeps
working; the API then logs a warning at boot when that login is a superuser or has BYPASSRLS).

One-time setup per database, as the owner or a superuser:

```sh
psql "$DATABASE_MIGRATE_URL" -v runtime_password="$(openssl rand -base64 24)" -f scripts/db/create-runtime-role.sql
```

Store the generated password in the secret manager and put it in `DATABASE_URL`. Behaviour is unchanged: each
request still switches to `safry_app` inside its transaction and sets the tenant. Because `safry_runtime` is not
the table owner and not BYPASSRLS, forced RLS applies to it even if that switch were skipped (fail closed).
The role also carries `statement_timeout=60s`, `idle_in_transaction_session_timeout=60s`, `lock_timeout=10s`.

At boot the API runs a probe transaction that proves `SET ROLE safry_app` works for the connecting login and
refuses to start if it does not (a swallowed `GRANT` would otherwise surface only on the first request).
`safry_app` is granted to the `safry_runtime` login only, never to the owner login. With `NODE_ENV=production` the API
also refuses to start when its login is a superuser, has BYPASSRLS, or owns (or is a member of the owner of) tables in
`public`: such a login can `RESET ROLE` out of `safry_app` and skip row-level security.

## 1a. Rate limiting and Redis outages

With `RATE_LIMIT_REDIS_URL` set, limits are shared across replicas. If Redis errors, the API fails degraded, not closed:
the in-process store answers (limits still apply per instance, so they multiply by replica count), one error is logged
per outage, `/metrics` exposes `safry_rate_limit_degraded` (0/1) and `safry_rate_limit_fallback_total`, and
`/health/ready` returns 200 with `status: "degraded"` / `rateLimit: "degraded-in-process"` (not 503: the API still serves).
The per-account bucket is keyed on e-mail plus client address; many addresses against one account are bounded by the
database login lockout (progressive, never blocks the owner's own address).

`POST /auth/refresh` (every page reload makes one) is limited per session, not only per address, so people behind one
shared address do not sign each other out. A refresh token that belongs to a live session is counted against that session
(family id, which survives rotation; the token itself is never stored or logged): `RATE_LIMIT_REFRESH_SESSION_PER_MINUTE`,
default 30. A missing or unknown token, an already used (rotated or revoked) token, or one whose stored expiry has passed is counted against the client address (a session that only timed out from inactivity is still counted per session, then refused):
`RATE_LIMIT_REFRESH_INVALID_PER_MINUTE`, default 20. All refresh calls also count toward the general per-address ceiling
`RATE_LIMIT_IP_PER_MINUTE` (default 300).

## 2. Migration rules

- New migrations are named `YYYYMMDD_<area>_<what>` so parallel branches never collide on a sequence number.
  There is no migration `0007` in the history (numbering jumps from `0006` to `0008`; the original reason is unknown); do not create
  one, and do not renumber: Prisma orders by directory name and records names in `_prisma_migrations`.
- DDL and data backfills live in separate migrations. Backfills must be idempotent and batched.
- Constraints on populated tables: `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT` (see
  `20261007_db_constraints`). A failing `VALIDATE` aborts the deploy; fix the data, never weaken the check.
- Indexes on large tables: `prisma migrate deploy` runs a file as one transaction, where
  `CREATE INDEX CONCURRENTLY` is not allowed. For a table over roughly 1M rows, create the index by hand
  first with the same name, then deploy (the migration uses `IF NOT EXISTS` and becomes a no-op):

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "bookings_example_idx" ON "bookings"("tenantId", "createdAt");
  ```

  If a concurrent build is cancelled it leaves an INVALID index: `DROP INDEX CONCURRENTLY` it and retry
  (`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`).
- Migration `0011_dev_server_wal_access` only does something on a database created by `prisma dev`
  (schema `_prisma_dev_wal`). It must never reach production: the API refuses to start with
  `NODE_ENV=production` when that schema exists. Never restore a developer database into an environment.
- Drift is checked automatically: `test/migrations.int.spec.ts` builds a fresh database from the migrations,
  asserts `prisma migrate diff` is empty and asserts what must still exist (tables, forced RLS, the
  non-privileged `safry_app` role, validated CHECKs, an index led by every foreign-key column). Run by hand:

  ```sh
  pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
  ```

  Expression indexes (for example the case-insensitive organization name) are not representable in
  `schema.prisma` and are not compared by that command.

### Row-level security on `users`

`users` is global (no tenant column). Migration `20261018_authz_users_row_level_security` puts forced row-level security on it:

- A tenant session sees and updates only identities that hold a membership in its tenant, and can never delete one.
- A tenant session may change only `displayName`, `phone` and `locale` of a member (trigger allow-list); e-mail, password hash, MFA state, status and `authVersion` change only in the system scope (login, password reset, MFA, platform administration).
- Staff creation and invitations look an identity up by e-mail and create one before a membership exists. They do it inside `withIdentityLookup` (`src/database/identity-access.ts`), which raises the transaction-local flag `app.identity_system` for SELECT and INSERT on `users` only.
- Operator scripts that run as a non-superuser owner need the system scope (`withRlsBypass`), as for every other forced table.
- **Rolling out**: deploy the NEW IMAGE FIRST, then the migration. The new image works on the old schema (it only sets a transaction-local setting and runs the second-factor check in the system scope). An image built before this change on the new schema fails with 42501 (HTTP 500) for staff creation, invitations, MFA disable and recovery-code regeneration.
- **Only a consenting, non-revoked member can be edited** from a tenant session (membership with `awaitingOwnerConsent = false` and status not `REVOKED`); SELECT still shows any member, including invited ones, because invitations list them.
- **Rollback**: run [rollback/users-row-level-security.sql](rollback/users-row-level-security.sql) as the owner (it drops the policies, disables RLS on `users` and restores the previous trigger), then `prisma migrate resolve --rolled-back 20261018_authz_users_row_level_security`. `test/users-rls.int.spec.ts` runs this file and checks the result.

### Money columns (bigint minor units)

`travel_services.priceCents`, `bookings.unitPriceCents` and `bookings.totalCents` are PostgreSQL `bigint` (migration
`20261014_db_money_bigint`; they were 32-bit `integer`, which stops at 2,147,483,647 minor units). The values are integer minor
units (cents); there is no fractional amount anywhere, so `bigint` is exact and `numeric` was not needed.

- **In the application** amounts are `bigint` (Prisma `BigInt`) and every product is computed with `bigint`
  (`bookingTerms` in `booking-rules.ts`); no floating-point arithmetic touches money. A total above `Number.MAX_SAFE_INTEGER`
  (9,007,199,254,740,991) is refused with `400`.
- **At the API** nothing changed: money fields stay JSON numbers. A global interceptor (`src/common/money`) converts every
  `bigint` in a response to a number and **throws** (HTTP 500, nothing rounded) for a stored value beyond the largest exact JSON
  integer, so a precision-losing answer is impossible. Request fields are still validated as integers by the DTOs (service
  price 100..100,000,000 minor units).
- **Locking**: `ALTER COLUMN ... TYPE bigint` rewrites the table and its indexes under `ACCESS EXCLUSIVE`; reads and writes of
  `travel_services` / `bookings` wait until the migration commits (a few seconds per million rows). The migration sets
  `lock_timeout = 10s`, so it fails fast instead of queueing every request behind a long transaction; just rerun it when quiet.
  For a table too large for one rewrite, use expand/contract instead: add nullable `bigint` columns, dual-write, backfill in
  batches, switch reads, drop the old columns in a later migration.
- **Rolling back**: an image built before this change reads these columns as 32-bit integers. Roll the migration and the new
  image out together, and do not run the old image against values above 2,147,483,647 (only the new image can create them).
- Rehearsal: `test/db-money-migration.int.spec.ts` migrates a populated database as a CREATEROLE, NOSUPERUSER owner with values at
  2,147,483,647, applies the migration, checks every value survived, writes 2,147,483,648 and 9,007,199,254,740,991 as the
  restricted runtime login, and checks forced row-level security and `prisma migrate diff`.
- `provider_organizations.licenseNumber` is intentionally **not** unique: two organizations may share a license number (an empty string
  means unknown). Do not add a uniqueness constraint.

## 3. Backup, restore and point-in-time recovery

Proposed targets (owner to confirm, see decisions): RPO 5 minutes, RTO 1 hour.

| Layer | Mechanism | RPO | Tooling |
|---|---|---|---|
| Daily logical dump | `scripts/backup/backup.sh` (pg_dump custom format, sha256, roles-only dump, 14-day pruning) | schedule (24 h) | cron / scheduled job, copy the output off the host |
| Continuous archiving + base backup | `archive_mode=on`, `archive_command` to object storage, weekly `pg_basebackup` | minutes | managed PITR (preferred) or pgBackRest / WAL-G |

Production Postgres settings for the second layer (self-managed): `wal_level=replica`, `archive_mode=on`,
`archive_command` that refuses to overwrite (`test ! -f ... && cp %p ...`), `archive_timeout=60`. Alert when
`pg_stat_archiver.failed_count` grows or `last_archived_time` is older than 5 minutes. Backups must be stored
outside the database host and the volume that holds the data; encrypt them at rest.

Restore a dump into a new, empty database (the script refuses a database that already has tables):

```sh
scripts/backup/restore.sh backups/safry-<stamp>.dump "$NEW_DATABASE_URL" backups/roles-<stamp>.sql
```

Drills (Docker required; both exit non-zero on failure, both remove what they create):

```sh
SRC_CONTAINER=<running-postgres-container> SRC_DB=safry sh scripts/backup/restore-test.sh
sh scripts/backup/pitr-drill.sh
```

`restore-test.sh` dumps the source, restores into a throwaway container and compares row counts of every
table, index count, validated CHECK count, forced-RLS tables, policies, the `safry_app` role flags and applied
migrations. `pitr-drill.sh` archives WAL, takes a base backup, writes more rows, deletes everything, then
rebuilds a server to a chosen timestamp and requires exactly the rows that existed at that moment. Run both
after every Postgres major upgrade and at least quarterly; record date and result.

## 4. Retention and audit partitions

**Defaults:** refresh sessions are purged 30 days after they expire or are revoked; reset and verification links 7 days after they
expire or are used; idle sign-in counters after 24 hours; audit events are kept 24 months. These are the defaults of
`backend/scripts/db/purge.sh`; `SESSION_RETENTION_DAYS`, `CREDENTIAL_TOKEN_RETENTION_DAYS`, `LOGIN_THROTTLE_RETENTION_HOURS` and
`AUDIT_RETENTION_DAYS` override them (ranges in `docs/DEPLOYMENT.md`; the audit procedure refuses less than 30 days).

**The job runs by default.** The compose `maintenance` service has no profile, so `docker compose up -d` starts it and it runs once a
day (a failed run is retried hourly). It connects as `safry_maintenance` (`scripts/db/create-maintenance-role.sql`, created by the
`db-roles` job): not a superuser, no table privilege, only EXECUTE on the seven maintenance procedures, which are `SECURITY DEFINER`
with a pinned `search_path` (migration `20261020_maintenance_role`). What a leaked password can and cannot do: it cannot read or change any table directly, and it cannot make retention
shorter than the owner-set policy floors (table `maintenance_policy`, defaults: audit 24 months, sessions 30 days, reset / verification
links 7 days, sign-in counters 24 hours, PENDING booking lifetime 48 hours; the routines use the greater of the argument and the floor, and
batch sizes are capped at 100,000). It can still run those routines early and often (delete what is already due, cancel bookings that
are already expired), and it can write a false heartbeat row, which would hide a stopped job from `PurgeJobStale` until someone checks the
job log. To keep data for a shorter time than a default (for example `AUDIT_RETENTION_DAYS=90`), the owner lowers the floor first:
`CALL set_maintenance_policy('audit_retention', interval '90 days');` (settings: `audit_retention`, `session_retention`,
`credential_token_retention`, `login_throttle_retention`, `booking_pending_ttl`); until then the job keeps data for the floor, never less.
Details of the bounds:
- A floor is compared as a date, not as an interval: the routines use the older of (now minus the argument) and (now minus the floor), so
  `721 days` does not beat a 24-month floor and `1 month` does not undercut `30 days`.
- The booking floor must follow the lifetime the API uses. The compose `db-roles` job writes `BOOKING_PENDING_TTL_HOURS` into it; **when you
  raise `BOOKING_PENDING_TTL_HOURS`, run `db-roles` again** (or `CALL set_maintenance_policy('booking_pending_ttl', make_interval(hours => N))`),
  otherwise the floor stays lower than the API's lifetime. The job still passes the configured value, so the job itself never cancels early.
- The login gets `maintenance_ensure_partitions(n)` (at most 24 months ahead, never into the past) instead of the raw partition procedure,
  and `record_maintenance_run` accepts only the job `purge` with a payload under 2 KB. Residual: it can still write a false heartbeat.
- Failed attempts by signed-in users (password change, re-authentication, second factor) are written through the same path as failed
  sign-ins, so they share the per-account hourly budget (`AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR`, default 20) with failed sign-ins and
  refused reset / verification requests. After the budget is spent, one `identity.login.failed_capped` row marks the hour and further
  per-attempt rows for that account are not written until the hour passes; they are counted in `safry_audit_skipped_total{kind="account_budget"}`
  and logged. What still survives in the audit trail: successful sign-ins, sign-outs, password and MFA changes, lock-outs
  (`identity.account.locked`), session revocations, the capped marker and every administrator action.

Each successful run writes a heartbeat row (`maintenance_runs`, job `purge`); the API exports it as
`safry_maintenance_last_success_timestamp_seconds` and `PurgeJobStale` fires after 36 hours. On a managed database without compose,
schedule `backend/scripts/db/purge.sh` once a day with the owner login (cron, scheduler job) and keep the same alert. Companion alerts:
`AuditDefaultPartitionHasRows` (the safety-net partition holds rows) and `RefreshSessionsPastRetention` (a session is older than its
retention plus 3 days).

In the same run `sweep_expired_bookings` cancels PENDING bookings older than `BOOKING_PENDING_TTL_HOURS` (the rule the API computes
for expiry; give the API and the job the same value) and records a `booking.expire` audit event per booking. The job never cancels earlier
than the policy floor `booking_pending_ttl` (default 48 hours): it uses the greater of `BOOKING_PENDING_TTL_HOURS` and the floor. If you set
`BOOKING_PENDING_TTL_HOURS` **below** the floor (for example 24), the API reports bookings as expired after 24 hours while the job leaves
them PENDING in the database until 48 hours, and it still reports success. Lower the floor to match: rerun `db-roles` (it writes
`BOOKING_PENDING_TTL_HOURS` into the floor) or `CALL set_maintenance_policy('booking_pending_ttl', make_interval(hours => 24));`.

`audit_events` is partitioned by month on `occurredAt` (migration `20261012_db_audit_partitioning`, UTC month boundaries):

| Partition | Holds |
|---|---|
| `audit_events_YYYY_MM` | one month; created from 24 months back to 12 months ahead by the migration, later by `ensure_audit_event_partitions` |
| `audit_events_legacy` | everything older than the retention window at migration time (dropped by the first purge) |
| `audit_events_default` | safety net for a row outside every range (job stopped, clock skew, far future). Never rejected, never purged; moved into its month when that partition is created. Alert if it holds rows: `SELECT count(*) FROM audit_events_default` |

The primary key is `(id, "occurredAt")` (a partitioned table's key must contain the partition column). Prisma does not model
partitions: `schema.prisma` declares the parent with `@@id([id, occurredAt])`; child partitions are ignored by
`prisma migrate diff` (checked in `test/db-data-migrations.int.spec.ts`), and the client reads and writes through the parent.
Partitions are closed to `safry_app` (default privileges would otherwise grant DML on them, bypassing row-level security and the
append-only grants on the parent); only the parent carries the grants, FORCE RLS and the tenant policy.

Owner-only procedures (execute revoked from `PUBLIC` and `safry_app`):

```sql
CALL ensure_audit_event_partitions(0, 6);          -- create missing months, now .. +6 (idempotent; 1..60 months ahead)
CALL purge_audit_events(interval '24 months');     -- DROP partitions wholly older than the retention; minimum 30 days
CALL purge_refresh_sessions(interval '30 days');   -- batched row delete, each batch commits separately
CALL purge_credential_tokens(interval '7 days');
CALL purge_login_throttles(interval '24 hours');   -- idle, not blocked, not trusted
CALL sweep_expired_bookings(interval '48 hours');  -- PENDING older than the pending lifetime -> CANCELLED (+ audit)
CALL record_maintenance_run('purge');              -- heartbeat, last step
```

`backend/scripts/db/purge.sh` runs all of them daily (default compose stack). Retention has month granularity: audit rows
live up to one month longer than the retention. Each drop is recorded as an `audit.retention.partitions_dropped` event.
`ensure_audit_event_partitions` sets `lock_timeout = 10s`. `purge_audit_events` waits at most 500 ms per DROP attempt and retries
5 times (PostgreSQL refuses `DETACH PARTITION ... CONCURRENTLY` inside a procedure), so audit writers never queue behind it for
more than about 500 ms; a long application transaction makes the job fail, and compose retries it an hour later. Both migrations of 2026-10-12
run as one transaction each and lock their tables until commit: use a maintenance window on a large table. The first purge
after the migration drops `audit_events_legacy` (history older than the retention): export it first if it must be kept. To keep audit rows longer than the retention, export or detach the partition before purging.

### Disk space after a purge (vacuum policy)

Deleting rows does not shrink PostgreSQL files: `DELETE` leaves dead rows, `VACUUM` makes their space reusable, and only
`VACUUM FULL` (ACCESS EXCLUSIVE lock) returns it to the operating system. Policy:

- Steady state needs no shrinking. New sessions and links refill the freed pages, so the files stay at the high-water mark of one
  retention window. Plan disk for that, not for the sum of everything ever written.
- Migration `20261019_retention_maintenance` sets per-table autovacuum parameters on `refresh_sessions` and `credential_tokens`
  (vacuum after 2% dead rows, threshold 1000 / 500) and `login_throttles` (5%, 200), instead of the default 20%. Check with
  `SELECT relname, reloptions FROM pg_class WHERE relname IN ('refresh_sessions','credential_tokens','login_throttles')`.
- Alert `TableDeadTuplesHigh` (from `pg_stat_user_tables`, exported as `safry_table_dead_tuples` / `safry_table_live_tuples`) fires
  when more than 100,000 dead rows make up over 30% of a churn table for 2 hours: autovacuum is blocked (a long transaction, a
  replication slot) or cannot keep up.
- Reclaiming disk after a one-off mass purge (for example the first run on a table that never was purged): do it in a quiet window with
  `pg_repack` (online, needs the extension) or `VACUUM FULL refresh_sessions` (locks the table; sign-in and refresh wait, so a short
  maintenance window). Measured on 99,108 sessions of which 88,229 were purged: 56.8 MiB before, 56.9 MiB after plain vacuum (space
  reusable), 6 MiB after `VACUUM FULL`.
- Why `refresh_sessions` is not partitioned by month (so a purge would be a `DROP`): the lookup key `tokenHash` must stay unique and
  PostgreSQL cannot enforce a unique index on a partitioned table unless it includes the partition column, so the rotation
  race protection (unique token hash) and `findUnique` by token would have to be replaced; a session row lives up to 30 days plus 30
  days of retention, so a monthly partition could only be dropped about two months after its month ended and still needs row
  deletes for revoked rows in younger partitions; and it is a rewrite of the hottest auth table. The audit table does not have these
  constraints (append-only, never looked up by a unique key). Revisit if one retention window of sessions exceeds a few GB.

Rewriting the table in the migration (copy into partitions, drop the old table) suits today's volume. For a large production
table, create the partitioned table beside the old one, copy in batches, then swap names in one short transaction.
Rollback of that migration means restoring from backup.

## 5. Connection budget

Each API instance holds up to `DATABASE_POOL_MAX` connections (default 10, 1 in development). Capacity rule:

`instances x DATABASE_POOL_MAX + migration/admin/backup sessions (about 5) + monitoring <= max_connections - 10`

With the PostgreSQL default of 100 that is at most 8 instances at 10 connections. Beyond that, put PgBouncer in
transaction mode in front: all session state the API uses (`set_config(..., true)`) is transaction-local, so
transaction pooling is compatible. Keep `DATABASE_MIGRATE_URL` pointing at PostgreSQL directly, not the pooler.

## Bootstrap rules

`pnpm db:bootstrap` is create-only: re-running never re-grants a role, a role permission or a membership an operator removed, never
renames a role and never touches an existing administrator. An existing account with `BOOTSTRAP_ADMIN_EMAIL` is refused unless it
is already an ACTIVE platform administrator; to make an existing ordinary account the first tenant administrator you must set
`BOOTSTRAP_ADOPT_EXISTING_ACCOUNT=true` after verifying who owns that address. A disabled, suspended or deleted account is always refused.
Platform administrators must hold an enrolled second factor. `db:bootstrap` creates the first administrator with a password only,
so that nobody is locked out: that account signs in, and until it enrols two-factor authentication (Account, Security) every platform
route answers `403 mfa_enrollment_required`; only the `/auth/mfa/*` enrolment endpoints, `/auth/me` and sign-out work. After
enrolment the same session is accepted at once. `admin:bootstrap` (promote an existing account) refuses an account that has no
two-factor authentication yet. A platform administrator cannot turn their own two-factor off, and platform administration can only
be granted to an account that has already enrolled.
New permission codes added in a later release are added to the catalogue, but NOT to roles that already exist (grant them in the product or by migration).

## Migrations that remove things

Removing a column or table ships one release after the code stops using it (expand/contract); see `prisma/deferred-migrations/README.md`.
Constraint migrations add `NOT VALID` first, validate in their own later migration, and begin with a pre-flight that lists offending rows.
If a deploy stops at a pre-flight: fix the listed data, run `prisma migrate resolve --rolled-back <migration_name>`, redeploy.
