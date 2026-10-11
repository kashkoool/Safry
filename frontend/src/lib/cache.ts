// Tiny request cache: de-duplicates in-flight GETs and keeps results for a short TTL.
// Mutations invalidate by key prefix; login/logout clears everything (no data survives a user switch).
interface Entry {
  value?: unknown;
  expires: number;
  promise?: Promise<unknown>;
}
const store = new Map<string, Entry>();

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit?.promise) return hit.promise as Promise<T>;
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);
  const entry: Entry = { expires: 0 };
  entry.promise = load().then(
    (value) => {
      // An invalidation or clear during the request removed the entry: do not resurrect stale data.
      if (store.get(key) === entry) {
        entry.value = value;
        entry.expires = Date.now() + ttlMs;
        entry.promise = undefined;
      }
      return value;
    },
    (reason: unknown) => {
      if (store.get(key) === entry) store.delete(key);
      throw reason;
    }
  );
  store.set(key, entry);
  return entry.promise as Promise<T>;
}

export function invalidate(...prefixes: string[]): void {
  for (const key of [...store.keys()]) if (prefixes.some((prefix) => key.startsWith(prefix))) store.delete(key);
}

export function clearCache(): void {
  store.clear();
}
