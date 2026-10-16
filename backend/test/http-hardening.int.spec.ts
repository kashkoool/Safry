import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../dist/database/prisma.service.js";
import { World } from "./support/world.js";

describe("HTTP hardening on the running app", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.start();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => world.stop());

  it("sends the security headers on API answers and never advertises the framework", async () => {
    for (const path of ["/health/live", "/auth/me"]) {
      const response = await fetch(`${world.baseUrl}${path}`);
      const headers = response.headers;
      expect(headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(headers.get("strict-transport-security"), path).toMatch(/max-age=\d+/);
      expect(headers.get("x-frame-options"), path).toBeTruthy();
      expect(headers.get("content-security-policy"), path).toBeTruthy();
      expect(headers.get("referrer-policy"), path).toBeTruthy();
      expect(headers.get("x-powered-by"), path).toBeNull();
    }
    const authenticated = await fetch(`${world.baseUrl}/auth/me`);
    expect(authenticated.status).toBe(401);
    expect(authenticated.headers.get("cache-control")).toBe("no-store");
    expect(authenticated.headers.get("pragma")).toBe("no-cache");
  });

  it("readiness answers 503 (not 200, not a hang) when the database fails or does not answer, and liveness stays 200", async () => {
    const prisma = world.app.get(PrismaService);
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    const failed = await world.api("GET", "/health/ready");
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("connection refused");

    vi.restoreAllMocks();
    vi.spyOn(prisma, "$queryRaw").mockReturnValue(new Promise(() => undefined) as never);
    const started = Date.now();
    const hung = await world.api("GET", "/health/ready");
    expect(hung.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await world.api("GET", "/health/live")).status).toBe(200);

    vi.restoreAllMocks();
    expect((await world.api("GET", "/health/ready")).status).toBe(200);
  });
});
