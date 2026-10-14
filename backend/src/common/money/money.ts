/**
 * Money is stored as integer minor units (cents) in PostgreSQL `bigint` columns and handled as `bigint` inside the
 * services, so arithmetic is exact. JSON carries plain numbers: a value is converted only when it is a safe integer
 * (|n| <= 2^53 - 1), otherwise the conversion throws instead of silently losing precision.
 */
export const MAX_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export class MoneyRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyRangeError";
  }
}

/** API number -> stored bigint. Rejects fractions, NaN, Infinity and unsafe integers. */
export function toMinorUnits(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new MoneyRangeError("money amount must be a safe integer of minor units");
  return BigInt(value);
}

/** Stored bigint -> API number. Throws when the value cannot be represented exactly. */
export function fromMinorUnits(value: bigint): number {
  if (value > MAX_MINOR_UNITS || value < -MAX_MINOR_UNITS)
    throw new MoneyRangeError("money amount exceeds the largest exact JSON integer");
  return Number(value);
}

/** Exact product of non-negative integer factors; throws instead of exceeding the exact JSON range. */
export function multiplyMinorUnits(first: bigint, ...factors: Array<number | bigint>): bigint {
  let result = first;
  for (const factor of factors) result *= toMinorUnits(factor);
  if (result > MAX_MINOR_UNITS || result < -MAX_MINOR_UNITS)
    throw new MoneyRangeError("money amount exceeds the largest exact JSON integer");
  return result;
}

/**
 * Deep copy of a response payload with every bigint replaced by a number (Prisma returns `bigint` for BigInt columns and
 * `JSON.stringify` throws on it). Dates, arrays and plain objects are walked; other values pass through untouched.
 */
export function serializeMoney(value: unknown): unknown {
  if (typeof value === "bigint") return fromMinorUnits(value);
  if (Array.isArray(value)) return value.map(serializeMoney);
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = serializeMoney(entry);
    return out;
  }
  return value;
}
