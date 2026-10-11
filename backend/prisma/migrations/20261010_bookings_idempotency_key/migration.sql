-- a client-chosen Idempotency-Key makes a retried POST /bookings return the first booking
-- instead of creating a second one. Additive and nullable: existing rows and clients without the header are unaffected.
-- NULLs are distinct in a unique index, so bookings without a key never collide.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_traveler_idempotency_key" ON "bookings" ("travelerMembershipId", "idempotencyKey");
