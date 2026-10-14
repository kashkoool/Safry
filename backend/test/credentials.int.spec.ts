import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type Json, type Reply, type TestTenant, type TestUser } from "./support/world.js";

/**
 * Password reset and e-mail verification: tokens, expiry, single use, tampering, enumeration (answers and timing), session
 * invalidation, lockout reset and the "unverified accounts cannot sign in" rule. Mail goes through the in-memory transport.
 */
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const FLOOR_MS = 250;
/** A valid password generated per run: fixtures are never real credentials. */
const FRESH_PASSWORD = `Np-${randomBytes(9).toString("hex")}-Zz`;

interface Sent { to: string; subject: string; text: string; html: string }

describe("password reset and e-mail verification", () => {
  let world: World;
  let tenant: TestTenant;
  let outbox: () => Sent[];
  let clearOutbox: () => void;
  let ipCounter = 0;
  const nextIp = (): string => `192.0.2.${++ipCounter}`;

  const api = (method: string, path: string, body: Json, ip = nextIp()): Promise<Reply> =>
    world.api(method, path, { headers: { "x-forwarded-for": ip }, body });
  const login = (user: Pick<TestUser, "email" | "tenant">, password: string, ip = nextIp()): Promise<Reply> =>
    world.api("POST", "/auth/login", { headers: { "x-forwarded-for": ip }, body: { email: user.email, password, tenantCode: user.tenant.code } });
  const mailsTo = (email: string): Sent[] => outbox().filter((m) => m.to === email);
  const tokenIn = (mail: Sent | undefined): string => {
    const found = /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "");
    if (!found) throw new Error("no token in mail");
    return found[1]!;
  };
  /** The previous link of this purpose was sent more than a minute ago (the per-account resend interval). */
  const ageTokens = (email: string): Promise<unknown> =>
    world.sql.query(`UPDATE credential_tokens SET "createdAt" = now() - interval '5 minutes' WHERE "userId" = (SELECT id FROM users WHERE "emailNormalized" = $1)`, [email]);
  const register = async (): Promise<{ email: string; password: string; user: Pick<TestUser, "email" | "tenant"> }> => {
    const email = `${world.unique("reg")}@example.test`;
    const password = "Registered-Pass-2026";
    const reply = await api("POST", "/auth/register/customer", { displayName: "Reg Person", email, password, tenantCode: tenant.code });
    expect(reply.status).toBe(201);
    return { email, password, user: { email, tenant } };
  };

  beforeAll(async () => {
    world = await World.start({ TRUST_PROXY: "true", AUTH_MAIL_MIN_RESPONSE_MS: String(FLOOR_MS), LOGIN_MAX_ATTEMPTS: "5" });
    const { MAIL_TRANSPORT } = await import("../dist/modules/mail/mail.types.js");
    const transport = world.app.get(MAIL_TRANSPORT) as { outbox: Sent[]; clear(): void };
    outbox = () => [...transport.outbox];
    clearOutbox = () => transport.clear();
    tenant = await world.createTenant("cred");
  });
  afterAll(async () => {
    await world.stop();
  });

  describe("e-mail verification", () => {
    it("a self-registered account cannot sign in until it confirms; the refusal looks like any wrong login", async () => {
      const { email, password, user } = await register();
      const refused = await login(user, password);
      const wrong = await login(user, "Wrong-Password-12345");
      expect(refused.status).toBe(401);
      expect({ ...refused.body, requestId: 0, timestamp: 0 }).toEqual({ ...wrong.body, requestId: 0, timestamp: 0 });
      const mail = mailsTo(email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.text).toContain("http://localhost:3001/verify-email#token=");
      const token = tokenIn(mail[0]);
      const verified = await api("POST", "/auth/email/verify", { token });
      expect(verified.status).toBe(204);
      expect((await login(user, password)).status).toBe(200);
      const account = await world.prisma.user.findUniqueOrThrow({ where: { emailNormalized: email } });
      expect(account.emailVerifiedAt).not.toBeNull();
      const audit = await world.prisma.auditEvent.findMany({ where: { actorUserId: account.id, action: { in: ["identity.email.verified", "identity.login.failed"] } }, select: { action: true, metadata: true } });
      expect(audit.map((a) => a.action)).toContain("identity.email.verified");
      expect(JSON.stringify(audit)).toContain("email_unverified");
    });

    it("stores only the hash, and a token is single use", async () => {
      const { email, password, user } = await register();
      const token = tokenIn(mailsTo(email)[0]);
      const rows = await world.sql.query(`SELECT "tokenHash", purpose FROM credential_tokens WHERE "userId" = (SELECT id FROM users WHERE "emailNormalized" = $1)`, [email]);
      expect(rows.rows).toEqual([{ tokenHash: sha256(token), purpose: "EMAIL_VERIFICATION" }]);
      expect((await api("POST", "/auth/email/verify", { token })).status).toBe(204);
      const again = await api("POST", "/auth/email/verify", { token });
      expect(again.status).toBe(400);
      expect(again.body.message).toBe("Verification link is invalid or expired");
      expect((await login(user, password)).status).toBe(200);
    });

    it("rejects an expired, tampered, wrong-length and wrong-purpose token with the same 400", async () => {
      const { email } = await register();
      const token = tokenIn(mailsTo(email)[0]);
      const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
      for (const bad of [tampered, "A".repeat(43), "short", "x".repeat(200)]) {
        const reply = await api("POST", "/auth/email/verify", { token: bad });
        expect(reply.status, bad).toBe(400);
      }
      await world.sql.query(`UPDATE credential_tokens SET "expiresAt" = now() - interval '1 second' WHERE "tokenHash" = $1`, [sha256(token)]);
      expect((await api("POST", "/auth/email/verify", { token })).status).toBe(400);
      expect((await world.prisma.user.findUniqueOrThrow({ where: { emailNormalized: email } })).emailVerifiedAt).toBeNull();
    });

    it("a verification link stops working when the account address has changed, and cannot be used as a reset link", async () => {
      const { email } = await register();
      const token = tokenIn(mailsTo(email)[0]);
      expect((await api("POST", "/auth/password/reset", { token, newPassword: "Another-Pass-2026-x" })).status).toBe(400);
      await world.sql.query(`UPDATE users SET "emailNormalized" = $2, email = $2 WHERE "emailNormalized" = $1`, [email, `moved-${email}`]);
      expect((await api("POST", "/auth/email/verify", { token })).status).toBe(400);
    });

    it("resend: a new link voids the old one; unknown, verified and throttled requests are answered identically without mail", async () => {
      const { email, password, user } = await register();
      const first = tokenIn(mailsTo(email)[0]);
      const tooSoon = await api("POST", "/auth/email/resend", { email });
      expect(tooSoon.status).toBe(202);
      expect(mailsTo(email)).toHaveLength(1); // per-account interval: no second mail within a minute
      await ageTokens(email);
      const sent = await api("POST", "/auth/email/resend", { email });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({ accepted: true });
      expect(mailsTo(email)).toHaveLength(2);
      const second = tokenIn(mailsTo(email)[1]);
      expect(second).not.toBe(first);
      expect((await api("POST", "/auth/email/verify", { token: first })).status).toBe(400);
      expect((await api("POST", "/auth/email/verify", { token: second })).status).toBe(204);
      expect((await login(user, password)).status).toBe(200);
      const verifiedUser = await world.createUser(tenant, { roles: ["traveler"] });
      const before = outbox().length;
      const unknown = await api("POST", "/auth/email/resend", { email: `${world.unique("nobody")}@example.test` });
      const already = await api("POST", "/auth/email/resend", { email: verifiedUser.email });
      expect([unknown.status, already.status]).toEqual([202, 202]);
      expect(unknown.body).toEqual(sent.body);
      expect(already.body).toEqual(sent.body);
      expect(outbox()).toHaveLength(before);
    });
  });

  describe("password reset", () => {
    let user: TestUser;
    beforeAll(() => {
      clearOutbox();
    });
    const newUser = async (locale?: string): Promise<TestUser> => {
      const created = await world.createUser(tenant, { roles: ["traveler"] });
      if (locale) await world.prisma.user.update({ where: { id: created.userId }, data: { locale } });
      return created;
    };
    const requestLink = async (target: TestUser): Promise<string> => {
      const before = mailsTo(target.email).length;
      const reply = await api("POST", "/auth/password/forgot", { email: target.email });
      expect(reply.status).toBe(202);
      expect(mailsTo(target.email)).toHaveLength(before + 1);
      return tokenIn(mailsTo(target.email).at(-1));
    };

    it("answers 202 {accepted:true} for known and unknown addresses alike; only the known one is mailed", async () => {
      user = await newUser("en");
      const known = await api("POST", "/auth/password/forgot", { email: user.email });
      const unknown = await api("POST", "/auth/password/forgot", { email: `${world.unique("ghost")}@example.test` });
      expect([known.status, unknown.status]).toEqual([202, 202]);
      expect(known.body).toEqual({ accepted: true });
      expect(unknown.body).toEqual(known.body);
      expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body));
      expect(mailsTo(user.email)).toHaveLength(1);
      expect(outbox().filter((m) => m.to.includes("ghost"))).toHaveLength(0);
    });

    it("takes the same time for a known and an unknown address (fixed floor, mail sent after the answer)", async () => {
      const target = await newUser();
      const timed = async (email: string): Promise<number> => {
        const started = performance.now();
        await api("POST", "/auth/password/forgot", { email });
        return performance.now() - started;
      };
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 5; i++) {
        await ageTokens(target.email);
        known.push(await timed(target.email));
        unknown.push(await timed(`${world.unique("ghost")}@example.test`));
      }
      const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      expect(Math.min(...known, ...unknown)).toBeGreaterThanOrEqual(FLOOR_MS - 20);
      expect(Math.abs(median(known) - median(unknown))).toBeLessThan(120);
    });

    it("mails a link by locale: Arabic is right-to-left, English left-to-right, no remote images, token only in the fragment", async () => {
      const arabic = await newUser("ar-SA");
      const english = await newUser("en-GB");
      await requestLink(arabic);
      await requestLink(english);
      const ar = mailsTo(arabic.email)[0]!;
      const en = mailsTo(english.email)[0]!;
      expect(ar.html).toContain('dir="rtl"');
      expect(ar.html).toContain('lang="ar"');
      expect(ar.subject).toMatch(/[؀-ۿ]/);
      expect(en.html).toContain('dir="ltr"');
      expect(en.subject).toBe("Reset your Safry password");
      for (const mail of [ar, en]) {
        expect(mail.html).not.toMatch(/<img|src=|url\(|<script|<link/i);
        expect(mail.text).toMatch(/http:\/\/localhost:3001\/reset-password#token=[A-Za-z0-9_-]{43}/);
        expect(mail.text).not.toContain("?token");
        expect(mail.html).not.toContain("?token");
      }
    });

    it("resets the password: single use, ends every session, bumps the access-token version, lifts the lockout, sends a notice", async () => {
      const target = await newUser("en");
      const session = await world.session(target);
      expect((await world.api("GET", "/auth/me", { session })).status).toBe(200);
      // Lock the account's address out first.
      const lockIp = nextIp();
      for (let i = 0; i < 5; i++) await login(target, "Wrong-Password-12345", lockIp);
      expect((await login(target, target.password, lockIp)).status).toBe(401);
      const token = await requestLink(target);
      const newPassword = "A-Brand-New-Pass-2026";
      const done = await api("POST", "/auth/password/reset", { token, newPassword }, lockIp);
      expect(done.status).toBe(204);
      expect((await login(target, target.password)).status).toBe(401);
      expect((await login(target, newPassword, lockIp)).status).toBe(200); // lockout cleared for the address that reset
      expect((await world.api("GET", "/auth/me", { session })).status).toBe(401);
      expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: session.refreshToken } })).status).toBe(401);
      const active = await world.prisma.refreshSession.count({ where: { userId: target.userId, revokedAt: null, id: { not: undefined } } });
      expect(active).toBe(1); // only the login made after the reset
      const notice = mailsTo(target.email).at(-1)!;
      expect(notice.subject).toBe("Your Safry password was changed");
      expect(notice.text).not.toMatch(/token|#/i);
      const reuse = await api("POST", "/auth/password/reset", { token, newPassword: "Yet-Another-Pass-2026" });
      expect(reuse.status).toBe(400);
      expect(reuse.body.message).toBe("Reset link is invalid or expired");
      expect((await login(target, newPassword)).status).toBe(200);
      const audit = await world.prisma.auditEvent.findFirst({ where: { actorUserId: target.userId, action: "identity.password.reset" } });
      expect(audit?.metadata).toMatchObject({ sessionsEnded: 1 });
    });

    it("applies the password policy before consuming the token", async () => {
      const target = await newUser();
      const token = await requestLink(target);
      for (const newPassword of ["short", "            ", "x".repeat(129), 12345678901234]) {
        expect((await api("POST", "/auth/password/reset", { token, newPassword })).status, String(newPassword)).toBe(400);
      }
      expect((await api("POST", "/auth/password/reset", { token, newPassword: FRESH_PASSWORD })).status).toBe(204);
    });

    it("refuses an expired, tampered or foreign token with one generic 400 and changes nothing", async () => {
      const target = await newUser();
      const token = await requestLink(target);
      const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
      for (const bad of [tampered, "A".repeat(43), "", "x".repeat(300)])
        expect((await api("POST", "/auth/password/reset", { token: bad, newPassword: FRESH_PASSWORD })).status, bad.slice(0, 8)).toBe(400);
      await world.sql.query(`UPDATE credential_tokens SET "expiresAt" = now() - interval '1 second' WHERE "tokenHash" = $1`, [sha256(token)]);
      const expired = await api("POST", "/auth/password/reset", { token, newPassword: FRESH_PASSWORD });
      expect(expired.status).toBe(400);
      expect((await login(target, target.password)).status).toBe(200);
    });

    it("expires after one hour: the issued token carries a 60-minute lifetime", async () => {
      const target = await newUser();
      const token = await requestLink(target);
      const row = (await world.sql.query<{ minutes: number }>(`SELECT extract(epoch FROM ("expiresAt" - "createdAt")) / 60 AS minutes FROM credential_tokens WHERE "tokenHash" = $1`, [sha256(token)])).rows[0]!;
      expect(Math.round(Number(row.minutes))).toBe(60);
    });

    it("two simultaneous uses of one token: exactly one wins", async () => {
      const target = await newUser();
      const token = await requestLink(target);
      const replies = await Promise.all(
        ["Concurrent-Pass-One-2026", "Concurrent-Pass-Two-2026", "Concurrent-Pass-Three-2026", "Concurrent-Pass-Four-2026"].map((newPassword) => api("POST", "/auth/password/reset", { token, newPassword }))
      );
      expect(replies.filter((r) => r.status === 204)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 400)).toHaveLength(replies.length - 1);
    });

    it("a newer link voids the older one", async () => {
      const target = await newUser();
      const first = await requestLink(target);
      await ageTokens(target.email);
      const second = await requestLink(target);
      expect(second).not.toBe(first);
      expect((await api("POST", "/auth/password/reset", { token: first, newPassword: FRESH_PASSWORD })).status).toBe(400);
      expect((await api("POST", "/auth/password/reset", { token: second, newPassword: FRESH_PASSWORD })).status).toBe(204);
    });

    it("sends at most one link per minute and five per hour per account, and always answers 202", async () => {
      const target = await newUser();
      await requestLink(target);
      const burst = await api("POST", "/auth/password/forgot", { email: target.email });
      expect(burst.status).toBe(202);
      expect(mailsTo(target.email)).toHaveLength(1);
      for (let i = 0; i < 4; i++) {
        await ageTokens(target.email);
        await requestLink(target);
      }
      expect(mailsTo(target.email)).toHaveLength(5);
      await ageTokens(target.email);
      expect((await api("POST", "/auth/password/forgot", { email: target.email })).status).toBe(202);
      expect(mailsTo(target.email)).toHaveLength(5);
      const suppressed = await world.prisma.auditEvent.count({ where: { actorUserId: target.userId, action: "identity.password.reset_requested.suppressed" } });
      expect(suppressed).toBeGreaterThanOrEqual(2);
    });

    it("sends nothing for a disabled or deleted account, and a link issued before it was disabled is dead", async () => {
      const disabled = await newUser();
      const token = await requestLink(disabled);
      await world.prisma.user.update({ where: { id: disabled.userId }, data: { status: "DISABLED" } });
      expect((await api("POST", "/auth/password/reset", { token, newPassword: FRESH_PASSWORD })).status).toBe(400);
      const before = outbox().length;
      expect((await api("POST", "/auth/password/forgot", { email: disabled.email })).status).toBe(202);
      expect(outbox()).toHaveLength(before);
    });

    it("a link stops working when the account address changed after it was issued", async () => {
      const target = await newUser();
      const token = await requestLink(target);
      await world.sql.query(`UPDATE users SET "emailNormalized" = $2, email = $2 WHERE id = $1`, [target.userId, `new-${target.email}`]);
      expect((await api("POST", "/auth/password/reset", { token, newPassword: FRESH_PASSWORD })).status).toBe(400);
    });

    it("completing a reset also proves the mailbox: an unverified account becomes verified and can sign in", async () => {
      const { email, user: registered } = await register();
      const account = await world.prisma.user.findUniqueOrThrow({ where: { emailNormalized: email } });
      await ageTokens(email);
      const before = mailsTo(email).length;
      expect((await api("POST", "/auth/password/forgot", { email })).status).toBe(202);
      const token = tokenIn(mailsTo(email)[before]);
      const newPassword = "Reset-Before-Verifying-2026";
      expect((await api("POST", "/auth/password/reset", { token, newPassword })).status).toBe(204);
      expect((await world.prisma.user.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt).not.toBeNull();
      expect((await login(registered, newPassword)).status).toBe(200);
    });

    it("keeps working through the restricted login: token rows are invisible to a tenant-scoped session", async () => {
      const target = await newUser();
      await requestLink(target);
      const asTenant = await world.asRole({ tenantId: tenant.id }, `SELECT count(*)::int AS n FROM credential_tokens`);
      expect(asTenant.rows[0]!.n).toBe(0);
      const asSystem = await world.asRole({ bypass: true }, `SELECT count(*)::int AS n FROM credential_tokens WHERE "userId" = $1`, [target.userId]);
      expect(asSystem.rows[0]!.n).toBe(1);
    });
  });

  describe("registration and account creation rules", () => {
    it("registration answers that a confirmation was mailed, sends exactly one mail, and the account has no verification time", async () => {
      const email = `${world.unique("fresh")}@example.test`;
      const reply = await api("POST", "/auth/register/customer", { displayName: "Fresh Person", email, password: "Fresh-Registration-2026", tenantCode: tenant.code });
      expect(reply.status).toBe(201);
      expect(reply.body.message).toContain("رابط تأكيد");
      expect(mailsTo(email)).toHaveLength(1);
      expect((await world.prisma.user.findUniqueOrThrow({ where: { emailNormalized: email } })).emailVerifiedAt).toBeNull();
    });
  });
});
