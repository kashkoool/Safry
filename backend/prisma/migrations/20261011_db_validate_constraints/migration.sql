-- Validates the constraints added NOT VALID by 20261007_db_constraints. Its own migration (= its own transaction) so the scan
-- runs under SHARE UPDATE EXCLUSIVE only (reads and writes continue) and not under the ACCESS EXCLUSIVE lock of ADD CONSTRAINT
--. The previous migration's pre-flight already proved the data; this makes the proof permanent in the catalog.
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_code_normalized";
ALTER TABLE "users" VALIDATE CONSTRAINT "users_email_normalized_matches";
ALTER TABLE "users" VALIDATE CONSTRAINT "users_failed_login_count_nonneg";
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_end_not_before_start";
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_travelers_range";
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_units_range";
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_currency_format";
ALTER TABLE "travel_services" VALIDATE CONSTRAINT "travel_services_currency_format";
ALTER TABLE "refresh_sessions" VALIDATE CONSTRAINT "refresh_sessions_token_hash_hex";
ALTER TABLE "refresh_sessions" VALIDATE CONSTRAINT "refresh_sessions_expiry_after_creation";
