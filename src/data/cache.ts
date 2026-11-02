/**
 * Small keyed cache with freshness windows and in-flight de-duplication.
 * No `vscode` import: unit tested directly.
 */
export type Freshness =
  /** Cached until invalidated. */
  | { kind: 'session' }
  /** Fresh for `ms`; refetched after that. */
  | { kind: 'ttl'; ms: number }
  /** Cached forever once `final(value)` is true; values that aren't final are never stored. */
  | { kind: 'final'; final: (v: unknown) => boolean };

export interface Entry<T> {
  value: T;
  at: number;
}

export type CacheLog = (line: string) => void;

export class RequestCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly log: CacheLog = () => {},
  ) {}

  peek<T>(key: string): Entry<T> | undefined {
    return this.entries.get(key) as Entry<T> | undefined;
  }

  isFresh(key: string, f: Freshness): boolean {
    const e = this.entries.get(key);
    if (!e || e.at === Number.NEGATIVE_INFINITY) return false;
    if (f.kind === 'ttl') return this.now() - e.at < f.ms;
    return true;
  }

  /**
   * Cached value when fresh (unless `force`); otherwise fetch. Concurrent
   * calls for the same key share one promise.
   */
  async get<T>(key: string, f: Freshness, fetch: () => Promise<T>, force = false): Promise<T> {
    if (!force && this.isFresh(key, f)) {
      const e = this.entries.get(key)!;
      this.log(`cache hit  ${key} (age ${Math.round((this.now() - e.at) / 1000)}s)`);
      return e.value as T;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.log(`cache dedup ${key} (request already in flight)`);
      return pending as Promise<T>;
    }
    this.log(`cache miss ${key}${force ? ' (refresh)' : this.entries.has(key) ? ' (stale)' : ''}`);
    const p = fetch()
      .then((v) => {
        if (f.kind !== 'final' || f.final(v)) this.entries.set(key, { value: v, at: this.now() });
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, at: this.now() });
  }

  /** Mark stale (keeps the value for offline display) by back-dating it. */
  invalidate(key: string): void {
    const e = this.entries.get(key);
    if (e) this.entries.set(key, { value: e.value, at: Number.NEGATIVE_INFINITY });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
