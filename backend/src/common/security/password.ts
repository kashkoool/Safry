import { argon2id, hash, verify } from "argon2";
import { ServiceBusyException } from "../filters/service-busy.exception.js";
import { ConcurrencyGate, GateFullError, InFlightLimit } from "./concurrency-gate.js";

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
const HASH_CONCURRENCY = intFromEnv("HASH_CONCURRENCY", 4);
const HASH_QUEUE = intFromEnv("HASH_QUEUE", 64);
const hashGate = new ConcurrencyGate(HASH_CONCURRENCY, HASH_QUEUE);
// The database work before the hash (user lookup, throttle transaction) of admitted sign-ins runs through this small gate, so a wave
// can never take more than a few pooled connections at once and unrelated requests keep the rest. Waiters hold no connection.
const preHashGate = new ConcurrencyGate(intFromEnv("SIGNIN_DB_CONCURRENCY", 3), HASH_CONCURRENCY + HASH_QUEUE);

/** Runs the pre-hash database work of a sign-in with bounded concurrency (queued, never refused: callers are already admitted). */
export function runPreHash<T>(task: () => Promise<T>): Promise<T> {
  return preHashGate.run(task);
}

const signInsInFlight = new InFlightLimit(HASH_CONCURRENCY + HASH_QUEUE);

/**
 * Admission for a sign-in: taken before any database work, held until the answer is ready. A sign-in waiting for the hash gate
 * holds no connection, but the steps around it (lookup, throttle, session) do; capping the sign-ins in flight at the capacity of
 * the hash gate keeps their demand on the shared pool bounded and refuses the surplus with a retryable 503 that costs no throttle attempt.
 */
export function enterSignIn(): () => void {
  try {
    return signInsInFlight.enter();
  } catch (error) {
    if (error instanceof GateFullError) throw new ServiceBusyException();
    throw error;
  }
}

async function gated<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await hashGate.run(task);
  } catch (error) {
    if (error instanceof GateFullError) throw new ServiceBusyException();
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
