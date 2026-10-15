import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { Response } from "express";

/**
 * Limits for POST /auth/refresh. A hard page reload refreshes once, so people behind one shared address (office, carrier NAT)
 * must not log each other out:
 *  - a credential that belongs to a live session is counted per session, never per address (the generous per-address
 *    ceiling is the global limiter that already runs before the handler);
 *  - a missing, unknown, expired or already used credential stays on the strict per-address limit.
 * The session bucket is keyed by the session family id, which survives rotation and is not a secret; the credential itself
 * is never stored, keyed or logged.
 */
@Injectable()
export class RefreshRateLimit {
  private readonly perSession: number;
  private readonly strictPerAddress: number;
  private readonly enabled: boolean;

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage, config: ConfigService) {
    this.enabled = config.get<string>("NODE_ENV") !== "test";
    this.perSession = config.get<number>("RATE_LIMIT_REFRESH_SESSION_PER_MINUTE", 30);
    this.strictPerAddress = config.get<number>("RATE_LIMIT_REFRESH_INVALID_PER_MINUTE", 20);
  }

  /** Counts one refresh attempt; throws 429 with Retry-After when its bucket is full. `familyId` is set for a live session. */
  async check(response: Response, address: string, familyId: string | null): Promise<void> {
    if (!this.enabled) return;
    const record = familyId
      ? await this.storage.increment(familyId, 60_000, this.perSession, 0, "refresh-session")
      : await this.storage.increment(address, 60_000, this.strictPerAddress, 0, "refresh-invalid");
    const limit = familyId ? this.perSession : this.strictPerAddress;
    if (record.totalHits > limit) {
      response.setHeader("Retry-After", String(record.timeToExpire));
      throw new HttpException("Too Many Requests", HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
