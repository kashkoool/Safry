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
