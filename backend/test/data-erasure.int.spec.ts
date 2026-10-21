import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeStatements, runStatements } from "../scripts/db/run-purge.js";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Erasure of personal data for deleted accounts (anonymise_deleted_users) and IP retention of the audit trail
 * (scrub_audit_ip_addresses): owner-only procedures run by backend/scripts/db/purge.sh. They run on the superuser fixture
 * connection like the real job runs as the owner; one test also runs them as a plain, row-level-security-bound role.
 */
describe("data erasure", () => {
  const METRICS_TOKEN = "erasure-metrics-token-0123456789abcdef";
  let world: World;
  let tenant: TestTenant;
  let provider: TestUser;
  let providerSession: Session;
  let platform: Session;
  let doomed: TestUser; // deleted 40 days ago
  let recent: TestUser; // deleted 5 days ago
  let active: TestUser;
  let bookingId: string;
  const auth = (s: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const notices: string[] = [];

  const audit = (actor: string | null, action: string, occurredAgo: string, ip: string | null, metadata: Json, entity: { type: string; id: string } | null = null): Promise<unknown> =>
    world.sql.query(
      `INSERT INTO audit_events ("id", "tenantId", "actorUserId", "action", "entityType", "entityId", "ipAddress", "metadata", "occurredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now() - $9::interval)`,
      [randomUUID(), tenant.id, actor, action, entity?.type ?? null, entity?.id ?? null, ip, JSON.stringify(metadata), occurredAgo]
    );
  const userRow = async (id: string): Promise<Record<string, unknown>> => (await world.sql.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    world = await World.start({ METRICS_TOKEN });
    world.sql.on("notice", (n) => notices.push(String(n.message)));
    tenant = await world.createTenant("erasure");
    const orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    providerSession = await world.session(provider);
    platform = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true }));
    doomed = await world.createUser(tenant, { roles: ["traveler"] });
    recent = await world.createUser(tenant, { roles: ["traveler"] });
    active = await world.createUser(tenant, { roles: ["traveler"] });

    // The doomed traveler has a booking, a live session, a credential link, MFA material, a phone number and audit rows with personal data.
    const serviceId = await world.createService(tenant, provider, { capacity: 100 });
    const traveler = await world.session(doomed);
    const booked = await world.api("POST", "/bookings", { session: auth(traveler), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate() } });
    expect(booked.status).toBe(201);
    bookingId = String(booked.body["id"]);
    await world.sql.query(
      `UPDATE users SET phone = '+97455500000', "displayName" = 'Alice Example', "mfaSecretEnc" = 'enc:secret', "mfaEnabledAt" = now(),
         "mfaRecoveryHashes" = '["a","b"]'::jsonb, "mfaChallengeHash" = repeat('a', 64) WHERE id = $1`,
      [doomed.userId]
    );
    await world.sql.query(
      `INSERT INTO credential_tokens ("id", "userId", "purpose", "tokenHash", "email", "expiresAt") VALUES ($1, $2, 'PASSWORD_RESET', $3, $4, now() + interval '1 hour')`,
      [randomUUID(), doomed.userId, randomUUID().replaceAll("-", "").repeat(2), doomed.email]
    );
    await audit(doomed.userId, "identity.user.profile.update", "50 days", "203.0.113.7", { changed: ["displayName"], before: { displayName: "Alice Example", phone: "+97455500000", locale: "ar-SA" } }, { type: "user", id: doomed.userId });
    await audit(null, "platform.account.suspend", "45 days", "203.0.113.8", { reason: "Alice called us from her home number", before: "ACTIVE", after: "SUSPENDED" }, { type: "user", id: doomed.userId });
    await audit(active.userId, "platform.account.suspend", "45 days", "203.0.113.9", { reason: "keep this reason", before: "ACTIVE", after: "SUSPENDED" }, { type: "user", id: active.userId });

    // Deleted through the real platform flow, then the deletion date is moved back.
    for (const [user, ago] of [[doomed, 40], [recent, 5]] as const) {
      const reply = await world.api("POST", `/platform/users/${user.userId}/state`, { session: auth(platform), body: { action: "DELETE", reason: "account closed on request" } });
      expect(reply.status).toBe(201);
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - $2::interval WHERE id = $1`, [user.userId, `${ago} days`]);
    }
  }, 180_000);
  afterAll(async () => world.stop());

  describe("anonymise_deleted_users", () => {
    it("a dry run reports the count and writes nothing", async () => {
      notices.length = 0;
      await world.sql.query(`CALL anonymise_deleted_users(interval '30 days', 500, true)`);
      expect(notices.join("\n")).toMatch(/dry run: 1 user\(s\) would be anonymised/);
      expect((await userRow(doomed.userId)).email).toBe(doomed.email);
      expect((await userRow(doomed.userId)).anonymisedAt).toBeNull();
    });

    it("anonymises only the account deleted longer ago than the setting", async () => {
      await world.sql.query(`CALL anonymise_deleted_users(interval '30 days', 1)`); // batch of 1: several rounds are fine
      const gone = await userRow(doomed.userId);
      expect(gone.email).toBe(`deleted-${doomed.userId}@anonymised.invalid`);
      expect(gone.emailNormalized).toBe(gone.email);
      expect(gone.displayName).toBe("Deleted user");
      expect(gone.phone).toBeNull();
      expect(gone.passwordHash).toBe("!anonymised");
      expect(gone.mfaSecretEnc).toBeNull();
      expect(gone.mfaEnabledAt).toBeNull();
      expect(gone.mfaRecoveryHashes).toEqual([]);
      expect(gone.mfaChallengeHash).toBeNull();
      expect(gone.status).toBe("DISABLED");
      expect(gone.locale).toBe("ar-SA");
      expect(gone.anonymisedAt).not.toBeNull();
      expect((await world.sql.query(`SELECT count(*)::int AS n FROM refresh_sessions WHERE "userId" = $1`, [doomed.userId])).rows[0].n).toBe(0);
      expect((await world.sql.query(`SELECT count(*)::int AS n FROM credential_tokens WHERE "userId" = $1`, [doomed.userId])).rows[0].n).toBe(0);

      const kept = await userRow(recent.userId);
      expect(kept.email).toBe(recent.email);
      expect(kept.anonymisedAt).toBeNull();
      const stillActive = await userRow(active.userId);
      expect(stillActive.email).toBe(active.email);
      expect(stillActive.displayName).toBe(active.email);
      expect(stillActive.passwordHash).not.toBe("!anonymised");
    });

    it("the anonymised account cannot sign in or be found by its old e-mail", async () => {
      expect((await world.login(doomed)).status).toBe(401);
      expect((await world.login(doomed, {}, "anything-at-all-1")).status).toBe(401);
      expect((await world.api("POST", "/auth/login", { body: { email: `deleted-${doomed.userId}@anonymised.invalid`, password: doomed.password, tenantCode: tenant.code } })).status).toBe(401);
      expect(await world.prisma.user.findUnique({ where: { emailNormalized: doomed.email.toLowerCase() } })).toBeNull();
      const search = await world.api("GET", `/platform/records/users?page=1&q=${encodeURIComponent(doomed.email)}`, { session: auth(platform) });
      expect((search.body.items as Array<Record<string, unknown>>).filter((item) => item.email === doomed.email)).toEqual([]);
    });

    it("the booking, its membership and the user row remain and resolve to the tombstone", async () => {
      const listed = (await world.api("GET", "/bookings", { session: auth(providerSession) })).body as unknown as Json[];
      expect(listed.find((b) => b["id"] === bookingId)).toBeTruthy();
      const joined = await world.sql.query(
        `SELECT b.id, u."displayName", u.email FROM bookings b JOIN tenant_memberships m ON m.id = b."travelerMembershipId" JOIN users u ON u.id = m."userId" WHERE b.id = $1`,
        [bookingId]
      );
      expect(joined.rows[0]).toMatchObject({ displayName: "Deleted user", email: `deleted-${doomed.userId}@anonymised.invalid` });
      expect((await world.sql.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE "userId" = $1`, [doomed.userId])).rows[0].n).toBe(1);
    });

    it("keeps the audit rows (action, time, entity) but strips free text and personal values from the user's rows only", async () => {
      const mine = await world.sql.query(
        `SELECT "action", "metadata", "occurredAt" FROM audit_events WHERE "actorUserId" = $1 OR ("entityType" = 'user' AND "entityId" = $1::text) ORDER BY "occurredAt"`,
        [doomed.userId]
      );
      const byAction = Object.fromEntries(mine.rows.map((r) => [r.action as string, r.metadata as Json]));
      expect(byAction["identity.user.profile.update"]).toEqual({ changed: ["displayName"] });
      expect(byAction["platform.account.suspend"]).toEqual({ before: "ACTIVE", after: "SUSPENDED" });
      expect(JSON.stringify(mine.rows)).not.toMatch(/Alice|home number|\+9745/);
      expect(mine.rows.every((r) => r.occurredAt instanceof Date)).toBe(true);
      const other = await world.sql.query(`SELECT "metadata" FROM audit_events WHERE "actorUserId" = $1 AND action = 'platform.account.suspend'`, [active.userId]);
      expect(other.rows[0].metadata).toMatchObject({ reason: "keep this reason" });
    });

    it("re-running changes nothing", async () => {
      const before = await userRow(doomed.userId);
      notices.length = 0;
      await world.sql.query(`CALL anonymise_deleted_users(interval '30 days', 500)`);
      expect(notices.join("\n")).toMatch(/0 user\(s\) anonymised/);
      const after = await userRow(doomed.userId);
      expect(after.anonymisedAt).toEqual(before.anonymisedAt);
      expect(after.authVersion).toBe(before.authVersion);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it("an anonymised account cannot be restored through the platform API", async () => {
      const reply = await world.api("POST", `/platform/users/${doomed.userId}/state`, { session: auth(platform), body: { action: "RESTORE", reason: "oops, restore it" } });
      expect(reply.status).toBe(409);
      expect((await userRow(doomed.userId)).deletedAt).not.toBeNull();
    });

    it("refuses a delay under one day and is closed to the application role", async () => {
      await expect(world.sql.query(`CALL anonymise_deleted_users(interval '1 hour')`)).rejects.toThrow(/at least 1 day/);
      await expect(world.sql.query(`SET ROLE safry_app; CALL anonymise_deleted_users(interval '30 days')`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
    });
  });

  describe("scrub_audit_ip_addresses", () => {
    const ip = async (id: string): Promise<unknown> => (await world.sql.query(`SELECT host("ipAddress") AS ip FROM audit_events WHERE "entityId" = $1`, [id])).rows[0].ip;

    it("clears the IP of old rows for every user, keeps recent rows and everything else, and repeats as a no-op", async () => {
      const oldKey = randomUUID(), newKey = randomUUID(), edge = randomUUID();
      await audit(active.userId, "identity.login", "100 days", "198.51.100.5", { n: 1 }, { type: "probe", id: oldKey });
      await audit(active.userId, "identity.login", "10 days", "198.51.100.6", { n: 2 }, { type: "probe", id: newKey });
      await audit(null, "identity.login.failed", "91 days", "198.51.100.7", { n: 3 }, { type: "probe", id: edge });

      notices.length = 0;
      await world.sql.query(`CALL scrub_audit_ip_addresses(interval '90 days', 100, true)`);
      expect(notices.join("\n")).toMatch(/dry run: [2-9]\d* audit row\(s\) would lose their IP address/);
      expect(await ip(oldKey)).toBe("198.51.100.5");

      await world.sql.query(`CALL scrub_audit_ip_addresses(interval '90 days', 1)`); // batch of 1
      expect(await ip(oldKey)).toBeNull();
      expect(await ip(edge)).toBeNull();
      expect(await ip(newKey)).toBe("198.51.100.6");
      const row = (await world.sql.query(`SELECT action, metadata FROM audit_events WHERE "entityId" = $1`, [oldKey])).rows[0];
      expect(row).toMatchObject({ action: "identity.login", metadata: { n: 1 } });
      expect((await world.sql.query(`SELECT count(*)::int AS n FROM audit_events WHERE "ipAddress" IS NOT NULL AND "occurredAt" < now() - interval '90 days'`)).rows[0].n).toBe(0);

      notices.length = 0;
      await world.sql.query(`CALL scrub_audit_ip_addresses(interval '90 days')`);
      expect(notices.join("\n")).toMatch(/0 audit row\(s\) lost their IP address/);
    });

    it("the application role still cannot update or delete audit rows, and cannot run the procedure", async () => {
      await expect(world.sql.query(`SET ROLE safry_app; UPDATE audit_events SET "ipAddress" = NULL`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
      await expect(world.sql.query(`SET ROLE safry_app; DELETE FROM audit_events`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
      await expect(world.sql.query(`SET ROLE safry_app; CALL scrub_audit_ip_addresses(interval '90 days')`)).rejects.toThrow(/permission denied/);
      await world.sql.query("RESET ROLE");
      await expect(world.sql.query(`CALL scrub_audit_ip_addresses(interval '1 hour')`)).rejects.toThrow(/at least 1 day/);
    });
  });

  describe("under row-level security", () => {
    it("works for a plain role that is bound by the policies (the owner is, via FORCE), using only the bypass the procedures raise", async () => {
      const role = `erasure_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - interval '60 days', status = 'DISABLED' WHERE id = $1`, [victim.userId]);
      await audit(victim.userId, "identity.login", "200 days", "198.51.100.77", { reason: "x" });
      await world.sql.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`);
      try {
        await world.sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await world.sql.query(`GRANT SELECT ON users, tenant_memberships TO ${role}`);
        // The procedures call SECURITY DEFINER functions: the role needs EXECUTE on those, and no table privilege at all.
        await world.sql.query(`GRANT EXECUTE ON PROCEDURE anonymise_deleted_users(interval, integer, boolean), scrub_audit_ip_addresses(interval, integer, boolean) TO ${role}`);
        await world.sql.query(`GRANT EXECUTE ON FUNCTION anonymise_deleted_users_batch(interval, integer), anonymise_deleted_users_count(interval), scrub_audit_ip_addresses_batch(interval, integer), scrub_audit_ip_addresses_count(interval) TO ${role}`);
        // Without the bypass the role sees no users at all: proves the policies bind it.
        await world.sql.query(`SET ROLE ${role}`);
        expect((await world.sql.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(0);
        await world.sql.query(`CALL anonymise_deleted_users(interval '30 days', 500)`);
        await world.sql.query(`CALL scrub_audit_ip_addresses(interval '90 days', 500)`);
        await world.sql.query("RESET ROLE");
      } finally {
        await world.sql.query("RESET ROLE");
        await world.sql.query(`DROP OWNED BY ${role}`);
        await world.sql.query(`DROP ROLE ${role}`);
      }
      expect((await userRow(victim.userId)).email).toBe(`deleted-${victim.userId}@anonymised.invalid`);
      const audited = (await world.sql.query(`SELECT host("ipAddress") AS ip, metadata FROM audit_events WHERE "actorUserId" = $1`, [victim.userId])).rows[0];
      expect(audited.ip).toBeNull();
      expect(audited.metadata).toEqual({});
    });
  });

  describe("the maintenance login (procedures-only role)", () => {
    const asMaintenance = async <T>(work: () => Promise<T>): Promise<T> => {
      await world.sql.query("SET ROLE safry_maintenance_ops");
      try {
        return await work();
      } finally {
        await world.sql.query("RESET ROLE");
      }
    };

    it("runs both erasure steps through the functions, with no table privilege", async () => {
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - interval '45 days', status = 'DISABLED' WHERE id = $1`, [victim.userId]);
      const key = randomUUID();
      await audit(victim.userId, "identity.login", "120 days", "198.51.100.88", { reason: "free text" }, { type: "probe", id: key });
      const lines: string[] = [];
      await asMaintenance(() => runStatements(world.sql, purgeStatements({ ANONYMISE_DELETED_USERS_AFTER_DAYS: "30", AUDIT_IP_RETENTION_DAYS: "90", PURGE_BATCH_SIZE: "100" }).filter((sql) => /anonymise|scrub/.test(sql)), (l) => lines.push(l)));
      expect(lines.join("\n")).toMatch(/anonymise_deleted_users_batch/);
      expect((await userRow(victim.userId)).email).toBe(`deleted-${victim.userId}@anonymised.invalid`);
      const row = (await world.sql.query(`SELECT host("ipAddress") AS ip, metadata FROM audit_events WHERE "entityId" = $1`, [key])).rows[0];
      expect(row.ip).toBeNull();
      expect(row.metadata).toEqual({});
    });

    it("the dry run counts for the login and changes nothing", async () => {
      const victim = await world.createUser(tenant, { roles: ["traveler"] });
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - interval '45 days', status = 'DISABLED' WHERE id = $1`, [victim.userId]);
      const lines: string[] = [];
      await asMaintenance(() => runStatements(world.sql, purgeStatements({ PURGE_DRY_RUN: "1" }), (l) => lines.push(l)));
      expect(lines.join("\n")).toMatch(/anonymise_deleted_users_count\(.*-> [1-9]\d* \(dry run/);
      expect((await userRow(victim.userId)).anonymisedAt).toBeNull();
      await world.sql.query(`UPDATE users SET "deletedAt" = NULL WHERE id = $1`, [victim.userId]);
    });

    it("cannot go below the policy floors: a short argument still waits for 30 days / 90 days", async () => {
      const young = await world.createUser(tenant, { roles: ["traveler"] });
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - interval '10 days', status = 'DISABLED' WHERE id = $1`, [young.userId]);
      const key = randomUUID();
      await audit(null, "identity.login", "30 days", "198.51.100.89", { n: 1 }, { type: "probe", id: key });
      await asMaintenance(async () => {
        await world.sql.query(`SELECT anonymise_deleted_users_batch(interval '1 day', 10000)`);
        await world.sql.query(`SELECT scrub_audit_ip_addresses_batch(interval '1 day', 100000)`);
      });
      expect((await userRow(young.userId)).anonymisedAt).toBeNull();
      expect((await world.sql.query(`SELECT host("ipAddress") AS ip FROM audit_events WHERE "entityId" = $1`, [key])).rows[0].ip).toBe("198.51.100.89");
      await world.sql.query(`UPDATE users SET "deletedAt" = NULL WHERE id = $1`, [young.userId]);
    });

    it("cannot read or change users or audit rows, or call the owner procedures", async () => {
      for (const sql of [
        `SELECT 1 FROM users LIMIT 1`, `SELECT 1 FROM audit_events LIMIT 1`, `UPDATE users SET phone = NULL`, `UPDATE audit_events SET "ipAddress" = NULL`,
        `CALL anonymise_deleted_users(interval '30 days')`, `CALL scrub_audit_ip_addresses(interval '90 days')`, `CALL set_maintenance_policy('user_anonymisation', interval '1 day')`,
        `SELECT 1 FROM maintenance_policy`, `SELECT erasure_overdue_counts(1, 1)`
      ]) {
        await expect(asMaintenance(() => world.sql.query(sql)), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("refuses a delay under one day", async () => {
      await expect(asMaintenance(() => world.sql.query(`SELECT anonymise_deleted_users_batch(interval '1 hour')`))).rejects.toThrow(/at least 1 day/);
      await expect(asMaintenance(() => world.sql.query(`SELECT scrub_audit_ip_addresses_batch(interval '1 hour')`))).rejects.toThrow(/at least 1 day/);
    });
  });

  describe("the erasure-overdue metric", () => {
    it("the counts are 0 when nothing is overdue, and the API exports 1 once a deleted account is past the setting plus slack", async () => {
      const counts = (await world.sql.query(`SELECT * FROM erasure_overdue_counts(33, 93)`)).rows[0];
      expect(Number(counts.users_pending)).toBe(0); // doomed was anonymised, recent is only 5 days old
      expect(Number(counts.audit_ip_pending)).toBe(0); // scrubbed above
      const off = (await world.sql.query(`SELECT * FROM erasure_overdue_counts(0, 0)`)).rows[0];
      expect([Number(off.users_pending), Number(off.audit_ip_pending)]).toEqual([0, 0]);
      await world.sql.query(`UPDATE users SET "deletedAt" = now() - interval '40 days' WHERE id = $1`, [recent.userId]);
      expect(Number((await world.sql.query(`SELECT * FROM erasure_overdue_counts(33, 0)`)).rows[0].users_pending)).toBe(1);
      const reply = await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      expect(String((reply.body as { text?: string }).text ?? "")).toMatch(/^safry_erasure_overdue 1$/m);
    });
  });
});
