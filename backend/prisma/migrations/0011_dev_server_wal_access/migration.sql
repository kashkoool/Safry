-- Local development only: "prisma dev" attaches change-capture triggers to every table that write
-- to the _prisma_dev_wal schema. The restricted safry_app role fires those triggers, so it needs
-- access to that schema. The block is a no-op on any database without it (staging, production).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '_prisma_dev_wal') THEN
    GRANT USAGE ON SCHEMA _prisma_dev_wal TO safry_app;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA _prisma_dev_wal TO safry_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA _prisma_dev_wal TO safry_app;
  END IF;
END
$$;
