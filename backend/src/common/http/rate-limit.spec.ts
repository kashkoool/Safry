import { createServer, type Server } from "node:net";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { trustProxySetting } from "../../app.setup.js";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { FailoverThrottlerStorage, REDIS_OPTIONS, createThrottlerStorage, RedisThrottlerStorage, accountOf, accountTracker, rateLimitState, resetRateLimitState } from "./rate-limit.js";

describe("trustProxySetting", () => {
  it("maps the environment value to an Express setting", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("true")).toBe(1);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });
});

describe("accountOf", () => {
  it("normalises the e-mail in the body and ignores anything else", () => {
    expect(accountOf({ body: { email: "  User@Example.TEST " } } as never)).toBe("user@example.test");
    expect(accountOf({ body: {} } as never)).toBeUndefined();
    expect(accountOf({ body: { email: 5 } } as never)).toBeUndefined();
    expect(accountOf({ body: undefined } as never)).toBeUndefined();
  });
});

// Needs a reachable Redis: REDIS_TEST_URL=redis://127.0.0.1:6379 pnpm test
const url = process.env["REDIS_TEST_URL"];
describe.skipIf(!url)("RedisThrottlerStorage", () => {
  const redis = url ? new Redis(url) : undefined;
  afterAll(async () => {
    await redis?.quit();
  });

  it("counts atomically across callers, expires the window and blocks after the limit", async () => {
    const storage = new RedisThrottlerStorage(redis!);
    const key = `test-${Math.random()}`;
    const records = await Promise.all(Array.from({ length: 12 }, () => storage.increment(key, 1500, 10, 2000, "default")));
    expect(Math.max(...records.map((r) => r.totalHits))).toBe(11); // the 11th hit trips the block; blocked callers are not counted further
    expect(records.filter((r) => r.isBlocked).length).toBeGreaterThanOrEqual(2);
    const after = await storage.increment(key, 1500, 10, 2000, "default");
    expect(after.isBlocked).toBe(true);
    expect(after.timeToBlockExpire).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect((await storage.increment(key, 1500, 10, 2000, "default")).totalHits).toBe(1);
  });

  it("keeps independent counters per throttler name", async () => {
    const storage = new RedisThrottlerStorage(redis!);
    const key = `test-${Math.random()}`;
    await storage.increment(key, 5000, 5, 0, "default");
    expect((await storage.increment(key, 5000, 5, 0, "account")).totalHits).toBe(1);
  });
});

describe("FailoverThrottlerStorage", () => {
  const failing = { eval: () => Promise.reject(new Error("ECONNREFUSED")) } as unknown as Redis;

  it("keeps limiting per instance when Redis is down instead of throwing, and reports degraded", async () => {
    resetRateLimitState();
    const storage = new FailoverThrottlerStorage(new RedisThrottlerStorage(failing), new ThrottlerStorageService());
    expect((await storage.increment("k", 60_000, 2, 60_000, "default")).isBlocked).toBe(false);
    await storage.increment("k", 60_000, 2, 60_000, "default");
    expect((await storage.increment("k", 60_000, 2, 60_000, "default")).isBlocked).toBe(true); // limit still enforced per instance
    expect(rateLimitState.degraded).toBe(true);
    expect(rateLimitState.fallbackTotal).toBe(3);
  });

  it("recovers when Redis answers again", async () => {
    resetRateLimitState();
    let up = false;
    const flaky = { eval: () => (up ? Promise.resolve([1, 1000, 0, 0]) : Promise.reject(new Error("down"))) } as unknown as Redis;
    const storage = new FailoverThrottlerStorage(new RedisThrottlerStorage(flaky), new ThrottlerStorageService());
    await storage.increment("k", 60_000, 5, 0, "default");
    expect(rateLimitState.degraded).toBe(true);
    up = true;
    await storage.increment("k", 60_000, 5, 0, "default");
    expect(rateLimitState.degraded).toBe(false);
  });
});

