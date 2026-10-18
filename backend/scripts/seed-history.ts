/**
 * Seeds about two years of realistic, synthetic history into a LOCAL database, so that storage growth, retention jobs and
 * query plans can be tried at a believable size. Development tool only.
 *
 *   pnpm seed:history                          # defaults: 5 000 users, 50 000 bookings, ~26 months
 *   pnpm seed:history -- --scale 0.2           # a fifth of that (quick check)
 *   pnpm seed:history -- --scale 4 --seed 7    # four times the volume, another deterministic data set
 *   pnpm seed:history -- --url postgresql://postgres:postgres@127.0.0.1:55432/safry
 *
 * Safety (all enforced before any connection is used, see assertSafeTarget):
 *   - refuses when NODE_ENV=production;
 *   - refuses unless the database host is localhost, 127.0.0.1 or ::1 (the embedded PostgreSQL of the tests listens there);
 *   - refuses a database that already holds users with a non-"@example.test" address (a real dev database), unless --allow-existing;
 *   - refuses a database that already holds a previous history seed (use a fresh database).
 * Every address is "@example.test" and no password hash can verify, so the rows can never be used to sign in or to send mail.
 *
 * The data set is deterministic: the same --seed, --scale and --anchor produce the same rows. The anchor ("now" of the data) defaults
 * to the start of today in UTC. Rows are inserted in batches inside ONE transaction (all or nothing).
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

export interface SeedOptions {
  scale: number;
  users: number;
  bookings: number;
  months: number;
  sessionsPerUser: number;
  seed: number;
  anchor: Date;
  batch: number;
  allowExisting: boolean;
  url: string;
}

const DAY = 86_400_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const SEED_TENANT_PREFIX = "hist-";
export const SEED_EMAIL_DOMAIN = "example.test";

/** Throws unless it is safe to write synthetic history to this database. Pure: tested in seed-history.spec.ts. */
export function assertSafeTarget(env: Record<string, string | undefined>, url: string): void {
  if (env["NODE_ENV"] === "production") throw new Error("Refusing to seed history with NODE_ENV=production.");
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("The database URL is not a valid URL.");
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing to seed history into "${host}": only localhost, 127.0.0.1 and ::1 are accepted.`);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>, now = new Date()): SeedOptions {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === "allow-existing") bare.add(name);
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    }
  }
  const known = new Set(["scale", "users", "bookings", "months", "sessions-per-user", "seed", "anchor", "batch", "url", "allow-existing"]);
  for (const name of [...flags.keys(), ...bare]) if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = flags.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${name} must be a number between ${min} and ${max}`);
    return value;
  };
  const scale = num("scale", 1, 0.01, 100);
  const anchorRaw = flags.get("anchor");
  const anchor = anchorRaw ? new Date(anchorRaw) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(anchor.getTime())) throw new Error("--anchor must be an ISO date");
  const url = flags.get("url") ?? env["DATABASE_MIGRATE_URL"] ?? env["DATABASE_URL"] ?? "";
  if (!url) throw new Error("Give the database with --url or DATABASE_URL (a local database only).");
  return {
    scale,
    users: Math.round(num("users", 5000 * scale, 10, 5_000_000)),
    bookings: Math.round(num("bookings", 50_000 * scale, 10, 50_000_000)),
    months: Math.round(num("months", 26, 1, 120)),
    sessionsPerUser: num("sessions-per-user", 60, 0, 2000),
    seed: Math.round(num("seed", 20_261_018, 0, 2 ** 31)),
    anchor,
    batch: Math.round(num("batch", 5000, 100, 20_000)),
    allowExisting: bare.has("allow-existing"),
    url
  };
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic UUID (version-5 shaped) from a kind and an index. */
export function uid(kind: string, index: number): string {
  const h = createHash("sha1").update(`safry-history:${kind}:${index}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Column {
  name: string;
  type: string;
}

/** Collects rows for one table and writes them with INSERT ... SELECT FROM unnest(...) in batches. */
class Batcher {
  private rows: unknown[][] = [];
  total = 0;
  constructor(
    private readonly client: pg.Client,
    private readonly table: string,
    private readonly columns: Column[],
    private readonly size: number
  ) {}

  async add(row: unknown[]): Promise<void> {
    this.rows.push(row);
    if (this.rows.length >= this.size) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const names = this.columns.map((c) => `"${c.name}"`).join(", ");
    const selects = this.columns.map((c, i) => (c.type === "jsonb" ? `$${i + 1}::text[]` : `$${i + 1}::${c.type}[]`)).join(", ");
    const aliases = this.columns.map((_, i) => `c${i}`).join(", ");
    const outer = this.columns.map((c, i) => (c.type === "jsonb" ? `c${i}::jsonb` : `c${i}`)).join(", ");
    const sql = `INSERT INTO "${this.table}" (${names}) SELECT ${outer} FROM unnest(${selects}) AS x(${aliases})`;
    const params = this.columns.map((_, i) => this.rows.map((r) => r[i] ?? null));
    await this.client.query(sql, params);
    this.total += this.rows.length;
    this.rows = [];
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const CITIES = ["Riyadh", "Jeddah", "Makkah", "Madinah", "Dammam", "Doha", "Dubai", "Cairo", "Istanbul", "Amman"];
const PROVIDER_TYPES = ["UMRAH_COMPANY", "TRAVEL_COMPANY", "HOTEL", "AIRLINE", "TRANSPORT", "RESTAURANT", "VISA", "VISIT", "OTHER"];
const CATEGORIES = ["FLIGHT", "HOTEL", "TRANSPORT", "TOUR", "UMRAH", "PACKAGE", "RESTAURANT", "VISA", "VISIT", "OTHER"];
const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
];

export interface SeedSummary {
  tenants: number;
  organizations: number;
  users: number;
  memberships: number;
  services: number;
  bookings: number;
  refreshSessions: number;
  credentialTokens: number;
  auditEvents: number;
  loginThrottles: number;
}

export async function seedHistory(client: pg.Client, opts: SeedOptions, log: (line: string) => void = () => undefined): Promise<SeedSummary> {
  const rand = prng(opts.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const anchor = opts.anchor.getTime();
  const windowDays = Math.round(opts.months * 30.44);
  const start = anchor - windowDays * DAY;
  const tenantCount = Math.max(2, Math.round(5 * opts.scale));
  const orgCount = tenantCount * 3;
  const servicesPerOrg = 10;

  const existing = await client.query<{ hist: string; foreign: string }>(
    `SELECT (SELECT count(*) FROM tenants WHERE code LIKE $1)::text AS hist,
            (SELECT count(*) FROM users WHERE "emailNormalized" NOT LIKE $2)::text AS foreign`,
    [`${SEED_TENANT_PREFIX}%`, `%@${SEED_EMAIL_DOMAIN}`]
  );
  if (Number(existing.rows[0]!.hist) > 0) throw new Error("This database already holds a history seed. Use a fresh database (pnpm db:embedded creates one).");
  if (Number(existing.rows[0]!.foreign) > 0 && !opts.allowExisting)
    throw new Error("This database holds users that are not @example.test addresses. Refusing; use a fresh database or pass --allow-existing.");

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    await client.query("SET LOCAL synchronous_commit = off");
    const B = (table: string, columns: Column[]): Batcher => new Batcher(client, table, columns, opts.batch);
    const c = (name: string, type: string): Column => ({ name, type });

    const tenants = B("tenants", [c("id", "uuid"), c("code", "text"), c("name", "text"), c("status", "\"TenantStatus\""), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz"), c("archivedAt", "timestamptz")]);
    const roles = B("roles", [c("id", "uuid"), c("tenantId", "uuid"), c("code", "text"), c("name", "text"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const orgs = B("provider_organizations", [c("id", "uuid"), c("tenantId", "uuid"), c("name", "text"), c("nameEn", "text"), c("type", "\"ProviderType\""), c("city", "text"), c("contactEmail", "text"), c("licenseNumber", "text"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const users = B("users", [c("id", "uuid"), c("email", "text"), c("emailNormalized", "text"), c("passwordHash", "text"), c("displayName", "text"), c("phone", "text"), c("status", "\"UserStatus\""), c("emailVerifiedAt", "timestamptz"), c("deletedAt", "timestamptz"), c("disabledAt", "timestamptz"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const members = B("tenant_memberships", [c("id", "uuid"), c("tenantId", "uuid"), c("userId", "uuid"), c("status", "\"MembershipStatus\""), c("providerOrganizationId", "uuid"), c("revokedAt", "timestamptz"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const memberRoles = B("membership_roles", [c("membershipId", "uuid"), c("roleId", "uuid"), c("tenantId", "uuid")]);
    const services = B("travel_services", [c("id", "uuid"), c("tenantId", "uuid"), c("providerMembershipId", "uuid"), c("providerOrganizationId", "uuid"), c("title", "text"), c("description", "text"), c("category", "\"ServiceCategory\""), c("city", "text"), c("priceCents", "bigint"), c("status", "\"ServiceStatus\""), c("capacity", "int"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const bookings = B("bookings", [c("id", "uuid"), c("tenantId", "uuid"), c("serviceId", "uuid"), c("travelerMembershipId", "uuid"), c("travelersCount", "int"), c("totalCents", "bigint"), c("unitPriceCents", "bigint"), c("units", "int"), c("serviceDate", "date"), c("endDate", "date"), c("notes", "text"), c("status", "\"BookingStatus\""), c("idempotencyKey", "text"), c("createdAt", "timestamptz"), c("updatedAt", "timestamptz")]);
    const sessions = B("refresh_sessions", [c("id", "uuid"), c("tokenHash", "text"), c("userId", "uuid"), c("tenantId", "uuid"), c("membershipId", "uuid"), c("userAgent", "text"), c("ipAddress", "inet"), c("expiresAt", "timestamptz"), c("lastUsedAt", "timestamptz"), c("revokedAt", "timestamptz"), c("createdAt", "timestamptz"), c("familyId", "uuid"), c("authenticatedAt", "timestamptz")]);
    const tokens = B("credential_tokens", [c("id", "uuid"), c("userId", "uuid"), c("purpose", "\"CredentialTokenPurpose\""), c("tokenHash", "text"), c("email", "text"), c("expiresAt", "timestamptz"), c("usedAt", "timestamptz"), c("createdAt", "timestamptz")]);
    const audit = B("audit_events", [c("id", "uuid"), c("tenantId", "uuid"), c("actorUserId", "uuid"), c("requestId", "uuid"), c("action", "text"), c("entityType", "text"), c("entityId", "text"), c("ipAddress", "inet"), c("metadata", "jsonb"), c("occurredAt", "timestamptz")]);
    const throttles = B("login_throttles", [c("key", "text"), c("failures", "int"), c("windowStartedAt", "timestamptz"), c("blockedUntil", "timestamptz"), c("trustedUntil", "timestamptz"), c("accountKey", "text"), c("updatedAt", "timestamptz")]);

    let auditSeq = 0;
    const ip = (): string => `${rand() < 0.5 ? "203.0.113" : "198.51.100"}.${1 + Math.floor(rand() * 254)}`;
    const addAudit = (tenantId: string | null, actor: string | null, action: string, entityType: string | null, entityId: string | null, at: number, address: string | null, metadata: object = {}): Promise<void> => {
      auditSeq += 1;
      return audit.add([uid("audit", auditSeq), tenantId, actor, uid("req", auditSeq), action, entityType, entityId, address, JSON.stringify(metadata), iso(at)]);
    };

    // Tenants, one member role each, provider organizations.
    const tenantIds: string[] = [];
    const tenantRole: string[] = [];
    for (let t = 0; t < tenantCount; t += 1) {
      tenantIds.push(uid("tenant", t));
      tenantRole.push(uid("role", t));
      const archived = tenantCount >= 4 && t === tenantCount - 1;
      await tenants.add([tenantIds[t], `${SEED_TENANT_PREFIX}t${String(t + 1).padStart(3, "0")}`, `History Tenant ${t + 1}`, archived ? "ARCHIVED" : "ACTIVE", iso(start), iso(start), archived ? iso(anchor - 90 * DAY) : null]);
      await roles.add([tenantRole[t], tenantIds[t], "seed-member", "Seed member", iso(start), iso(start)]);
    }
    await tenants.flush();
    await roles.flush();
    const orgTenant: string[] = [];
    for (let o = 0; o < orgCount; o += 1) {
      orgTenant.push(tenantIds[o % tenantCount]!);
      await orgs.add([uid("org", o), orgTenant[o], `History Provider ${o + 1}`, `History Provider ${o + 1}`, PROVIDER_TYPES[o % PROVIDER_TYPES.length], pick(CITIES), `provider-${o + 1}@${SEED_EMAIL_DOMAIN}`, `LIC-${100000 + o}`, iso(start), iso(start)]);
    }
    await orgs.flush();

    // Users: one staff account per organization, then travelers. Account creation times grow linearly over the window.
    const total = orgCount + opts.users;
    interface UserRow { id: string; email: string; tenant: number; membership: string; createdAt: number; status: string; deletedAt: number | null; verified: boolean; staffOrg: number }
    const userRows: UserRow[] = [];
    for (let i = 0; i < total; i += 1) {
      const staff = i < orgCount;
      const createdAt = staff ? start + 1000 * (i + 1) : Math.floor(start + (anchor - start) * Math.sqrt(rand()));
      const tenant = staff ? i % tenantCount : Math.floor(rand() * tenantCount);
      const roll = rand();
      const status = staff ? "ACTIVE" : roll < 0.02 ? "DISABLED" : roll < 0.05 ? "SUSPENDED" : roll < 0.07 ? "INVITED" : "ACTIVE";
      const deleted = !staff && status === "DISABLED" && rand() < 0.75;
      const deletedAt = deleted ? Math.min(anchor - DAY, createdAt + Math.floor(rand() * 400) * DAY) : null;
      const verified = status !== "INVITED" && (staff || rand() < 0.97);
      const email = `${staff ? "staff" : "user"}${String(i + 1).padStart(6, "0")}@${SEED_EMAIL_DOMAIN}`;
      userRows.push({ id: uid("user", i), email, tenant, membership: uid("membership", i), createdAt, status, deletedAt, verified, staffOrg: staff ? i : -1 });
      const gone = status === "DISABLED" ? (deletedAt ?? createdAt + 30 * DAY) : null;
      await users.add([uid("user", i), email, email, "$argon2id$history-seed-not-a-real-hash", `History User ${i + 1}`, rand() < 0.6 ? `+9665${String(10_000_000 + i).slice(-8)}` : null, status, verified ? iso(createdAt + 60_000 + Math.floor(rand() * 3_600_000)) : null, deletedAt ? iso(deletedAt) : null, gone ? iso(gone) : null, iso(createdAt), iso(gone ?? createdAt)]);
    }
    await users.flush();
    for (const u of userRows) {
      const revoked = u.status === "DISABLED" || u.status === "SUSPENDED" ? (u.status === "DISABLED" ? "REVOKED" : "SUSPENDED") : u.status === "INVITED" ? "INVITED" : "ACTIVE";
      await members.add([u.membership, tenantIds[u.tenant], u.id, revoked, u.staffOrg >= 0 ? uid("org", u.staffOrg) : null, revoked === "REVOKED" ? iso(u.deletedAt ?? u.createdAt + 30 * DAY) : null, iso(u.createdAt), iso(u.createdAt)]);
    }
    await members.flush();
    for (const u of userRows) await memberRoles.add([u.membership, tenantRole[u.tenant], tenantIds[u.tenant]]);
    await memberRoles.flush();

    // Services: servicesPerOrg per organization, provided by that organization's staff membership.
    const tenantServices: string[][] = tenantIds.map(() => []);
    for (let o = 0; o < orgCount; o += 1) {
      const tenant = o % tenantCount;
      for (let s = 0; s < servicesPerOrg; s += 1) {
        const id = uid("service", o * servicesPerOrg + s);
        tenantServices[tenant]!.push(id);
        const roll = rand();
        await services.add([id, tenantIds[tenant], userRows[o]!.membership, uid("org", o), `Service ${o + 1}-${s + 1} (history seed)`, "Synthetic service used to size storage; not a real offer.", CATEGORIES[(o + s) % CATEGORIES.length], pick(CITIES), 20_000 + Math.floor(rand() * 900_000), roll < 0.8 ? "ACTIVE" : roll < 0.9 ? "INACTIVE" : "DRAFT", 20 + Math.floor(rand() * 200), iso(start + DAY * s), iso(start + DAY * s)]);
      }
    }
    await services.flush();
    const unitPrices = new Map<string, number>();

    // Bookings: a traveler books at some point after the account exists; status depends on age.
    const travelers = userRows.slice(orgCount).filter((u) => u.status !== "INVITED");
    const pendingTtl = 48 * 3_600_000;
    let bookingSeq = 0;
    for (let b = 0; b < opts.bookings && travelers.length > 0; b += 1) {
      const u = travelers[Math.floor(rand() * travelers.length)]!;
      const end = u.deletedAt ?? anchor;
      const createdAt = Math.floor(u.createdAt + (end - u.createdAt) * Math.sqrt(rand()));
      const service = pick(tenantServices[u.tenant]!);
      const unit = unitPrices.get(service) ?? 20_000 + Math.floor(rand() * 900_000);
      unitPrices.set(service, unit);
      const units = 1 + Math.floor(rand() * 4);
      const travelersCount = 1 + Math.floor(rand() * 6);
      const age = anchor - createdAt;
      const roll = rand();
      let status: string;
      if (age < pendingTtl) status = roll < 0.4 ? "PENDING" : roll < 0.9 ? "CONFIRMED" : "CANCELLED";
      else status = roll < 0.12 ? "PENDING" : roll < 0.74 ? "CONFIRMED" : "CANCELLED";
      const serviceDay = createdAt + (7 + Math.floor(rand() * 120)) * DAY;
      const endDay = rand() < 0.5 ? serviceDay + (1 + Math.floor(rand() * 14)) * DAY : null;
      const updatedAt = status === "PENDING" ? createdAt : createdAt + Math.floor(rand() * 3 * DAY);
      bookingSeq += 1;
      const key = rand() < 0.3 ? `seed-${bookingSeq}` : null;
      const id = uid("booking", bookingSeq);
      await bookings.add([id, tenantIds[u.tenant], service, u.membership, travelersCount, unit * units * travelersCount, unit, units, isoDate(serviceDay), endDay ? isoDate(endDay) : null, rand() < 0.15 ? "Synthetic note for storage sizing." : null, status, key, iso(createdAt), iso(updatedAt)]);
      await addAudit(tenantIds[u.tenant]!, u.id, "booking.create", "booking", id, createdAt, ip(), { serviceId: service, units, travelersCount });
      if (status === "CONFIRMED") await addAudit(tenantIds[u.tenant]!, u.id, "booking.update", "booking", id, updatedAt, ip(), { status: "CONFIRMED" });
      else if (status === "CANCELLED") await addAudit(tenantIds[u.tenant]!, u.id, rand() < 0.4 ? "booking.expire" : "booking.update", "booking", id, updatedAt, ip(), { status: "CANCELLED" });
    }
    await bookings.flush();

    // Sessions: families of rotated refresh tokens (access tokens last 15 minutes, so an active browser rotates about 4 times an hour).
    // Every issued session also has one audit row (login or refresh), exactly as the application writes them.
    let sessionSeq = 0;
    let failureSeq = 0;
    for (const u of userRows) {
      if (u.status === "INVITED") continue;
      const lifeEnd = u.deletedAt ?? anchor;
      const lifeDays = Math.max(0, (lifeEnd - u.createdAt) / DAY);
      const target = Math.round(opts.sessionsPerUser * (lifeDays / windowDays) * (0.4 + 1.2 * rand()));
      let made = 0;
      const tenantId = tenantIds[u.tenant]!;
      const agent = pick(AGENTS);
      const address = ip();
      while (made < target) {
        const length = Math.min(target - made, 1 + Math.floor(rand() * 12));
        const familyStart = Math.floor(u.createdAt + (lifeEnd - u.createdAt) * rand());
        const familyId = uid("family", sessionSeq + 1);
        for (let k = 0; k < length; k += 1) {
          sessionSeq += 1;
          const createdAt = Math.min(lifeEnd - 1, familyStart + k * 14 * 60_000);
          const last = k === length - 1;
          const nextAt = Math.min(lifeEnd, familyStart + (k + 1) * 14 * 60_000);
          const expiresAt = Math.min(createdAt + 30 * DAY, familyStart + DAY);
          const live = last && expiresAt > anchor && !u.deletedAt && u.status === "ACTIVE";
          const revokedAt = live ? null : last ? (rand() < 0.4 || u.deletedAt ? Math.min(nextAt, anchor) : null) : nextAt;
          const id = uid("session", sessionSeq);
          await sessions.add([id, sha256(`history-seed-token:${sessionSeq}`), u.id, tenantId, u.membership, agent, address, iso(Math.max(expiresAt, createdAt + 1000)), iso(createdAt), revokedAt ? iso(revokedAt) : null, iso(createdAt), familyId, iso(familyStart)]);
          await addAudit(tenantId, u.id, k === 0 ? "identity.login" : "identity.session.refresh", "refresh_session", id, createdAt, address);
        }
        made += length;
        if (rand() < 0.03) {
          failureSeq += 1;
          const at = familyStart - Math.floor(rand() * 60_000);
          await addAudit(null, null, "identity.login.failed", null, null, Math.max(start, at), address, { reason: "invalid_credentials" });
        }
      }
    }
    await sessions.flush();

    // Single-use links: one verification link per verified account; password resets for about a third of accounts.
    let tokenSeq = 0;
    for (const u of userRows) {
      if (u.staffOrg >= 0) continue;
      tokenSeq += 1;
      const used = u.verified;
      await tokens.add([uid("token", tokenSeq), u.id, "EMAIL_VERIFICATION", sha256(`history-seed-link:${tokenSeq}`), u.email, iso(u.createdAt + 24 * 3_600_000), used ? iso(u.createdAt + 120_000) : null, iso(u.createdAt)]);
      await addAudit(null, null, "identity.email.verification_requested", null, null, u.createdAt, ip(), { matched: true });
      if (used) await addAudit(tenantIds[u.tenant]!, u.id, "identity.email.verified", "user", u.id, u.createdAt + 120_000, ip());
      if (rand() < 0.33) {
        tokenSeq += 1;
        const at = Math.floor(u.createdAt + (anchor - u.createdAt) * rand());
        const resetUsed = rand() < 0.7;
        await tokens.add([uid("token", tokenSeq), u.id, "PASSWORD_RESET", sha256(`history-seed-link:${tokenSeq}`), u.email, iso(at + 3_600_000), resetUsed ? iso(at + 600_000) : null, iso(at)]);
        await addAudit(null, null, "identity.password.reset_requested", null, null, at, ip(), { matched: true });
        if (resetUsed) await addAudit(tenantIds[u.tenant]!, u.id, "identity.password.reset", "user", u.id, at + 600_000, ip());
      }
    }
    await tokens.flush();

    // Sign-in counters: about 2 % of accounts failed a sign-in at some point; rows are keyed by hashes, never by address.
    for (const u of userRows) {
      if (rand() >= 0.02) continue;
      const updatedAt = Math.floor(start + (anchor - start) * rand());
      const account = sha256(`history-seed-throttle-account:${u.id}`);
      const blocked = rand() < 0.1 ? iso(updatedAt + 15 * 60_000) : null;
      await throttles.add([account, 1 + Math.floor(rand() * 5), iso(updatedAt), blocked, null, null, iso(updatedAt)]);
      await throttles.add([sha256(`history-seed-throttle-pair:${u.id}`), 1 + Math.floor(rand() * 3), iso(updatedAt), null, rand() < 0.5 ? iso(updatedAt + 30 * DAY) : null, account, iso(updatedAt)]);
    }
    await throttles.flush();
    await audit.flush();

    await client.query("COMMIT");
    log(`done: ${auditSeq} audit rows, ${failureSeq} failed sign-ins recorded`);
    return {
      tenants: tenants.total,
      organizations: orgs.total,
      users: users.total,
      memberships: members.total,
      services: services.total,
      bookings: bookings.total,
      refreshSessions: sessions.total,
      credentialTokens: tokens.total,
      auditEvents: audit.total,
      loginThrottles: throttles.total
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  assertSafeTarget(process.env, opts.url);
  const client = new pg.Client({ connectionString: opts.url });
  await client.connect();
  try {
    console.log(`seeding history into ${new URL(opts.url).host}: ${opts.users} users, ${opts.bookings} bookings, ${opts.months} months, anchor ${opts.anchor.toISOString().slice(0, 10)}, seed ${opts.seed}`);
    const started = Date.now();
    const summary = await seedHistory(client, opts, console.log);
    await client.query("ANALYZE");
    console.table(summary);
    console.log(`finished in ${Math.round((Date.now() - started) / 1000)} s`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
