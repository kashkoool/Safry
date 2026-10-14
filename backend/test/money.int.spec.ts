import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Session, type TestTenant, type TestUser } from "./support/world.js";

/** Money columns are bigint minor units; the API keeps returning JSON numbers. */
describe("money amounts beyond 32 bits", () => {
  let world: World;
  let tenant: TestTenant;
  let admin: Session;
  let provider: TestUser;
  let providerSession: Session;
  let traveler: TestUser;
  let travelerSession: Session;
  let orgId: string;
  const auth = (s: Session) => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });

  const hotel = async (priceCents: number | bigint, capacity = 50): Promise<string> =>
    (
      await world.prisma.travelService.create({
        data: {
          tenantId: tenant.id,
          providerMembershipId: provider.membershipId,
          providerOrganizationId: orgId,
          title: world.unique("hotel"),
          description: "Integration test hotel",
          category: "HOTEL",
          city: "Makkah",
          priceCents,
          capacity,
          status: "ACTIVE",
          details: { roomType: "double", maxGuests: "4", mealPlan: "breakfast" }
        }
      })
    ).id;
  const stay = (serviceId: string, units: number, nights: number) => {
    const start = Date.parse(`${world.futureDate()}T00:00:00Z`);
    return world.api("POST", "/bookings", {
      session: auth(travelerSession),
      body: {
        serviceId,
        travelersCount: 1,
        units,
        serviceDate: new Date(start).toISOString().slice(0, 10),
        endDate: new Date(start + nights * 86_400_000).toISOString().slice(0, 10)
      }
    });
  };

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("money");
    orgId = await world.createOrganization(tenant, "HOTEL");
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    traveler = await world.createUser(tenant, { roles: ["traveler"] });
    admin = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"] }));
    providerSession = await world.session(provider);
    travelerSession = await world.session(traveler);
  });
  afterAll(async () => {
    await world.stop();
  });

  it("stores and returns a total of exactly 2^31 (one above the old column ceiling) as a JSON number", async () => {
    const serviceId = await hotel(67_108_864);
    const reply = await stay(serviceId, 16, 2);
    expect(reply.status).toBe(201);
    expect(reply.body.totalCents).toBe(2_147_483_648);
    expect(reply.body.unitPriceCents).toBe(67_108_864);
    expect(typeof reply.body.totalCents).toBe("number");
    const [row] = (await world.sql.query<{ type: string; total: string }>(`SELECT pg_typeof("totalCents")::text AS type, "totalCents"::text AS total FROM bookings WHERE id = $1`, [reply.body.id])).rows;
    expect(row).toEqual({ type: "bigint", total: "2147483648" });
  });

  it("computes the largest allowed price x 20 rooms x 90 nights exactly and sums it across bookings", async () => {
    const serviceId = await hotel(100_000_000, 100);
    const first = await stay(serviceId, 20, 90);
    expect(first.status).toBe(201);
    expect(first.body.totalCents).toBe(180_000_000_000);
    const list = await world.api("GET", "/bookings", { session: auth(admin) });
    expect(list.status).toBe(200);
    const mine = (list.body.items ?? list.body).filter((b: { serviceId: string }) => b.serviceId === serviceId);
    expect(mine.map((b: { totalCents: number }) => b.totalCents)).toContain(180_000_000_000);
  });

  it("keeps editing a pending booking exact above 32 bits", async () => {
    const serviceId = await hotel(100_000_000, 100);
    const made = await stay(serviceId, 20, 30);
    expect(made.body.totalCents).toBe(60_000_000_000);
    const edit = await world.api("PATCH", `/bookings/${made.body.id}`, { session: auth(travelerSession), body: { units: 10 } });
    expect(edit.status).toBe(200);
    expect(edit.body.totalCents).toBe(30_000_000_000);
  });

  it("answers services with a price above 2147483647 as a number (price changed in the database)", async () => {
    const serviceId = await hotel(2_147_483_648n);
    const reply = await world.api("GET", "/services?limit=100", { session: auth(admin) });
    expect(reply.status).toBe(200);
    const row = (reply.body.items ?? reply.body).find((s: { id: string }) => s.id === serviceId);
    expect(row.priceCents).toBe(2_147_483_648);
  });

  it("rejects service prices outside the product range with 400 (32-bit edge, max safe integer, one above)", async () => {
    const serviceId = await hotel(10_000);
    for (const priceCents of [99, 100_000_001, 2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1.5, "5000000000"]) {
      const reply = await world.api("PATCH", `/services/${serviceId}`, { session: auth(providerSession), body: { priceCents } });
      expect(reply.status, String(priceCents)).toBe(400);
    }
    const ok = await world.api("PATCH", `/services/${serviceId}`, { session: auth(providerSession), body: { priceCents: 100_000_000 } });
    expect(ok.status).toBe(200);
    expect(ok.body.priceCents).toBe(100_000_000);
  });

  it("never rounds a stored amount that a JSON number cannot hold: safe maximum is returned, one above is a server error", async () => {
    const serviceId = await hotel(10_000);
    const booking = async (total: bigint): Promise<string> =>
      (
        await world.prisma.booking.create({
          data: { tenantId: tenant.id, serviceId, travelerMembershipId: traveler.membershipId, travelersCount: 1, totalCents: total, unitPriceCents: 100n, serviceDate: new Date(`${world.futureDate(200)}T00:00:00Z`) }
        })
      ).id;
    const safe = await booking(BigInt(Number.MAX_SAFE_INTEGER));
    const ok = await world.api("GET", "/bookings", { session: auth(admin) });
    expect(ok.status).toBe(200);
    const row = (ok.body.items ?? ok.body).find((b: { id: string }) => b.id === safe);
    expect(row.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    await booking(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const broken = await world.api("GET", "/bookings", { session: auth(admin) });
    expect(broken.status).toBe(500);
    expect(JSON.stringify(broken.body)).not.toContain("9007199254740992");
  });

  it("rejects a booking whose total would pass the largest exact integer", async () => {
    // Price is capped by the DTO, so this guard is reachable only with a price written outside the API.
    const serviceId = await hotel(BigInt(Number.MAX_SAFE_INTEGER));
    const reply = await stay(serviceId, 1, 1);
    expect(reply.status).toBe(201);
    const over = await stay(serviceId, 2, 1);
    expect(over.status).toBe(400);
  });
});
