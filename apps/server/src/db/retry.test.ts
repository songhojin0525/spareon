import { describe, expect, it } from 'vitest';

import { backoffDelayMs, retry } from './retry.js';

class Transient extends Error {}

describe('retry', () => {
  it('returns the first success and passes the attempt number', async () => {
    const seen: number[] = [];
    const result = await retry(
      (attempt) => {
        seen.push(attempt);
        if (attempt < 3) return Promise.reject(new Transient('again'));
        return Promise.resolve('ok');
      },
      { shouldRetry: (e) => e instanceof Transient, sleep: () => Promise.resolve() },
    );
    expect(result).toBe('ok');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does not retry errors the predicate rejects (default: none)', async () => {
    let calls = 0;
    await expect(
      retry(() => {
        calls++;
        return Promise.reject(new Transient('nope'));
      }),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  it('rethrows the last error when attempts run out', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls++;
          return Promise.reject(new Transient(`fail ${String(calls)}`));
        },
        { maxAttempts: 4, shouldRetry: () => true, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });

  it('sleeps with capped exponential backoff and reports each retry', async () => {
    const sleeps: number[] = [];
    const retries: { attempt: number; delayMs: number }[] = [];
    await expect(
      retry(() => Promise.reject(new Transient('x')), {
        maxAttempts: 6,
        baseDelayMs: 10,
        maxDelayMs: 50,
        random: () => 0.999999,
        shouldRetry: () => true,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
      }),
    ).rejects.toThrow('x');
    // Ceilings 10, 20, 40, 50, 50 (capped); random just below 1 gives ceiling - 1.
    expect(sleeps).toEqual([9, 19, 39, 49, 49]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it('uses full jitter: random 0 means no wait', () => {
    expect(backoffDelayMs(5, { random: () => 0 })).toBe(0);
    expect(backoffDelayMs(1, { random: () => 0.5, baseDelayMs: 100 })).toBe(50);
  });

  it('rejects a non-positive or fractional attempt limit', async () => {
    await expect(retry(() => Promise.resolve(1), { maxAttempts: 0 })).rejects.toThrow(RangeError);
    await expect(retry(() => Promise.resolve(1), { maxAttempts: 1.5 })).rejects.toThrow(
      RangeError,
    );
  });
});
