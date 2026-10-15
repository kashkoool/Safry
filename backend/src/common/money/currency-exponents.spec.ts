import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { supportedCurrencies } from "../../modules/travel-services/currencies.js";
import { CURRENCY_EXPONENTS, currencyExponent } from "./currency-exponents.js";

// The frontend table is read as TEXT (never imported), so the backend build does not pull frontend sources into its rootDir.
const FRONTEND_FILE = new URL("../../../../frontend/src/lib/minor-units.ts", import.meta.url);

function readFrontendExponents(): Record<string, number> {
  const source = readFileSync(FRONTEND_FILE, "utf8");
  const block = /export const CURRENCY_EXPONENTS = \{([\s\S]*?)\} as const;/.exec(source);
  const body = block?.[1];
  if (body === undefined) throw new Error("CURRENCY_EXPONENTS table not found in frontend/src/lib/minor-units.ts");
  const table: Record<string, number> = {};
  for (const match of body.matchAll(/\b([A-Z]{3}):\s*(\d+)/g)) table[match[1] ?? ""] = Number(match[2]);
  return table;
}

describe("currency exponent tables", () => {
  it("backend and frontend tables are identical", () => {
    const frontend = readFrontendExponents();
    expect(Object.keys(frontend).length).toBeGreaterThan(0);
    expect(frontend).toEqual(CURRENCY_EXPONENTS);
  });
  it("every supported currency has an exponent", () => {
    for (const code of supportedCurrencies) expect(currencyExponent(code)).toBe(2);
  });
  it("knows zero and three decimal currencies and throws on unknown codes", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(() => currencyExponent("XXX")).toThrow();
    expect(() => currencyExponent("toString")).toThrow();
  });
});
