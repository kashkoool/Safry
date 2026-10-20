import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeStatements, runStatements } from "../scripts/db/run-purge.js";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * The retention job's database procedures (owner-only, run by backend/scripts/db/purge.sh) and the metrics built on them:
 * idle sign-in counters, the expired-PENDING-booking sweep (same rule as the API's computed expiry), the heartbeat, and the
 * storage gauges the alerts read. Procedures run on the superuser fixture connection, like the real job runs as the owner.
 */
describe("retention maintenance", () => {
  const METRICS_TOKEN = "maintenance-metrics-token-0123456789abcdef";
  let world: World;
  let tenant: TestTenant;
  let provider: TestUser;
  let providerSession: Session;
  let scrape: string;

  const auth = (s: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const book = (s: Session, serviceId: string, extra: Json = {}): Promise<{ status: number; body: Json }> =>
    world.api("POST", "/bookings", { session: auth(s), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate(), ...extra } });
  const ageMinutes = (id: string, minutes: number): Promise<unknown> =>
    world.prisma.booking.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });
  const traveler = async (): Promise<Session> => world.session(await world.createUser(tenant, { roles: ["traveler"] }));
  const value = (series: string): number => {
    const hit = scrape.split("\n").find((line) => line.startsWith(`${series} `));
    if (!hit) throw new Error(`series ${series} missing`);
    return Number(hit.slice(series.length + 1));
  };

  beforeAll(async () => {
    world = await World.start({ METRICS_TOKEN, BOOKING_PENDING_TTL_HOURS: "48", SESSION_RETENTION_DAYS: "30" });
    tenant = await world.createTenant("maint");
    const orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    providerSession = await world.session(provider);
    // Fixture for the overdue gauge: a session revoked 40 days ago (30 days retention + 3 days slack = 33). Created before the first scrape.
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    await world.sql.query(
      `INSERT INTO refresh_sessions ("id", "tokenHash", "userId", "tenantId", "membershipId", "familyId", "authenticatedAt", "expiresAt", "revokedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '41 days', now() - interval '20 days', now() - interval '40 days', now() - interval '41 days')`,
      [randomUUID(), randomUUID().replaceAll("-", "").repeat(2), user.userId, tenant.id, user.membershipId, randomUUID()]
    );
    const reply = await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    scrape = String((reply.body as { text?: string }).text ?? "");
  }, 180_000);
  afterAll(async () => world.stop());

  describe("storage gauges", () => {
    it("exports the heartbeat (seeded by the migration), an empty default partition and the overdue flag", () => {
      expect(value("safry_maintenance_last_success_timestamp_seconds")).toBeGreaterThan(Date.now() / 1000 - 3600);
      expect(value("safry_audit_default_partition_rows")).toBe(0);
      expect(value("safry_refresh_sessions_overdue")).toBe(1);
    });

    it("exports live and dead row counts for the churn tables, without ids or names", () => {
      for (const table of ["refresh_sessions", "credential_tokens", "login_throttles", "bookings"]) {
        expect(value(`safry_table_live_tuples{table="${table}"}`)).toBeGreaterThanOrEqual(0);
        expect(value(`safry_table_dead_tuples{table="${table}"}`)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("the whole job", () => {
    it("every statement purge.sh runs exists with that signature and the run ends with a fresh heartbeat", async () => {
      await world.sql.query(`UPDATE maintenance_runs SET "lastSuccessAt" = now() - interval '3 days' WHERE job = 'purge'`);
      await runStatements(world.sql, purgeStatements({ SESSION_RETENTION_DAYS: "30", AUDIT_RETENTION_DAYS: "730", PURGE_BATCH_SIZE: "200" }));
      const age = await world.sql.query(`SELECT extract(epoch FROM now() - "lastSuccessAt") AS s FROM maintenance_runs WHERE job = 'purge'`);
      expect(Number(age.rows[0].s)).toBeLessThan(60);
    });
  });

  describe("the maintenance login", () => {
    const asMaintenance = async <T>(work: () => Promise<T>): Promise<T> => {
      await world.sql.query("SET ROLE safry_maintenance_ops");
      try {
        return await work();
      } finally {
        await world.sql.query("RESET ROLE");
      }
    };

    it("is not a superuser, does not bypass row-level security and is not the table owner", async () => {
      const role = await world.sql.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'safry_maintenance_ops'`);
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false }]);
      const owned = await world.sql.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'safry_maintenance_ops'`);
      expect(owned.rows[0].n).toBe(0);
    });

    it("runs every statement of the job, so the heartbeat advances, with only that privilege", async () => {
      await world.sql.query(`UPDATE maintenance_runs SET "lastSuccessAt" = now() - interval '3 days' WHERE job = 'purge'`);
      await asMaintenance(async () => {
        await runStatements(world.sql, purgeStatements({ PURGE_BATCH_SIZE: "200" }));
      });
      const age = await world.sql.query(`SELECT extract(epoch FROM now() - "lastSuccessAt") AS s FROM maintenance_runs WHERE job = 'purge'`);
      expect(Number(age.rows[0].s)).toBeLessThan(60);
    });

    it("sweeps and purges for real while connected as that role", async () => {
      const serviceId = await world.createService(tenant, provider, { capacity: 100 });
      const t = await traveler();
      const reply = await book(t, serviceId);
      const id = String(reply.body["id"]);
      await ageMinutes(id, 3 * 24 * 60);
      await asMaintenance(() => runStatements(world.sql, ["SELECT sweep_expired_bookings_batch(interval '48 hours', 1000)"]));
      expect((await world.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
      expect(await world.prisma.auditEvent.count({ where: { entityId: id, action: "booking.expire" } })).toBe(1);
    });

    it("cannot read or change application data, or run other things", async () => {
      for (const sql of [
        `SELECT 1 FROM users LIMIT 1`, `SELECT 1 FROM refresh_sessions LIMIT 1`, `SELECT 1 FROM bookings LIMIT 1`, `SELECT 1 FROM audit_events LIMIT 1`,
        `SELECT 1 FROM maintenance_runs LIMIT 1`, `DELETE FROM login_throttles`, `UPDATE bookings SET notes = 'x'`, `CREATE TABLE public.leak (a int)`,
        `TRUNCATE audit_events`, `CREATE ROLE evil`, `SELECT audit_default_partition_rows()`,
        `CALL sweep_expired_bookings(interval '48 hours')`, `CALL purge_refresh_sessions(interval '30 days')`
      ])
        await expect(asMaintenance(() => world.sql.query(sql)), sql).rejects.toThrow(/permission denied|must be owner/);
      // Even a hostile search_path or a temp table named like a real one cannot redirect the procedures.
      const dueKey = `z${randomUUID().replaceAll("-", "")}`.padEnd(64, "0").slice(0, 64);
      await world.sql.query(`INSERT INTO public.login_throttles ("key", "failures", "updatedAt", "windowStartedAt") VALUES ($1, 1, now() - interval '3 days', now() - interval '3 days')`, [dueKey]);
      let tempRows = -1;
      await asMaintenance(async () => {
        await world.sql.query(`SET search_path = pg_temp, public`);
        try {
          await world.sql.query(`CREATE TEMP TABLE login_throttles (key text, "updatedAt" timestamptz, "blockedUntil" timestamptz, "trustedUntil" timestamptz)`);
          await world.sql.query(`INSERT INTO pg_temp.login_throttles VALUES ($1, now() - interval '3 days', NULL, NULL)`, [dueKey]);
          await world.sql.query(`SELECT purge_login_throttles_batch(interval '24 hours')`);
          tempRows = Number((await world.sql.query(`SELECT count(*)::int AS n FROM pg_temp.login_throttles`)).rows[0].n);
        } finally {
          try {
            await world.sql.query(`DROP TABLE IF EXISTS pg_temp.login_throttles`);
          } finally {
            await world.sql.query(`RESET search_path`);
          }
        }
      });
      // The function worked on the real table (the due row is gone) and never touched the temp table that shadowed it.
      expect(tempRows).toBe(1);
      expect((await world.sql.query(`SELECT 1 FROM public.login_throttles WHERE "key" = $1`, [dueKey])).rowCount).toBe(0);
    });
  });

  describe("policy floors for the maintenance login", () => {
    const asMaintenance = async <T>(work: () => Promise<T>): Promise<T> => {
      await world.sql.query("SET ROLE safry_maintenance_ops");
      try {
        return await work();
      } finally {
        await world.sql.query("RESET ROLE");
      }
    };
    const partition = async (name: string): Promise<boolean> => (await world.sql.query(`SELECT to_regclass('public.${name}') AS r`)).rows[0].r !== null;

    it("cannot drop audit partitions younger than the policy retention, whatever it asks for", async () => {
      await world.sql.query(`CALL ensure_audit_event_partitions(5, 1)`);
      const old = (await world.sql.query(`SELECT 'audit_events_' || to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '5 months', 'YYYY_MM') AS n`)).rows[0].n as string;
      expect(await partition(old)).toBe(true);
      await asMaintenance(() => world.sql.query(`CALL purge_audit_events(interval '30 days')`));
      expect(await partition(old)).toBe(true);
      // The owner can lower the floor on purpose; then the same call drops it. Restore the default afterwards.
      await world.sql.query(`CALL set_maintenance_policy('audit_retention', interval '30 days')`);
      try {
        await asMaintenance(() => world.sql.query(`CALL purge_audit_events(interval '30 days')`));
        expect(await partition(old)).toBe(false);
      } finally {
        await world.sql.query(`CALL set_maintenance_policy('audit_retention', interval '24 months')`);
      }
    });

    it("cannot cancel a PENDING booking before the policy lifetime, or delete sessions and links before the policy retention", async () => {
      const serviceId = await world.createService(tenant, provider, { capacity: 100 });
      const t = await traveler();
      const reply = await book(t, serviceId);
      const id = String(reply.body["id"]);
      await ageMinutes(id, 10 * 60); // 10 hours old, policy lifetime is 48 hours
      await asMaintenance(() => runStatements(world.sql, ["SELECT sweep_expired_bookings_batch(interval '1 hour', 1000)"]));
      expect((await world.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");

      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const sessionId = randomUUID();
      await world.sql.query(
        `INSERT INTO refresh_sessions ("id", "tokenHash", "userId", "tenantId", "membershipId", "familyId", "authenticatedAt", "expiresAt", "revokedAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '12 days', now() - interval '10 days', now() - interval '10 days', now() - interval '12 days')`,
        [sessionId, randomUUID().replaceAll("-", "").repeat(2), user.userId, tenant.id, user.membershipId, randomUUID()]
      );
      await asMaintenance(() => runStatements(world.sql, ["SELECT purge_refresh_sessions_batch(interval '1 day', 100000)"]));
      expect((await world.sql.query(`SELECT 1 FROM refresh_sessions WHERE id = $1`, [sessionId])).rowCount).toBe(1);
      await world.sql.query(`DELETE FROM refresh_sessions WHERE id = $1`, [sessionId]);
    });

    it("compares dates, not intervals: 721 days does not beat a 24-month floor, 1 month does not undercut 30 days", async () => {
      // Audit: a partition whose upper bound is a few days newer than (now - floor) must survive a call that asks for a slightly shorter
      // retention measured in days. Built on a 36-month floor in a range no other partition uses (the legacy partition is dropped first).
      await world.sql.query(`DROP TABLE IF EXISTS audit_events_legacy`);
      await world.sql.query(`DROP TABLE IF EXISTS audit_events_boundary_test`);
      await world.sql.query(
        `CREATE TABLE audit_events_boundary_test PARTITION OF audit_events FOR VALUES FROM (now() - interval '36 months' - interval '2 days') TO (now() - interval '36 months' + interval '3 days')`
      );
      await world.sql.query(`CALL set_maintenance_policy('audit_retention', interval '36 months')`);
      try {
        // 1090 days is "longer" than 36 months as an interval (36 months counts as 1080 days) but a calendar 36 months is 1095-1096 days.
        await asMaintenance(() => world.sql.query(`CALL purge_audit_events(interval '1090 days')`));
        expect(await partition("audit_events_boundary_test")).toBe(true);
        await world.sql.query(`CALL set_maintenance_policy('audit_retention', interval '30 days')`);
        await asMaintenance(() => world.sql.query(`CALL purge_audit_events(interval '1090 days')`));
        expect(await partition("audit_events_boundary_test")).toBe(false);
      } finally {
        await world.sql.query(`CALL set_maintenance_policy('audit_retention', interval '24 months')`);
        await world.sql.query(`DROP TABLE IF EXISTS audit_events_boundary_test`);
      }

      // Sessions: revoked 28 days ago survives "1 month" under the 30-day floor, in any month length.
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      const sessionId = randomUUID();
      await world.sql.query(
        `INSERT INTO refresh_sessions ("id", "tokenHash", "userId", "tenantId", "membershipId", "familyId", "authenticatedAt", "expiresAt", "revokedAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '40 days', now() - interval '28 days', now() - interval '28 days', now() - interval '40 days')`,
        [sessionId, randomUUID().replaceAll("-", "").repeat(2), user.userId, tenant.id, user.membershipId, randomUUID()]
      );
      await asMaintenance(() => runStatements(world.sql, ["SELECT purge_refresh_sessions_batch(interval '1 month', 1000)"]));
      expect((await world.sql.query(`SELECT 1 FROM refresh_sessions WHERE id = $1`, [sessionId])).rowCount).toBe(1);
      await world.sql.query(`DELETE FROM refresh_sessions WHERE id = $1`, [sessionId]);
    });

    it("the booking floor follows the configured lifetime: with 168 hours a 100-hour-old PENDING booking is kept, a 200-hour-old one is cancelled", async () => {
      const serviceId = await world.createService(tenant, provider, { capacity: 100 });
      const t = await traveler();
      const young = String((await book(t, serviceId, { serviceDate: world.futureDate(20) })).body["id"]);
      const old = String((await book(t, serviceId, { serviceDate: world.futureDate(21) })).body["id"]);
      await ageMinutes(young, 100 * 60);
      await ageMinutes(old, 200 * 60);
      await world.sql.query(`CALL set_maintenance_policy('booking_pending_ttl', interval '168 hours')`);
      try {
        await asMaintenance(() => runStatements(world.sql, ["SELECT sweep_expired_bookings_batch(interval '1 hour', 1000)"]));
        await runStatements(world.sql, ["SELECT sweep_expired_bookings_batch(interval '168 hours', 1000)"]);
      } finally {
        await world.sql.query(`CALL set_maintenance_policy('booking_pending_ttl', interval '48 hours')`);
      }
      expect((await world.prisma.booking.findUniqueOrThrow({ where: { id: young } })).status).toBe("PENDING");
      expect((await world.prisma.booking.findUniqueOrThrow({ where: { id: old } })).status).toBe("CANCELLED");
    });

    it("partition creation is capped at 24 months ahead for the login, and the heartbeat accepts only the purge job with a small payload", async () => {
      await asMaintenance(() => world.sql.query(`CALL maintenance_ensure_partitions(100)`));
      const month = async (plus: number): Promise<string> =>
        (await world.sql.query(`SELECT 'audit_events_' || to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => $1::int), 'YYYY_MM') AS n`, [plus])).rows[0].n as string;
      expect(await partition(await month(24))).toBe(true);
      expect(await partition(await month(25))).toBe(false);
      await expect(asMaintenance(() => world.sql.query(`CALL ensure_audit_event_partitions(0, 1)`))).rejects.toThrow(/permission denied/);
      await expect(asMaintenance(() => world.sql.query(`CALL record_maintenance_run('other')`))).rejects.toThrow(/unknown maintenance job/);
      await expect(asMaintenance(() => world.sql.query(`CALL record_maintenance_run('purge', jsonb_build_object('x', repeat('a', 5000)))`))).rejects.toThrow(/too large/);
      await asMaintenance(() => world.sql.query(`CALL record_maintenance_run('purge')`));
    });

    it("the policy table and the policy procedure are closed to the maintenance login", async () => {
      for (const sql of [`SELECT * FROM maintenance_policy`, `UPDATE maintenance_policy SET minimum = interval '1 day'`, `CALL set_maintenance_policy('audit_retention', interval '30 days')`, `SELECT maintenance_policy_floor('audit_retention')`])
        await expect(asMaintenance(() => world.sql.query(sql)), sql).rejects.toThrow(/permission denied/);
    });
  });

  describe("record_maintenance_run", () => {
    it("moves the heartbeat forward and is closed to the application role", async () => {
      await world.sql.query(`UPDATE maintenance_runs SET "lastSuccessAt" = now() - interval '3 days' WHERE job = 'purge'`);
      await world.sql.query(`CALL record_maintenance_run('purge')`);
      const age = await world.sql.query(`SELECT extract(epoch FROM now() - "lastSuccessAt") AS s FROM maintenance_runs WHERE job = 'purge'`);
      expect(Number(age.rows[0].s)).toBeLessThan(60);
      await expect(world.sql.query(`SET ROLE safry_app; CALL record_maintenance_run('purge')`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
      await expect(world.sql.query(`SET ROLE safry_app; DELETE FROM maintenance_runs`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
    });
  });

  describe("purge_login_throttles", () => {
    const row = (key: string, updatedAgo: string, extra: string): Promise<unknown> =>
      world.sql.query(`INSERT INTO login_throttles ("key", "failures", "updatedAt", "windowStartedAt" ${extra.split("|")[0]}) VALUES ($1, 1, now() - interval '${updatedAgo}', now() - interval '${updatedAgo}' ${extra.split("|")[1]})`, [key]);
    const exists = async (key: string): Promise<boolean> => (await world.sql.query(`SELECT 1 FROM login_throttles WHERE "key" = $1`, [key])).rowCount === 1;

    it("removes idle counters and keeps recent, blocked and trusted ones", async () => {
      const k = (n: string): string => `${n}${randomUUID().replaceAll("-", "")}`.slice(0, 64).padEnd(64, "0");
      const idle = k("a"), recent = k("b"), blocked = k("c"), trusted = k("d"), expiredBlock = k("e");
      await row(idle, "3 days", "|");
      await row(recent, "2 hours", "|");
      await row(blocked, "3 days", `, "blockedUntil"|, now() + interval '10 minutes'`);
      await row(trusted, "3 days", `, "trustedUntil"|, now() + interval '10 days'`);
      await row(expiredBlock, "3 days", `, "blockedUntil"|, now() - interval '1 day'`);
      await world.sql.query(`CALL purge_login_throttles(interval '24 hours', 100)`);
      expect(await exists(idle)).toBe(false);
      expect(await exists(expiredBlock)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(blocked)).toBe(true);
      expect(await exists(trusted)).toBe(true);
      await expect(world.sql.query(`CALL purge_login_throttles(interval '10 minutes')`)).rejects.toThrow(/at least 1 hour/);
    });
  });

  describe("sweep_expired_bookings", () => {
    it("cancels exactly the bookings the API reports as expired, with one audit event each, and leaves the rest", async () => {
      const serviceId = await world.createService(tenant, provider, { capacity: 100 });
      const t = await traveler();
      // Create everything first and age afterwards: creating a booking sweeps this traveler's expired PENDING ones on its own.
      const ages = new Map<string, number>();
      const mk = async (minutesOld: number, status?: "CONFIRMED" | "CANCELLED"): Promise<string> => {
        const reply = await book(t, serviceId, { serviceDate: world.futureDate(10 + Math.floor(Math.random() * 80)) });
        expect(reply.status).toBe(201);
        const id = String(reply.body["id"]);
        if (status === "CONFIRMED") await world.api("PATCH", `/bookings/${id}/status`, { session: auth(providerSession), body: { status } });
        if (status === "CANCELLED") await world.api("PATCH", `/bookings/${id}/status`, { session: auth(t), body: { status } });
        ages.set(id, minutesOld);
        return id;
      };
      const justInside = await mk(48 * 60 - 5); // 47 h 55 min: not expired
      const justOutside = await mk(48 * 60 + 5); // 48 h 05 min: expired
      const longGone = await mk(30 * 24 * 60);
      const oldConfirmed = await mk(10 * 24 * 60, "CONFIRMED");
      const oldCancelled = await mk(10 * 24 * 60, "CANCELLED");

      for (const [id, minutes] of ages) await ageMinutes(id, minutes);

      // What the API says before any sweep: the rule the procedure must agree with.
      const listed = (await world.api("GET", "/bookings", { session: auth(t) })).body as unknown as Json[];
      const apiExpired = new Set(listed.filter((b) => b["expired"] === true).map((b) => String(b["id"])));
      expect(apiExpired).toEqual(new Set([justOutside, longGone]));
      const auditBefore = await world.prisma.auditEvent.count({ where: { action: "booking.expire" } });

      await world.sql.query(`CALL sweep_expired_bookings(interval '48 hours', 1)`); // batch of 1: several rounds
      const status = async (id: string): Promise<string> => (await world.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(justInside)).toBe("PENDING");
      expect(await status(justOutside)).toBe("CANCELLED");
      expect(await status(longGone)).toBe("CANCELLED");
      expect(await status(oldConfirmed)).toBe("CONFIRMED");
      expect(await status(oldCancelled)).toBe("CANCELLED");
      for (const id of [justOutside, longGone])
        expect(await world.prisma.auditEvent.count({ where: { entityId: id, action: "booking.expire", tenantId: tenant.id } })).toBe(1);
      expect(await world.prisma.auditEvent.count({ where: { entityId: justInside, action: "booking.expire" } })).toBe(0);
      expect(await world.prisma.auditEvent.count({ where: { action: "booking.expire" } })).toBeGreaterThanOrEqual(auditBefore + 2);

      // Repeating changes nothing (idempotent), and the API view of the swept ones is the same as before.
      await world.sql.query(`CALL sweep_expired_bookings(interval '48 hours')`);
      expect(await world.prisma.auditEvent.count({ where: { entityId: justOutside, action: "booking.expire" } })).toBe(1);
      const after = (await world.api("GET", "/bookings", { session: auth(t) })).body as unknown as Json[];
      expect(after.find((b) => b["id"] === justOutside)).toMatchObject({ status: "CANCELLED" });
      expect(after.find((b) => b["id"] === justInside)).toMatchObject({ status: "PENDING" });
    });

    it("sweeps in batches across tenants and refuses a lifetime under one hour", async () => {
      const other = await world.createTenant("maint2");
      const orgId = await world.createOrganization(other);
      const owner = await world.createUser(other, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
      const serviceId = await world.createService(other, owner, { capacity: 100 });
      const t = await world.session(await world.createUser(other, { roles: ["traveler"] }));
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const reply = await world.api("POST", "/bookings", { session: auth(t), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate(5 + i) } });
        ids.push(String(reply.body["id"]));
        await ageMinutes(ids[i]!, 3 * 24 * 60);
      }
      await world.sql.query(`CALL sweep_expired_bookings(interval '48 hours', 2)`);
      const rows = await world.prisma.booking.findMany({ where: { id: { in: ids } }, select: { status: true } });
      expect(rows.map((r) => r.status)).toEqual(Array(5).fill("CANCELLED"));
      await expect(world.sql.query(`CALL sweep_expired_bookings(interval '10 minutes')`)).rejects.toThrow(/at least 1 hour/);
    });

    it("is closed to the application role", async () => {
      await expect(world.sql.query(`SET ROLE safry_app; CALL sweep_expired_bookings(interval '48 hours')`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
    });
  });
});
