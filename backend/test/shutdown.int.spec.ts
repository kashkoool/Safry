import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./support/world.js";

/** on shutdown readiness flips to 503 first and the process closes only after the drain window. */
describe("graceful shutdown", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.start({ SHUTDOWN_DRAIN_MS: "600" });
  });
  afterAll(async () => {
    await world.stop();
  });

  it("answers readiness 200, then 503 while draining, and finishes closing after the drain window", async () => {
    expect((await world.api("GET", "/health/ready")).status).toBe(200);
    const started = Date.now();
    const closing = world.app.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const draining = await world.api("GET", "/health/ready");
    expect(draining.status).toBe(503);
    await closing;
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });
});

/** A request that is already running when shutdown starts finishes with its real answer; only then does the server close. */
describe("graceful shutdown with a request in flight", () => {
  it("lets the in-flight request complete while readiness already reports draining", async () => {
    const world = await World.start({ SHUTDOWN_DRAIN_MS: "500" });
    const holder = new pg.Client({ connectionString: world.databaseUrl });
    try {
      const tenant = await world.createTenant("shutdown-inflight");
      const platform = await world.session(await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true }));
      const target = await world.createUser(tenant, { roles: ["traveler"] });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [target.userId]);
      const inFlight = world.api("PATCH", `/platform/users/${target.userId}`, {
        session: { accessToken: platform.accessToken, tenantId: tenant.id },
        body: { displayName: "Finished during shutdown" }
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const closing = world.app.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await world.api("GET", "/health/ready")).status).toBe(503);
      await holder.query("COMMIT");
      const reply = await inFlight;
      expect(reply.status).toBe(200);
      await closing;
      expect((await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).displayName).toBe("Finished during shutdown");
    } finally {
      await holder.end().catch(() => undefined);
      await world.stop().catch(() => undefined);
    }
  }, 60_000);
});
