import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Limits against inventory hoarding: per-traveler PENDING cap, date horizon, computed PENDING expiry, offset cap. */
describe("booking limits", () => {
  let world: World;
  let tenant: TestTenant;
  let provider: TestUser;
  let admin: Session;
  let providerSession: Session;

  const auth = (s: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const book = (s: Session, serviceId: string, extra: Json = {}): Promise<{ status: number; body: Json }> =>
    world.api("POST", "/bookings", { session: auth(s), body: { serviceId, travelersCount: 1, serviceDate: world.futureDate(), ...extra } });
  const confirm = (id: string): Promise<{ status: number; body: Json }> =>
    world.api("PATCH", `/bookings/${id}/status`, { session: auth(providerSession), body: { status: "CONFIRMED" } });
  const age = (id: string, hours: number): Promise<unknown> =>
    world.prisma.booking.update({ where: { id }, data: { createdAt: new Date(Date.now() - hours * 3_600_000) } });
  const traveler = async (): Promise<Session> => world.session(await world.createUser(tenant, { roles: ["traveler"] }));

  beforeAll(async () => {
    world = await World.start({ BOOKING_MAX_PENDING_PER_TRAVELER: "3", BOOKING_MAX_DAYS_AHEAD: "100", BOOKING_PENDING_TTL_HOURS: "48" });
    tenant = await world.createTenant("blim");
    const orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    providerSession = await world.session(provider);
    admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
  });
  afterAll(async () => {
    await world.stop();
  });

  it("refuses the 4th open PENDING booking with a stable code and frees a slot on cancel", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await book(t, serviceId, { serviceDate: world.futureDate(10 + i) });
      expect(r.status).toBe(201);
      ids.push(String(r.body["id"]));
    }
    const refused = await book(t, serviceId, { serviceDate: world.futureDate(20) });
    expect(refused.status).toBe(409);
    expect(refused.body["code"]).toBe("BOOKING_PENDING_LIMIT");
    await world.api("PATCH", `/bookings/${ids[0]}/status`, { session: auth(t), body: { status: "CANCELLED" } });
    expect((await book(t, serviceId, { serviceDate: world.futureDate(20) })).status).toBe(201);
  });

  it("parallel creates cannot exceed the cap across services", async () => {
    const t = await traveler();
    const services = await Promise.all([1, 2, 3, 4, 5, 6].map(() => world.createService(tenant, provider, { capacity: 100 })));
    const replies = await Promise.all(services.map((id) => book(t, id)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 409 && r.body["code"] === "BOOKING_PENDING_LIMIT")).toHaveLength(3);
  });

  it("parallel creates cannot exceed service capacity", async () => {
    const serviceId = await world.createService(tenant, provider, { capacity: 2 });
    const ts = await Promise.all([traveler(), traveler(), traveler(), traveler()]);
    const replies = await Promise.all(ts.map((t) => book(t, serviceId)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(2);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it("enforces the date horizon on create and on edit, and still refuses the past", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 100 });
    const far = await book(t, serviceId, { serviceDate: world.futureDate(101) });
    expect(far.status).toBe(400);
    expect(far.body["code"]).toBe("BOOKING_DATE_TOO_FAR");
    expect((await book(t, serviceId, { serviceDate: world.futureDate(99) })).status).toBe(201);
    expect((await book(t, serviceId, { serviceDate: world.futureDate(-1) })).status).toBe(400);
    const ok = await book(t, serviceId, { serviceDate: world.futureDate(5) });
    const edit = await world.api("PATCH", `/bookings/${String(ok.body["id"])}`, { session: auth(t), body: { serviceDate: world.futureDate(150) } });
    expect(edit.status).toBe(400);
    expect(edit.body["code"]).toBe("BOOKING_DATE_TOO_FAR");
  });

  it("expired PENDING frees capacity, is listed as cancelled+expired, and is swept with an audit event", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 1 });
    const first = await book(t, serviceId);
    const id = String(first.body["id"]);
    const other = await traveler();
    expect((await book(other, serviceId)).status).toBe(409);
    await age(id, 49);
    const listed = await world.api("GET", "/bookings", { session: auth(t) });
    const row = (listed.body as unknown as Json[]).find((b) => b["id"] === id)!;
    expect(row).toMatchObject({ status: "CANCELLED", expired: true });
    expect((await book(other, serviceId)).status).toBe(201);
    const stored = await world.prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe("CANCELLED");
    expect(await world.prisma.auditEvent.count({ where: { entityId: id, action: "booking.expire" } })).toBe(1);
  });

  it("expired PENDING does not count toward the traveler cap", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 100 });
    for (let i = 0; i < 3; i++) {
      const r = await book(t, serviceId, { serviceDate: world.futureDate(10 + i) });
      await age(String(r.body["id"]), 72);
    }
    expect((await book(t, serviceId)).status).toBe(201);
  });

  it("refuses to confirm or edit an expired PENDING booking (409 BOOKING_EXPIRED)", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 5 });
    const r = await book(t, serviceId);
    const id = String(r.body["id"]);
    await age(id, 100);
    const edit = await world.api("PATCH", `/bookings/${id}`, { session: auth(t), body: { travelersCount: 2 } });
    expect(edit.status).toBe(409);
    expect(edit.body["code"]).toBe("BOOKING_EXPIRED");
    expect((await world.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
    expect((await confirm(id)).status).toBe(409);
    const second = String((await book(t, serviceId)).body["id"]);
    await age(second, 100);
    const done = await confirm(second);
    expect(done.status).toBe(409);
    expect(done.body["code"]).toBe("BOOKING_EXPIRED");
    expect((await world.prisma.booking.findUniqueOrThrow({ where: { id: second } })).status).toBe("CANCELLED");
  });

  it("a fresh PENDING booking still confirms", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 5 });
    const r = await book(t, serviceId);
    expect((await confirm(String(r.body["id"]))).status).toBe(200);
  });

  it("capacity edit counts live bookings only and refuses shrinking below the peak", async () => {
    const t = await traveler();
    const serviceId = await world.createService(tenant, provider, { capacity: 5 });
    await book(t, serviceId, { travelersCount: 4 });
    const stale = await book(t, serviceId, { travelersCount: 1, serviceDate: world.futureDate(40) });
    await age(String(stale.body["id"]), 72);
    const shrink = (capacity: number): Promise<{ status: number; body: Json }> =>
      world.api("PATCH", `/services/${serviceId}`, { session: auth(providerSession), body: { capacity } });
    expect((await shrink(3)).status).toBe(409);
    expect((await shrink(4)).status).toBe(200);
  });

  it("caps the legacy offset at 1000", async () => {
    expect((await world.api("GET", "/bookings?offset=1001", { session: auth(admin) })).status).toBe(400);
    expect((await world.api("GET", "/bookings?offset=1000", { session: auth(admin) })).status).toBe(200);
  });
});
