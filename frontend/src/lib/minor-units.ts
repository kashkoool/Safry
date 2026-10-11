/**
 * Converts a typed decimal amount ("12.5", "1.005") to integer minor units (cents) with string
 * arithmetic, so binary floating point cannot shift the amount: Number("1.005") * 100 is 100.49999999999999.
 * Returns NaN for anything that is not a plain non-negative decimal with at most two fraction digits
 * (the API then rejects it with a validation error instead of storing a rounded value).
 */
export function toMinorUnits(text: string): number {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(",", "."));
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
