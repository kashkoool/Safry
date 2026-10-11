-- login counters live in "login_throttles" since migration 0020; these users columns are never
-- read or written by the application any more. Dropping a column drops the CHECK that references it
-- (users_failed_login_count_nonneg). IF EXISTS keeps the file re-runnable.
ALTER TABLE "users" DROP COLUMN IF EXISTS "failedLoginCount";
ALTER TABLE "users" DROP COLUMN IF EXISTS "lastFailedLoginAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "lockedUntil";
