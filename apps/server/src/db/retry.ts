/** Retry with capped exponential backoff and full jitter. Time and randomness are injectable for tests. */
export interface RetryOptions {
  /** Total attempts including the first (default 5). */
  readonly maxAttempts?: number;
  /** Delay cap before attempt n+1 is min(maxDelayMs, baseDelayMs * 2^(n-1)) (defaults 10 ms / 500 ms). */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Which errors to retry (default: none — pass a predicate). */
  readonly shouldRetry?: (err: unknown) => boolean;
  /** Uniform [0, 1) source for jitter (default Math.random). */
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each retry (metrics, logs). */
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function backoffDelayMs(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = options.baseDelayMs ?? 10;
  const cap = options.maxDelayMs ?? 500;
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  const r = (options.random ?? Math.random)();
  return Math.floor(r * ceiling);
}

/** Run fn until it succeeds, a non-retryable error occurs, or attempts run out (last error is rethrown). */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('retry: maxAttempts must be a positive integer');
  }
  const shouldRetry = options.shouldRetry ?? (() => false);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      const delayMs = backoffDelayMs(attempt, options);
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
