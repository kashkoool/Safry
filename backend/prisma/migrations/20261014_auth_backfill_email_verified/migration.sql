-- Self-registered accounts must now verify their e-mail before signing in. Accounts that already exist were created before
-- verification existed (self-registration, tenant-created staff, seed and bootstrap accounts); locking them out would also lock
-- out every account whose address cannot receive mail. They are grandfathered as verified at the time of this migration.
-- Idempotent: only rows still without a verification time are touched. The users table has no row-level security.
UPDATE "users" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL AND "deletedAt" IS NULL;
