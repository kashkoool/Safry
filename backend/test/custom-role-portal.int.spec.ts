import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant } from "./support/world.js";

/** A member whose only roles are tenant-defined signs in through the customer (workspace) portal, nowhere else. */
describe("portal sign-in for custom roles", () => {
  let world: World;
  let tenant: TestTenant;

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("crp");
  });
  afterAll(async () => {
    await world.stop();
  });

  it("lets a custom-role-only member into the customer portal with exactly the granted permissions", async () => {
    const user = await world.createUser(tenant, { roles: [] });
    await world.grantCustomRole(tenant, user.membershipId, ["tenant.read", "catalog.service.read"]);
    const signedIn = await world.login(user, { portal: "customer" });
    expect(signedIn.status).toBe(200);
    const session = signedIn.body as Session;
    const me = await world.api("GET", "/auth/me", { session: { accessToken: session.accessToken, tenantId: tenant.id } });
    expect(me.status).toBe(200);
    expect((me.body.permissions as string[]).sort()).toEqual(["catalog.service.read", "tenant.read"]);
    expect((await world.api("GET", "/bookings", { session: { accessToken: session.accessToken, tenantId: tenant.id } })).status).toBe(403);
    expect((await world.login(user)).status).toBe(200);
  });

  it("keeps a custom-role-only member out of the provider and platform admin portals", async () => {
    const user = await world.createUser(tenant, { roles: [] });
    await world.grantCustomRole(tenant, user.membershipId, ["tenant.read", "booking.read", "booking.manage"]);
    expect((await world.login(user, { portal: "provider" })).status).toBe(401);
    expect((await world.login(user, { portal: "admin" })).status).toBe(401);
  });

  it("does not change the system roles or accounts without any role", async () => {
    const orgId = await world.createOrganization(tenant);
    const traveler = await world.createUser(tenant, { roles: ["traveler"] });
    const provider = await world.createUser(tenant, { roles: ["travel-company"], organizationId: orgId });
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"] });
    const bare = await world.createUser(tenant, { roles: [] });
    const orgCustom = await world.createUser(tenant, { roles: [], organizationId: orgId });
    await world.grantCustomRole(tenant, orgCustom.membershipId, ["booking.read"]);
    const mixed = await world.createUser(tenant, { roles: ["service-provider"] });
    await world.grantCustomRole(tenant, mixed.membershipId, ["booking.read"]);
    expect((await world.login(traveler, { portal: "customer" })).status).toBe(200);
    expect((await world.login(traveler, { portal: "provider" })).status).toBe(401);
    expect((await world.login(provider, { portal: "provider" })).status).toBe(200);
    expect((await world.login(provider, { portal: "customer" })).status).toBe(401);
    expect((await world.login(admin, { portal: "provider" })).status).toBe(200);
    expect((await world.login(admin, { portal: "customer" })).status).toBe(401);
    expect((await world.login(bare, { portal: "customer" })).status).toBe(401);
    expect((await world.login(orgCustom, { portal: "customer" })).status).toBe(401);
    expect((await world.login(orgCustom, { portal: "provider" })).status).toBe(200);
    // A system role without an organization plus a custom role is not "custom only".
    expect((await world.login(mixed, { portal: "customer" })).status).toBe(401);
  });
});
