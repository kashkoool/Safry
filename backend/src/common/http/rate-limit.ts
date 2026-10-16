import { HttpException, HttpStatus, Inject, Injectable, Logger, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerStorage, ThrottlerStorageService } from "@nestjs/throttler";
import { Redis } from "ioredis";
import type { Request } from "express";
import type { AuthUser } from "../security/auth-user.js";
import { productionLike } from "../../config/environment.js";

/** Atomic fixed-window counter with an optional block period, shared by every replica through Redis. */
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
local blockedFor = redis.call('PTTL', blockKey)
if blockedFor > 0 then
  return {tonumber(redis.call('GET', key) or limit + 1), redis.call('PTTL', key), 1, blockedFor}
end
local hits = redis.call('INCR', key)
if hits == 1 then redis.call('PEXPIRE', key, ttl) end
local expires = redis.call('PTTL', key)
if hits > limit and blockMs > 0 then
  redis.call('SET', blockKey, '1', 'PX', blockMs)
  return {hits, expires, 1, blockMs}
end
return {hits, expires, hits > limit and 1 or 0, 0}
`;

/** Throttler storage backed by Redis so that limits hold across replicas and restarts. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<Awaited<ReturnType<ThrottlerStorage["increment"]>>> {
    const redisKey = `safry:rl:${throttlerName}:${key}`;
    const [totalHits, timeToExpire, blocked, timeToBlockExpire] = (await this.redis.eval(
      INCREMENT_SCRIPT, 2, redisKey, `${redisKey}:block`, ttl, limit, blockDuration
    )) as [number, number, number, number];
    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(timeToExpire / 1000)),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.max(0, Math.ceil(timeToBlockExpire / 1000))
    };
  }
}

/**
 * A Redis that accepts the connection but never answers (stalled, packet loss, failover) must not hold requests: without a command
 * timeout each of up to three limiter calls per request waited until the OS gave up. A timed-out command rejects,
 * and FailoverThrottlerStorage then answers from the in-process store.
 */
export const REDIS_OPTIONS = { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false, commandTimeout: 250, connectTimeout: 2000 } as const;

/** Process-wide rate-limit store health, read by /health/ready and /metrics. */
export const rateLimitState = { degraded: false, fallbackTotal: 0 };
export function resetRateLimitState(): void {
  rateLimitState.degraded = false;
  rateLimitState.fallbackTotal = 0;
}

/**
 * Fail-degraded: when Redis errors, the in-process store answers instead, so limits
 * still hold per instance and no route returns 500. Logged once per outage; recovery is logged once.
 * Readiness reports "degraded" (HTTP 200: the app serves traffic) and /metrics counts fallbacks.
 */
export class FailoverThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger("RateLimit");
  constructor(private readonly primary: ThrottlerStorage, private readonly fallback: ThrottlerStorage) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<Awaited<ReturnType<ThrottlerStorage["increment"]>>> {
    try {
      const record = await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
      if (rateLimitState.degraded) {
        rateLimitState.degraded = false;
        this.logger.log("Redis rate-limit store recovered; shared limits are active again");
      }
      return record;
    } catch (error) {
      rateLimitState.fallbackTotal += 1;
      if (!rateLimitState.degraded) {
        rateLimitState.degraded = true;
        this.logger.error(`Redis rate-limit store unavailable (${(error as Error).message}); falling back to per-instance in-process limits until it recovers`);
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}

/**
 * Chooses the rate-limit store. In-process is the default (single replica, tests); in production it
 * is loudly reported because limits then multiply with the number of replicas and reset on deploy.
 */
export function createThrottlerStorage(config: ConfigService): ThrottlerStorage {
  const logger = new Logger("RateLimit");
  const url = config.get<string>("RATE_LIMIT_REDIS_URL");
  if (url) {
    const redis = new Redis(url, { ...REDIS_OPTIONS });
    redis.on("error", (error: Error) => logger.error(`Redis rate-limit store error: ${error.message}`));
    return new FailoverThrottlerStorage(new RedisThrottlerStorage(redis), new ThrottlerStorageService());
  }
  if (productionLike(config))
    logger.error(
      "RATE_LIMIT_REDIS_URL is not set: rate limits are kept in process memory. With N replicas the effective limits are N times higher and reset on every restart. Set RATE_LIMIT_REDIS_URL before running more than one replica."
    );
  return new ThrottlerStorageService();
}

/** Normalised account identifier from the request body (login, registration, password flows). */
export function accountOf(request: Request): string | undefined {
  const body: unknown = request.body;
  const email = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["email"] : undefined;
  return typeof email === "string" && email.length > 0 && email.length < 255 ? email.trim().toLowerCase() : undefined;
}

/**
 * Tracker of the "account" throttler: e-mail plus client address. Keyed on the e-mail alone, any
 * stranger could exhaust a victim's bucket and lock the real user out. Guessing one
 * account from many addresses is bounded by the database lockout (AccountSecurityService: per-account
 * and per-pair counters, progressive block), which never denies the owner's own address.
 */
export function accountTracker(request: Request): string {
  const account = accountOf(request);
  return account ? `${account}|${request.ip ?? ""}` : "";
}

/**
 * Per-account limit that follows a verified identity. Runs after JwtAuthGuard, so the key is the
 * authenticated user id and can not be chosen by a caller (unlike a decoded-but-unverified token).
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly config: ConfigService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get<string>("NODE_ENV") === "test") return true;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) return true;
    const limit = this.config.get<number>("RATE_LIMIT_USER_PER_MINUTE", 600);
    const record = await this.storage.increment(`${user.tenantId}:${user.userId}`, 60_000, limit, 0, "user");
    if (record.totalHits > limit) {
      context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>().setHeader("Retry-After", String(record.timeToExpire));
      throw new HttpException("Too Many Requests", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
