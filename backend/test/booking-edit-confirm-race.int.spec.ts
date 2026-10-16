import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Session, type TestTenant, type TestUser } from "./support/world.js";

const ROUNDS = 20;

/** An edit, a confirm and a cancel of the same pending booking, plus an edit of a competing booking, all at once. */
describe("booking edit, confirm and cancel racing each other", () => {
  let world: World;
  let tenant: TestTenant;
  let provider: TestUser;
  let providerSession: Session;
  let travelerSession: Session;
  let otherSession: Session;

  const auth = (s: Session): { accessToken: string; tenantId: string } => ({ accessToken: s.accessToken, tenantId: s.user.tenantId });
  const book = (session: Session, serviceId: string, travelersCount: number, serviceDate: string): Promise<{ status: number; body: Json }> =>
    world.api("POST", "/bookings", { session: auth(session), body: { serviceId, travelersCount, serviceDate } });
  const edit = (session: Session, id: string, travelersCount: number): Promise<{ status: number; body: Json }> =>
    world.api("PATCH", `/bookings/${id}`, { session: auth(session), body: { travelersCount, notes: "edited" } });
  const setStatus = (session: Session, id: string, next: string): Promise<{ status: number; body: Json }> =>
    world.api("PATCH", `/bookings/${id}/status`, { session: auth(session), body: { status: next } });

  beforeAll(async () => {
    world = await World.start();
    tenant = await world.createTenant("booking-race");
    const orgId = await world.createOrganization(tenant);
    provider = await world.createUser(tenant, { roles: ["travel-company", "organization-manager"], organizationId: orgId });
    providerSession = await world.session(provider);
    travelerSession = await world.session(await world.createUser(tenant, { roles: ["traveler"] }));
    otherSession = await world.session(await world.createUser(tenant, { roles: ["traveler"] }));
  });
  afterAll(async () => world.stop());

  it(`stays consistent over ${ROUNDS} rounds on a nearly full service`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // capacity 4: the target holds 1, the competing booking holds 2, so only one more traveler fits across both.
      const serviceId = await world.createService(tenant, provider, { capacity: 4 });
      const date = world.futureDate(30);
      const target = await book(travelerSession, serviceId, 1, date);
      const rival = await book(otherSession, serviceId, 2, date);
      expect([target.status, rival.status]).toEqual([201, 201]);
      const targetId = target.body.id as string;
      const rivalId = rival.body.id as string;

      const [edited, confirmed, cancelled, rivalEdited] = await Promise.all([
        edit(travelerSession, targetId, 2),
        setStatus(providerSession, targetId, "CONFIRMED"),
        setStatus(travelerSession, targetId, "CANCELLED"),
        edit(otherSession, rivalId, 3)
      ]);
      const label = `round ${round}: edit ${edited.status}, confirm ${confirmed.status}, cancel ${cancelled.status}, rival edit ${rivalEdited.status}`;

      for (const reply of [edited, confirmed, cancelled, rivalEdited]) expect([200, 409], label).toContain(reply.status);
      // An edit that reports success must have been applied while the booking was still pending.
      if (edited.status === 200) expect(edited.body.status, label).toBe("PENDING");
      if (confirmed.status === 200) expect(["CONFIRMED", "CANCELLED"], label).toContain(confirmed.body.status);

      const finalTarget = await world.prisma.booking.findUniqueOrThrow({ where: { id: targetId } });
      const finalRival = await world.prisma.booking.findUniqueOrThrow({ where: { id: rivalId } });
      // A cancel always lands (cancelling is allowed from pending and from confirmed); confirm alone leaves it confirmed.
      expect(finalTarget.status, label).toBe(cancelled.status === 200 ? "CANCELLED" : confirmed.status === 200 ? "CONFIRMED" : "PENDING");
      expect(finalTarget.travelersCount, label).toBe(edited.status === 200 ? 2 : 1);
      expect(finalTarget.notes, label).toBe(edited.status === 200 ? "edited" : null);
      expect(finalRival.travelersCount, label).toBe(rivalEdited.status === 200 ? 3 : 2);
      // Capacity: live travelers (not cancelled) never exceed 4, and the two edits can not both succeed while the target is live.
      const live = [finalTarget, finalRival].filter((b) => b.status !== "CANCELLED").reduce((sum, b) => sum + b.travelersCount, 0);
      expect(live, label).toBeLessThanOrEqual(4);
      // A cancelled booking was never edited after the cancel: its edit succeeded only if the response said it was still pending (checked above).
      const audits = await world.prisma.auditEvent.findMany({ where: { entityId: targetId }, select: { action: true } });
      expect(audits.filter((a) => a.action === "booking.cancelled").length, label).toBeLessThanOrEqual(1);
      expect(audits.filter((a) => a.action === "booking.confirmed").length, label).toBeLessThanOrEqual(1);
      // Free the pending slots of both travelers for the next round (they have a cap on open bookings).
      await world.prisma.booking.updateMany({ where: { id: { in: [targetId, rivalId] } }, data: { status: "CANCELLED" } });
    }
  });
});
