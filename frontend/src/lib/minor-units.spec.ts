import { describe, expect, it } from "vitest";
import { supportedCurrencies } from "./api";
import {
  CURRENCY_EXPONENTS,
  convertMinorUnits,
  currencyExponent,
  formatMinorUnits,
  minorToDecimal,
  toMinorUnits
} from "./minor-units";

describe("currency exponents", () => {
  it("maps every table currency to its ISO 4217 exponent", () => {
    expect(CURRENCY_EXPONENTS).toEqual({
      TRY: 2, SYP: 2, SAR: 2, USD: 2, EUR: 2, EGP: 2,
      JPY: 0, KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3
    });
    for (const [code, exponent] of Object.entries(CURRENCY_EXPONENTS)) {
      expect(currencyExponent(code), code).toBe(exponent);
    }
  });

  it("covers every supported app currency", () => {
    for (const code of supportedCurrencies) expect(currencyExponent(code), code).toBeGreaterThanOrEqual(0);
  });

  it("rejects unknown codes and inherited object keys", () => {
    for (const code of ["XXX", "", "usd", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => currencyExponent(code), code).toThrow();
    }
  });
});

describe("formatting and parsing", () => {
  it("formats JPY with 0, USD with 2 and KWD with 3 fraction digits", () => {
    expect(formatMinorUnits(1234, "JPY", "en-US", false)).toBe("1234");
    expect(formatMinorUnits(1234, "USD", "en-US", false)).toBe("12.34");
    expect(formatMinorUnits(1234, "KWD", "en-US", false)).toBe("1.234");
    expect(formatMinorUnits(1234, "USD", "en-US")).toMatch(/^\$12\.34$/);
  });

  it("converts minor units to exact decimal strings without floating point", () => {
    expect(minorToDecimal(1005, "KWD")).toBe("1.005");
    expect(minorToDecimal(5, "USD")).toBe("0.05");
    expect(minorToDecimal(-1250, "USD")).toBe("-12.50");
    expect(minorToDecimal(7, "JPY")).toBe("7");
  });

  it("round-trips format and parse for each exponent", () => {
    for (const code of ["JPY", "USD", "KWD"]) {
      for (const minor of [0, 1, 7, 99, 100, 1005, 99999, 123456789]) {
        const text = formatMinorUnits(minor, code, "en-US", false);
        expect(toMinorUnits(text, code), `${code} ${minor} via "${text}"`).toBe(minor);
      }
    }
  });

  it("parses typed decimals with exactly the currency's fraction digits", () => {
    expect(toMinorUnits("1234", "JPY")).toBe(1234);
    expect(toMinorUnits("12.5", "USD")).toBe(1250);
    expect(toMinorUnits("12,5", "USD")).toBe(1250);
    expect(toMinorUnits("1.000", "KWD")).toBe(1000);
    expect(toMinorUnits(" 3.25 ", "USD")).toBe(325);
  });

  it("rejects extra fraction digits instead of rounding them", () => {
    expect(toMinorUnits("1.005", "USD")).toBeNaN();
    expect(toMinorUnits("1.0005", "KWD")).toBeNaN();
    expect(toMinorUnits("1.1234", "KWD")).toBeNaN();
    expect(toMinorUnits("1.5", "JPY")).toBeNaN();
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const text of ["", " ", "abc", "-1", "+1", "1e3", "1.", "1..2", "1,000.5", "0x10", "Infinity", "1234567890123"]) {
      expect(toMinorUnits(text, "USD"), JSON.stringify(text)).toBeNaN();
    }
  });
});

describe("convertMinorUnits", () => {
  it("converts between currencies with different exponents", () => {
    expect(convertMinorUnits(100, "USD", "JPY", 1, 150)).toBe(150);
    expect(convertMinorUnits(100, "USD", "KWD", 1, 0.3)).toBe(300);
    expect(convertMinorUnits(1000, "JPY", "USD", 150, 1)).toBe(667);
  });

  it("rounds half values away from zero, also for negative amounts", () => {
    expect(convertMinorUnits(2, "USD", "JPY", 1, 375)).toBe(8); // 0.02 USD * 375 = 7.5 -> 8
    expect(convertMinorUnits(-2, "USD", "JPY", 1, 375)).toBe(-8); // -7.5 -> -8, not -7
    expect(convertMinorUnits(-100, "USD", "JPY", 1, 150.5)).toBe(-151);
  });

  it("returns NaN for zero, negative, NaN or infinite rates", () => {
    const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const rate of bad) {
      expect(convertMinorUnits(100, "USD", "JPY", rate, 150), `from ${rate}`).toBeNaN();
      expect(convertMinorUnits(100, "USD", "JPY", 1, rate), `to ${rate}`).toBeNaN();
    }
  });

  it("throws for unknown or inherited currency codes", () => {
    expect(() => convertMinorUnits(100, "toString", "USD", 1, 1)).toThrow();
    expect(() => convertMinorUnits(100, "USD", "constructor", 1, 1)).toThrow();
  });
});
