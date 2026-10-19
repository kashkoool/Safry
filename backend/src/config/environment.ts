import { MAIL_POOL_DEFAULTS, type MailPool } from "../modules/mail/mail-limits.js";
import { isPlaceholder } from "./placeholders.js";

type Environment = Record<string, unknown>;

function integerInRange(config: Environment, key: string, min: number, max: number): void {
  const raw = config[key];
  if (raw !== undefined && (!Number.isInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)) throw new Error(`${key} must be an integer from ${min} to ${max}`);
}

function requiredString(config: Environment, key: string, minimumLength = 1): string {
  const value = config[key];
  if (typeof value !== "string" || value.length < minimumLength) {
    throw new Error(`${key} must be a string of at least ${minimumLength} characters`);
  }
  return value;
}

/** Optional operational tunables (all non-negative integers; defaults live where they are read). */
const TUNABLE_INTEGERS = ["DATABASE_CONNECT_TIMEOUT_MS", "DATABASE_IDLE_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS",
    "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", "DATABASE_TX_MAX_WAIT_MS", "DATABASE_TX_TIMEOUT_MS", "AUTH_CACHE_TTL_MS",
    "AUTH_CACHE_MAX_ENTRIES", "RATE_LIMIT_IP_PER_MINUTE", "RATE_LIMIT_ACCOUNT_PER_MINUTE", "RATE_LIMIT_USER_PER_MINUTE", "RATE_LIMIT_REFRESH_SESSION_PER_MINUTE", "RATE_LIMIT_REFRESH_INVALID_PER_MINUTE",
    "SHUTDOWN_DRAIN_MS", "SHUTDOWN_DEADLINE_MS", "HTTP_KEEP_ALIVE_TIMEOUT_MS", "HTTP_REQUEST_TIMEOUT_MS", "ACTIVITY_WRITE_INTERVAL_MS", "MAIL_TIMEOUT_MS", "AUTH_MAIL_MIN_RESPONSE_MS", "MAIL_RETRY_ATTEMPTS", "MAIL_RETRY_BASE_MS", "MAIL_BUDGET_REGISTRATION_PER_HOUR", "MAIL_BUDGET_REGISTRATION_PER_DAY", "MAIL_BUDGET_RESET_PER_HOUR", "MAIL_BUDGET_RESET_PER_DAY", "MAIL_BUDGET_SECURITY_PER_HOUR", "MAIL_BUDGET_SECURITY_PER_DAY", "MAIL_ADDRESS_REGISTRATION_PER_DAY", "MAIL_ADDRESS_RESET_PER_DAY",
    "BOOKING_MAX_PENDING_PER_TRAVELER", "BOOKING_MAX_DAYS_AHEAD", "BOOKING_PENDING_TTL_HOURS"];

/**
 * Shannon estimate of the bits in a secret (length x per-character entropy). It catches repeated,
 * patterned and short-alphabet values that pass a length check; it cannot prove randomness.
 */
export function estimatedEntropyBits(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let perChar = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * value.length;
}

const MIN_SECRET_BITS = 112;

function requiredSecret(config: Environment, key: string): string {
  const value = requiredString(config, key, 32);
  if (isPlaceholder(value)) throw new Error(`${key} is a placeholder value; generate one with: openssl rand -base64 48`);
  if (estimatedEntropyBits(value) < MIN_SECRET_BITS)
    throw new Error(`${key} has too little entropy; generate one with: openssl rand -base64 48`);
  return value;
}

const NODE_ENVIRONMENTS = ["development", "test", "staging", "production"];

/**
 * Production-grade safety defaults (https, Secure cookies, real mail transport, dedicated MFA key, no API docs, no localhost CORS,
 * TLS to the database) apply to production AND to staging, because a staging copy is routinely loaded with production data and
 * exposed to the internet. A staging environment that deliberately runs with development defaults (a local test stack with console
 * mail) must say so: ALLOW_NON_PRODUCTION_DEFAULTS=true, valid only with NODE_ENV=staging.
 */
export function isProductionLike(nodeEnv: unknown, allowNonProduction: unknown): boolean {
  return nodeEnv === "production" || (nodeEnv === "staging" && allowNonProduction !== "true");
}

/** The same decision from a ConfigService (or any key reader). */
export function productionLike(config: { get(key: string): unknown }): boolean {
  return isProductionLike(config.get("NODE_ENV"), config.get("ALLOW_NON_PRODUCTION_DEFAULTS"));
}

