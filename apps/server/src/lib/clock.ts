/**
 * The only source of wall-clock time for server code.
 * Everything else receives a Clock by injection so tests can control time (lint-enforced).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at a fixed instant. Useful for tests and deterministic tooling. */
export function fixedClock(at: Date): Clock {
  const ms = at.getTime();
  return { now: () => new Date(ms) };
}
