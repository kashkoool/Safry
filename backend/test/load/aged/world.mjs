// Session and fixture helpers shared by the sweep, the growth simulation, the soak and the probes.
import { call, ownerClient, docker } from "./common.mjs";

const { hotp, totpStep } = await import(new URL("../../../dist/common/security/totp.js", import.meta.url).href);

export class World {
  constructor(run, actors, dbName) {
    this.run = run;
    this.actors = actors;
    this.dbName = dbName;
    this.sessions = new Map(); // key -> { token, refreshToken, at, email, tenantCode }
    this.sql = null;
    this.mfaSecret = actors.platformMfaSecret ?? null;
  }
  async init() {
    this.sql = await ownerClient(this.run.ownerUrl(this.dbName));
    return this;
  }
  async close() { await this.sql?.end(); }

  /** Real login. Returns the token pair body or throws. */
  async login(email, tenantCode, password = this.actors.password, extra = {}) {
    const r = await call(this.run.base, "POST", "/auth/login", { body: { email, password, tenantCode, ...extra } });
    return r;
  }
  async session(key, email, tenantCode, maxAgeMs = this.maxAgeMs ?? 420_000) {
    const cur = this.sessions.get(key);
    if (cur && Date.now() - cur.at < maxAgeMs) return cur;
    // one login at a time per key: concurrent callers share it (otherwise a burst of requests would each sign in)
    this.pending ??= new Map();
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      let r = await this.login(email, tenantCode);
      if (r.status === 200 && r.body.mfaRequired) r = await this.verifyMfa(r.body.mfaToken);
      if (r.status !== 200) throw new Error(`login ${key} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      const s = { token: r.body.accessToken, refreshToken: r.body.refreshToken, at: Date.now(), email, tenantCode };
      this.sessions.set(key, s);
      return s;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
  async verifyMfa(mfaToken) {
    await this.resetMfaStep(this.actors.platform.email);
    const code = hotp(this.mfaSecret, totpStep());
    return call(this.run.base, "POST", "/auth/mfa/verify", { body: { mfaToken, code } });
  }
  async resetMfaStep(email) {
    await this.sql.query('UPDATE users SET "mfaLastStep" = NULL WHERE "emailNormalized" = $1', [email]);
  }
  totp(secret = this.mfaSecret) { return hotp(secret, totpStep()); }

  actor(name, i = 0) {
    const a = this.actors;
    switch (name) {
      case "traveler": { const t = a.travelers[i % 36]; return this.session(`traveler-${i % 36}`, t.email, a.tenantCode); }
      case "provider": return this.session("provider", a.provider.email, a.tenantCode);
      case "orgmgr": return this.session("orgmgr", a.orgmgr.email, a.tenantCode);
      case "admin": return this.session("admin", a.admin.email, a.tenantCode);
      case "platform": return this.session("platform", a.platform.email, a.platform.tenantCode);
      default: throw new Error(`unknown actor ${name}`);
    }
  }

  /** Enrols MFA for the platform administrator through the real endpoints (once per database). */
  async enrollPlatformMfa() {
    if (this.mfaSecret) return;
    const a = this.actors;
    const login = await this.login(a.platform.email, a.platform.tenantCode);
    if (login.status !== 200 || !login.body.accessToken) throw new Error(`platform login failed ${login.status} ${JSON.stringify(login.body)}`);
    const token = login.body.accessToken;
    const setup = await call(this.run.base, "POST", "/auth/mfa/setup", { token, body: { password: a.password } });
    if (setup.status !== 200) throw new Error(`mfa setup ${setup.status} ${JSON.stringify(setup.body)}`);
    const secret = setup.body.secret;
    const enable = await call(this.run.base, "POST", "/auth/mfa/enable", { token, body: { code: hotp(secret, totpStep()) } });
    if (enable.status !== 200) throw new Error(`mfa enable ${enable.status} ${JSON.stringify(enable.body)}`);
    this.mfaSecret = secret;
    a.platformMfaSecret = secret;
  }
  /** Fields a privileged platform call needs (step-up): current password and a fresh TOTP code. */
  async stepUp() {
    await this.resetMfaStep(this.actors.platform.email);
    return { currentPassword: this.actors.password, mfaCode: this.totp() };
  }
}

/** Most recent e-mailed link for an address, read from the API log (console mail transport, local runs only). */
export function latestLink(containerName, email, since = "10m") {
  const out = docker("logs", "--since", since, containerName);
  const lines = out.split("\n").filter((l) => l.includes(`to=${email}`) && l.includes("link="));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /link=(\S+?)"?[,}]?(\s|$)/.exec(last.replace(/\\"/g, '"'));
  return m ? m[1].replace(/["}]+$/, "") : null;
}
export const tokenOf = (link) => (link ? (/token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? null) : null);

/** All e-mailed links in the last `since`, as a Map(email -> last link), from ONE log read (console mail transport, local runs only). */
export function linksByEmail(containerName, since = "30m") {
  const out = docker("logs", "--since", since, containerName);
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line.includes("MailConsole")) continue;
    let message = "";
    try { message = JSON.parse(line).message ?? ""; } catch { continue; }
    const m = /to=(\S+) subject="[^"]*" link=(\S+)/.exec(message);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}
