import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createOwnerDatabase, prismaCommand } from "./support/owner-db.js";

/**
 * Rehearsal of the three 2026-10-12 migrations as a CREATEROLE, NOSUPERUSER owner (what a hosted database gives you) on a
 * database that already holds rows the migrations must handle: audit events spread over the calendar (including one older than
 * 24 months and one far in the future), legacy bookings without a service date, and legacy MFA recovery-code hashes.
 *   20261012_auth_invalidate_legacy_recovery_codes  
 *   20261012_db_audit_partitioning                   (monthly partitions)
 *   20261012_db_bookings_service_date_required      
 */
const root = resolve(import.meta.dirname, "..");
const first = "20261012_";
const bookingsMigration = "20261012_db_bookings_service_date_required";
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

describe("2026-10-12 migrations on a database with seeded legacy rows, as a non-superuser owner", () => {
  const workDir = mkdtempSync(join(tmpdir(), "safry-dm-"));
  let db: Awaited<ReturnType<typeof createOwnerDatabase>>;
  let owner: pg.Client;
  const config = join(workDir, "prisma.config.mjs");
  const ids = {
    tenant: "11111111-1111-4111-8111-111111111111",
    user: "22222222-2222-4222-8222-222222222222",
    membership: "33333333-3333-4333-8333-333333333333",
    org: "44444444-4444-4444-8444-444444444444",
    service: "55555555-5555-4555-8555-555555555555",
    mfaLegacy: "66666666-6666-4666-8666-666666666661",
    mfaCurrent: "66666666-6666-4666-8666-666666666662",
    mfaMixed: "66666666-6666-4666-8666-666666666663",
    plain: "66666666-6666-4666-8666-666666666664"
  };
  const seededAudit: Array<{ action: string; occurredAt: string }> = [];
  let auditSeeded = 0;
  let runtimeUrl = "";

  /** A restricted login like production's safry_runtime: member of safry_app, not the owner, NOBYPASSRLS. */
  async function connectRuntime(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: runtimeUrl });
    await client.connect();
    return client;
  }

  async function addAudit(action: string, monthsFromNow: number, tenantId: string | null = ids.tenant): Promise<void> {
    await owner.query(
      `INSERT INTO audit_events (id, "tenantId", action, "occurredAt")
       VALUES (gen_random_uuid(), $1, $2, date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + ($3::int * interval '1 month') + interval '3 days 10 hours')`,
      [tenantId, action, monthsFromNow]
    );
    seededAudit.push({ action, occurredAt: String(monthsFromNow) });
    auditSeeded += 1;
  }

  beforeAll(async () => {
    const server = new URL(inject("databaseUrl"));
    server.pathname = "/postgres";
    db = await createOwnerDatabase(server.toString(), { migrate: false });
    const all = readdirSync(resolve(root, "prisma/migrations"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const older = join(workDir, "older");
    mkdirSync(older);
    for (const name of all.filter((n) => n < first)) cpSync(resolve(root, "prisma/migrations", name), join(older, name), { recursive: true });
    cpSync(resolve(root, "prisma/migrations/migration_lock.toml"), join(older, "migration_lock.toml"));
    const schema = JSON.stringify(resolve(root, "prisma/schema.prisma"));
    const configFor = (migrations: string): string => `export default { schema: ${schema}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`;
    writeFileSync(join(workDir, "older.config.mjs"), configFor(older));
    writeFileSync(config, configFor(resolve(root, "prisma/migrations")));
    prismaCommand(["migrate", "deploy"], db.ownerUrl, join(workDir, "older.config.mjs"));
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    await owner.query(`SELECT set_config('app.bypass_rls', 'on', false)`);

    const runtimeRole = `${db.ownerRole}_rt`;
    const admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD 'rt-pass-dm'`);
    await admin.query(`GRANT safry_app TO ${runtimeRole}`);
    await admin.end();
    const rt = new URL(db.ownerUrl);
    rt.username = runtimeRole;
    rt.password = "rt-pass-dm";
    runtimeUrl = rt.toString();

    await owner.query(`INSERT INTO tenants (id, code, name, "updatedAt") VALUES ($1, 'dm-home', 'x', now())`, [ids.tenant]);
    await owner.query(
      `INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "updatedAt") VALUES ($1, 'dm@example.test', 'dm@example.test', 'x', 'x', now())`,
      [ids.user]
    );
    await owner.query(`INSERT INTO tenant_memberships (id, "tenantId", "userId", "updatedAt") VALUES ($1, $2, $3, now())`, [ids.membership, ids.tenant, ids.user]);
    await owner.query(
      `INSERT INTO provider_organizations (id, "tenantId", name, type, city, "contactEmail", "updatedAt") VALUES ($1, $2, 'DM Co', 'HOTEL', 'c', 'c@example.test', now())`,
      [ids.org, ids.tenant]
    );
    await owner.query(
      `INSERT INTO travel_services (id, "tenantId", "providerMembershipId", "providerOrganizationId", title, description, category, city, "priceCents", "updatedAt")
       VALUES ($1, $2, $3, $4, 't', 'd', 'TOUR', 'c', 1000, now())`,
      [ids.service, ids.tenant, ids.membership, ids.org]
    );

    // Audit events: very old, 30 / 26 / 10 / 3 months ago, now, +3 months, +5 years, plus a platform-level (no tenant) row.
    await addAudit("seed.ancient", -120);
    await addAudit("seed.m30", -30);
    await addAudit("seed.m26", -26);
    await addAudit("seed.m10", -10);
    await addAudit("seed.m3", -3);
    await addAudit("seed.now", 0);
    await addAudit("seed.p3", 3);
    await addAudit("seed.far_future", 60);
    await addAudit("seed.platform", -2, null);

    // Bookings: one valid, three legacy rows without a service date (PENDING, CANCELLED, CONFIRMED).
    const booking = (status: string, date: string | null, key: string): Promise<unknown> =>
      owner.query(
        `INSERT INTO bookings (id, "tenantId", "serviceId", "travelerMembershipId", "totalCents", "unitPriceCents", status, "serviceDate", "idempotencyKey", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 1000, 1000, $4::"BookingStatus", $5::date, $6, now())`,
        [ids.tenant, ids.service, ids.membership, status, date, key]
      );
    await booking("PENDING", "2031-01-10", "valid");
    await booking("PENDING", null, "legacy-pending");
    await booking("CANCELLED", null, "legacy-cancelled");
    await booking("CONFIRMED", null, "legacy-confirmed");

    // MFA users: legacy plain SHA-256 hashes only, current keyed hashes only, a mix, and no MFA at all.
    const mfaUser = (id: string, mail: string, enabled: boolean, hashes: string[]): Promise<unknown> =>
      owner.query(
        `INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "mfaSecretEnc", "mfaEnabledAt", "mfaRecoveryHashes", "updatedAt")
         VALUES ($1, $2, $2, 'x', 'x', $3, $4, $5::jsonb, now())`,
        [id, mail, enabled ? "sealed" : null, enabled ? new Date() : null, JSON.stringify(hashes)]
      );
    await mfaUser(ids.mfaLegacy, "legacy@example.test", true, [hex("a"), hex("b")]);
    await mfaUser(ids.mfaCurrent, "current@example.test", true, [`h1:${hex("c")}`, `h1:${hex("d")}`]);
    await mfaUser(ids.mfaMixed, "mixed@example.test", true, [hex("e"), `h1:${hex("f")}`]);
    await mfaUser(ids.plain, "plain@example.test", false, []);
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    const admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect().then(() => admin.query(`DROP ROLE IF EXISTS ${db.ownerRole}_rt`)).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await db?.drop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("stops the bookings migration with a readable pre-flight message when a settled legacy booking exists, changing nothing", async () => {
    let output = "";
    try {
      prismaCommand(["migrate", "deploy"], db.ownerUrl, config);
      throw new Error("migrate deploy unexpectedly succeeded");
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      output = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}${failure.message}`;
    }
    expect(output).toContain("bookings pre-flight");
    expect(output).toContain("CONFIRMED");
    const rows = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM bookings`);
    expect(Number(rows.rows[0]!.n)).toBe(4);
    const nullable = await owner.query<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'serviceDate'`);
    expect(nullable.rows[0]!.is_nullable).toBe("YES");
  }, 180_000);

  it("deploys once the operator has cancelled the settled legacy rows, and the earlier migrations of the same run stay applied", async () => {
    await owner.query(`UPDATE bookings SET status = 'CANCELLED' WHERE "serviceDate" IS NULL AND status = 'CONFIRMED'`);
    prismaCommand(["migrate", "resolve", "--rolled-back", bookingsMigration], db.ownerUrl, config);
    prismaCommand(["migrate", "deploy"], db.ownerUrl, config);
    const applied = await owner.query<{ migration_name: string }>(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name >= $1 AND migration_name < '20261013' ORDER BY 1`, [first]);
    expect(applied.rows.map((r) => r.migration_name)).toEqual([
      "20261012_auth_invalidate_legacy_recovery_codes",
      "20261012_db_audit_partitioning",
      bookingsMigration
    ]);
  }, 180_000);

  describe("audit_events partitioning", () => {
    it("is a partitioned table keyed (id, occurredAt) and kept every seeded row, plus the migration's own audit record", async () => {
      const kind = await owner.query<{ relkind: string }>(`SELECT relkind FROM pg_class WHERE relname = 'audit_events' AND relnamespace = 'public'::regnamespace`);
      expect(kind.rows[0]!.relkind).toBe("p");
      const pk = await owner.query<{ cols: string }>(
        `SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey::int2[], a.attnum)) AS cols
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = 'audit_events'::regclass AND i.indisprimary`
      );
      expect(pk.rows[0]!.cols).toBe("id,occurredAt");
      const seeded = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE action LIKE 'seed.%'`);
      expect(Number(seeded.rows[0]!.n)).toBe(auditSeeded);
    });

    it("routes every row to the right partition: legacy, its month, or the default safety net", async () => {
      const { rows } = await owner.query<{ action: string; part: string }>(`SELECT action, tableoid::regclass::text AS part FROM audit_events WHERE action LIKE 'seed.%'`);
      const where = new Map(rows.map((r) => [r.action, r.part]));
      const monthName = async (offset: number): Promise<string> =>
        `audit_events_${(await owner.query<{ m: string }>(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + ($1::int * interval '1 month'), 'YYYY_MM') AS m`, [offset])).rows[0]!.m}`;
      expect(where.get("seed.ancient")).toBe("audit_events_legacy");
      expect(where.get("seed.m30")).toBe("audit_events_legacy");
      expect(where.get("seed.m26")).toBe("audit_events_legacy");
      expect(where.get("seed.m10")).toBe(await monthName(-10));
      expect(where.get("seed.m3")).toBe(await monthName(-3));
      expect(where.get("seed.now")).toBe(await monthName(0));
      expect(where.get("seed.p3")).toBe(await monthName(3));
      expect(where.get("seed.platform")).toBe(await monthName(-2));
      expect(where.get("seed.far_future")).toBe("audit_events_default");
    });

    it("has the partitions: 24 months back through 12 months ahead, a legacy and a default partition", async () => {
      const { rows } = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'audit_events'::regclass`);
      expect(Number(rows[0]!.n)).toBe(24 + 1 + 12 + 2);
    });

    it("keeps the indexes, the foreign keys, forced row-level security and the append-only grants", async () => {
      const idx = await owner.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events' ORDER BY 1`);
      expect(idx.rows.map((r) => r.indexname)).toEqual([
        "audit_events_actorUserId_occurredAt_idx",
        "audit_events_occurredAt_idx",
        "audit_events_occurredAt_with_ip_idx",
        "audit_events_pkey",
        "audit_events_tenantId_action_occurredAt_idx",
        "audit_events_tenantId_entityType_entityId_occurredAt_idx",
        "audit_events_tenantId_occurredAt_idx"
      ]);
      const fks = await owner.query<{ conname: string; confdeltype: string }>(`SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'audit_events'::regclass AND contype = 'f' ORDER BY 1`);
      expect(fks.rows).toEqual([
        { conname: "audit_events_actorUserId_fkey", confdeltype: "n" },
        { conname: "audit_events_tenantId_fkey", confdeltype: "n" }
      ]);
      const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'audit_events'::regclass`);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policy = await owner.query(`SELECT 1 FROM pg_policies WHERE tablename = 'audit_events' AND policyname = 'tenant_isolation'`);
      expect(policy.rowCount).toBe(1);
      const grants = await owner.query<{ p: string }>(`SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = 'audit_events' AND grantee = 'safry_app' ORDER BY 1`);
      expect(grants.rows.map((r) => r.p)).toEqual(["INSERT", "SELECT"]);
    });

    it("lets the restricted role insert and read through the parent under RLS, but never update, delete, truncate or touch a partition directly", async () => {
      const app = await connectRuntime();
      try {
        await app.query(`BEGIN`);
        await app.query(`SET LOCAL ROLE safry_app`);
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenant]);
        await app.query(`INSERT INTO audit_events (id, "tenantId", action) VALUES (gen_random_uuid(), $1, 'seed.app_insert')`, [ids.tenant]);
        const visible = await app.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE action = 'seed.app_insert'`);
        expect(Number(visible.rows[0]!.n)).toBe(1);
        const other = await app.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE "tenantId" IS NULL`);
        expect(Number(other.rows[0]!.n)).toBe(0); // the platform-level seed row is invisible to a tenant scope
        await app.query(`ROLLBACK`);
        for (const sql of [
          `UPDATE audit_events SET action = 'x'`,
          `DELETE FROM audit_events`,
          `TRUNCATE audit_events`,
          `SELECT count(*) FROM audit_events_legacy`,
          `INSERT INTO audit_events_default (id, action) VALUES (gen_random_uuid(), 'direct')`,
          `DELETE FROM audit_events_default`
        ]) {
          await app.query(`BEGIN`);
          await app.query(`SET LOCAL ROLE safry_app`);
          await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenant]);
          await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
          await app.query(`ROLLBACK`);
        }
      } finally {
        await app.end();
      }
    });

    it("creates future partitions with the owner-only function, idempotently, and moves default-partition rows into a new month", async () => {
      const before = Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'audit_events'::regclass`)).rows[0]!.n);
      await owner.query(`CALL ensure_audit_event_partitions(0, 14)`);
      const after = Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'audit_events'::regclass`)).rows[0]!.n);
      expect(after).toBe(before + 2);
      await owner.query(`CALL ensure_audit_event_partitions(0, 14)`);
      expect(Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'audit_events'::regclass`)).rows[0]!.n)).toBe(after);
      // A row that landed in the default partition is moved when its month gets created.
      await owner.query(`INSERT INTO audit_events (id, "tenantId", action, "occurredAt") VALUES (gen_random_uuid(), $1, 'seed.default_then_moved', date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '20 months 5 days')`, [ids.tenant]);
      expect((await owner.query(`SELECT tableoid::regclass::text AS p FROM audit_events WHERE action = 'seed.default_then_moved'`)).rows[0]!.p).toBe("audit_events_default");
      await owner.query(`CALL ensure_audit_event_partitions(0, 21)`);
      const moved = await owner.query<{ p: string }>(`SELECT tableoid::regclass::text AS p FROM audit_events WHERE action = 'seed.default_then_moved'`);
      expect(moved.rowCount).toBe(1);
      expect(moved.rows[0]!.p).toMatch(/^audit_events_20\d\d_\d\d$/);
      // The new partition is closed to the application like the others.
      const grants = await owner.query(`SELECT 1 FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = 'safry_app'`, [moved.rows[0]!.p]);
      expect(grants.rowCount).toBe(0);
      await expect(owner.query(`CALL ensure_audit_event_partitions(0, 1000)`)).rejects.toThrow(/months_ahead/);
    });

    it("is not callable by the application role", async () => {
      const app = await connectRuntime();
      try {
        for (const sql of [`CALL ensure_audit_event_partitions(0, 3)`, `CALL purge_audit_events(interval '24 months')`]) {
          await app.query(`BEGIN`);
          await app.query(`SET LOCAL ROLE safry_app`);
          await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
          await app.query(`ROLLBACK`);
        }
      } finally {
        await app.end();
      }
    });

    it("purges by dropping whole partitions older than the retention (24 months), refusing less than 30 days", async () => {
      await expect(owner.query(`CALL purge_audit_events(interval '10 days')`)).rejects.toThrow(/at least 30 days/);
      await owner.query(`CALL purge_audit_events(interval '24 months')`);
      const left = await owner.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'seed.%' ORDER BY action`);
      const actions = left.rows.map((r) => r.action);
      expect(actions).not.toContain("seed.ancient");
      expect(actions).not.toContain("seed.m30");
      expect(actions).not.toContain("seed.m26");
      for (const kept of ["seed.m10", "seed.m3", "seed.now", "seed.p3", "seed.far_future", "seed.platform"]) expect(actions, kept).toContain(kept);
      const legacy = await owner.query(`SELECT 1 FROM pg_class WHERE relname = 'audit_events_legacy'`);
      expect(legacy.rowCount).toBe(0);
      const record = await owner.query<{ metadata: { dropped: string[] } }>(`SELECT metadata FROM audit_events WHERE action = 'audit.retention.partitions_dropped' ORDER BY "occurredAt" DESC LIMIT 1`);
      expect(record.rows[0]!.metadata.dropped).toContain("audit_events_legacy");
      // Idempotent: a second run drops nothing and the table keeps working.
      await owner.query(`CALL purge_audit_events(interval '24 months')`);
      expect(Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE action = 'seed.m10'`)).rows[0]!.n)).toBe(1);
    });

    it("purge does not stall audit writers while an open writer delays its DROP", async () => {
      const connect = async (): Promise<pg.Client> => {
        const c = new pg.Client({ connectionString: db.ownerUrl });
        await c.connect();
        await c.query(`SELECT set_config('app.bypass_rls', 'on', false)`);
        return c;
      };
      await owner.query(`CREATE TABLE audit_events_2000_01 PARTITION OF audit_events FOR VALUES FROM ('2000-01-01') TO ('2000-02-01')`);
      const writer = await connect();
      const purger = await connect();
      const probe = await connect();
      const insert = `INSERT INTO audit_events (id, "tenantId", action) VALUES (gen_random_uuid(), '${ids.tenant}', 'seed.lock_probe')`;
      try {
        await writer.query(`BEGIN`);
        await writer.query(insert); // an open transaction holding ROW EXCLUSIVE on the parent
        const purge = purger.query(`CALL purge_audit_events(interval '24 months')`);
        await new Promise((r) => setTimeout(r, 200)); // purge is now queued for ACCESS EXCLUSIVE
        const started = Date.now();
        await probe.query(insert);
        const waited = Date.now() - started;
        expect(waited, `audit insert was blocked ${waited} ms by the purge`).toBeLessThan(1500);
        await writer.query(`COMMIT`);
        await purge; // bounded retries succeed once the writer is gone
        expect((await owner.query(`SELECT 1 FROM pg_class WHERE relname = 'audit_events_2000_01'`)).rowCount).toBe(0);
      } finally {
        await writer.query(`ROLLBACK`).catch(() => undefined);
        await Promise.all([writer.end(), purger.end(), probe.end()]);
      }
    });

    it("has no drift against schema.prisma (partitions are ignored by Prisma introspection)", () => {
      const out = prismaCommand(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], db.ownerUrl);
      expect(out).toContain("No difference detected");
    });
  });

  describe("legacy bookings without a service date", () => {
    it("deleted only the NULL-date rows, kept the valid one, and recorded how many in the audit trail", async () => {
      const { rows } = await owner.query<{ key: string }>(`SELECT "idempotencyKey" AS key FROM bookings`);
      expect(rows.map((r) => r.key)).toEqual(["valid"]);
      const record = await owner.query<{ metadata: { deleted: number; byStatus: Record<string, number> } }>(`SELECT metadata FROM audit_events WHERE action = 'booking.legacy_null_service_date_deleted'`);
      expect(record.rowCount).toBe(1);
      expect(record.rows[0]!.metadata.deleted).toBe(3);
      expect(record.rows[0]!.metadata.byStatus).toEqual({ PENDING: 1, CANCELLED: 2 });
    });

    it("makes serviceDate NOT NULL and leaves no helper CHECK behind", async () => {
      const col = await owner.query<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'serviceDate'`);
      expect(col.rows[0]!.is_nullable).toBe("NO");
      const check = await owner.query(`SELECT 1 FROM pg_constraint WHERE conname = 'bookings_service_date_present'`);
      expect(check.rowCount).toBe(0);
      await expect(
        owner.query(`INSERT INTO bookings (id, "tenantId", "serviceId", "travelerMembershipId", "totalCents", "unitPriceCents", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, 1000, 1000, now())`, [ids.tenant, ids.service, ids.membership])
      ).rejects.toThrow(/serviceDate/);
    });
  });

  describe("legacy MFA recovery codes", () => {
    it("removes only the legacy hashes and flags the users who must regenerate; TOTP material is untouched", async () => {
      const { rows } = await owner.query<{ id: string; hashes: string[]; flag: boolean; secret: string | null; enabled: boolean }>(
        `SELECT id, "mfaRecoveryHashes" AS hashes, "mfaRecoveryRegenerationRequired" AS flag, "mfaSecretEnc" AS secret, ("mfaEnabledAt" IS NOT NULL) AS enabled
         FROM users WHERE id = ANY($1)`,
        [[ids.mfaLegacy, ids.mfaCurrent, ids.mfaMixed, ids.plain]]
      );
      const by = new Map(rows.map((r) => [r.id, r]));
      expect(by.get(ids.mfaLegacy)).toMatchObject({ hashes: [], flag: true, secret: "sealed", enabled: true });
      expect(by.get(ids.mfaMixed)).toMatchObject({ hashes: [`h1:${hex("f")}`], flag: true, secret: "sealed", enabled: true });
      expect(by.get(ids.mfaCurrent)).toMatchObject({ hashes: [`h1:${hex("c")}`, `h1:${hex("d")}`], flag: false });
      expect(by.get(ids.plain)).toMatchObject({ hashes: [], flag: false, enabled: false });
    });
  });
});