describe("a hung Redis", () => {
  it("degrades to the in-process limiter within the command timeout instead of blocking the request", async () => {
    resetRateLimitState();
    // Answers only the ready-check (INFO) so the client becomes READY, then swallows every other byte: connected, never answers a command.
    const sockets: import("node:net").Socket[] = [];
    const info = "redis_version:7.0.0\r\nloading:0\r\n";
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (chunk) => {
        // One reply per command, in order: SETINFO is accepted, INFO (the ready check) is answered; EVAL and everything else is never answered.
        for (const command of chunk.toString().split(/(?=\*[0-9]+\r\n)/)) {
          if (/hello/i.test(command)) socket.write("-ERR unknown command\r\n");
          else if (/\$4\r\ninfo/i.test(command)) socket.write(`$${info.length}\r\n${info}\r\n`);
          else if (/setinfo/i.test(command)) socket.write("+OK\r\n");
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const redis = new Redis(`redis://127.0.0.1:${port}`, { ...REDIS_OPTIONS, protocol: 2 });
    redis.on("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => { redis.once("ready", () => resolve()); setTimeout(() => reject(new Error("redis never became ready")), 3000); });
      const storage = new FailoverThrottlerStorage(new RedisThrottlerStorage(redis), new ThrottlerStorageService());
      const started = Date.now();
      const record = await storage.increment("hung-key", 60_000, 5, 60_000, "default");
      expect(Date.now() - started).toBeLessThan(2500);
      expect(record.totalHits).toBe(1);
      expect(rateLimitState.degraded).toBe(true);
    } finally {
      redis.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resetRateLimitState();
    }
  }, 15_000);
});

describe("accountTracker", () => {
  it("keys on e-mail AND client address so a stranger cannot exhaust the owner's bucket", () => {
    const a = accountTracker({ body: { email: "Victim@Example.test" }, ip: "198.51.100.1" } as never);
    const b = accountTracker({ body: { email: "victim@example.test" }, ip: "198.51.100.2" } as never);
    expect(a).not.toBe(b);
    expect(a).toBe(accountTracker({ body: { email: " victim@example.test " }, ip: "198.51.100.1" } as never));
  });
});

describe("createThrottlerStorage without Redis", () => {
  const config = (values: Record<string, string>): never => ({ get: (key: string) => values[key] }) as never;
  const logged = (nodeEnv: string, extra: Record<string, string> = {}): string[] => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    createThrottlerStorage(config({ NODE_ENV: nodeEnv, ...extra }));
    const messages = error.mock.calls.map((call) => String(call[0]));
    error.mockRestore();
    return messages;
  };

  it("reports loudly (error level) that limits are per process in production and in staging", () => {
    for (const env of ["production", "staging"]) expect(logged(env).join()).toContain("RATE_LIMIT_REDIS_URL is not set");
  });

  it("stays quiet in development, tests and an explicitly relaxed staging", () => {
    expect(logged("development")).toEqual([]);
    expect(logged("test")).toEqual([]);
    expect(logged("staging", { ALLOW_NON_PRODUCTION_DEFAULTS: "true" })).toEqual([]);
  });
});

describe("client address grouping for rate-limit keys", () => {
  const key = (ip: string): string => accountTracker({ body: { email: "a@example.test" }, ip } as never);
  it("groups every address of one IPv6 /64 into one key", () => {
    expect(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(key("2001:db8:1:2:1::9"));
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
  });
  it("treats an IPv4-mapped IPv6 address as the plain IPv4 address", () => {
    expect(key("::ffff:198.51.100.7")).toBe(key("198.51.100.7"));
  });
  it("leaves IPv4 behaviour unchanged", () => {
    expect(key("198.51.100.7")).toBe("a@example.test|198.51.100.7");
    expect(key("198.51.100.7")).not.toBe(key("198.51.100.8"));
  });
  it("keeps an unknown address distinct from an empty one", () => {
    expect(accountTracker({ body: { email: "a@example.test" } } as never)).toBe("a@example.test|");
  });
});
