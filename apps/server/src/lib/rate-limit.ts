import type { Clock } from './clock.js';

/** A fixed-window rule: at most `limit` hits per `windowMs`. */
export interface RateRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Hits in the current window, this one included when counted. */
  readonly count: number;
  /** Milliseconds until the window resets (when not allowed: how long to wait). */
  readonly retryAfterMs: number;
}

/**
 * Rate limiting storage. The single-instance server uses the memory store; a Postgres or Redis store
 * can replace it for several instances (same interface, S05 optional extension / S30).
 */
export interface RateLimiter {
  /** Count one hit for `key` and say whether it is within the rule (a refused hit still counts). */
  hit(key: string, rule: RateRule): Promise<RateDecision>;
  /** The current state without counting. */
  peek(key: string, rule: RateRule): Promise<RateDecision>;
  /** Forget `key` (e.g. failed logins after a success). */
  reset(key: string): Promise<void>;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface MemoryRateLimiterOptions {
  readonly clock: Clock;
  /** Upper bound on remembered keys; expired windows are dropped first (default 100,000). */
  readonly maxKeys?: number;
}

export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #clock: Clock;
  readonly #maxKeys: number;

  constructor(options: MemoryRateLimiterOptions) {
    this.#clock = options.clock;
    this.#maxKeys = options.maxKeys ?? 100_000;
  }

  #current(key: string, now: number): Window | undefined {
    const w = this.#windows.get(key);
    if (w !== undefined && w.resetAt <= now) {
      this.#windows.delete(key);
      return undefined;
    }
    return w;
  }

  #decide(w: Window | undefined, rule: RateRule, now: number): RateDecision {
    const count = w?.count ?? 0;
    return {
      allowed: count <= rule.limit,
      count,
      retryAfterMs: w === undefined ? 0 : Math.max(0, w.resetAt - now),
    };
  }

  #evict(now: number): void {
    for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
    // Still full: drop the oldest entries (insertion order). Under a flood of distinct keys this
    // forgets some counts, which only weakens limiting for the flooded keys; it never blocks anyone.
    const excess = this.#windows.size - this.#maxKeys + 1;
    if (excess > 0) {
      let n = 0;
      for (const k of this.#windows.keys()) {
        if (n++ >= excess) break;
        this.#windows.delete(k);
      }
    }
  }

  hit(key: string, rule: RateRule): Promise<RateDecision> {
    const now = this.#clock.now().getTime();
    let w = this.#current(key, now);
    if (w === undefined) {
      if (this.#windows.size >= this.#maxKeys) this.#evict(now);
      w = { count: 0, resetAt: now + rule.windowMs };
      this.#windows.set(key, w);
    }
    w.count += 1;
    return Promise.resolve(this.#decide(w, rule, now));
  }

  peek(key: string, rule: RateRule): Promise<RateDecision> {
    const now = this.#clock.now().getTime();
    const w = this.#current(key, now);
    // A peek asks "would one more hit be allowed?"
    const count = w?.count ?? 0;
    return Promise.resolve({
      allowed: count < rule.limit,
      count,
      retryAfterMs: w === undefined ? 0 : Math.max(0, w.resetAt - now),
    });
  }

  reset(key: string): Promise<void> {
    this.#windows.delete(key);
    return Promise.resolve();
  }

  /** Number of remembered keys (tests, metrics). */
  get size(): number {
    return this.#windows.size;
  }
}

/** Per-key concurrency limit (in-flight requests). Memory only: a request lives in one process. */
export class ConcurrencyLimiter {
  readonly #inFlight = new Map<string, number>();

  /** A release function when under `max`, otherwise undefined. Release is idempotent. */
  tryAcquire(key: string, max: number): (() => void) | undefined {
    const n = this.#inFlight.get(key) ?? 0;
    if (n >= max) return undefined;
    this.#inFlight.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#inFlight.get(key) ?? 1) - 1;
      if (left <= 0) this.#inFlight.delete(key);
      else this.#inFlight.set(key, left);
    };
  }

  inFlight(key: string): number {
    return this.#inFlight.get(key) ?? 0;
  }
}
