import { describe, expect, it } from "vitest";
import { runPreHash } from "./password.js";

describe("runPreHash", () => {
  it("never runs more pre-hash database tasks at once than its small limit, and queues the rest instead of refusing", async () => {
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 40 }, () => runPreHash(task)));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
