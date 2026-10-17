import { ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";

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

export function mapDatabaseError(error: unknown): HttpException | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { name, code, message, meta } = error as DatabaseError;
  const text = typeof message === "string" ? message : "";
  if (RLS_VIOLATION.test(text)) return new ForbiddenException("Access denied by the tenant isolation policy");
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
