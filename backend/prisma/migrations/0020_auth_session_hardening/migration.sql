-- session hardening (additive; existing rows are backfilled, nothing is dropped).
--
-- refresh_sessions: a family id shared by every rotation of one login (refresh-token reuse
-- detection) and the login time that caps the absolute session lifetime. The backfill rewrites
-- each existing row once; the table only holds live and recently expired sessions.
ALTER TABLE "refresh_sessions"
  ADD COLUMN "familyId" UUID,
  ADD COLUMN "authenticatedAt" TIMESTAMPTZ(3);

-- refresh_sessions has forced row-level security (migration 0010); the backfill must see every row.
SELECT set_config('app.bypass_rls', 'on', false);

UPDATE "refresh_sessions" SET "familyId" = "id", "authenticatedAt" = "createdAt"
  WHERE "familyId" IS NULL;

ALTER TABLE "refresh_sessions"
  ALTER COLUMN "familyId" SET NOT NULL,
  ALTER COLUMN "authenticatedAt" SET NOT NULL;

CREATE INDEX "refresh_sessions_familyId_idx" ON "refresh_sessions"("familyId");

SELECT set_config('app.bypass_rls', '', false);

-- users: hash of the single pending MFA login challenge (single use).
ALTER TABLE "users" ADD COLUMN "mfaChallengeHash" CHAR(64);

-- Authentication attempt counters (per e-mail and per e-mail + client address). No tenant column,
-- so no row-level security; rows are small and pruned by the API after a day of inactivity.
CREATE TABLE "login_throttles" (
  "key" CHAR(64) NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" TIMESTAMPTZ(3),
  "trustedUntil" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "login_throttles_updatedAt_idx" ON "login_throttles"("updatedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON "login_throttles" TO safry_app;
