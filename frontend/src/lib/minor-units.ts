/**
 * Money is integer minor units. The number of minor units per major unit depends on the currency (ISO 4217 exponent):
 * JPY 0, USD 2, KWD 3. Keep CURRENCY_EXPONENTS identical to backend/src/common/money/currency-exponents.ts
 * (a backend unit test compares the two). This file has no imports so that test can load it.
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

/** Exact decimal string for minor units ("1234", JPY -> "1234"; 1234, USD -> "12.34"), no floating point. */
export function minorToDecimal(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, "0");
  return exponent === 0 ? sign + digits : `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Localised currency string. The exact decimal string is passed to Intl (no minor / 10^n float division). */
export function formatMinorUnits(minor: number, currency: string, locale: string, withSymbol = true): string {
  const exponent = currencyExponent(currency);
  const options: Intl.NumberFormatOptions = withSymbol
    ? { style: "currency", currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }
    : { useGrouping: false, minimumFractionDigits: exponent, maximumFractionDigits: exponent };
  return new Intl.NumberFormat(locale, options).format(minorToDecimal(minor, currency) as unknown as number);
}

/**
 * Converts a typed decimal amount ("12.5", "1.005") to integer minor units with string arithmetic, so binary floating
 * point cannot shift the amount: Number("1.005") * 100 is 100.49999999999999. Returns NaN for anything that is not a
 * plain non-negative decimal with at most `exponent` fraction digits (the API then rejects it instead of storing a
 * rounded value).
 */
export function toMinorUnits(text: string, currency: string): number {
  const exponent = currencyExponent(currency);
  const match = /^(\d{1,12})(?:\.(\d*))?$/.exec(text.trim().replace(",", "."));
  if (!match) return Number.NaN;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent || (match[0].includes(".") && fraction.length === 0)) return Number.NaN;
  return Number(match[1] + fraction.padEnd(exponent, "0"));
}

/** Converts minor units between currencies via per-USD rates; rounds half up to a whole minor unit of the target. */
export function convertMinorUnits(minor: number, from: string, to: string, rateFrom: number, rateTo: number): number {
  if (!(Number.isFinite(rateFrom) && rateFrom > 0 && Number.isFinite(rateTo) && rateTo > 0)) return Number.NaN;
  const major = minor / 10 ** currencyExponent(from) / rateFrom * rateTo;
  return Math.round(major * 10 ** currencyExponent(to));
}
