/**
 * Lets a frequent, idempotent "touch" write (last-activity) reach the database at most once per
 * interval per key. Per process: with N replicas a key may be written up to N times per interval.
 * Memory is bounded: when full, expired keys are dropped, then the oldest.
 */
export class WriteThrottle {
  private readonly last = new Map<string, number>();
  constructor(private readonly maxKeys = 50_000) {}

  /** True when the caller should perform the write (and records it). */
  shouldWrite(key: string, intervalMs: number, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < intervalMs) return false;
    this.last.delete(key);
    this.last.set(key, now);
    if (this.last.size > this.maxKeys) {
      for (const [k, at] of this.last) {
        if (now - at >= intervalMs) this.last.delete(k);
        if (this.last.size <= this.maxKeys) break;
      }
      while (this.last.size > this.maxKeys) this.last.delete(this.last.keys().next().value as string);
    }
    return true;
  }

  /** Forget a key (e.g. a failed write must be retried by the next call). */
  forget(key: string): void {
    this.last.delete(key);
  }
}
