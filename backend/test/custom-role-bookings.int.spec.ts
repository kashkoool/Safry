import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Booking access follows permissions, so tenant-defined roles work, with least privilege. */
describe("bookings for custom roles", () => {
  let world: World;
  let tenant: TestTenant;
  let provider: TestUser;
  let orgId: string;
  let rival: TestUser;
  let traveler: Session;
  let travelerUser: TestUser;
  let admin: Session;
  let providerSession: Session;
  let rivalSession: Session;
  let ownServiceId: string;
  let rivalServiceId: string;
  let travelerBooking: string;
  let rivalBooking: string;

  const auth = (s: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const list = async (s: Session): Promise<{ status: number; ids: string[] }> => {
    const r = await world.api("GET", "/bookings", { session: auth(s) });
    return { status: r.status, ids: Array.isArray(r.body) ? (r.body as Json[]).map((b) => b.id as string) : [] };
  };
  const book = (s: Session, serviceId: string): Promise<{ status: number; body: Json }> =>
    world.api("POST", "/bookings", { session: auth(s), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate() } });
  const status = (s: Session, id: string, next: string): Promise<{ status: number; body: Json }> =>
    world.api("PATCH", `/bookings/${id}/status`, { session: auth(s), body: { status: next } });
  const custom = async (codes: string[], organizationId?: string): Promise<{ user: TestUser; session: Session }> => {
    const user = await world.createUser(tenant, { roles: [], organizationId });
    await world.grantCustomRole(tenant, user.membershipId, codes);
    return { user, session: await world.session(user) };
  };

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("crb");
    orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company"], organizationId: orgId });
    rival = await world.createUser(tenant, { roles: ["travel-company"], organizationId: await world.createOrganization(tenant) });
    travelerUser = await world.createUser(tenant, { roles: ["traveler"] });
    admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
    providerSession = await world.session(provider);
    rivalSession = await world.session(rival);
    traveler = await world.session(travelerUser);
    ownServiceId = await world.createService(tenant, provider);
    rivalServiceId = await world.createService(tenant, rival);
    travelerBooking = (await book(traveler, ownServiceId)).body.id as string;
    rivalBooking = (await book(traveler, rivalServiceId)).body.id as string;
  });

  afterAll(async () => {
    await world.stop();
  });

  it("refuses a custom role without booking.read", async () => {
    const { session } = await custom(["tenant.read", "catalog.service.read"]);
    expect((await list(session)).status).toBe(403);
    expect((await status(session, travelerBooking, "CANCELLED")).status).toBe(403);
  });

  it("booking.read alone lists only the member's own bookings, never other people's", async () => {
    const { session } = await custom(["booking.read"]);
    expect(await list(session)).toEqual({ status: 200, ids: [] });
    expect((await book(session, ownServiceId)).status).toBe(403);
    expect((await status(session, travelerBooking, "CANCELLED")).status).toBe(403);
  });

  it("booking.read + booking.create books, sees, amends and cancels only its own, and cannot confirm", async () => {
    const { session } = await custom(["booking.read", "booking.create"]);
    const created = await book(session, ownServiceId);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(await list(session)).toEqual({ status: 200, ids: [id] });
    const amended = await world.api("PATCH", `/bookings/${id}`, { session: auth(session), body: { travelersCount: 2 } });
    expect(amended.status).toBe(200);
    expect((await world.api("PATCH", `/bookings/${travelerBooking}`, { session: auth(session), body: { travelersCount: 2 } })).status).toBe(404);
    expect((await status(session, id, "CONFIRMED")).status).toBe(403);
    expect((await status(session, travelerBooking, "CANCELLED")).status).toBe(404);
    expect((await status(session, id, "CANCELLED")).body.status).toBe("CANCELLED");
  });

  it("booking.manage on its organization sees and confirms only that organization's bookings", async () => {
    const { session } = await custom(["booking.read", "booking.manage"], orgId);
    const reply = await list(session);
    expect(reply.status).toBe(200);
    expect(reply.ids).toContain(travelerBooking);
    expect(reply.ids).not.toContain(rivalBooking);
    expect((await status(session, rivalBooking, "CONFIRMED")).status).toBe(404);
    expect((await world.api("PATCH", `/bookings/${travelerBooking}`, { session: auth(session), body: { travelersCount: 2 } })).status).toBe(403);
    expect((await book(session, ownServiceId)).status).toBe(403);
    expect((await status(session, travelerBooking, "CONFIRMED")).body.status).toBe("CONFIRMED");
  });

  it("booking.manage without an organization gets no wider view than its own bookings", async () => {
    const { session } = await custom(["booking.read", "booking.manage"]);
    expect(await list(session)).toEqual({ status: 200, ids: [] });
    expect((await status(session, rivalBooking, "CONFIRMED")).status).toBe(403);
  });

  it("booking.read without booking.manage inside an organization sees only its own bookings", async () => {
    const { session } = await custom(["booking.read"], orgId);
    expect(await list(session)).toEqual({ status: 200, ids: [] });
  });

  it("a custom role in another tenant never sees this tenant's bookings", async () => {
    const other = await world.createTenant("crb-other");
    const user = await world.createUser(other, { roles: [] });
    await world.grantCustomRole(other, user.membershipId, ["booking.read", "booking.create", "booking.manage"]);
    const session = await world.session(user);
    expect(await list(session)).toEqual({ status: 200, ids: [] });
    expect((await status(session, travelerBooking, "CANCELLED")).status).toBe(404);
    expect((await book(session, ownServiceId)).status).toBe(404);
  });

  it("system roles are unchanged", async () => {
    const mine = await list(traveler);
    expect(mine.status).toBe(200);
    expect(mine.ids.sort()).toEqual([travelerBooking, rivalBooking].sort());
    const own = await list(providerSession);
    expect(own.ids).toContain(travelerBooking);
    expect(own.ids).not.toContain(rivalBooking);
    const theirs = (await list(rivalSession)).ids;
    expect(theirs).toContain(rivalBooking);
    expect(theirs).not.toContain(travelerBooking);
    const all = await list(admin);
    expect(all.ids).toEqual(expect.arrayContaining([travelerBooking, rivalBooking]));
    expect((await book(admin, ownServiceId)).status).toBe(403);
    expect((await book(providerSession, ownServiceId)).status).toBe(403);
    expect((await status(rivalSession, travelerBooking, "CONFIRMED")).status).toBe(404);
    expect((await status(traveler, travelerBooking, "CONFIRMED")).status).toBe(403);
    expect((await world.api("PATCH", `/bookings/${travelerBooking}`, { session: auth(providerSession), body: { travelersCount: 3 } })).status).toBe(403);
    const pending = (await book(traveler, ownServiceId)).body.id as string;
    expect((await world.api("PATCH", `/bookings/${pending}`, { session: auth(admin), body: { travelersCount: 3 } })).status).toBe(200);
  });
});