/** Hosts that are the machine itself or a single-label name on a private network (a compose service such as `postgres`). */
function isInternalHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || (!host.includes(".") && !host.includes(":"));
}

/** In production a database reached over a routable name must use TLS. */
export function assertDatabaseTls(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (isInternalHost(url.hostname)) return;
  const mode = url.searchParams.get("sslmode");
  if (mode !== "require" && mode !== "verify-ca" && mode !== "verify-full")
    throw new Error("DATABASE_URL must set sslmode=require (or verify-full) in production when the database is not on the internal network; set DATABASE_ALLOW_PLAINTEXT=true to accept the risk");
}

const MAIL_FROM = /^(?:[^<>\r\n]{1,100} <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/;

/** Transactional e-mail settings: resend needs a real key and sender, production never uses the console transport. */
export function assertMailConfig(config: Environment): void {
  const production = isProductionLike(config["NODE_ENV"], config["ALLOW_NON_PRODUCTION_DEFAULTS"]);
  const transport = config["MAIL_TRANSPORT"] ?? (production ? "resend" : "console");
  if (transport !== "resend" && transport !== "console") throw new Error("MAIL_TRANSPORT must be resend or console");
  if (production && transport === "console")
    throw new Error("MAIL_TRANSPORT=console is not allowed in production or staging (the e-mailed link is a credential); use resend, or set ALLOW_NON_PRODUCTION_DEFAULTS=true on a local staging stack");
  const base = config["APP_BASE_URL"];
  if (base !== undefined || production) {
    const value = requiredString(config, "APP_BASE_URL");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("APP_BASE_URL is not a valid URL");
    }
    if (url.origin !== value.replace(/\/+$/, "")) throw new Error("APP_BASE_URL must be a bare origin (scheme://host[:port], no path)");
    if (production && (url.protocol !== "https:" || isPlaceholder(value))) throw new Error("APP_BASE_URL must be a real https origin in production");
  }
  const attempts = config["MAIL_RETRY_ATTEMPTS"];
  if (attempts !== undefined && (!Number.isInteger(Number(attempts)) || Number(attempts) < 1 || Number(attempts) > 5))
    throw new Error("MAIL_RETRY_ATTEMPTS must be an integer from 1 (no retry) to 5");
  for (const [key, min, max] of [["BOOKING_MAX_PENDING_PER_TRAVELER", 1, 1000], ["BOOKING_MAX_DAYS_AHEAD", 1, 1825], ["BOOKING_PENDING_TTL_HOURS", 1, 720]] as const) {
    const raw = config[key];
    if (raw !== undefined && (!Number.isInteger(Number(raw)) || Number(raw) < min || Number(raw) > max))
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  for (const pool of ["REGISTRATION", "RESET", "SECURITY"]) {
    for (const [suffix, max] of [["PER_HOUR", 100_000], ["PER_DAY", 1_000_000]] as const) integerInRange(config, `MAIL_BUDGET_${pool}_${suffix}`, 1, max);
    // A pool whose hourly limit exceeds its daily one would be capped by the daily limit alone; that is a typo, so refuse it.
    if (Number(config[`MAIL_BUDGET_${pool}_PER_HOUR`] ?? MAIL_POOL_DEFAULTS[pool.toLowerCase() as MailPool].hour) > Number(config[`MAIL_BUDGET_${pool}_PER_DAY`] ?? MAIL_POOL_DEFAULTS[pool.toLowerCase() as MailPool].day))
      throw new Error(`MAIL_BUDGET_${pool}_PER_HOUR must not exceed MAIL_BUDGET_${pool}_PER_DAY`);
  }
  for (const scope of ["REGISTRATION", "RESET"]) integerInRange(config, `MAIL_ADDRESS_${scope}_PER_DAY`, 1, 100_000);
  integerInRange(config, "MAIL_RECIPIENT_RESET_PER_DAY", 1, 1000);
  const baseMs = config["MAIL_RETRY_BASE_MS"];
  if (baseMs !== undefined && (!Number.isInteger(Number(baseMs)) || Number(baseMs) > 30_000))
    throw new Error("MAIL_RETRY_BASE_MS must be an integer from 0 to 30000");
  if (transport === "resend") {
    const key = requiredString(config, "RESEND_API_KEY", 16);
    if (isPlaceholder(key)) throw new Error("RESEND_API_KEY is a placeholder value; create a key in the Resend dashboard");
    if (/\s/.test(key)) throw new Error("RESEND_API_KEY must not contain whitespace");
    const from = requiredString(config, "MAIL_FROM");
    if (!MAIL_FROM.test(from) || isPlaceholder(from)) throw new Error("MAIL_FROM must be a real sender such as \"Safry <no-reply@mail.your-domain.tld>\"");
  }
}

/** Hosts the loose staging mode may serve without a second flag: this machine, a `.localhost` name or a single-label compose name. */
function isLocalOrigin(url: URL): boolean {
  return isInternalHost(url.hostname) || url.hostname.endsWith(".localhost");
}

/**
 * ALLOW_NON_PRODUCTION_DEFAULTS=true switches off the production safety rules (console mail, open API docs, localhost CORS, non-Secure
 * cookies). If APP_BASE_URL or CORS_ORIGINS names a non-local https host the stack is probably reachable from the internet, so the loose
 * mode needs a second, explicit acknowledgement; otherwise a flag left on by accident can not silently weaken a public host.
 */
export function assertLooseModeNotPublic(config: Environment): void {
  if (config["ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST"] === "true") return;
  const named = [config["APP_BASE_URL"], ...(typeof config["CORS_ORIGINS"] === "string" ? config["CORS_ORIGINS"] : "").split(",")]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
  for (const value of named) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue; // malformed values are rejected by their own checks
    }
    if (url.protocol === "https:" && !isLocalOrigin(url))
      throw new Error(
        `ALLOW_NON_PRODUCTION_DEFAULTS=true with the public host ${url.host} is refused: the loose mode turns off production safety rules. Remove the flag, or set ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST=true if this stack really is a throwaway test environment`
      );
  }
}

