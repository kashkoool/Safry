import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, URL-safe. Only `hashToken(token)` is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time equality of two hex digests of the same length. */
export function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** A token as a client may send it: base64url of 32 bytes is exactly 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const RESET_TTL_MINUTES = 60;
export const VERIFY_TTL_HOURS = 24;
/** A new link for one account is refused (silently) when the previous one was sent less than this long ago ... */
export const MIN_RESEND_INTERVAL_MS = 60_000;
/** ... or when this many were sent within the last hour. */
export const MAX_LINKS_PER_HOUR = 5;
