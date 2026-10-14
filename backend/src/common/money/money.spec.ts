import { describe, expect, it } from "vitest";
import { MoneyRangeError, fromMinorUnits, multiplyMinorUnits, serializeMoney, toMinorUnits } from "./money.js";

const INT32_MAX = 2_147_483_647;
const SAFE = Number.MAX_SAFE_INTEGER;

describe("money conversions", () => {
  it("round-trips values around the old 32-bit ceiling", () => {
    for (const n of [0, 1, INT32_MAX - 1, INT32_MAX, INT32_MAX + 1, 4_294_967_296, SAFE])
      expect(fromMinorUnits(toMinorUnits(n))).toBe(n);
  });
  it("rejects fractions, NaN, infinities and unsafe integers on the way in", () => {
    for (const n of [1.5, NaN, Infinity, SAFE + 1, 2 ** 60]) expect(() => toMinorUnits(n)).toThrow(MoneyRangeError);
  });
  it("refuses to emit a bigint that a JSON number cannot hold exactly", () => {
    expect(() => fromMinorUnits(BigInt(SAFE) + 1n)).toThrow(MoneyRangeError);
    expect(() => fromMinorUnits(-BigInt(SAFE) - 1n)).toThrow(MoneyRangeError);
  });
  it("multiplies exactly and stops at the safe ceiling", () => {
    expect(multiplyMinorUnits(100_000_000n, 20, 90)).toBe(180_000_000_000n);
    expect(multiplyMinorUnits(BigInt(SAFE), 1)).toBe(BigInt(SAFE));
    expect(() => multiplyMinorUnits(BigInt(SAFE), 2)).toThrow(MoneyRangeError);
    expect(() => multiplyMinorUnits(2n ** 62n, 4)).toThrow(MoneyRangeError);
  });
});

describe("serializeMoney", () => {
  it("converts nested bigint, keeps dates and everything else", () => {
    const date = new Date("2026-10-14T00:00:00Z");
    const out = serializeMoney({ a: 5n, list: [{ b: 2_147_483_648n }], date, text: "x", none: null, flag: true }) as Record<string, unknown>;
    expect(out).toEqual({ a: 5, list: [{ b: 2_147_483_648 }], date, text: "x", none: null, flag: true });
    expect(out.date).toBe(date);
    expect(JSON.stringify(out)).toContain("2147483648");
  });
  it("throws for an unsafe stored value instead of rounding it", () => {
    expect(() => serializeMoney({ totalCents: BigInt(SAFE) + 1n })).toThrow(MoneyRangeError);
  });
});
