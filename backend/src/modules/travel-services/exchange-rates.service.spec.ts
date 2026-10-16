import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ExchangeRatesService } from "./exchange-rates.service.js";
import { CreateServiceDto } from "./dto/create-service.dto.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ExchangeRatesService", () => {
  it("accepts only the six configured service currencies", () => {
    const valid = plainToInstance(CreateServiceDto, { currency: "SYP" });
    const invalid = plainToInstance(CreateServiceDto, { currency: "GBP" });
    expect(validateSync(valid).find((error) => error.property === "currency")).toBeUndefined();
    expect(validateSync(invalid).find((error) => error.property === "currency")).toBeDefined();
  });
  it("requires all six supported currencies and caches a valid reference snapshot", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const rows = ["TRY", "SYP", "SAR", "EUR", "EGP"].map((quote, index) =>
      ({ date, base: "USD", quote, rate: index + 2 }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rows) });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ExchangeRatesService();
    const first = await service.latest();
    expect(first.rates.USD.rate).toBe(1);
    expect(first.rates.SYP.rate).toBe(3);
    expect(first.rates.EGP.date).toBe(date);
    expect(await service.latest()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips malformed feed entries (null, primitives, wrong types) instead of failing the whole snapshot", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const good = ["TRY", "SYP", "SAR", "EUR", "EGP"].map((quote, index) => ({ date, base: "USD", quote, rate: index + 2 }));
    const rows = [null, 7, "x", { quote: 1 }, { date, base: "USD", quote: "SAR", rate: "3.7" }, ...good];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rows) }));
    const snapshot = await new ExchangeRatesService().latest();
    expect(snapshot.rates.SAR.rate).toBe(4);
  });

  it("does not present an incomplete external feed as a usable conversion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
    await expect(new ExchangeRatesService().latest()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe("upstream failure handling", () => {
    const timeout = (): Error => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const feed = (): Array<{ date: string; base: string; quote: string; rate: number }> =>
      ["TRY", "SYP", "SAR", "EUR", "EGP"].map((quote, index) => ({ date: new Date().toISOString().slice(0, 10), base: "USD", quote, rate: index + 2 }));

    it("asks the upstream with a bounded timeout signal and shares one in-flight request between callers", async () => {
      const fetchMock = vi.fn().mockRejectedValue(timeout());
      vi.stubGlobal("fetch", fetchMock);
      const service = new ExchangeRatesService();
      const results = await Promise.allSettled([service.latest(), service.latest(), service.latest()]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });

    it("does not hammer a failing upstream: a failure is negative-cached for 30 s", async () => {
      const fetchMock = vi.fn().mockRejectedValue(timeout());
      vi.stubGlobal("fetch", fetchMock);
      const service = new ExchangeRatesService();
      await expect(service.latest()).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.latest()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("logs a failed refresh once per outage, marks the answer stale, and reports the recovery", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const info = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(feed()) }));
      const service = new ExchangeRatesService();
      expect((await service.latest()).stale).toBe(false);
      const internals = service as unknown as { expiresAt: number; retryAt: number };
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout()));
      for (let attempt = 0; attempt < 3; attempt++) {
        internals.expiresAt = 0;
        internals.retryAt = 0;
        expect((await service.latest()).stale).toBe(true);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/exchange rate/i);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(feed()) }));
      internals.expiresAt = 0;
      internals.retryAt = 0;
      expect((await service.latest()).stale).toBe(false);
      expect(info).toHaveBeenCalledTimes(1);
    });

    it("serves the last good snapshot for up to 24 h when a refresh fails, and refuses older data", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(feed()) }));
      const service = new ExchangeRatesService();
      const good = await service.latest();
      const internals = service as unknown as { expiresAt: number; retryAt: number; snapshot: { fetchedAt: string } };
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout()));
      internals.expiresAt = 0;
      expect(await service.latest()).toMatchObject({ fetchedAt: good.fetchedAt, rates: good.rates, stale: true });
      internals.expiresAt = 0;
      internals.retryAt = 0;
      internals.snapshot.fetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await expect(service.latest()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