export function validateEnvironment(config: Environment): Environment {
  const databaseUrl = requiredString(config, "DATABASE_URL");
  const nodeEnv = config["NODE_ENV"];
  if (nodeEnv !== undefined && (typeof nodeEnv !== "string" || !NODE_ENVIRONMENTS.includes(nodeEnv)))
    throw new Error(`NODE_ENV must be one of ${NODE_ENVIRONMENTS.join(", ")}`);
  const allowNonProduction = config["ALLOW_NON_PRODUCTION_DEFAULTS"];
  if (allowNonProduction !== undefined && allowNonProduction !== "true" && allowNonProduction !== "false")
    throw new Error("ALLOW_NON_PRODUCTION_DEFAULTS must be true or false");
  if (allowNonProduction === "true" && nodeEnv !== "staging")
    throw new Error("ALLOW_NON_PRODUCTION_DEFAULTS=true is only valid with NODE_ENV=staging");
  if (allowNonProduction === "true") assertLooseModeNotPublic(config);
  const productionGrade = isProductionLike(nodeEnv, allowNonProduction);
  if (productionGrade && config["DATABASE_ALLOW_PLAINTEXT"] !== "true") assertDatabaseTls(databaseUrl);
  // The demo seed creates known accounts. Only its own one-off job may carry these settings; a running production or staging API that does
  // has been given a local env file by mistake.
  if (productionGrade && (config["ALLOW_DEMO_SEED_IN_PRODUCTION"] === "true" || (typeof config["DEMO_SEED_PASSWORD"] === "string" && config["DEMO_SEED_PASSWORD"] !== "")))
    throw new Error("ALLOW_DEMO_SEED_IN_PRODUCTION=true and DEMO_SEED_PASSWORD must not be set in production or staging; they belong to the one-off demo seed job only");
  const jwtSecret = requiredSecret(config, "JWT_ACCESS_SECRET");
  // The TOTP seed key must not depend on the JWT secret: production needs a dedicated key.
  if (config["MFA_ENCRYPTION_KEY"] !== undefined || productionGrade) {
    if (config["MFA_ENCRYPTION_KEY"] === undefined) throw new Error("MFA_ENCRYPTION_KEY is required in production and staging");
    if (requiredSecret(config, "MFA_ENCRYPTION_KEY") === jwtSecret) throw new Error("MFA_ENCRYPTION_KEY must differ from JWT_ACCESS_SECRET");
  }

  const port = Number(config["PORT"] ?? 3000);
  const accessTtl = Number(config["JWT_ACCESS_TTL_SECONDS"] ?? 900);
  const refreshDays = Number(config["REFRESH_TOKEN_TTL_DAYS"] ?? 30);
  const sessionIdleMinutes = Number(config["SESSION_IDLE_TIMEOUT_MINUTES"] ?? 15);
  const sessionAbsoluteHours = Number(config["SESSION_ABSOLUTE_TIMEOUT_HOURS"] ?? 24);
  const maxAttempts = Number(config["LOGIN_MAX_ATTEMPTS"] ?? 5);
  const lockoutMinutes = Number(config["LOGIN_LOCKOUT_MINUTES"] ?? 15);
  const poolMax = config["DATABASE_POOL_MAX"] === undefined ? undefined : Number(config["DATABASE_POOL_MAX"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 3 || maxAttempts > 20) throw new Error("LOGIN_MAX_ATTEMPTS is invalid");
  if (config["LOGIN_PORTAL_REQUIRED"] !== undefined && config["LOGIN_PORTAL_REQUIRED"] !== "true" && config["LOGIN_PORTAL_REQUIRED"] !== "false")
    throw new Error("LOGIN_PORTAL_REQUIRED must be true or false");
  if (!Number.isInteger(lockoutMinutes) || lockoutMinutes < 1 || lockoutMinutes > 1440)
    throw new Error("LOGIN_LOCKOUT_MINUTES is invalid");
  if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100))
    throw new Error("DATABASE_POOL_MAX is invalid");
  for (const key of TUNABLE_INTEGERS) {
    const value = config[key];
    if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) throw new Error(`${key} must be a non-negative integer`);
  }
  if (config["DATABASE_RLS"] !== undefined && config["DATABASE_RLS"] !== "on" && config["DATABASE_RLS"] !== "off" && config["DATABASE_RLS"] !== "auto")
    throw new Error("DATABASE_RLS must be on, off or auto");
  // The database layer of tenant isolation can only be switched off on a developer machine or in tests.
  if (config["DATABASE_RLS"] === "off" && !["development", "test"].includes(String(config["NODE_ENV"])))
    throw new Error("DATABASE_RLS=off is only allowed when NODE_ENV is development or test");
  if (config["MFA_ENCRYPTION_KEY"] !== undefined && isPlaceholder(requiredString(config, "MFA_ENCRYPTION_KEY", 32)))
    throw new Error("MFA_ENCRYPTION_KEY is a placeholder value");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  if (!Number.isInteger(accessTtl) || accessTtl < 60 || accessTtl > 3600) throw new Error("JWT_ACCESS_TTL_SECONDS is invalid (60-3600)");
  if (!Number.isInteger(refreshDays) || refreshDays < 1) throw new Error("REFRESH_TOKEN_TTL_DAYS is invalid");
  if (!Number.isInteger(sessionIdleMinutes) || sessionIdleMinutes < 1 || sessionIdleMinutes > 1440)
    throw new Error("SESSION_IDLE_TIMEOUT_MINUTES is invalid");
  if (!Number.isInteger(sessionAbsoluteHours) || sessionAbsoluteHours < 1 || sessionAbsoluteHours > 720)
    throw new Error("SESSION_ABSOLUTE_TIMEOUT_HOURS is invalid (1-720)");
  assertMailConfig(config);
  // Retention and growth limits. The maintenance job (backend/scripts/db/purge.sh) reads the same names with the same ranges.
  integerInRange(config, "AUDIT_UNAUTH_ROWS_PER_ACCOUNT_HOUR", 1, 1000);
  integerInRange(config, "SESSION_RETENTION_DAYS", 1, 3650);
  integerInRange(config, "AUDIT_RETENTION_DAYS", 30, 3650);
  integerInRange(config, "CREDENTIAL_TOKEN_RETENTION_DAYS", 1, 3650);
  integerInRange(config, "LOGIN_THROTTLE_RETENTION_HOURS", 1, 720);
  integerInRange(config, "PURGE_BATCH_SIZE", 100, 100000);
  integerInRange(config, "BOOKING_PENDING_TTL_HOURS", 1, 720);

  const numeric = Object.fromEntries(TUNABLE_INTEGERS.filter((key) => config[key] !== undefined).map((key) => [key, Number(config[key])]));
  return { ...config, ...numeric, PORT: port, JWT_ACCESS_TTL_SECONDS: accessTtl, REFRESH_TOKEN_TTL_DAYS: refreshDays,
    SESSION_IDLE_TIMEOUT_MINUTES: sessionIdleMinutes, SESSION_ABSOLUTE_TIMEOUT_HOURS: sessionAbsoluteHours, LOGIN_MAX_ATTEMPTS: maxAttempts,
    LOGIN_LOCKOUT_MINUTES: lockoutMinutes, ...(poolMax === undefined ? {} : { DATABASE_POOL_MAX: poolMax }) };
}
