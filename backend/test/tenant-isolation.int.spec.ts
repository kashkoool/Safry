import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../dist/database/prisma.service.js";
import { requestContext } from "../dist/common/context/request-context.js";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Tenant Data Isolation, verified on a real PostgreSQL:
 *  - layer 1: application-level tenant confinement,
 *  - layer 2: row-level security policies (migration 0010),
 *  - same e-mail in several tenants (Linked Account Management).
 */
describe("tenant isolation", () => {
  let world: World;
  let a: TestTenant;
  let b: TestTenant;
  let adminA: TestUser;
  let travelerA: TestUser;
  let adminB: TestUser;
  let travelerB: TestUser;
  let providerB: TestUser;
  let platformAdmin: TestUser;
  let serviceB: string;
  let bookingB: string;
  let sessionAdminA: Session;
  let sessionTravelerA: Session;
  let sessionTravelerB: Session;

  const auth = (session: Session): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });

  beforeAll(async () => {
    world = await World.start();
    a = await world.createTenant("iso-a");
    b = await world.createTenant("iso-b");
    adminA = await world.createUser(a, { roles: ["tenant-admin"] });
    travelerA = await world.createUser(a, { roles: ["traveler"] });
    adminB = await world.createUser(b, { roles: ["tenant-admin"] });
    travelerB = await world.createUser(b, { roles: ["traveler"] });
    const orgB = await world.createOrganization(b);
    providerB = await world.createUser(b, { roles: ["travel-company", "organization-manager"], organizationId: orgB });
    platformAdmin = await world.createUser(a, { roles: ["tenant-admin"], isPlatformAdmin: true });
    serviceB = await world.createService(b, providerB);
    sessionAdminA = await world.session(adminA);
    sessionTravelerA = await world.session(travelerA);
    sessionTravelerB = await world.session(travelerB);
    const booking = await world.api("POST", "/bookings", {
      session: auth(sessionTravelerB),
      body: { serviceId: serviceB, travelersCount: 1, serviceDate: world.futureDate() }
    });
    expect(booking.status).toBe(201);
    bookingB = booking.body.id as string;
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("row-level security (database layer)", () => {
    const tables = [
      "tenant_memberships", "provider_organizations", "organization_departments", "travel_services",
      "service_components", "bookings", "roles", "membership_roles", "refresh_sessions", "audit_events"
    ];

    it("enables and forces RLS on every table that has a tenant key", async () => {
      const keyed = await world.sql.query<{ table_name: string }>(
        // Partitions of audit_events carry the column too but are closed to the application role; only the parent is policed.
        `SELECT c.table_name FROM information_schema.columns c
         JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
         WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' AND NOT k.relispartition ORDER BY 1`
      );
      const expected = [...keyed.rows.map((row) => row.table_name), "tenants"].sort();
      const protectedTables = await world.sql.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname = ANY($1)`,
        [expected]
      );
      expect(protectedTables.rows.map((row) => row.relname).sort()).toEqual(expected);
      for (const row of protectedTables.rows) {
        expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} must force RLS`).toBe(true);
      }
      expect(expected).toEqual(expect.arrayContaining([...tables, "tenants"]));
    });

    it("fails closed: a session without a tenant sees no tenant data", async () => {
      for (const table of [...tables, "tenants"]) {
        const result = await world.asRole({}, `SELECT count(*)::int AS n FROM "${table}"`);
        expect(result.rows[0]?.n, table).toBe(0);
      }
    });

    it("confines a tenant session to its own rows", async () => {
      const own = await world.asRole<{ tenantId: string }>({ tenantId: a.id }, `SELECT DISTINCT "tenantId" FROM tenant_memberships`);
      expect(own.rows.map((row) => row.tenantId)).toEqual([a.id]);
      const foreign = await world.asRole({ tenantId: a.id }, `SELECT count(*)::int AS n FROM bookings WHERE "tenantId" = $1`, [b.id]);
      expect(foreign.rows[0]?.n).toBe(0);
      const tenants = await world.asRole<{ id: string }>({ tenantId: a.id }, `SELECT id FROM tenants`);
      expect(tenants.rows.map((row) => row.id)).toEqual([a.id]);
    });

    it("rejects writes aimed at another tenant", async () => {
      await expect(
        world.asRole({ tenantId: a.id }, `INSERT INTO roles (id, "tenantId", code, name, "updatedAt") VALUES (gen_random_uuid(), $1, 'smuggled', 'x', now())`, [b.id])
      ).rejects.toThrow(/row-level security/);
      const update = await world.asRole({ tenantId: a.id }, `UPDATE bookings SET notes = 'tampered' WHERE id = $1`, [bookingB]);
      expect(update.rowCount).toBe(0);
      const remove = await world.asRole({ tenantId: a.id }, `DELETE FROM travel_services WHERE id = $1`, [serviceB]);
      expect(remove.rowCount).toBe(0);
    });

    it("grants cross-tenant visibility only to an explicit system scope", async () => {
      const all = await world.asRole<{ n: number }>({ bypass: true }, `SELECT count(DISTINCT "tenantId")::int AS n FROM tenant_memberships`);
      expect(all.rows[0]?.n).toBeGreaterThanOrEqual(2);
    });

    it("keeps the migrations table out of reach of the application role", async () => {
      await expect(world.asRole({ bypass: true }, `SELECT 1 FROM _prisma_migrations`)).rejects.toThrow(/permission denied/);
    });
  });

  describe("PrismaService scope plumbing", () => {
    type Scope = { kind: "tenant"; tenantId: string } | { kind: "system" } | undefined;

    async function inScope<T>(scope: Scope, work: (prisma: InstanceType<typeof PrismaService>) => Promise<T>): Promise<T> {
      const prisma = world.app.get(PrismaService);
      // Prisma promises are lazy: await inside the context so the query runs with this scope.
      return requestContext.run({ requestId: "scope-test", ...(scope ? { scope } : {}) }, async () => await work(prisma));
    }

    it("runs the application's transactions as the restricted role bound to the request tenant", async () => {
      const probe = await inScope({ kind: "tenant", tenantId: b.id }, (prisma) =>
        // Raw SQL bypasses the application-level confinement, so only RLS can limit these rows.
        prisma.$transaction(async (tx) => {
          const who = await tx.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`;
          const rows = await tx.$queryRaw<Array<{ tenantId: string }>>`SELECT DISTINCT "tenantId" FROM bookings`;
          return { role: who[0]?.role, tenants: rows.map((row) => row.tenantId) };
        })
      );
      expect(probe.role).toBe("safry_app");
      expect(probe.tenants).toEqual([b.id]);
    });

    it("shows nothing to a tenant that owns no rows, even through raw SQL", async () => {
      const count = await inScope({ kind: "tenant", tenantId: a.id }, (prisma) =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bookings`;
          return rows[0]?.n;
        })
      );
      expect(count).toBe(0);
    });

    it("refuses database access without a scope", async () => {
      await expect(inScope(undefined, (prisma) => prisma.booking.findMany())).rejects.toThrow(/without a tenant scope/);
      await expect(inScope(undefined, (prisma) => prisma.$transaction(async (tx) => tx.booking.findMany()))).rejects.toThrow(
        /without a tenant scope/
      );
    });

    it("applies the application-level confinement before the query reaches the database", async () => {
      await expect(
        inScope({ kind: "tenant", tenantId: a.id }, (prisma) => prisma.booking.findFirst({ where: { tenantId: b.id } }))
      ).rejects.toThrow(/Tenant isolation violation/);
      const own = await inScope({ kind: "tenant", tenantId: b.id }, (prisma) => prisma.booking.findMany());
      expect(own.map((booking) => booking.id)).toContain(bookingB);
    });

    it("lets an explicit system scope read across tenants", async () => {
      const tenants = await inScope({ kind: "system" }, (prisma) => prisma.tenant.findMany({ where: { id: { in: [a.id, b.id] } } }));
      expect(tenants).toHaveLength(2);
    });
  });

  describe("application layer", () => {
    it("rejects unauthenticated requests", async () => {
      expect((await world.api("GET", "/bookings")).status).toBe(401);
      expect((await world.api("GET", "/tenants/current")).status).toBe(401);
    });

    it("returns only the caller's tenant", async () => {
      const tenant = await world.api("GET", "/tenants/current", { session: auth(sessionAdminA) });
      expect(tenant.body.id).toBe(a.id);
      const members = await world.api("GET", "/tenants/members", { session: auth(sessionAdminA) });
      const ids = (members.body as Array<{ id: string }>).map((member) => member.id);
      expect(ids).toContain(travelerA.membershipId);
      expect(ids).not.toContain(travelerB.membershipId);
    });

    it("hides another tenant's bookings and services (404, never 403/200)", async () => {
      const list = await world.api("GET", "/bookings", { session: auth(sessionAdminA) });
      expect((list.body as Array<{ id: string }>).some((booking) => booking.id === bookingB)).toBe(false);
      const confirm = await world.api("PATCH", `/bookings/${bookingB}/status`, {
        session: auth(sessionAdminA),
        body: { status: "CONFIRMED" }
      });
      expect(confirm.status).toBe(404);
      const edit = await world.api("PATCH", `/services/${serviceB}`, { session: auth(sessionAdminA), body: { title: "hijacked" } });
      expect(edit.status).toBe(404);
      const services = await world.api("GET", "/services", { session: auth(sessionAdminA) });
      expect((services.body as Array<{ id: string }>).some((service) => service.id === serviceB)).toBe(false);
    });

    it("refuses to book a service of another tenant", async () => {
      const reply = await world.api("POST", "/bookings", {
        session: auth(sessionTravelerA),
        body: { serviceId: serviceB, travelersCount: 1, serviceDate: world.futureDate() }
      });
      expect(reply.status).toBe(404);
    });

    it("refuses role assignment, status changes and history across tenants", async () => {
      const assign = await world.api("PUT", `/memberships/${travelerB.membershipId}/roles`, {
        session: auth(sessionAdminA),
        body: { roleIds: [a.roleIds["tenant-admin"]] }
      });
      expect(assign.status).toBe(404);
      const status = await world.api("PATCH", `/tenants/members/${travelerB.membershipId}/status`, {
        session: auth(sessionAdminA),
        body: { status: "SUSPENDED" }
      });
      expect(status.status).toBe(404);
      const history = await world.api("GET", `/tenants/members/${travelerB.membershipId}/history`, { session: auth(sessionAdminA) });
      expect(history.status).toBe(404);
      const foreignRole = await world.api("PATCH", `/roles/${b.roleIds["tenant-admin"]}`, {
        session: auth(sessionAdminA),
        body: { name: "renamed" }
      });
      expect([403, 404]).toContain(foreignRole.status);
    });

    it("ignores a forged x-tenant-id header", async () => {
      const forged = await world.api("GET", "/bookings", { session: { accessToken: sessionAdminA.accessToken, tenantId: b.id } });
      expect(forged.status).toBe(401);
      const malformed = await world.api("GET", "/bookings", { session: { accessToken: sessionAdminA.accessToken, tenantId: "not-a-uuid" } });
      expect(malformed.status).toBe(400);
    });

    it("keeps platform routes behind the platform administrator guard", async () => {
      expect((await world.api("GET", "/platform/overview", { session: auth(sessionAdminA) })).status).toBe(403);
      expect((await world.api("GET", "/platform/tenants", { session: auth(sessionAdminA) })).status).toBe(403);
      const admin = await world.session(platformAdmin);
      const overview = await world.api("GET", "/platform/overview", { session: auth(admin) });
      expect(overview.status).toBe(200);
      const tenants = await world.api("GET", "/platform/tenants", { session: auth(admin) });
      const codes = (tenants.body as Array<{ code: string }>).map((tenant) => tenant.code);
      expect(codes).toEqual(expect.arrayContaining([a.code, b.code]));
    });
  });

  describe("one e-mail in several tenants", () => {
    it("links the existing identity after proof of ownership and keeps tenants apart", async () => {
      const email = `${world.unique("shared")}@example.test`;
      const password = "Shared-Identity-Pass-77";
      const first = await world.api("POST", "/auth/register/customer", {
        body: { displayName: "Shared Person", email, password, tenantCode: a.code }
      });
      expect(first.status).toBe(201);
      const second = await world.api("POST", "/auth/register/customer", {
        body: { displayName: "Shared Person", email, password, tenantCode: b.code }
      });
      expect(second.status).toBe(201);
      const users = await world.prisma.user.count({ where: { emailNormalized: email } });
      expect(users).toBe(1);
      const memberships = await world.prisma.tenantMembership.count({ where: { user: { emailNormalized: email } } });
      expect(memberships).toBe(2);

      // Self-registered accounts sign in only after the address is confirmed (the mail flow is covered in credentials.int.spec.ts).
      expect((await world.login({ email, password, tenant: a } as TestUser)).status).toBe(401);
      await world.markEmailVerified(email);
      const inA = await world.login({ email, password, tenant: a } as TestUser);
      const inB = await world.login({ email, password, tenant: b } as TestUser);
      expect(inA.status).toBe(200);
      expect(inB.status).toBe(200);
      expect(inA.body.user.tenantId).toBe(a.id);
      expect(inB.body.user.tenantId).toBe(b.id);
      expect(inA.body.user.membershipId).not.toBe(inB.body.user.membershipId);
      const bookingsInA = await world.api("GET", "/bookings", { session: { accessToken: inA.body.accessToken, tenantId: a.id } });
      expect((bookingsInA.body as unknown[]).length).toBe(0);
    });

    it("refuses to link an existing identity without the right password", async () => {
      const reply = await world.api("POST", "/auth/register/customer", {
        body: { displayName: "Intruder", email: travelerA.email, password: "Wrong-Password-12345", tenantCode: b.code }
      });
      expect(reply.status).toBe(401);
      expect(await world.prisma.tenantMembership.count({ where: { tenantId: b.id, userId: travelerA.userId } })).toBe(0);
    });

    it("does not register the same e-mail twice in one tenant", async () => {
      const reply = await world.api("POST", "/auth/register/customer", {
        body: { displayName: "Again", email: travelerA.email, password: travelerA.password, tenantCode: a.code }
      });
      expect(reply.status).toBe(409);
    });

    it("invites, never links, an existing identity when a manager adds staff with that e-mail", async () => {
      const orgA = await world.createOrganization(a);
      const manager = await world.createUser(a, { roles: ["travel-company", "organization-manager"], organizationId: orgA });
      const managerSession = await world.session(manager);
      const department = await world.api("POST", `/organizations/${orgA}/departments`, {
        session: auth(managerSession),
        body: { code: "ops", name: "Operations" }
      });
      expect(department.status).toBe(201);
      const before = await world.prisma.user.count();
      const employee = await world.api("POST", `/organizations/${orgA}/employees`, {
        session: auth(managerSession),
        body: {
          email: travelerB.email,
          displayName: "Cross tenant staff",
          password: "Irrelevant-Password-123",
          jobTitle: "Agent",
          departmentId: department.body.id,
          roleIds: [a.roleIds["travel-company"]]
        }
      });
      expect(employee.status).toBe(201);
      expect(employee.body.status).toBe("INVITED");
      expect(await world.prisma.user.count()).toBe(before);
      // nothing is linked until the identity's owner accepts (test/authorization.int.spec.ts),
      // and the password given by the manager is never applied to the existing identity.
      expect((await world.login({ ...travelerB, tenant: a })).status).toBe(401);
      expect((await world.login({ ...travelerB, tenant: a }, {}, "Irrelevant-Password-123")).status).toBe(401);
    });
  });
});
