/** Default start instant for fake clocks: a fixed, readable UTC time (deterministic tests). */
export const DEFAULT_FAKE_CLOCK_START = '2026-01-01T00:00:00.000Z';

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

function toMs(at: Date | string | number): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isSafeInteger(ms)) throw new RangeError(`FakeClock: invalid instant ${String(at)}`);
  return ms;
}

/**
 * A manually controlled wall clock. Structurally compatible with the server's `Clock`
 * (`{ now(): Date }`), so tests inject it wherever production code takes a Clock.
 * Time only moves when the test says so: nothing here reads the real clock.
 */
export class FakeClock {
  #ms: number;

  constructor(start: Date | string | number = DEFAULT_FAKE_CLOCK_START) {
    this.#ms = toMs(start);
  }

  /** A new Date each call, so callers cannot mutate the clock through the returned object. */
  now(): Date {
    return new Date(this.#ms);
  }

  /** Milliseconds since the Unix epoch. */
  nowMs(): number {
    return this.#ms;
  }

  /** Jump to an instant. Going backwards is allowed on purpose (real clocks get corrected too). */
  set(at: Date | string | number): Date {
    this.#ms = toMs(at);
    return this.now();
  }

  /** Move forward by a non-negative whole number of milliseconds. */
  advance(ms: number): Date {
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance: expected a non-negative integer, got ${String(ms)}`);
    }
    this.#ms += ms;
    return this.now();
  }
}
