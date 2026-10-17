import { describe, expect, it } from "vitest";
import { ConcurrencyGate, GateFullError, InFlightLimit } from "./concurrency-gate.js";

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("ConcurrencyGate", () => {
  it("never runs more than `limit` tasks at once and runs queued tasks in order", async () => {
    const gate = new ConcurrencyGate(2, 10);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const tasks = gates.map((g, i) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await g.promise;
        running -= 1;
      })
    );
    await Promise.resolve();
    expect(running).toBe(2);
    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("rejects with GateFullError when the waiting queue is full and keeps serving afterwards", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const second = gate.run(() => Promise.resolve("queued"));
    await expect(gate.run(() => Promise.resolve("overflow"))).rejects.toBeInstanceOf(GateFullError);
    hold.resolve();
    await first;
    await expect(second).resolves.toBe("queued");
    await expect(gate.run(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("releases the slot when a task throws", async () => {
    const gate = new ConcurrencyGate(1, 1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("InFlightLimit", () => {
  it("admits up to the limit, refuses the next one with GateFullError, and admits again after a release", () => {
    const limit = new InFlightLimit(2);
    const first = limit.enter();
    limit.enter();
    expect(() => limit.enter()).toThrow(GateFullError);
    first();
    expect(() => limit.enter()).not.toThrow();
  });

  it("a release is idempotent: calling it twice frees only one slot", () => {
    const limit = new InFlightLimit(1);
    const release = limit.enter();
    release();
    release();
    limit.enter();
    expect(() => limit.enter()).toThrow(GateFullError);
  });
});
