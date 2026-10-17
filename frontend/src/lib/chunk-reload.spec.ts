import { describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadOnceForStaleChunk } from "./chunk-reload";

const memory = (): Pick<Storage, "getItem" | "setItem"> => {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://x.test/assets/Page-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Loading chunk 12 failed.",
    "Unable to preload CSS for /assets/a.css"
  ])("recognises %s", (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });
  it("recognises the named error and ignores everything else", () => {
    const named = new Error("x");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadOnceForStaleChunk", () => {
  it("reloads the first time and not again within the window (no reload loop)", () => {
    const reload = vi.fn();
    const store = memory();
    expect(reloadOnceForStaleChunk({ storage: store, reload, now: () => 1_000 })).toBe(true);
    expect(reloadOnceForStaleChunk({ storage: store, reload, now: () => 20_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("allows a new reload for a later deploy once the window has passed", () => {
    const reload = vi.fn();
    const store = memory();
    reloadOnceForStaleChunk({ storage: store, reload, now: () => 1_000 });
    expect(reloadOnceForStaleChunk({ storage: store, reload, now: () => 1_000 + 61_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("never reloads when the flag can not be stored (a loop would be possible)", () => {
    const reload = vi.fn();
    const blocked = (): never => {
      throw new Error("blocked");
    };
    expect(reloadOnceForStaleChunk({ storage: { getItem: blocked, setItem: blocked }, reload })).toBe(false);
    expect(reloadOnceForStaleChunk({ storage: undefined, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
