-- recovery codes issued before 2026-10-07 were 8 characters stored as a plain, unsalted SHA-256 (64 hex characters,
-- no prefix). Current codes are 80-bit and stored as "h1:<keyed per-user hash>". Invalidate the legacy hashes.
--
-- Rollback-safe (expand): one new column with a constant default; a previous image never reads it and keeps working. The users
-- keep their authenticator (TOTP) secret and can still sign in with it. A legacy recovery code simply stops matching (the same
-- normal 401 as a wrong code). Users who lost codes are flagged so the UI can ask them to generate a new set.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaRecoveryRegenerationRequired" boolean NOT NULL DEFAULT false;

UPDATE "users"
SET "mfaRecoveryRegenerationRequired" = true,
    "mfaRecoveryHashes" = (
      SELECT coalesce(jsonb_agg(h.value), '[]'::jsonb)
      FROM jsonb_array_elements("mfaRecoveryHashes") AS h(value)
      WHERE jsonb_typeof(h.value) = 'string' AND (h.value #>> '{}') LIKE 'h1:%'
    )
WHERE "mfaEnabledAt" IS NOT NULL
  AND jsonb_typeof("mfaRecoveryHashes") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("mfaRecoveryHashes") AS h(value)
    WHERE jsonb_typeof(h.value) <> 'string' OR (h.value #>> '{}') NOT LIKE 'h1:%'
  );
