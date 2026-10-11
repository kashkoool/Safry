import type { AuthUser } from "../security/auth-user.js";

/** Which cached principals a write makes stale. "all" is the safe fallback when a write can not be narrowed. */
export type InvalidationTarget =
  | "all"
  | { sessionId?: string; userId?: string; membershipId?: string; tenantId?: string };

/**
 * Short-lived cache of the verified principal (session + membership + role permissions).
 * The key always contains the tenant id (see {@link principalKey}). The in-process LRU below is the
 * default; a Redis implementation can replace it behind this class without touching the callers.
 * Staleness is bounded by the TTL on every replica and removed immediately on the replica that
 * performed the write (the Prisma extension calls {@link invalidate} after every relevant write).
 */
export abstract class AuthPrincipalCache {
  abstract getOrLoad(key: string, meta: PrincipalMeta, loader: () => Promise<AuthUser>): Promise<AuthUser>;
  abstract invalidate(target: InvalidationTarget): void;
  abstract stats(): { hits: number; misses: number; size: number; invalidations: number };
}

export interface PrincipalMeta {
  sessionId: string;
  userId: string;
  membershipId: string;
  tenantId: string;
}

export function principalKey(meta: PrincipalMeta, authVersion: number): string {
  return `${meta.tenantId}|${meta.sessionId}|${meta.membershipId}|${meta.userId}|${authVersion}`;
}

interface Entry {
  value: AuthUser;
  meta: PrincipalMeta;
  expiresAt: number;
}

export class InMemoryAuthPrincipalCache extends AuthPrincipalCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<AuthUser>>();
  /** Bumped by every invalidation; a load that started before a bump is returned but never stored. */
  private generation = 0;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {
    super();
  }

  async getOrLoad(key: string, meta: PrincipalMeta, loader: () => Promise<AuthUser>): Promise<AuthUser> {
    if (this.ttlMs <= 0) return loader();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      this.entries.delete(key); // re-insert: Map order is the LRU order
      this.entries.set(key, hit);
      this.hits += 1;
      return structuredClone(hit.value);
    }
    if (hit) this.entries.delete(key);
    this.misses += 1;
    const pending = this.inflight.get(key);
    if (pending) return structuredClone(await pending);
    const started = this.generation;
    const load = loader().then((value) => {
      if (started === this.generation) this.store(key, { value, meta, expiresAt: Date.now() + this.ttlMs });
      return value;
    });
    this.inflight.set(key, load);
    try {
      return structuredClone(await load);
    } finally {
      this.inflight.delete(key);
    }
  }

  private store(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  invalidate(target: InvalidationTarget): void {
    this.generation += 1;
    this.invalidations += 1;
    this.inflight.clear();
    if (target === "all") {
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      const m = entry.meta;
      if (
        (target.sessionId && m.sessionId === target.sessionId) ||
        (target.userId && m.userId === target.userId) ||
        (target.membershipId && m.membershipId === target.membershipId) ||
        (target.tenantId && m.tenantId === target.tenantId)
      )
        this.entries.delete(key);
    }
  }

  stats(): { hits: number; misses: number; size: number; invalidations: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size, invalidations: this.invalidations };
  }
}
