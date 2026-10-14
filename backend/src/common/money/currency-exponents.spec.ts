import { describe, expect, it } from "vitest";
import { supportedCurrencies } from "../../modules/travel-services/currencies.js";
import { CURRENCY_EXPONENTS, currencyExponent } from "./currency-exponents.js";

// Loaded by path (not a static import) so the backend build/typecheck does not pull frontend sources into its rootDir.
const frontend = (await import(new URL("../../../../frontend/src/lib/minor-units.ts", import.meta.url).href)) as {
  CURRENCY_EXPONENTS: Record<string, number>;
  currencyExponent: (code: string) => number;
  formatMinorUnits: (minor: number, currency: string, locale: string, withSymbol?: boolean) => string;
  toMinorUnits: (text: string, currency: string) => number;
  convertMinorUnits: (minor: number, from: string, to: string, rateFrom: number, rateTo: number) => number;
};
const { CURRENCY_EXPONENTS: FRONTEND_EXPONENTS, convertMinorUnits, currencyExponent: frontendExponent,
  formatMinorUnits, toMinorUnits } = frontend;

describe("currency exponent tables", () => {
  it("backend and frontend tables are identical", () => {
    expect(FRONTEND_EXPONENTS).toEqual(CURRENCY_EXPONENTS);
  });
  it("every supported currency has an exponent", () => {
    for (const code of supportedCurrencies) expect(currencyExponent(code)).toBe(2);
  });
  it("knows zero and three decimal currencies and throws on unknown codes", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(() => currencyExponent("XXX")).toThrow();
    expect(() => frontendExponent("XXX")).toThrow();
    expect(() => currencyExponent("toString")).toThrow();
    expect(() => frontendExponent("toString")).toThrow();
  });
});

describe("frontend minor-unit helpers", () => {
  it("formats with the currency exponent", () => {
    expect(formatMinorUnits(1234, "JPY", "en")).toBe("¥1,234");
    expect(formatMinorUnits(1234, "USD", "en")).toBe("$12.34");
    expect(formatMinorUnits(1234, "KWD", "en").replace(/\s/g, " ")).toBe("KWD 1.234");
  });
  it("parses exactly and round-trips", () => {
    expect(toMinorUnits("1234", "JPY")).toBe(1234);
    expect(toMinorUnits("12.5", "USD")).toBe(1250);
    expect(toMinorUnits("1.005", "USD")).toBeNaN();
    expect(toMinorUnits("1.005", "KWD")).toBe(1005);
    expect(toMinorUnits("1.5", "JPY")).toBeNaN();
    expect(toMinorUnits("1.2345", "KWD")).toBeNaN();
    for (const code of ["JPY", "USD", "KWD"]) expect(toMinorUnits(formatMinorUnits(7, code, "en", false), code)).toBe(7);
  });
  it("converts between currencies of different exponents", () => {
    // 100 USD cents (1.00 USD) at rate USD->JPY 150: 150 yen
    expect(convertMinorUnits(100, "USD", "JPY", 1, 150)).toBe(150);
    // 1.00 USD to KWD at 0.3: 0.300 KWD = 300 fils
    expect(convertMinorUnits(100, "USD", "KWD", 1, 0.3)).toBe(300);
    expect(convertMinorUnits(1000, "JPY", "USD", 150, 1)).toBe(667);
    expect(convertMinorUnits(-2, "USD", "JPY", 1, 375)).toBe(-8);
    expect(convertMinorUnits(2, "USD", "JPY", 1, 375)).toBe(8);
    expect(convertMinorUnits(100, "USD", "JPY", 0, 150)).toBeNaN();
    expect(convertMinorUnits(100, "USD", "JPY", 1, Number.POSITIVE_INFINITY)).toBeNaN();
  });
});
