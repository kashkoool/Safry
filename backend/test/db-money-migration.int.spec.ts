import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createOwnerDatabase, prismaCommand } from "./support/owner-db.js";

/**
 * Rehearsal of 20261014_db_money_bigint as a CREATEROLE, NOSUPERUSER owner on a database that already holds money rows,
 * including values at the old 32-bit ceiling. A second step then writes values above it as the restricted runtime login.
 */
const root = resolve(import.meta.dirname, "..");
const migration = "20261014_db_money_bigint";
const ids = {
  tenant: "11111111-1111-4111-8111-1111111111a1",
  user: "22222222-2222-4222-8222-2222222222a2",
  membership: "33333333-3333-4333-8333-3333333333a3",
  org: "44444444-4444-4444-8444-4444444444a4",
  service: "55555555-5555-4555-8555-5555555555a5",
  serviceMax: "55555555-5555-4555-8555-5555555555a6"
};

describe("money migration on a populated database, as a non-superuser owner", () => {
  const workDir = mkdtempSync(join(tmpdir(), "safry-money-"));
  let db: Awaited<ReturnType<typeof createOwnerDatabase>>;
  let owner: pg.Client;
  let runtimeUrl = "";
  const configPath = join(workDir, "all.config.mjs");

  beforeAll(async () => {
    const server = new URL(inject("databaseUrl"));
    server.pathname = "/postgres";
    db = await createOwnerDatabase(server.toString(), { migrate: false });
    const all = readdirSync(resolve(root, "prisma/migrations"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const older = join(workDir, "older");
    mkdirSync(older);
    for (const name of all.filter((n) => n < migration)) cpSync(resolve(root, "prisma/migrations", name), join(older, name), { recursive: true });
    cpSync(resolve(root, "prisma/migrations/migration_lock.toml"), join(older, "migration_lock.toml"));
    const schema = JSON.stringify(resolve(root, "prisma/schema.prisma"));
    const configFor = (migrations: string): string => `export default { schema: ${schema}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`;
    writeFileSync(join(workDir, "older.config.mjs"), configFor(older));
    writeFileSync(configPath, configFor(resolve(root, "prisma/migrations")));
    prismaCommand(["migrate", "deploy"], db.ownerUrl, join(workDir, "older.config.mjs"));

    owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    await owner.query(`SELECT set_config('app.bypass_rls', 'on', false)`);
    const runtimeRole = `${db.ownerRole}_rt`;
    const admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD 'rt-pass-money'`);
    await admin.query(`GRANT safry_app TO ${runtimeRole}`);
    await admin.end();
    const rt = new URL(db.ownerUrl);
    rt.username = runtimeRole;
    rt.password = "rt-pass-money";
    runtimeUrl = rt.toString();

    await owner.query(`INSERT INTO tenants (id, code, name, "updatedAt") VALUES ($1, 'mm-home', 'x', now())`, [ids.tenant]);
    await owner.query(`INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "updatedAt") VALUES ($1, 'mm@example.test', 'mm@example.test', 'x', 'x', now())`, [ids.user]);
    await owner.query(`INSERT INTO tenant_memberships (id, "tenantId", "userId", "updatedAt") VALUES ($1, $2, $3, now())`, [ids.membership, ids.tenant, ids.user]);
    await owner.query(`INSERT INTO provider_organizations (id, "tenantId", name, type, city, "contactEmail", "updatedAt") VALUES ($1, $2, 'MM Co', 'HOTEL', 'c', 'c@example.test', now())`, [ids.org, ids.tenant]);
    const service = (id: string, price: number): Promise<unknown> =>
      owner.query(
        `INSERT INTO travel_services (id, "tenantId", "providerMembershipId", "providerOrganizationId", title, description, category, city, "priceCents", "updatedAt")
         VALUES ($1, $2, $3, $4, 't', 'd', 'TOUR', 'c', $5, now())`,
        [id, ids.tenant, ids.membership, ids.org, price]
      );
    await service(ids.service, 2_147_483_647);
    await service(ids.serviceMax, 100);
    for (const [key, total, unit] of [["a", 2_147_483_647, 2_147_483_647], ["b", 1, 1], ["c", 99_999, 100]] as const)
      await owner.query(
        `INSERT INTO bookings (id, "tenantId", "serviceId", "travelerMembershipId", "totalCents", "unitPriceCents", "serviceDate", "idempotencyKey", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '2031-01-10', $6, now())`,
        [ids.tenant, ids.serviceMax, ids.membership, total, unit, key]
      );
  }, 180_000);

  afterAll(async () => {
    await owner?.end().catch(() => undefined);
    await db?.drop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("is a 32-bit column before and bigint after, with every value preserved", async () => {
    const type = async (): Promise<string[]> =>
      (await owner.query<{ t: string }>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE (attrelid, attname) IN (('travel_services'::regclass, 'priceCents'), ('bookings'::regclass, 'totalCents'), ('bookings'::regclass, 'unitPriceCents')) ORDER BY attname`)).rows.map((r) => r.t);
    expect(await type()).toEqual(["integer", "integer", "integer"]);
    const before = (await owner.query(`SELECT "totalCents"::text t, "unitPriceCents"::text u FROM bookings ORDER BY "idempotencyKey"`)).rows;
    prismaCommand(["migrate", "deploy"], db.ownerUrl, configPath);
    expect(await type()).toEqual(["bigint", "bigint", "bigint"]);
    expect((await owner.query(`SELECT "totalCents"::text t, "unitPriceCents"::text u FROM bookings ORDER BY "idempotencyKey"`)).rows).toEqual(before);
    expect((await owner.query(`SELECT "priceCents"::text p FROM travel_services ORDER BY "priceCents"`)).rows.map((r) => r.p)).toEqual(["100", "2147483647"]);
    expect((await owner.query(`SELECT count(*)::int n FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [migration])).rows[0].n).toBe(1);
  });

  it("keeps row-level security, grants and the restricted runtime login working, and accepts values above 2147483647", async () => {
    const rt = new pg.Client({ connectionString: runtimeUrl });
    await rt.connect();
    try {
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('role', 'safry_app', true), set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', 'off', true)`, [ids.tenant]);
      await rt.query(
        `INSERT INTO bookings (id, "tenantId", "serviceId", "travelerMembershipId", "totalCents", "unitPriceCents", "serviceDate", "idempotencyKey", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 2147483648, 2147483648, '2031-01-11', 'big', now())`,
        [ids.tenant, ids.serviceMax, ids.membership]
      );
      await rt.query(`UPDATE travel_services SET "priceCents" = 9007199254740991 WHERE id = $1`, [ids.service]);
      const visible = await rt.query(`SELECT count(*)::int n, max("totalCents")::text m FROM bookings`);
      expect(visible.rows[0]).toEqual({ n: 4, m: "2147483648" });
      await rt.query("ROLLBACK");
      // Another tenant's scope sees none of it: forced RLS is intact.
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('role', 'safry_app', true), set_config('app.tenant_id', '99999999-9999-4999-8999-999999999999', true), set_config('app.bypass_rls', 'off', true)`);
      expect((await rt.query(`SELECT count(*)::int n FROM bookings`)).rows[0].n).toBe(0);
      await rt.query("ROLLBACK");
    } finally {
      await rt.end();
    }
    const rls = await owner.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('bookings','travel_services') ORDER BY relname`);
    expect(rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });

  it("leaves no drift against schema.prisma", () => {
    const out = prismaCommand(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], db.ownerUrl);
    expect(out).toContain("No difference detected");
  });
});
