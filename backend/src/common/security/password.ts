import { ServiceUnavailableException } from "@nestjs/common";
import { argon2id, hash, verify } from "argon2";
import { ConcurrencyGate, GateFullError } from "./concurrency-gate.js";

/**
 * Password hashing parameters, pinned instead of relying on library defaults. argon2id with
 * 64 MiB, 3 passes and 4 lanes is above the OWASP Password Storage Cheat Sheet minimum
 * (argon2id, 19 MiB, 2 passes, 1 lane).
 */
export const PASSWORD_HASH_OPTIONS = { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

/**
 * argon2 runs on the libuv thread pool (64 MiB per hash). Hashes beyond HASH_CONCURRENCY wait in a bounded queue; when the
 * queue is full the request gets a 503 instead of starving DNS, fs and other async work on the same pool.
 */
const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const hashGate = new ConcurrencyGate(intFromEnv("HASH_CONCURRENCY", 4), intFromEnv("HASH_QUEUE", 64));

async function gated<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await hashGate.run(task);
  } catch (error) {
    if (error instanceof GateFullError) throw new ServiceUnavailableException("الخدمة مشغولة حالياً، حاول بعد لحظات");
    throw error;
  }
}

export function hashPassword(password: string): Promise<string> {
  return gated(() => hash(password, PASSWORD_HASH_OPTIONS));
}

/** False (never throws) for a wrong password or a malformed stored hash. */
export function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return gated(() => verify(storedHash, password).catch(() => false));
}
