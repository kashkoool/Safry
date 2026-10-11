import type { ExchangeRates, SupportedCurrency } from "./api";
import { currentLocale } from "../i18n/locale";

export const money = (cents: number, currency: SupportedCurrency = "SAR"): string =>
  new Intl.NumberFormat(currentLocale(), { style: "currency", currency }).format(cents / 100);

export function convertedMoney(cents: number, from: SupportedCurrency, to: SupportedCurrency,
  snapshot: ExchangeRates | null): string | null {
  if (from === to) return money(cents, from);
  if (!snapshot?.rates[from] || !snapshot.rates[to]) return null;
  const fresh = (currency: SupportedCurrency): boolean => currency === "USD" ||
    Date.now() - Date.parse(snapshot.rates[currency].date) < (currency === "SYP" ? 35 : 7) * 24 * 60 * 60 * 1000;
  if (!fresh(from) || !fresh(to)) return null;
  const converted = Math.round(cents / snapshot.rates[from].rate * snapshot.rates[to].rate);
  return money(converted, to);
}
