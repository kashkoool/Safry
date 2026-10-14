/**
 * ISO 4217 minor-unit exponents (digits after the decimal point). Money is stored as integer minor units, so the
 * exponent says how many minor units make one major unit. Keep identical to frontend/src/lib/minor-units.ts
 * (a unit test compares the two). Adding a currency to `supportedCurrencies` needs no code change here when it is listed.
 */
export const CURRENCY_EXPONENTS = {
  TRY: 2, SYP: 2, SAR: 2, USD: 2, EUR: 2, EGP: 2,
  JPY: 0, KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3
} as const;

export function currencyExponent(code: string): number {
  const exponent = Object.hasOwn(CURRENCY_EXPONENTS, code) ? (CURRENCY_EXPONENTS as Record<string, number>)[code] : undefined;
  if (exponent === undefined) throw new Error(`Unknown currency exponent for ${code}`);
  return exponent;
}
