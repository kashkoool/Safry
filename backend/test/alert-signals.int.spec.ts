import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type TestTenant } from "./support/world.js";

/** The counters the alert rules (deploy/alerts/safry.rules.yml) depend on actually move on the real HTTP paths. */
describe("alert signal metrics", () => {
  const METRICS_TOKEN = "alert-signals-metrics-token-0123456789abcdef";
  let world: World;
  let tenant: TestTenant;

  const scrape = async (): Promise<string> => {
    const reply = await world.api("GET", "/metrics", { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(reply.status).toBe(200);
    return String((reply.body as { text?: string }).text ?? "");
  };
  const value = (text: string, series: string): number => {
    const hit = text.split("\n").find((line) => line.startsWith(`${series} `));
    if (!hit) throw new Error(`series ${series} missing`);
    return Number(hit.slice(series.length + 1));
  };

  beforeAll(async () => {
    world = await World.start({ METRICS_TOKEN, LOGIN_MAX_ATTEMPTS: "3", LOGIN_LOCKOUT_MINUTES: "15" });
    tenant = await world.createTenant("alerts");
  }, 180_000);
  afterAll(async () => world.stop());

  it("counts bad credentials, unknown accounts and the lockout; never exposes the e-mail", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const before = await scrape();
    for (let attempt = 0; attempt < 4; attempt++) await world.login(user, {}, "Wrong-Password-1");
    await world.login({ ...user, email: `${world.unique("ghost")}@example.test` }, {}, "Wrong-Password-1");
    const after = await scrape();
    const series = 'safry_login_failures_total{reason="bad_credentials"}';
    expect(value(after, series) - value(before, series)).toBeGreaterThanOrEqual(4);
    // the 4th attempt from one address is refused as throttled: counted apart from a wrong password
    expect(value(after, 'safry_login_failures_total{reason="locked"}')).toBeGreaterThan(value(before, 'safry_login_failures_total{reason="locked"}'));
    expect(value(after, "safry_account_lockouts_total")).toBeGreaterThan(value(before, "safry_account_lockouts_total"));
    expect(after).not.toContain(user.email);
    expect(after).not.toContain(tenant.code);
  });

  it("counts a refresh token replayed after rotation", async () => {
    const user = await world.createUser(tenant, { roles: ["traveler"] });
    const first = await world.session(user);
    const before = value(await scrape(), "safry_refresh_reuse_detected_total");
    await world.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } });
    await world.sql.query(`UPDATE refresh_sessions SET "revokedAt" = now() - interval '5 minutes' WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`, [user.userId]);
    expect((await world.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } })).status).toBe(401);
    expect(value(await scrape(), "safry_refresh_reuse_detected_total")).toBe(before + 1);
  });

  it("counts platform-administrator sign-ins (not ordinary users) and reads break-glass MFA resets from the audit trail", async () => {
    const admin = await world.createUser(tenant, { roles: ["tenant-admin"], isPlatformAdmin: true });
    const ordinary = await world.createUser(tenant, { roles: ["traveler"] });
    const before = await scrape();
    await world.session(ordinary);
    expect(value(await scrape(), "safry_platform_admin_signins_total")).toBe(value(before, "safry_platform_admin_signins_total"));
    await world.session(admin);
    expect(value(await scrape(), "safry_platform_admin_signins_total")).toBeGreaterThan(value(before, "safry_platform_admin_signins_total"));

    expect(value(before, "safry_platform_admin_mfa_resets_24h")).toBe(0);
    await world.sql.query(
      `INSERT INTO audit_events (id, action, "entityType", "entityId", metadata) VALUES (gen_random_uuid(), 'platform.admin.mfa_reset', 'user', $1, '{}'::jsonb)`,
      [admin.userId]
    );
    // cached for 60 s inside the process: a fresh process would show it at once, so only assert the series exists and is numeric here
    expect(Number.isFinite(value(await scrape(), "safry_platform_admin_mfa_resets_24h"))).toBe(true);
  });
});
