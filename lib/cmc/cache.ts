// Cache abstraction for CMC data. [CMC Hackathon — new integration]
//
// Purpose: keep credit use predictable and keep serving the last good data for
// a bounded time when CMC is unavailable (key expired, plan change, 429, outage).
//
//   fresh      (age <= ttlMs)                 -> served, no request
//   refresh    (age >  ttlMs)                 -> one request per key (single flight)
//   failure    -> served stale while age <= maxStaleMs, else the error is raised
//   backoff    -> after a failure no new request for backoffMs
//                 (longer when the error asks for it, e.g. rate limiting)
//
// The store is an interface so a shared store can replace the in-memory one
// later without changing callers. Nothing here knows about CMC specifically.

export interface CacheEntry<T> {
  value: T;
  fetchedAt: number; // ms epoch
}

export interface CacheStore<T> {
  get(key: string): CacheEntry<T> | undefined;
  set(key: string, entry: CacheEntry<T>): void;
  delete(key: string): void;
}

/** In-memory store with a hard entry limit (oldest insertion evicted first). */
export class MemoryStore<T> implements CacheStore<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  constructor(maxEntries = 32) {
    this.maxEntries = maxEntries;
  }
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, entry: CacheEntry<T>) {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string) {
    this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}

export interface CachePolicy {
  ttlMs: number;
  maxStaleMs: number; // > ttlMs; how long last good data may still be served
  backoffMs: number; // minimum wait after a failed refresh
}

export interface CacheResult<T> {
  value: T;
  fetchedAt: number;
  stale: boolean; // served after a failed or skipped refresh
  /** the refresh failure behind a stale result */
  error?: unknown;
}

/** An error can ask for a longer backoff (e.g. HTTP 429). */
export interface BackoffHint {
  backoffMs?: number;
}

export class CacheUnavailableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("no usable cached value");
    this.name = "CacheUnavailableError";
    this.cause = cause;
  }
}

export class TtlCache<T> {
  private readonly store: CacheStore<T>;
  private readonly policy: CachePolicy;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<CacheResult<T>>>();
  private readonly failures = new Map<string, { until: number; error: unknown }>();

  constructor(policy: CachePolicy, opts: { store?: CacheStore<T>; now?: () => number } = {}) {
    if (!(policy.ttlMs > 0 && policy.maxStaleMs >= policy.ttlMs && policy.backoffMs >= 0)) {
      throw new RangeError("invalid cache policy");
    }
    this.policy = policy;
    this.store = opts.store ?? new MemoryStore<T>();
    this.now = opts.now ?? Date.now;
  }

  /** Value for `key`, calling `load` only when the cached value is too old. */
  get(key: string, load: () => Promise<T>): Promise<CacheResult<T>> {
    const t = this.now();
    const entry = this.store.get(key);
    if (entry && t - entry.fetchedAt <= this.policy.ttlMs) {
      return Promise.resolve({ value: entry.value, fetchedAt: entry.fetchedAt, stale: false });
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const failure = this.failures.get(key);
    // executor form: a throw from fallback() becomes a rejection, never a sync throw
    if (failure && t < failure.until) return new Promise((resolve) => resolve(this.fallback(key, failure.error)));

    const p = this.refresh(key, load).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async refresh(key: string, load: () => Promise<T>): Promise<CacheResult<T>> {
    try {
      const value = await load();
      const fetchedAt = this.now();
      this.store.set(key, { value, fetchedAt });
      this.failures.delete(key);
      return { value, fetchedAt, stale: false };
    } catch (error) {
      const hinted = (error as BackoffHint | null)?.backoffMs;
      const wait = Math.max(this.policy.backoffMs, typeof hinted === "number" && hinted > 0 ? hinted : 0);
      this.failures.set(key, { until: this.now() + wait, error });
      return this.fallback(key, error);
    }
  }

  private fallback(key: string, error: unknown): CacheResult<T> {
    const entry = this.store.get(key);
    if (entry && this.now() - entry.fetchedAt <= this.policy.maxStaleMs) {
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true, error };
    }
    if (entry) this.store.delete(key); // too old to show at all
    throw new CacheUnavailableError(error);
  }
}

/**
 * Default policies, sized for the CMC Basic plan (15,000 credits/month):
 * quotes every 15 min, global metrics every 30 min, fear & greed every 60 min
 * (map is free) = at most 168 credits/day, ~5,040/month per server process.
 * Credits are only spent when someone requests the page after the TTL.
 * The per-process daily hard cap is in budget.ts.
 */
export const POLICIES = {
  map: { ttlMs: 24 * 3600_000, maxStaleMs: 7 * 24 * 3600_000, backoffMs: 15 * 60_000 },
  quotes: { ttlMs: 15 * 60_000, maxStaleMs: 3 * 3600_000, backoffMs: 5 * 60_000 },
  global: { ttlMs: 30 * 60_000, maxStaleMs: 6 * 3600_000, backoffMs: 5 * 60_000 },
  fearGreed: { ttlMs: 60 * 60_000, maxStaleMs: 6 * 3600_000, backoffMs: 10 * 60_000 },
} as const satisfies Record<string, CachePolicy>;
