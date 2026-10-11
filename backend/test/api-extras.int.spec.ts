import { randomBytes, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Cases covered:
 *  (a) production boot refuses a privileged runtime login, with real PostgreSQL roles
 *  (d) logout scope           (e) refresh-token reuse and races
 *  (f) cursor pagination across tenants and tampered cursors
 *  (g) the consent state machine of invitations
 * (b) account throttle and (c) Redis outage are in api-throttle.int.spec.ts (they need rate limiting switched on).
 */
describe("api extras", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({ accessToken: session.accessToken, tenantId: session.user.tenantId });
  const refresh = (refreshToken: string) => world.api("POST", "/auth/refresh", { body: { refreshToken } });
  const me = (session: Session) => world.api("GET", "/auth/me", { session: auth(session) });

  beforeAll(async () => {
    world = await World.start();
    a = await world.createTenant("ex-a");
    b = await world.createTenant("ex-b");
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("(a) production refuses a runtime login that can leave the restricted role", () => {
    const roles: string[] = [];
    const passwords = new Map<string, string>();

    /** A throw-away login role; `memberOf` grants it the given roles. */
    async function login(kind: string, attributes: string, memberOf: string[]): Promise<string> {
      const name = `g1_${kind}_${world.stamp}`.replaceAll("-", "_");
      const password = randomBytes(12).toString("hex");
      await world.sql.query(`CREATE ROLE ${name} LOGIN ${attributes} PASSWORD '${password}'`);
      roles.push(name);
      passwords.set(name, password);
      for (const parent of memberOf) await world.sql.query(`GRANT ${parent} TO ${name}`);
      return name;
    }

    const urlFor = (user: string, password: string): string => {
      const url = new URL(world.databaseUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };

    /** Boots only the database service, exactly as the application module wires it. */
    async function boot(connection: string, nodeEnv: "production" | "test"): Promise<void> {
      const { PrismaService } = await import("../dist/database/prisma.service.js");
      const { InMemoryAuthPrincipalCache } = await import("../dist/common/cache/auth-principal-cache.js");
      const config = new ConfigService({ DATABASE_URL: connection, NODE_ENV: nodeEnv, DATABASE_RLS: "on", DATABASE_POOL_MAX: 2 });
      const service = new (PrismaService as unknown as new (c: ConfigService, p: unknown) => { onModuleInit(): Promise<void>; onApplicationShutdown(): Promise<void> })(
        config,
        new InMemoryAuthPrincipalCache(0, 10)
      );
      try {
        await service.onModuleInit();
      } finally {
        await service.onApplicationShutdown().catch(() => undefined);
      }
    }

    afterAll(async () => {
      for (const role of roles.reverse()) await world.sql.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    });

    it("refuses a superuser login in production", async () => {
      await expect(boot(world.databaseUrl, "production")).rejects.toThrow(/restricted runtime login/);
    });

    it("refuses a BYPASSRLS login in production", async () => {
      const name = await login("bypass", "NOSUPERUSER BYPASSRLS", ["safry_app"]);
      await expect(boot(urlFor(name, passwords.get(name)!), "production")).rejects.toThrow(/restricted runtime login/);
    });

    it("refuses a member of the table-owner role in production (it could RESET ROLE and bypass row-level security)", async () => {
      const owner = (await world.sql.query<{ tableowner: string }>(`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`)).rows[0]!.tableowner;
      const name = await login("owner", "NOSUPERUSER NOBYPASSRLS", ["safry_app", owner]);
      await expect(boot(urlFor(name, passwords.get(name)!), "production")).rejects.toThrow(/restricted runtime login/);
    });

    it("accepts a restricted login in production and lets the same privileged logins start outside production", async () => {
      const name = await login("runtime", "NOSUPERUSER NOBYPASSRLS NOCREATEROLE", ["safry_app"]);
      await expect(boot(urlFor(name, passwords.get(name)!), "production")).resolves.toBeUndefined();
      await expect(boot(world.databaseUrl, "test")).resolves.toBeUndefined();
    });

    it("the restricted login really is confined: it cannot read another tenant's rows or reset the role", async () => {
      const name = `g1_runtime_${world.stamp}`.replaceAll("-", "_");
      const client = new pg.Client({ connectionString: urlFor(name, passwords.get(name)!) });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role', 'safry_app', true), set_config('app.tenant_id', $1, true)", [a.id]);
        const visible = await client.query("SELECT DISTINCT \"tenantId\" FROM roles");
        expect(visible.rows.map((row: { tenantId: string }) => row.tenantId)).toEqual([a.id]);
        await client.query("ROLLBACK");
        await expect(client.query("SELECT 1 FROM roles")).resolves.toBeDefined();
        await expect(client.query("ALTER TABLE roles DISABLE ROW LEVEL SECURITY")).rejects.toThrow(/must be owner/);
      } finally {
        await client.end();
      }
    });
  });

  describe("(d) logout scope, current behaviour (documented)", () => {
    it("ends exactly the presented session: its access token and refresh token die at once, the same user's other devices live on", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const phone = await world.session(user);
      const laptop = await world.session(user);
      expect((await world.api("POST", "/auth/logout", { body: { refreshToken: phone.refreshToken } })).status).toBe(204);
      expect((await me(phone)).status).toBe(401);
      expect((await refresh(phone.refreshToken)).status).toBe(401);
      expect((await me(laptop)).status).toBe(200);
      expect((await refresh(laptop.refreshToken)).status).toBe(200);
    });

    it("a logout presented with a rotated (old) token ends the whole rotated chain, not other logins", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const other = await world.session(user);
      const first = await world.session(user);
      const second = (await refresh(first.refreshToken)).body as Session;
      expect((await world.api("POST", "/auth/logout", { body: { refreshToken: first.refreshToken } })).status).toBe(204);
      expect((await me(second)).status).toBe(401);
      expect((await me(other)).status).toBe(200);
    });

    it("an anonymous caller cannot end someone's session without the refresh token; a wrong or empty token changes nothing", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const session = await world.session(user);
      for (const body of [{ refreshToken: "" }, { refreshToken: "z".repeat(64) }, {}, { refreshToken: 5 }, { refreshToken: "x".repeat(5000) }]) {
        const reply = await world.api("POST", "/auth/logout", { body });
        expect([204, 400], JSON.stringify(body).slice(0, 40)).toContain(reply.status);
      }
      expect((await me(session)).status).toBe(200);
      expect((await world.api("POST", "/auth/logout-all", {})).status).toBe(401);
    });

    it("the access token is not enough to log out another user's refresh token (token is a bearer secret, never guessable)", async () => {
      const victim = await world.session(await world.createUser(a, { roles: ["traveler"] }));
      const attacker = await world.session(await world.createUser(b, { roles: ["traveler"] }));
      const forged = victim.refreshToken.slice(0, -4) + "AAAA";
      expect((await world.api("POST", "/auth/logout", { session: auth(attacker), body: { refreshToken: forged } })).status).toBe(204);
      expect((await me(victim)).status).toBe(200);
    });
  });

  describe("(e) refresh-token reuse detection and races", () => {
    it("replaying a rotated token after the family moved on kills the family and audits it once", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const first = await world.session(user);
      const second = (await refresh(first.refreshToken)).body as Session;
      const third = (await refresh(second.refreshToken)).body as Session;
      // Past the rotation grace window a replay is theft.
      await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '5 minutes' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
      expect((await refresh(first.refreshToken)).status).toBe(401);
      for (const dead of [second, third]) {
        expect((await refresh(dead.refreshToken)).status).toBe(401);
        expect((await me(dead)).status).toBe(401);
      }
      const events = await world.prisma.auditEvent.count({ where: { actorUserId: user.userId, action: "identity.session.reuse_detected" } });
      expect(events).toBeGreaterThanOrEqual(1);
    });

    it("two parallel refreshes with the same token never both succeed with usable descendants", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const session = await world.session(user);
      const replies = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken), refresh(session.refreshToken)]);
      const winners = replies.filter((reply) => reply.status === 200);
      expect(winners.length).toBeLessThanOrEqual(1);
      for (const reply of replies) expect([200, 401]).toContain(reply.status);
      // Whatever happened, once the loser's replay was seen no descendant stays alive.
      if (winners.length === 1) {
        await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '5 minutes' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
        await refresh(session.refreshToken);
        expect((await refresh((winners[0]!.body as Session).refreshToken)).status).toBe(401);
      }
    });

    it("a token that was logged out cannot come back through refresh, and a malformed token is 401/400, never 500", async () => {
      const user = await world.createUser(a, { roles: ["traveler"] });
      const session = await world.session(user);
      await world.api("POST", "/auth/logout", { body: { refreshToken: session.refreshToken } });
      expect((await refresh(session.refreshToken)).status).toBe(401);
      for (const token of ["", "short", "x".repeat(10_000), "' OR 1=1 --", "a.b.c"]) {
        const reply = await refresh(token);
        expect([400, 401], token.slice(0, 20)).toContain(reply.status);
      }
    });

    it("a refresh token cannot be used as an access token and an access token cannot be used to refresh", async () => {
      const session = await world.session(await world.createUser(a, { roles: ["traveler"] }));
      expect((await world.api("GET", "/auth/me", { session: { accessToken: session.refreshToken, tenantId: a.id } })).status).toBe(401);
      expect((await refresh(session.accessToken)).status).toBe(401);
    });
  });

  describe("(f) cursor pagination: tenant confinement and tampered cursors", () => {
    let adminA: Session;
    let adminB: Session;
    let providerA: TestUser;
    let sessionA: Session;
    const forge = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
    const list = (session: Session, path: string, query: string) => world.api("GET", `${path}${query}`, { session: auth(session) });

    beforeAll(async () => {
      adminA = await world.session(await world.createUser(a, { roles: ["tenant-admin"] }));
      adminB = await world.session(await world.createUser(b, { roles: ["tenant-admin"] }));
      const org = await world.createOrganization(a);
      providerA = await world.createUser(a, { roles: ["travel-company"], organizationId: org });
      sessionA = await world.session(providerA);
      for (let i = 0; i < 5; i += 1) await world.createService(a, providerA);
      for (let i = 0; i < 3; i += 1) await world.createOrganization(a);
      await world.createService(b, await world.createUser(b, { roles: ["travel-company"], organizationId: await world.createOrganization(b) }));
    });

    async function nextCursor(session: Session, path: string): Promise<string> {
      const response = await fetch(`${world.baseUrl}${path}?limit=2`, { headers: { authorization: `Bearer ${session.accessToken}`, "x-tenant-id": session.user.tenantId } });
      expect(response.status).toBe(200);
      const cursor = response.headers.get("x-next-cursor");
      expect(cursor, `${path} needs a second page`).toBeTruthy();
      return cursor!;
    }

    it("a cursor minted for tenant A, replayed by tenant B, never reveals a row of A", async () => {
      const cursor = await nextCursor(adminA, "/services");
      const aIds = new Set(((await list(adminA, "/services", "")).body as unknown as Array<{ id: string }>).map((row) => row.id));
      const replay = await list(adminB, "/services", `?cursor=${cursor}`);
      expect(replay.status).toBe(200);
      for (const row of replay.body as unknown as Array<{ id: string }>) expect(aIds.has(row.id)).toBe(false);
      const marketplace = await list(adminB, "/services/marketplace", `?cursor=${await nextCursor(adminA, "/services/marketplace")}`);
      expect(marketplace.status).toBe(200);
      for (const row of marketplace.body as unknown as Array<{ id: string }>) expect(aIds.has(row.id)).toBe(false);
    });

    it("rejects a tampered keyset cursor with 400 on every cursor-paged route", async () => {
      const sample = forge({ t: new Date().toISOString(), id: randomUUID() });
      const tampered = [
        "not-base64-json",
        forge("plain text"),
        forge("{"),
        forge({}),
        forge({ t: "yesterday", id: randomUUID() }),
        forge({ t: new Date().toISOString(), id: "00000000-0000-0000-0000-00000000000g" }),
        forge({ t: new Date().toISOString(), id: "1; DROP TABLE services;--" }),
        forge({ t: new Date().toISOString(), id: 7 }),
        forge([1, 2]),
        sample.slice(0, 10),
        "A".repeat(201)
      ];
      for (const path of ["/services", "/services/marketplace", "/bookings"]) {
        for (const cursor of tampered) {
          const reply = await list(sessionA, path, `?cursor=${encodeURIComponent(cursor)}`);
          expect(reply.status, `${path} cursor=${cursor.slice(0, 30)}`).toBe(400);
        }
      }
    });

    it("a parseable but out-of-range date, or a NUL byte in a provider cursor, is 400 and never 500", async () => {
      const id = randomUUID();
      for (const t of ["+275760-09-13T00:00:00.000Z", "-271821-04-20T00:00:00.000Z", "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2026-13-45", "2026-10-10", " 2026-10-10T00:00:00.000Z"]) {
        const reply = await list(sessionA, "/services", `?cursor=${encodeURIComponent(forge({ t, id }))}`);
        expect(reply.status, t).toBe(400);
      }
      expect((await list(sessionA, "/services", `?cursor=${encodeURIComponent(forge({ t: "2026-10-10T00:00:00.000Z", id }))}`)).status).toBe(200);
      for (const name of ["a b", "x".repeat(201)]) {
        const reply = await list(adminA, "/providers", `?cursor=${encodeURIComponent(forge({ name, id }))}`);
        expect(reply.status, name.slice(0, 5)).toBe(400);
      }
      expect((await list(adminA, "/providers", `?cursor=${encodeURIComponent(forge({ name: "Alpha", id }))}`)).status).toBe(200);
    });

    it("a well-formed cursor with an unknown id simply yields the page after that point, scoped to the caller's tenant", async () => {
      const reply = await list(adminA, "/services", `?cursor=${forge({ t: new Date(Date.now() + 86_400_000).toISOString(), id: randomUUID() })}`);
      expect(reply.status).toBe(200);
      expect((reply.body as unknown as Array<{ id: string }>).length).toBeGreaterThan(0);
    });

    it("providers (name,id keyset) accept only its own cursor shape: tampering is 400, never 500, and tenant B sees nothing of A", async () => {
      const cursor = await nextCursor(adminA, "/providers");
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { name: string; id: string };
      expect(Object.keys(decoded).sort()).toEqual(["id", "name"]);
      const aNames = new Set(((await list(adminA, "/providers", "")).body as unknown as Array<{ id: string }>).map((row) => row.id));
      const replay = await list(adminB, "/providers", `?cursor=${cursor}`);
      expect(replay.status).toBe(200);
      for (const row of replay.body as unknown as Array<{ id: string }>) expect(aNames.has(row.id)).toBe(false);
      for (const bad of ["garbage", forge("x"), forge({}), forge({ name: 1, id: randomUUID() }), forge({ name: "a", id: 2 })]) {
        const reply = await list(adminA, "/providers", `?cursor=${encodeURIComponent(bad)}`);
        expect(reply.status, bad.slice(0, 30)).toBe(400);
      }
    });

    it("a non-uuid id inside a providers cursor is a client error (400), not a database error (500)", async () => {
      const reply = await list(adminA, "/providers", `?cursor=${forge({ name: "a", id: "not-a-uuid" })}`);
      expect(reply.status).toBe(400);
    });

    it("walking every page returns each row exactly once and only the caller's tenant", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response: Response = await fetch(`${world.baseUrl}/services?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
          headers: { authorization: `Bearer ${adminA.accessToken}`, "x-tenant-id": a.id }
        });
        expect(response.status).toBe(200);
        seen.push(...((await response.json()) as Array<{ id: string }>).map((row) => row.id));
        cursor = response.headers.get("x-next-cursor");
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      const owned = await world.prisma.travelService.findMany({ where: { tenantId: a.id }, select: { id: true } });
      expect([...seen].sort()).toEqual(owned.map((row) => row.id).sort());
    });
  });

  describe("(g) consent state machine: an invitation becomes ACTIVE only by its owner's acceptance", () => {
    let managerSession: Session;
    let orgId: string;
    let departmentId: string;

    async function invite(): Promise<{ owner: TestUser; ownerSession: Session; id: string }> {
      const owner = await world.createUser(b, { roles: ["traveler"] });
      const reply = await world.api("POST", `/organizations/${orgId}/employees`, {
        session: auth(managerSession),
        body: { email: owner.email, displayName: "Invited", password: `Invite-Typed-${world.stamp}-Pw`, jobTitle: "Agent", departmentId, roleIds: [a.roleIds["travel-company"]] }
      });
      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
      return { owner, ownerSession: await world.session(owner), id: reply.body.id as string };
    }
    const row = (id: string) => world.prisma.tenantMembership.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      orgId = await world.createOrganization(a);
      const manager = await world.createUser(a, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
      managerSession = await world.session(manager);
      const department = await world.api("POST", `/organizations/${orgId}/departments`, { session: auth(managerSession), body: { code: "sales", name: "Sales" } });
      departmentId = department.body.id as string;
    });

    it("an invitation is not a membership: no sign-in to the inviting tenant, not listed as a member, owner sees it as pending", async () => {
      const { owner, ownerSession, id } = await invite();
      expect(await row(id)).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
      expect((await world.login({ ...owner, tenant: a })).status).toBe(401);
      const pending = await world.api("GET", "/users/me/invitations", { session: auth(ownerSession) });
      expect((pending.body as unknown as Array<{ membershipId?: string; id?: string }>).some((item) => (item.membershipId ?? item.id) === id)).toBe(true);
    });

    it("no administrative path activates it: role changes, employee edits and status changes leave it INVITED", async () => {
      const { id } = await invite();
      const adminA = await world.session(await world.createUser(a, { roles: ["tenant-admin"] }));
      const attempts = await Promise.all([
        world.api("PATCH", `/tenants/members/${id}/status`, { session: auth(adminA), body: { status: "ACTIVE" } }),
        world.api("PATCH", `/organizations/${orgId}/employees/${id}`, { session: auth(managerSession), body: { status: "ACTIVE" } }),
        world.api("PUT", `/memberships/${id}/roles`, { session: auth(adminA), body: { roleIds: [a.roleIds["travel-company"]] } })
      ]);
      expect(attempts[0].status).toBe(409);
      expect(attempts[1].status).toBe(409);
      expect(await row(id)).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
    });

    it("only the invited identity can accept: a third party and a member of the inviting tenant get 404 and change nothing", async () => {
      const { id } = await invite();
      const stranger = await world.session(await world.createUser(b, { roles: ["traveler"] }));
      expect((await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(stranger) })).status).toBe(404);
      const adminA = await world.session(await world.createUser(a, { roles: ["tenant-admin"] }));
      expect((await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(adminA) })).status).toBe(404);
      expect((await world.api("POST", `/users/me/invitations/${id}/decline`, { session: auth(stranger) })).status).toBe(404);
      expect(await row(id)).toMatchObject({ status: "INVITED", awaitingOwnerConsent: true });
    });

    it("the owner accepts: ACTIVE, consent cleared, sign-in to the tenant works; a second accept or a late decline is refused", async () => {
      const { owner, ownerSession, id } = await invite();
      expect((await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(ownerSession) })).status).toBe(200);
      expect(await row(id)).toMatchObject({ status: "ACTIVE", awaitingOwnerConsent: false });
      expect((await world.login({ ...owner, tenant: a })).status).toBe(200);
      const again = await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(ownerSession) });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.status).toBeLessThan(500);
      const late = await world.api("POST", `/users/me/invitations/${id}/decline`, { session: auth(ownerSession) });
      expect(late.status).toBeGreaterThanOrEqual(400);
      expect(late.status).toBeLessThan(500);
      expect(await row(id)).toMatchObject({ status: "ACTIVE", awaitingOwnerConsent: false });
    });

    it("accepting a revoked invitation is impossible (404) and the membership stays revoked", async () => {
      const { ownerSession, id } = await invite();
      const adminA = await world.session(await world.createUser(a, { roles: ["tenant-admin"] }));
      expect((await world.api("PATCH", `/tenants/members/${id}/status`, { session: auth(adminA), body: { status: "REVOKED" } })).status).toBe(200);
      expect((await world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(ownerSession) })).status).toBe(404);
      expect((await row(id)).status).toBe("REVOKED");
    });

    it("racing accept and decline never leaves an ACTIVE membership that still awaits consent (documented: both calls may answer 200, the later write wins)", async () => {
      const { ownerSession, id } = await invite();
      await Promise.all([
        world.api("POST", `/users/me/invitations/${id}/accept`, { session: auth(ownerSession) }),
        world.api("POST", `/users/me/invitations/${id}/decline`, { session: auth(ownerSession) })
      ]);
      const final = await row(id);
      expect(["ACTIVE", "REVOKED"]).toContain(final.status);
      if (final.status === "ACTIVE") expect(final.awaitingOwnerConsent).toBe(false);
    });
  });
});
