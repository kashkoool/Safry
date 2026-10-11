import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../../database/prisma.service.js";
import { AccountSecurityService } from "./account-security.service.js";

interface Row {
  key: string;
  failures: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
  trustedUntil: Date | null;
  updatedAt: Date;
}

/** In-memory stand-in for the login_throttles table (enough of the Prisma surface the service uses). */
function setup(settings: Record<string, number> = {}): { service: AccountSecurityService; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const loginThrottle = {
    createMany: ({ data }: { data: Array<{ key: string }> }): Promise<{ count: number }> => {
      for (const { key } of data)
        if (!rows.has(key))
          rows.set(key, { key, failures: 0, windowStartedAt: new Date(), blockedUntil: null, trustedUntil: null, updatedAt: new Date() });
      return Promise.resolve({ count: data.length });
    },
    findMany: ({ where }: { where: { key: { in: string[] } } }): Promise<Row[]> => Promise.resolve(where.key.in.map((key) => ({ ...rows.get(key)! }))),
    findUnique: ({ where }: { where: { key: string } }): Promise<Row | null> => Promise.resolve(rows.get(where.key) ? { ...rows.get(where.key)! } : null),
    update: ({ where, data }: { where: { key: string }; data: Partial<Row> }): Promise<object> => {
      Object.assign(rows.get(where.key)!, data);
      return Promise.resolve({});
    },
    updateMany: ({ where, data }: { where: { key: string; failures?: { gt: number } }; data: Omit<Partial<Row>, "failures"> & { failures?: number | { decrement: number } } }): Promise<{ count: number }> => {
      const row = rows.get(where.key);
      if (!row || (where.failures && !(row.failures > where.failures.gt))) return Promise.resolve({ count: 0 });
      const { failures, ...rest } = data;
      Object.assign(row, rest);
      if (typeof failures === "number") row.failures = failures;
      else if (failures) row.failures -= failures.decrement;
      return Promise.resolve({ count: 1 });
    },
    deleteMany: (): Promise<{ count: number }> => Promise.resolve({ count: 0 })
  };
  const tx = { loginThrottle, $queryRaw: (): Promise<unknown[]> => Promise.resolve([]) };
  const prisma = { ...tx, $transaction: (callback: (client: typeof tx) => Promise<unknown>): Promise<unknown> => callback(tx) } as unknown as PrismaService;
  const config = { get: (key: string, fallback: number) => settings[key] ?? fallback } as unknown as ConfigService;
  return { service: new AccountSecurityService(prisma, config), rows };
}

const expireBlocks = (rows: Map<string, Row>): void => {
  for (const row of rows.values()) if (row.blockedUntil) row.blockedUntil = new Date(Date.now() - 1);
};

describe("AccountSecurityService throttle", () => {
  it("blocks an e-mail + address pair after LOGIN_MAX_ATTEMPTS attempts, with a doubling, capped delay", async () => {
    const { service, rows } = setup();
    for (let i = 0; i < 4; i++) expect(await service.begin("a@x.test", "10.0.0.1")).toEqual({ allowed: true, blocks: false });
    expect(await service.begin("a@x.test", "10.0.0.1")).toEqual({ allowed: true, blocks: true });
    expect((await service.begin("a@x.test", "10.0.0.1")).allowed).toBe(false);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      expireBlocks(rows);
      const before = Date.now();
      await service.begin("a@x.test", "10.0.0.1");
      const pair = [...rows.values()].find((row) => row.blockedUntil && row.blockedUntil.getTime() > before)!;
      delays.push(pair.blockedUntil!.getTime() - before);
    }
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(15 * 60_000 + 50);
  });

  it("does not block the same e-mail from another address", async () => {
    const { service } = setup();
    for (let i = 0; i < 6; i++) await service.begin("b@x.test", "10.0.0.1");
    expect((await service.begin("b@x.test", "10.0.0.2")).allowed).toBe(true);
  });

  it("blocks the e-mail account-wide after 4 x LOGIN_MAX_ATTEMPTS, but never for an address that signed in before", async () => {
    const { service } = setup({ LOGIN_MAX_ATTEMPTS: 3 });
    await service.begin("c@x.test", "192.0.2.1");
    await service.succeed("c@x.test", "192.0.2.1");
    let blocked = false;
    for (let ip = 1; ip <= 20 && !blocked; ip++)
      for (let i = 0; i < 2; i++) blocked = (await service.begin("c@x.test", `198.51.100.${ip}`)).blocks || blocked;
    expect(blocked).toBe(true);
    expect((await service.begin("c@x.test", "203.0.113.9")).allowed).toBe(false);
    expect((await service.begin("c@x.test", "192.0.2.1")).allowed).toBe(true);
  });

  it("keeps register and login counters apart", async () => {
    const { service } = setup();
    for (let i = 0; i < 10; i++) await service.begin("d@x.test", "10.0.0.1", "register");
    expect((await service.begin("d@x.test", "10.0.0.1", "register")).allowed).toBe(false);
    expect((await service.begin("d@x.test", "10.0.0.1")).allowed).toBe(true);
  });

  it("unlock lifts an account-wide block", async () => {
    const { service } = setup({ LOGIN_MAX_ATTEMPTS: 3 });
    for (let ip = 1; ip <= 20; ip++) await service.begin("e@x.test", `198.51.100.${ip}`);
    expect((await service.begin("e@x.test", "203.0.113.9")).allowed).toBe(false);
    expect(await service.unlock("E@x.test")).toBe(1);
    expect((await service.begin("e@x.test", "203.0.113.9")).allowed).toBe(true);
  });
});
