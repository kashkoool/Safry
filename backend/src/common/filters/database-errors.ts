import { ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { ServiceBusyException } from "./service-busy.exception.js";

interface DatabaseError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  meta?: unknown;
}

const RETRY_MESSAGE = "The request collided with another change; please try again";
/** SQLSTATE of a deadlock (40P01) and of a lock that could not be acquired in time (55P03). */
const CONTENTION_SQLSTATES = new Set(["40P01", "55P03"]);
function isContention(meta: unknown): boolean {
  return typeof meta === "object" && meta !== null && "code" in meta && typeof meta.code === "string" && CONTENTION_SQLSTATES.has(meta.code);
}

// Only the PostgreSQL message of a real policy violation. A bare 42501 also means "permission denied for table" (a missing GRANT),
// which is a deployment fault: it must stay a 500 with an internal log and raise the 5xx alarm, not look like a client 403.
const RLS_VIOLATION = /violates row-level security policy/i;

/**
 * Translates database failures that escaped a service into the HTTP error a client can act on,
 * without leaking table or column names. Returns undefined for errors that are not database errors.
 */
/** True for a Prisma unique-constraint violation (P2002). The one shared test; do not re-implement it inline. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

// Prisma: P2024 pool wait timeout, P2037 too many connections, P1008 operation timed out. P2028 only for its "could not start in time" cause (below).
const OVERLOAD_PRISMA_CODES = new Set(["P2024", "P2037", "P1008"]);
// P2028 is a general transaction error; an already-closed transaction is not cured by waiting, so only the pool-wait cause is retryable.
const TRANSACTION_START_TIMEOUT = /unable to start a transaction in the given time/i;
// PostgreSQL: 53300 too_many_connections, 57P03 cannot_connect_now (starting up / shutting down).
const OVERLOAD_PG_CODES = new Set(["53300", "57P03"]);
// node-postgres pool errors that carry no code.
const POOL_EXHAUSTED = /^(timeout exceeded when trying to connect|sorry, too many clients already)$/i;

function isOverload(error: DatabaseError, text: string): boolean {
  const { name, code } = error;
  if (name === "PrismaClientKnownRequestError" && typeof code === "string") return OVERLOAD_PRISMA_CODES.has(code) || (code === "P2028" && TRANSACTION_START_TIMEOUT.test(text));
  if (typeof code === "string" && OVERLOAD_PG_CODES.has(code) && (error as { severity?: unknown }).severity !== undefined) return true;
  return POOL_EXHAUSTED.test(text.trim());
}

export function mapDatabaseError(error: unknown): HttpException | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { name, code, message, meta } = error as DatabaseError;
  const text = typeof message === "string" ? message : "";
  if (RLS_VIOLATION.test(text)) return new ForbiddenException("Access denied by the tenant isolation policy");
  if (isOverload(error, text)) return new ServiceBusyException();
  if (name !== "PrismaClientKnownRequestError" || typeof code !== "string") return undefined;
  switch (code) {
    case "P2002":
      return new ConflictException("A record with the same unique value already exists");
    case "P2003":
      return new ConflictException("The record is still referenced by other records or references a missing one");
    case "P2025":
      return new NotFoundException("The requested record was not found");
    case "P2034": // transaction aborted by a write conflict or deadlock
      return new ConflictException(RETRY_MESSAGE);
    case "P2010": // raw query failed: only the contention SQLSTATEs are translated, anything else stays a 500
      return isContention(meta) ? new ConflictException(RETRY_MESSAGE) : undefined;
    default:
      return undefined;
  }
}
