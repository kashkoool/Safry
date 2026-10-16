import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Reply, type Session, type TestTenant } from "./support/world.js";

/**
 * Role changes read what they depend on inside the transaction that writes. The "other actor" is simulated with a row lock
 * held by a second connection, released only after the request is already waiting, so the interleaving is deterministic.
 */
describe("role administration under concurrent changes", () => {
  let world: World;
  let tenant: TestTenant;
  let admin: Session;
  const auth = (s: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("role-race");
    admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
  });
  afterAll(async () => world.stop());

  async function createRole(code: string, permissions: string[]): Promise<string> {
    const reply = await world.api("POST", "/roles", { session: auth(admin), body: { code, name: code, permissions } });
    expect(reply.status).toBe(201);
    return reply.body.id as string;
  }

  /** Holds a lock in a second transaction, starts the request, lets it reach the lock, applies the other actor's change and commits. */
  async function interleave(hold: (db: pg.Client) => Promise<void>, change: (db: pg.Client) => Promise<void>, request: () => Promise<Reply>): Promise<Reply> {
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      await db.query("BEGIN");
      await hold(db);
      const pending = request();
      await pause(800);
      await change(db);
      await db.query("COMMIT");
      return await pending;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await db.end();
    }
  }

  it("deleteRole refuses when a member is assigned the role after the first check, instead of silently stripping them", async () => {
    const roleId = await createRole("race-delete", ["booking.read"]);
    const member = await world.createUser(tenant, { roles: [] });
    const reply = await interleave(
      (db) => db.query("SELECT 1 FROM roles WHERE id = $1 FOR SHARE", [roleId]).then(() => undefined),
      (db) => db.query(`INSERT INTO membership_roles ("membershipId", "roleId", "tenantId") VALUES ($1, $2, $3)`, [member.membershipId, roleId, tenant.id]).then(() => undefined),
      () => world.api("DELETE", `/roles/${roleId}`, { session: auth(admin) })
    );
    expect(reply.status).toBe(409);
    expect(await world.prisma.membershipRole.count({ where: { roleId, membershipId: member.membershipId } })).toBe(1);
    expect(await world.prisma.role.count({ where: { id: roleId } })).toBe(1);
  });

  it("assignRoles judges the role as it is when it commits: a role widened meanwhile is refused for a manager who does not hold the new permission", async () => {
    const managerRole = await createRole("race-manager", ["identity.role.manage", "booking.read"]);
    const manager = await world.createUser(tenant, { roles: [] });
    expect((await world.api("PUT", `/memberships/${manager.membershipId}/roles`, { session: auth(admin), body: { roleIds: [managerRole] } })).status).toBe(200);
    const managerSession = await world.session(manager);
    const roleId = await createRole("race-assign", ["booking.read"]);
    const target = await world.createUser(tenant, { roles: [] });
    const widen = (await world.prisma.permission.findUniqueOrThrow({ where: { code: "catalog.service.read" } })).id;

    const reply = await interleave(
      (db) => db.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]).then(() => undefined),
      (db) => db.query(`INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1, $2)`, [roleId, widen]).then(() => undefined),
      () => world.api("PUT", `/memberships/${target.membershipId}/roles`, { session: auth(managerSession), body: { roleIds: [roleId] } })
    );
    expect(reply.status).toBe(403);
    expect(await world.prisma.membershipRole.count({ where: { membershipId: target.membershipId } })).toBe(0);
  });
});
