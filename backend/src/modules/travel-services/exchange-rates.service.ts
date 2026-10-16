import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { supportedCurrencies, type SupportedCurrency } from "./currencies.js";

type RateRow = { date: string; base: string; quote: string; rate: number };

const HOUR_MS = 60 * 60 * 1000;
/** A fetched snapshot is served for one hour; an older one is only a fallback during an outage, for at most a day. */
const SNAPSHOT_TTL_MS = HOUR_MS;
const FALLBACK_MAX_AGE_MS = 24 * HOUR_MS;
/** After a failed fetch wait before asking again, so requests are not held for the full timeout each time. */
const RETRY_BACKOFF_MS = 30_000;
const FETCH_TIMEOUT_MS = 3000;

/** The feed is external: check the shape of every entry before reading a field (a null element must not throw). */
function isRateRow(value: unknown): value is RateRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.date === "string" && typeof row.base === "string" && typeof row.quote === "string" && typeof row.rate === "number";
}
type Snapshot = {
  base: "USD";
  source: string;
  fetchedAt: string;
  /** True when these are the last good rates served because the refresh failed; `fetchedAt` says how old they are. */
  stale: boolean;
  rates: Record<SupportedCurrency, { rate: number; date: string }>;
};

@Injectable()
export class ExchangeRatesService {
  private snapshot: Snapshot | null = null;
  private expiresAt = 0;
  private pending: Promise<Snapshot> | null = null;
  /** After a failed fetch do not retry on every request: each retry would hold a request for the full timeout. */
  private retryAt = 0;
  private readonly logger = new Logger(ExchangeRatesService.name);
  /** The current outage has been logged; reset by the next successful refresh. */
  private outageLogged = false;

  async latest(): Promise<Snapshot> {
    if (this.snapshot && Date.now() < this.expiresAt) return this.snapshot;
    if (!this.pending && Date.now() < this.retryAt) return this.fallback();
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = null; });
    try {
      return await this.pending;
    } catch (error) {
      this.retryAt = Date.now() + RETRY_BACKOFF_MS;
      if (!this.outageLogged) {
        this.outageLogged = true;
        const reason = error instanceof Error ? error.message : "unknown error";
        this.logger.warn(
          `Exchange rate refresh failed (${reason}); ${this.snapshot ? `serving the rates fetched at ${this.snapshot.fetchedAt} until they are 24 h old` : "no rates available"}`
        );
      }
      return this.fallback();
    }
  }

  private fallback(): Snapshot {
    // A short network outage must not quietly turn an old rate into a current price.
    if (this.snapshot && Date.now() - Date.parse(this.snapshot.fetchedAt) < FALLBACK_MAX_AGE_MS)
      return { ...this.snapshot, stale: true };
    throw new ServiceUnavailableException("أسعار الصرف غير متاحة حالياً؛ يرجى عرض السعر الأصلي فقط");
  }

  private async refresh(): Promise<Snapshot> {
    const response = await fetch(
      "https://api.frankfurter.dev/v2/rates?base=USD&quotes=TRY,SYP,SAR,EUR,EGP",
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "application/json" } }
    );
    if (!response.ok) throw new Error(`Exchange rate response ${response.status}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid exchange rate response");
    const rates = {} as Snapshot["rates"];
    const today = new Date().toISOString().slice(0, 10);
    rates.USD = { rate: 1, date: today };
    for (const row of rows) {
      if (!isRateRow(row)) continue;
      if (!supportedCurrencies.includes(row.quote as SupportedCurrency) || row.base !== "USD" ||
        !Number.isFinite(row.rate) || row.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(row.date))
        continue;
      rates[row.quote as SupportedCurrency] = { rate: row.rate, date: row.date };
    }
    if (supportedCurrencies.some((code) => !rates[code])) throw new Error("Missing supported currency rate");
    const snapshot: Snapshot = { base: "USD", source: "Frankfurter (official-source blended reference rates)",
      fetchedAt: new Date().toISOString(), stale: false, rates };
    this.snapshot = snapshot;
    if (this.outageLogged) {
      this.outageLogged = false;
      this.logger.log("Exchange rate refresh recovered");
    }
    this.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
    return snapshot;
  }
}
