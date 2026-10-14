import { randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { World, type Json, type Reply, type TestTenant } from "./support/world.js";

/**
 * Link-request endpoints must behave the same for known and unknown addresses even under concurrency (a burst as wide as
 * the connection pool), and a failure while issuing or mailing a link must never turn a committed change into a 500.
 */
const POOL = 5;
const BURST = 16;
const password = `Np-${randomBytes(9).toString("hex")}-Zz`;

interface Sent { to: string; text: string }

describe("credential links: pool-wide bursts and post-commit failures", () => {
  let world: World;
  let tenant: TestTenant;
  let outbox: () => Sent[];
  let transport: { send: (...args: unknown[]) => Promise<void> };
  let ipCounter = 0;
  const nextIp = (): string => `203.0.113.${++ipCounter}`;
  const api = (method: string, path: string, body: Json, session?: { accessToken: string }): Promise<Reply> =>
    world.api(method, path, { headers: { "x-forwarded-for": nextIp() }, body, ...(session ? { session } : {}) });

  beforeAll(async () => {
    world = await World.start({ DATABASE_POOL_MAX: String(POOL), TRUST_PROXY: "true", AUTH_MAIL_MIN_RESPONSE_MS: "250", NODE_ENV: "development", RATE_LIMIT_IP_PER_MINUTE: "10000", RATE_LIMIT_ACCOUNT_PER_MINUTE: "10000" });
    const { MAIL_TRANSPORT } = await import("../dist/modules/mail/mail.types.js");
    transport = world.app.get(MAIL_TRANSPORT) as typeof transport;
    outbox = () => [...(transport as unknown as { outbox: Sent[] }).outbox];
    tenant = await world.createTenant("resil");
  });
  afterAll(async () => {
    await world.stop();
  });

  const burst = async (path: string, emails: string[]): Promise<{ replies: Reply[]; ms: number }> => {
    const started = Date.now();
    const replies = await Promise.all(emails.map((email) => api("POST", path, { email })));
    return { replies, ms: Date.now() - started };
  };

  for (const path of ["/auth/password/forgot", "/auth/email/resend"]) {
    it(`${path}: a burst wider than the pool answers every unknown and known address alike, in comparable time`, async () => {
      const unknown = Array.from({ length: BURST }, () => `${world.unique("nobody")}@example.test`);
      const known = await Promise.all(Array.from({ length: BURST }, async () => {
        const user = await world.createUser(tenant, { roles: ["traveler"] });
        if (path === "/auth/email/resend") await world.prisma.user.update({ where: { id: user.userId }, data: { emailVerifiedAt: null } });
        return user.email;
      }));
      const unknownRun = await burst(path, unknown);
      const knownRun = await burst(path, known);
      for (const reply of [...unknownRun.replies, ...knownRun.replies]) {
        expect(reply.status).toBe(202);
        expect(reply.body).toEqual(unknownRun.replies[0]!.body);
      }
      const ratio = Math.max(unknownRun.ms, knownRun.ms) / Math.min(unknownRun.ms, knownRun.ms);
      expect(ratio, `unknown ${unknownRun.ms} ms, known ${knownRun.ms} ms`).toBeLessThan(3);
    }, 60_000);
  }

  for (const path of ["/auth/password/forgot", "/auth/email/resend"]) {
    it(`${path}: a known address answers like an unknown one when the link cannot be issued, and nothing logs the address`, async () => {
      const user = await world.createUser(tenant, { roles: ["traveler"] });
      if (path === "/auth/email/resend") await world.prisma.user.update({ where: { id: user.userId }, data: { emailVerifiedAt: null } });
      const logged = vi.spyOn(Logger.prototype, "error");
      await world.sql.query(`ALTER TABLE credential_tokens RENAME TO credential_tokens_off`);
      try {
        const started = Date.now();
        const unknown = await api("POST", path, { email: `${world.unique("ghost")}@example.test` });
        const unknownMs = Date.now() - started;
        const knownStarted = Date.now();
        const known = await api("POST", path, { email: user.email });
        const knownMs = Date.now() - knownStarted;
        expect(known.status).toBe(202);
        expect(known.body).toEqual(unknown.body);
        expect(Math.abs(knownMs - unknownMs), `unknown ${unknownMs} ms, known ${knownMs} ms`).toBeLessThan(500);
        expect(logged).toHaveBeenCalled();
        expect(JSON.stringify(logged.mock.calls)).not.toContain(user.email);
        expect(JSON.stringify(logged.mock.calls)).not.toContain("@");
      } finally {
        await world.sql.query(`ALTER TABLE IF EXISTS credential_tokens_off RENAME TO credential_tokens`);
        logged.mockRestore();
      }
    }, 30_000);
  }

  describe("a failure after the change committed", () => {
    const restoreSend = transportSendHolder();
    function transportSendHolder(): { original?: (...args: unknown[]) => Promise<void> } {
      return {};
    }
    const failMail = (): void => {
      restoreSend.original = transport.send.bind(transport);
      transport.send = () => Promise.reject(new Error("transport down"));
    };
    const restoreMail = (): void => {
      if (restoreSend.original) transport.send = restoreSend.original;
    };
    const breakTokens = async (): Promise<void> => void (await world.sql.query(`ALTER TABLE credential_tokens RENAME TO credential_tokens_off`));
    const fixTokens = async (): Promise<void> => void (await world.sql.query(`ALTER TABLE IF EXISTS credential_tokens_off RENAME TO credential_tokens`));
    const tokenIn = (mail: Sent | undefined): string => /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1] ?? "";

    for (const failure of ["mail transport", "issuing the link"] as const) {
      it(`registration still answers normally when ${failure} fails, and /auth/email/resend then works`, async () => {
        const email = `${world.unique("late")}@example.test`;
        if (failure === "mail transport") failMail();
        else await breakTokens();
        let reply: Reply;
        try {
          reply = await api("POST", "/auth/register/customer", { displayName: "Late Person", email, password, tenantCode: tenant.code });
        } finally {
          restoreMail();
          await fixTokens();
        }
        expect(reply.status).toBe(201);
        expect(await world.prisma.user.count({ where: { emailNormalized: email } })).toBe(1);
        // Forget the undelivered link: the account-level limit (1 link a minute) would otherwise suppress an immediate resend.
        await world.sql.query(`DELETE FROM credential_tokens WHERE "userId" = (SELECT id FROM users WHERE "emailNormalized" = $1)`, [email]);
        const before = outbox().filter((m) => m.to === email).length;
        const resend = await api("POST", "/auth/email/resend", { email });
        expect(resend.status).toBe(202);
        await vi_waitFor(() => outbox().filter((m) => m.to === email).length > before);
        const token = tokenIn(outbox().filter((m) => m.to === email).at(-1));
        expect((await api("POST", "/auth/email/verify", { token })).status).toBeLessThan(300);
      }, 30_000);
    }

    it("a platform address change that cannot mail its link still answers 200 and keeps the change", async () => {
      const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
      const session = await world.session(admin);
      const target = await world.createUser(tenant, { roles: ["traveler"] });
      const email = `${world.unique("moved")}@example.test`;
      await breakTokens();
      let reply: Reply;
      try {
        reply = await api("PATCH", `/platform/users/${target.userId}`, { email }, session);
      } finally {
        await fixTokens();
      }
      expect(reply.status).toBe(200);
      const row = await world.prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
      expect(row.emailNormalized).toBe(email);
      expect(row.emailVerifiedAt).toBeNull();
    }, 30_000);
  });
});

async function vi_waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for mail");
    await new Promise((r) => setTimeout(r, 50));
  }
}
