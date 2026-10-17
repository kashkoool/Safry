const KEY = "safry.chunk-reload";
/** A second failure inside this window is a real fault (not a stale tab), so it is shown instead of reloading again. */
const WINDOW_MS = 60_000;

const PATTERNS = [
  /dynamically imported module/i, // Chrome and Firefox
  /importing a module script failed/i, // Safari
  /loading (css )?chunk [\w-]+ failed/i,
  /unable to preload css/i // Vite
];

/**
 * A deploy removes the old hashed files, so a tab opened before it fails to fetch the page chunk it navigates to.
 * Matching is on the message because browsers word it differently and the error is not a custom class.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || PATTERNS.some((pattern) => pattern.test(error.message));
}

interface Options {
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  now?: () => number;
}

function defaultStorage(): Options["storage"] {
  try { return window.sessionStorage; } catch { return undefined; }
}

/**
 * Reloads the page once to pick up the new build. The sessionStorage flag stops a reload loop when the chunk is missing for
 * another reason; with no usable storage it does nothing, because a loop could not be prevented. Returns whether it reloaded.
 */
export function reloadOnceForStaleChunk(options: Options = {}): boolean {
  const { storage = defaultStorage(), reload = () => window.location.reload(), now = Date.now } = options;
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY));
    if (Number.isFinite(last) && last > 0 && now() - last < WINDOW_MS) return false;
    storage.setItem(KEY, String(now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** Vite fires this when a preload of a lazy chunk fails, before the import itself rejects. */
export function installStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForStaleChunk()) event.preventDefault();
  });
}
