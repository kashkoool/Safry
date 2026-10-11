# Deferred (contract) migrations

`prisma migrate deploy` applies every directory in `prisma/migrations/`. A migration that **removes** something an already
running image still reads (a column, a table) must not ship in the same release as the code that stops using it: during a rolling
deploy, or after a rollback, the old image would fail on every query that selects the removed column (Prisma selects all scalar
columns of a model explicitly). Those migrations wait here until the release after the one that stopped using the object.

## Safe order (expand / contract)

1. Release N: code no longer reads or writes the object; `schema.prisma` still lists it (marked DEPRECATED). Nothing is dropped.
2. Release N+1, once no image older than N can run any more (no rollback target and no old task left): remove the field from
   `schema.prisma`, then `git mv prisma/deferred-migrations/<name> prisma/migrations/<new-timestamp>_<name>` (a name later than every
   existing migration) and ship it. Re-run `prisma migrate diff ... --exit-code` to prove there is no drift.

## Waiting here

| Migration | Drops | Safe to ship when |
|---|---|---|
| `20261010_auth_drop_dead_lockout_columns` | `users.failedLoginCount`, `lastFailedLoginAt`, `lockedUntil` (login counters live in `login_throttles` since migration 0020) | the release after the first production release that contains this layout; it also drops the CHECK `users_failed_login_count_nonneg` |
