import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Reply, type TestTenant } from "./support/world.js";

/**
 * Overload answers: a sign-in wave beyond the hash capacity and an exhausted database pool are refused with a retryable 503
 * (Retry-After), never a 500, and one user's reads keep working while the sign-ins queue.
 */
const POOL = 3;

describe("overload: sign-in wave and exhausted pool", () => {
  let world: World;
  let tenant: TestTenant;
  let ipCounter = 0;
  const nextIp = (): string => `198.51.100.${++ipCounter}`;

  beforeAll(async () => {
    world = await World.start({
      HASH_CONCURRENCY: "1",
      HASH_QUEUE: "3",
      DATABASE_POOL_MAX: String(POOL),
      DATABASE_CONNECT_TIMEOUT_MS: "500",
      DATABASE_TX_MAX_WAIT_MS: "500",
      TRUST_PROXY: "true"
    });
    tenant = await world.createTenant("overload");
  });
  afterAll(async () => {
    await world.stop();
  });

  const signIn = (email: string, password: string): Promise<Reply> =>
    world.api("POST", "/auth/login", { headers: { "x-forwarded-for": nextIp() }, body: { email, password, tenantCode: tenant.code } });

  it("a sign-in wave wider than the hash capacity answers only 200 or 503 with Retry-After, and a signed-in read stays fast", async () => {
    const reader = await world.createUser(tenant, { roles: ["traveler"] });
    const readerSession = await world.session(reader);
    const users = await Promise.all(Array.from({ length: 16 }, () => world.createUser(tenant, { roles: ["traveler"] })));

    await world.sql.query(`DELETE FROM login_throttles`);
    let waveDone = false;
    const reads: number[] = [];
    const readStatuses: number[] = [];
    const reading = (async (): Promise<void> => {
      while (!waveDone) {
        const started = Date.now();
        const reply = await world.api("GET", "/auth/me", { session: readerSession });
        reads.push(Date.now() - started);
        readStatuses.push(reply.status);
      }
    })();
    const replies = await Promise.all(users.map((user) => signIn(user.email, user.password)));
    waveDone = true;
    await reading;

    const statuses = replies.map((reply) => reply.status);
    expect(statuses.filter((status) => status !== 200 && status !== 503), JSON.stringify(statuses)).toEqual([]);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThanOrEqual(4);
    for (const reply of replies.filter((item) => item.status === 503)) {
      expect(Number(reply.headers["retry-after"])).toBeGreaterThan(0);
      expect(JSON.stringify(reply.body)).not.toMatch(/prisma|P20\d\d|postgres|SELECT/i);
    }
    // A refused sign-in is turned away before any database work: it leaves no throttle row (two per admitted sign-in) and costs no attempt.
    const rows = Number((await world.sql.query(`SELECT count(*)::int AS n FROM login_throttles`)).rows[0].n);
    expect(rows).toBeLessThanOrEqual(2 * statuses.filter((status) => status === 200).length);
    expect(readStatuses.length).toBeGreaterThan(0);
    expect(readStatuses.every((status) => status === 200), JSON.stringify(readStatuses)).toBe(true);
    expect(Math.max(...reads)).toBeLessThan(5000);
  }, 120_000);

  it("refused sign-ins cost no throttle attempt: the same account signs in afterwards", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const wave = await Promise.all(Array.from({ length: 12 }, () => signIn(user.email, user.password)));
    expect(wave.every((reply) => reply.status === 200 || reply.status === 503 || reply.status === 401)).toBe(true);
    await world.sql.query(`DELETE FROM login_throttles`);
    expect((await signIn(user.email, user.password)).status).toBe(200);
  }, 60_000);

  it("a sign-in and a read answer 503 with Retry-After (not 500) while every pooled connection is busy", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const session = await world.session(user);
    const { PrismaService } = await import("../dist/database/prisma.service.js");
    const prisma = world.app.get(PrismaService);
    const holders = Array.from({ length: POOL }, () => prisma.$queryRaw`SELECT pg_sleep(3)::text`.then(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const [login, read] = await Promise.all([signIn(user.email, user.password), world.api("GET", "/auth/me", { session })]);
    expect(login.status, JSON.stringify(login.body)).toBe(503);
    expect(read.status, JSON.stringify(read.body)).toBe(503);
    expect(Number(login.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(read.headers["retry-after"])).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(3000);
    await Promise.all(holders);
    expect((await world.api("GET", "/auth/me", { session })).status).toBe(200);
    expect((await signIn(user.email, user.password)).status).toBe(200);
  }, 60_000);
});
