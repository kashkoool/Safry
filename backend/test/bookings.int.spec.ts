import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Booking Management: creation rules, capacity, visibility and the status lifecycle. */
describe("booking management", () => {
  let world: World;
  let tenant: TestTenant;
  let admin: Session;
  let provider: TestUser;
  let providerSession: Session;
  let rivalSession: Session;
  let traveler1: TestUser;
  let traveler2: TestUser;
  let traveler1Session: Session;
  let traveler2Session: Session;
  let orgId: string;

  const auth = (session: Pick<Session, "accessToken" | "user">): { accessToken: string; tenantId: string } => ({
    accessToken: session.accessToken,
    tenantId: session.user.tenantId
  });
  const book = (session: Session, serviceId: string, extra: Json = {}): Promise<{ status: number; body: Json }> =>
    world.api("POST", "/bookings", {
      session: auth(session),
      body: { serviceId, travelersCount: 1, serviceDate: world.futureDate(), ...extra }
    });
  const status = (session: Session, id: string, next: string): Promise<{ status: number; body: Json }> =>
    world.api("PATCH", `/bookings/${id}/status`, { session: auth(session), body: { status: next } });
  const newService = (options: { capacity?: number; priceCents?: number; status?: "ACTIVE" | "DRAFT" } = {}): Promise<string> =>
    world.createService(tenant, provider, options);

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("book");
    orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    const rivalOrg = await world.createOrganization(tenant);
    const rival = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: rivalOrg });
    traveler1 = await world.createUser(tenant, { roles: ["traveler"] });
    traveler2 = await world.createUser(tenant, { roles: ["traveler"] });
    admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
    providerSession = await world.session(provider);
    rivalSession = await world.session(rival);
    traveler1Session = await world.session(traveler1);
    traveler2Session = await world.session(traveler2);
  });

  afterAll(async () => {
    await world.stop();
  });

  describe("creation", () => {
    it("creates a pending booking priced from the service", async () => {
      const serviceId = await newService({ priceCents: 150_000 });
      const reply = await book(traveler1Session, serviceId, { travelersCount: 2, notes: "  window seat  " });
      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({
        status: "PENDING",
        travelersCount: 2,
        units: 2,
        unitPriceCents: 150_000,
        totalCents: 300_000,
        currency: "SAR",
        notes: "window seat",
        tenantId: tenant.id,
        travelerMembershipId: traveler1.membershipId
      });
      const audit = await world.prisma.auditEvent.findFirst({ where: { entityId: reply.body.id as string, action: "booking.create" } });
      expect(audit).toMatchObject({ tenantId: tenant.id, actorUserId: traveler1.userId });
    });

    it("validates the request", async () => {
      const serviceId = await newService();
      expect((await book(traveler1Session, serviceId, { travelersCount: 0 })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { travelersCount: 21 })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { serviceDate: "2020-01-01" })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { serviceDate: "31/12/2030" })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { endDate: world.futureDate(40) })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { status: "CONFIRMED" })).status).toBe(400);
      expect((await book(traveler1Session, serviceId, { totalCents: 1 })).status).toBe(400);
      expect((await book(traveler1Session, "not-a-uuid")).status).toBe(400);
      expect((await book(traveler1Session, crypto.randomUUID())).status).toBe(404);
    });

    it("lets only travelers create bookings", async () => {
      const serviceId = await newService();
      expect((await book(providerSession, serviceId)).status).toBe(403);
      expect((await book(admin, serviceId)).status).toBe(403);
      expect((await world.api("POST", "/bookings", { body: { serviceId, travelersCount: 1, serviceDate: world.futureDate() } })).status).toBe(401);
    });

    it("refuses services or organizations that are not open for booking", async () => {
      const draft = await newService({ status: "DRAFT" });
      expect((await book(traveler1Session, draft)).status).toBe(409);
      const suspendedOrg = await world.createOrganization(tenant);
      const owner = await world.createUser(tenant, { roles: ["travel-company"], organizationId: suspendedOrg });
      const service = await world.createService(tenant, owner);
      await world.prisma.providerOrganization.update({ where: { id: suspendedOrg }, data: { status: "SUSPENDED" } });
      expect((await book(traveler1Session, service)).status).toBe(409);
    });
  });

  describe("capacity", () => {
    it("never overbooks a date, frees seats on cancellation and counts dates separately", async () => {
      const serviceId = await newService({ capacity: 3 });
      const date = world.futureDate(50);
      const first = await book(traveler1Session, serviceId, { travelersCount: 2, serviceDate: date });
      expect(first.status).toBe(201);
      expect((await book(traveler2Session, serviceId, { travelersCount: 2, serviceDate: date })).status).toBe(409);
      const last = await book(traveler2Session, serviceId, { travelersCount: 1, serviceDate: date });
      expect(last.status).toBe(201);
      expect((await book(traveler2Session, serviceId, { travelersCount: 1, serviceDate: date })).status).toBe(409);
      // Another date has its own capacity.
      expect((await book(traveler2Session, serviceId, { travelersCount: 3, serviceDate: world.futureDate(51) })).status).toBe(201);
      // Cancelling frees the seats.
      expect((await status(traveler1Session, first.body.id as string, "CANCELLED")).body.status).toBe("CANCELLED");
      expect((await book(traveler2Session, serviceId, { travelersCount: 2, serviceDate: date })).status).toBe(201);
    });

    it("stays within capacity under concurrent requests", async () => {
      const serviceId = await newService({ capacity: 3 });
      const date = world.futureDate(60);
      const attempts = await Promise.all(
        Array.from({ length: 6 }, (_, index) => book(index % 2 ? traveler1Session : traveler2Session, serviceId, { serviceDate: date }))
      );
      const created = attempts.filter((reply) => reply.status === 201).length;
      const rejected = attempts.filter((reply) => reply.status === 409).length;
      expect(created).toBe(3);
      expect(rejected).toBe(3);
      const stored = await world.prisma.booking.aggregate({ where: { serviceId, status: { not: "CANCELLED" } }, _sum: { units: true } });
      expect(stored._sum.units).toBe(3);
    });

    it("refuses to shrink a service below its confirmed demand", async () => {
      const serviceId = await newService({ capacity: 5 });
      await book(traveler1Session, serviceId, { travelersCount: 4, serviceDate: world.futureDate(70) });
      const shrink = await world.api("PATCH", `/services/${serviceId}`, { session: auth(providerSession), body: { capacity: 2 } });
      expect(shrink.status).toBe(409);
    });
  });

  describe("visibility", () => {
    let serviceId: string;
    let bookingId: string;

    beforeAll(async () => {
      serviceId = await newService();
      bookingId = (await book(traveler1Session, serviceId)).body.id as string;
    });

    it("shows a traveler only their own bookings", async () => {
      const own = await world.api("GET", "/bookings", { session: auth(traveler1Session) });
      expect((own.body as Json[]).map((item) => item.id)).toContain(bookingId);
      expect((own.body as Json[]).every((item) => item.travelerMembershipId === traveler1.membershipId)).toBe(true);
      const other = await world.api("GET", "/bookings", { session: auth(traveler2Session) });
      expect((other.body as Json[]).map((item) => item.id)).not.toContain(bookingId);
    });

    it("shows a provider only bookings of their own organization's services", async () => {
      const mine = await world.api("GET", "/bookings", { session: auth(providerSession) });
      expect((mine.body as Json[]).map((item) => item.id)).toContain(bookingId);
      const rivals = await world.api("GET", "/bookings", { session: auth(rivalSession) });
      expect((rivals.body as Json[]).map((item) => item.id)).not.toContain(bookingId);
    });

    it("shows the tenant administrator every booking of the tenant", async () => {
      const all = await world.api("GET", "/bookings", { session: auth(admin) });
      expect((all.body as Json[]).map((item) => item.id)).toContain(bookingId);
    });

    it("hides a booking from everyone else as not found", async () => {
      expect((await status(traveler2Session, bookingId, "CANCELLED")).status).toBe(404);
      expect((await status(rivalSession, bookingId, "CONFIRMED")).status).toBe(404);
      const edit = await world.api("PATCH", `/bookings/${bookingId}`, { session: auth(traveler2Session), body: { travelersCount: 3 } });
      expect(edit.status).toBe(404);
    });
  });

  describe("status lifecycle", () => {
    it("lets the provider confirm and the traveler cancel, with an audit trail", async () => {
      const serviceId = await newService();
      const created = await book(traveler1Session, serviceId);
      const id = created.body.id as string;
      const forbidden = await status(traveler1Session, id, "CONFIRMED");
      expect(forbidden.status).toBe(403);
      const confirmed = await status(providerSession, id, "CONFIRMED");
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe("CONFIRMED");
      // a repeated change answers with the same projection (service, traveler), not the bare row.
      const repeated = await status(providerSession, id, "CONFIRMED");
      expect(repeated.body.status).toBe("CONFIRMED");
      expect(Object.keys(repeated.body).sort()).toEqual(Object.keys(confirmed.body).sort());
      expect(repeated.body.service?.title).toBeTruthy();
      const cancelled = await status(traveler1Session, id, "CANCELLED");
      expect(cancelled.body.status).toBe("CANCELLED");
      const actions = (await world.prisma.auditEvent.findMany({ where: { entityId: id }, orderBy: { occurredAt: "asc" } })).map((event) => event.action);
      expect(actions).toEqual(["booking.create", "booking.confirmed", "booking.cancelled"]);
    });

    it("does not revive a cancelled booking and rejects unknown statuses", async () => {
      const serviceId = await newService();
      const id = (await book(traveler1Session, serviceId)).body.id as string;
      await status(traveler1Session, id, "CANCELLED");
      expect((await status(providerSession, id, "CONFIRMED")).status).toBe(409);
      expect((await status(providerSession, id, "PENDING")).status).toBe(400);
      expect((await status(providerSession, id, "DELETED")).status).toBe(400);
    });

    it("does not confirm a booking whose service is no longer available", async () => {
      const serviceId = await newService();
      const id = (await book(traveler1Session, serviceId)).body.id as string;
      await world.prisma.travelService.update({ where: { id: serviceId }, data: { status: "INACTIVE" } });
      expect((await status(providerSession, id, "CONFIRMED")).status).toBe(409);
      // The traveler can still cancel.
      expect((await status(traveler1Session, id, "CANCELLED")).body.status).toBe("CANCELLED");
    });
  });

  describe("changing a pending booking", () => {
    it("recalculates the total and re-checks capacity", async () => {
      const serviceId = await newService({ capacity: 3, priceCents: 100_000 });
      const date = world.futureDate(80);
      const mine = await book(traveler1Session, serviceId, { travelersCount: 1, serviceDate: date });
      const id = mine.body.id as string;
      const grown = await world.api("PATCH", `/bookings/${id}`, { session: auth(traveler1Session), body: { travelersCount: 3 } });
      expect(grown.status).toBe(200);
      expect(grown.body).toMatchObject({ travelersCount: 3, units: 3, totalCents: 300_000 });
      const tooMany = await world.api("PATCH", `/bookings/${id}`, { session: auth(traveler1Session), body: { travelersCount: 4 } });
      expect(tooMany.status).toBe(409);
    });

    it("only allows traveler or administrator edits of pending bookings", async () => {
      const serviceId = await newService();
      const id = (await book(traveler1Session, serviceId)).body.id as string;
      expect((await world.api("PATCH", `/bookings/${id}`, { session: auth(providerSession), body: { travelersCount: 2 } })).status).toBe(403);
      await status(providerSession, id, "CONFIRMED");
      const late = await world.api("PATCH", `/bookings/${id}`, { session: auth(traveler1Session), body: { travelersCount: 2 } });
      expect(late.status).toBe(409);
      const price = await world.api("PATCH", `/bookings/${id}`, { session: auth(admin), body: { totalCents: 1 } });
      expect(price.status).toBe(400);
    });
  });
});
