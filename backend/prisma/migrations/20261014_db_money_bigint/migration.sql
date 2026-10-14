-- Money columns move from 32-bit integer to 64-bit bigint (integer minor units, i.e. cents). The ceiling of 2,147,483,647
-- minor units (about 21.4 million of a 2-decimal currency) is too low for real payments. Values are unchanged; the API keeps
-- returning JSON numbers (converted with a safe-integer check in the application).
--
-- Locking: ALTER COLUMN ... TYPE bigint rewrites the table and its indexes under ACCESS EXCLUSIVE, so reads and writes of
-- travel_services and bookings wait until this transaction commits. Cost is proportional to table size (a few seconds per
-- million rows); run it in a maintenance window on a large table. lock_timeout makes the migration fail fast, instead of
-- queueing every request behind it, if a long transaction already holds a lock on either table; retry when it is quiet.
--
-- Rolling deploys: an image built before this change reads these columns through a 32-bit Int field. Roll the migration and the
-- new image out together (the migrate job runs first, the old image keeps serving values below 2,147,483,648 correctly and fails
-- on larger ones, which only the new image can create). For a table too big for one rewrite, use expand/contract instead: add
-- nullable bigint columns, dual-write, backfill in batches, switch reads, then drop the old columns in a later migration.
SET LOCAL lock_timeout = '10s';

ALTER TABLE "travel_services" ALTER COLUMN "priceCents" TYPE BIGINT;
ALTER TABLE "bookings" ALTER COLUMN "totalCents" TYPE BIGINT, ALTER COLUMN "unitPriceCents" TYPE BIGINT;
