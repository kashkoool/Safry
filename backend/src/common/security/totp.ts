import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s step) with RFC 4648 base32 secrets. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/** Returns the matching time step (for replay protection) or null. Tolerates ±`window` steps of clock drift. */
export function verifyTotp(secret: string, code: string, now: number = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(code);
    // Evaluate every step so timing does not reveal which one matched.
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: string, account: string, issuer = "Safry Platform"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
