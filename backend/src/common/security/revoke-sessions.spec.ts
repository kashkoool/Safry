import { describe, expect, it, vi } from "vitest";
import { revokeActiveSessions } from "./revoke-sessions.js";

describe("revokeActiveSessions", () => {
  it("only touches sessions that are not yet revoked, stamps revokedAt and returns the count", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const count = await revokeActiveSessions({ refreshSession: { updateMany } }, { userId: "u", id: { not: "keep" } });
    expect(count).toBe(3);
    const args = updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: { revokedAt: Date } };
    expect(args.where).toEqual({ userId: "u", id: { not: "keep" }, revokedAt: null });
    expect(args.data.revokedAt).toBeInstanceOf(Date);
  });
});
