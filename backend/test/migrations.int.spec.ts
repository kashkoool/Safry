import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createOwnerDatabase, prismaCommand } from "./support/owner-db.js";

/**
 * Guard: a brand-new database built only from prisma/migrations must
 * (1) apply cleanly, (2) match schema.prisma exactly and (3) still contain what must remain
 * (positive invariants), not just lack what was removed.
 */
const root = resolve(import.meta.dirname, "..");
const prismaCli = resolve(root, "node_modules/prisma/build/index.js");

function prisma(args: string[], url: string): string {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe"
  }).toString();
}

describe("migration chain on a fresh database", () => {
  let admin: pg.Client;
  let fresh: pg.Client;
  let freshUrl: string;
  const name = `safry_fresh_${process.pid}`;

  beforeAll(async () => {
    const base = new URL(inject("databaseUrl"));
    admin = new pg.Client({ connectionString: base.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    base.pathname = `/${name}`;
    freshUrl = base.toString();
    prisma(["migrate", "deploy"], freshUrl);
    fresh = new pg.Client({ connectionString: freshUrl });
    await fresh.connect();
  });

  afterAll(async () => {
    await fresh?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it("has no drift between the migrations and schema.prisma", () => {
    // execFileSync throws (non-zero exit) when `--exit-code` finds a difference.
    const out = prisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], freshUrl);
    expect(out).toContain("No difference detected");
  });

  it("records every migration directory as applied, in order", async () => {
    const { readdirSync } = await import("node:fs");
    const dirs = readdirSync(resolve(root, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const { rows } = await fresh.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
    );
    expect(rows.map((row) => row.migration_name)).toEqual(dirs);
  });

  it("has the search and capacity indexes and the extension they need", async () => {
    const extension = await fresh.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(extension.rowCount).toBe(1);
    const { rows } = await fresh.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [["users_email_trgm_idx", "users_displayName_trgm_idx", "travel_services_title_trgm_idx", "provider_organizations_name_trgm_idx", "bookings_serviceId_serviceDate_endDate_idx"]]
    );
    expect(rows).toHaveLength(5);
    for (const row of rows.filter((r) => r.indexname.endsWith("_trgm_idx"))) expect(row.indexdef, row.indexname).toMatch(/USING gin .*gin_trgm_ops/);
  });

  it("has the tenant-first newest-first indexes that serve the paginated admin lists", async () => {
    for (const table of ["bookings", "travel_services"]) {
      const { rows } = await fresh.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [table]);
      expect(rows.map((row) => row.indexdef).join("\n"), table).toMatch(/\("tenantId", "createdAt" DESC, id DESC\)/);
    }
  });

  it("keeps the objects the application depends on", async () => {
    const tables = await fresh.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const table of [
      "tenants", "users", "tenant_memberships", "provider_organizations", "organization_departments",
      "travel_services", "service_components", "bookings", "roles", "permissions", "role_permissions",
      "membership_roles", "refresh_sessions", "audit_events"
    ])
      expect(tables.rows.map((row) => row.tablename)).toContain(table);

    const rls = await fresh.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relforcerowsecurity`);
    expect(rls.rows.length).toBeGreaterThanOrEqual(11);

    const role = await fresh.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'safry_app'`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const constraints = await fresh.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`
    );
    const byName = new Map(constraints.rows.map((row) => [row.conname, row.convalidated]));
    for (const wanted of ["bookings_currency_format", "bookings_end_not_before_start", "tenants_code_normalized", "refresh_sessions_token_hash_hex"])
      expect(byName.get(wanted), wanted).toBe(true);
  });

  it("has an index led by a foreign-key column for every foreign key", async () => {
    // Positive invariant against the "FK without index" pattern (): some valid index must
    // start with one of the FK's columns so parent-row RESTRICT/CASCADE checks and joins do not scan.
    const { rows } = await fresh.query<{ conname: string; relname: string }>(`
      SELECT c.conname, t.relname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indkey[0] = ANY (c.conkey)
        )`);
    // Documented exception: permissions are never deleted at runtime and role_permissions is tiny.
    expect(rows.map((row) => `${row.relname}.${row.conname}`)).toEqual(["role_permissions.role_permissions_permissionId_fkey"]);
  });
});

/**
 * Constraints-migration rehearsal: run as a CREATEROLE, non-superuser owner (what a hosted database gives you), with existing rows that
 * break the new rules. The constraints migration must stop with a readable pre-flight message and leave NOTHING half-created;
 * after the data is fixed it must deploy, and every constraint must end up validated by the separate validation migration.
 */
describe("db_constraints migration against dirty data, as a non-superuser owner", () => {
  const workDir = mkdtempSync(join(tmpdir(), "safry-migrate-"));
  let db: Awaited<ReturnType<typeof createOwnerDatabase>>;
  let owner: pg.Client;
  const config = join(workDir, "prisma.config.mjs");
  const target = "20261007_db_constraints";

  beforeAll(async () => {
    const server = new URL(inject("databaseUrl"));
    server.pathname = "/postgres";
    db = await createOwnerDatabase(server.toString(), { migrate: false });
    // A migrations folder holding only what ships BEFORE the constraints migration.
    const all = readdirSync(resolve(root, "prisma/migrations"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const older = join(workDir, "older");
    mkdirSync(older);
    for (const name of all.filter((n) => n < target)) cpSync(resolve(root, "prisma/migrations", name), join(older, name), { recursive: true });
    cpSync(resolve(root, "prisma/migrations/migration_lock.toml"), join(older, "migration_lock.toml"));
    const schema = JSON.stringify(resolve(root, "prisma/schema.prisma"));
    const configFor = (migrations: string): string => `export default { schema: ${schema}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`;
    writeFileSync(join(workDir, "older.config.mjs"), configFor(older));
    writeFileSync(config, configFor(resolve(root, "prisma/migrations")));
    prismaCommand(["migrate", "deploy"], db.ownerUrl, join(workDir, "older.config.mjs"));
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    await owner.query(`SET app.bypass_rls = 'on'`);
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await db?.drop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("fails with a readable pre-flight message, creating no constraint and no index", async () => {
    await owner.query(`INSERT INTO tenants (id, code, name, "updatedAt") VALUES (gen_random_uuid(), 'Bad-Code', 'x', now()), (gen_random_uuid(), 'dup-home', 'x', now())`);
    await owner.query(`INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "updatedAt") VALUES (gen_random_uuid(), 'A@Example.test', 'a@example.test ', 'x', 'x', now())`);
    const tenant = await owner.query<{ id: string }>(`SELECT id FROM tenants WHERE code = 'dup-home'`);
    for (const name of ["Same Co", " same co "])
      await owner.query(`INSERT INTO provider_organizations (id, "tenantId", name, type, city, "contactEmail", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'HOTEL', 'c', 'c@example.test', now())`, [tenant.rows[0]!.id, name]);
    let output = "";
    try {
      prismaCommand(["migrate", "deploy"], db.ownerUrl, config);
      throw new Error("migrate deploy unexpectedly succeeded on dirty data");
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      output = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}${failure.message}`;
    }
    expect(output).toContain("db_constraints pre-flight");
    expect(output).toContain("tenants.tenants_code_normalized");
    expect(output).toContain("users.users_email_normalized_matches");
    expect(output).toContain("provider_organizations: 1 group(s)");
    const created = await owner.query(`SELECT conname FROM pg_constraint WHERE conname IN ('tenants_code_normalized','users_email_normalized_matches') UNION SELECT indexname FROM pg_indexes WHERE indexname = 'provider_organizations_tenantId_lower_name_key'`);
    expect(created.rowCount).toBe(0);
  }, 120_000);

  it("deploys once the data is fixed (after marking the failed run rolled back), and every constraint ends up validated", async () => {
    await owner.query(`UPDATE tenants SET code = lower(code)`);
    await owner.query(`UPDATE users SET "emailNormalized" = lower(btrim(email))`);
    await owner.query(`UPDATE provider_organizations SET name = 'Other Co' WHERE name = ' same co '`);
    prismaCommand(["migrate", "resolve", "--rolled-back", target], db.ownerUrl, config);
    prismaCommand(["migrate", "deploy"], db.ownerUrl, config);
    const { rows } = await owner.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1)`,
      [["tenants_code_normalized", "users_email_normalized_matches", "users_failed_login_count_nonneg", "bookings_end_not_before_start", "bookings_travelers_range", "bookings_units_range", "bookings_currency_format", "travel_services_currency_format", "refresh_sessions_token_hash_hex", "refresh_sessions_expiry_after_creation"]]
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.convalidated)).toBe(true);
    const index = await owner.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'provider_organizations_tenantId_lower_name_key'`);
    expect(index.rowCount).toBe(1);
  }, 120_000);

  it("keeps the deprecated lockout columns until the deferred contract migration ships (rollback-safe)", async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('failedLoginCount','lastFailedLoginAt','lockedUntil')`
    );
    expect(rows).toHaveLength(3);
  });
});
