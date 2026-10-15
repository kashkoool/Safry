import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("./api", () => ({ request: (...args: unknown[]) => request(...args) }));
vi.mock("./cache", () => ({ cached: (_key: string, _ttl: number, load: () => unknown) => load(), invalidate: vi.fn() }));

const { platform } = await import("./platform");

describe("platform.records", () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it("builds the query string and omits empty filters", () => {
    void platform.records("accounts", 2, "", "");
    expect(request).toHaveBeenCalledWith("/platform/records/accounts?page=2", { signal: undefined });
  });

  it("includes tenant and search filters and encodes the kind segment", () => {
    void platform.records("a/b c", 1, "tenant-1", "ali ce&x=1");
    const [path] = request.mock.calls[0] as [string];
    expect(path).toBe("/platform/records/a%2Fb%20c?page=1&tenantId=tenant-1&q=ali+ce%26x%3D1");
  });
});

describe("platform.unlockLogin", () => {
  it("posts the e-mail in the JSON body, never in the URL", () => {
    request.mockResolvedValue(undefined);
    void platform.unlockLogin("user@example.com");
    expect(request).toHaveBeenCalledWith("/auth/login-throttle/unlock", {
      method: "POST",
      body: JSON.stringify({ email: "user@example.com" })
    });
  });
});
