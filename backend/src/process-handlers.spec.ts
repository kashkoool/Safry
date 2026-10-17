import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, type Mock } from "vitest";
import { describeFatal, installProcessHandlers } from "./process-handlers.js";

describe("describeFatal", () => {
  it("reports the error class and the message length only", () => {
    class DatabaseBoom extends Error {}
    const text = describeFatal(new DatabaseBoom("password=hunter2 for user a@b.test"));
    expect(text).toContain("DatabaseBoom");
    expect(text).toContain("34 characters");
    expect(text).not.toMatch(/hunter2|a@b\.test/);
  });
  it("handles values that are not errors without printing them", () => {
    expect(describeFatal("secret string")).not.toContain("secret");
    expect(describeFatal(undefined)).toContain("non-error");
  });
});

describe("installProcessHandlers", () => {
  const setup = (): { target: EventEmitter; log: Mock; exit: Mock; shutdown: Mock; release: () => void } => {
    const target = new EventEmitter();
    const log = vi.fn();
    const exit = vi.fn();
    let release: () => void = () => undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    installProcessHandlers({ target, log, shutdown, exit });
    return { target, log, exit, shutdown, release: () => release() };
  };

  it("logs the class, drains through the shutdown path, then exits non-zero", async () => {
    const { target, log, shutdown, exit, release } = setup();
    target.emit("unhandledRejection", new TypeError("token abc"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("TypeError");
    expect(String(log.mock.calls[0]![0])).not.toContain("abc");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled(); // not before the drain ends
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("handles uncaughtException the same way and only once however many errors follow", async () => {
    const { target, shutdown, exit, release } = setup();
    target.emit("uncaughtException", new RangeError("x"));
    target.emit("unhandledRejection", new Error("y"));
    expect(shutdown).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero even if the shutdown itself fails", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installProcessHandlers({ target, log: vi.fn(), shutdown: () => Promise.reject(new Error("close failed")), exit });
    target.emit("unhandledRejection", new Error("z"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("works in a real child process: an unhandled rejection logs the class and exits 1", () => {
    const code = `
      import { installProcessHandlers } from "./src/process-handlers.ts";
      installProcessHandlers({ target: process, log: (m) => console.log(m), shutdown: async () => {}, exit: (c) => process.exit(c) });
      Promise.reject(new TypeError("secret-value"));
      setTimeout(() => {}, 5000);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", cwd: process.cwd() });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("TypeError");
    expect(result.stdout + result.stderr).not.toContain("secret-value");
  }, 20_000);
});
