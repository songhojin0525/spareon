import { describe, expect, it } from 'vitest';

import { DAY_MS, DEFAULT_FAKE_CLOCK_START, FakeClock, HOUR_MS } from '../src/clock.js';

describe('FakeClock', () => {
  it('starts at a fixed default instant and does not move by itself', () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe(DEFAULT_FAKE_CLOCK_START);
    expect(clock.now().toISOString()).toBe(DEFAULT_FAKE_CLOCK_START);
  });

  it('advances by exact milliseconds and returns the new time', () => {
    const clock = new FakeClock('2026-10-09T00:00:00.000Z');
    expect(clock.advance(72 * HOUR_MS).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(clock.advance(1).toISOString()).toBe('2026-10-12T00:00:00.001Z');
    expect(clock.nowMs()).toBe(Date.parse('2026-10-12T00:00:00.001Z'));
  });

  it('can be set to any instant, including backwards', () => {
    const clock = new FakeClock(new Date('2026-05-01T00:00:00.000Z'));
    clock.set('2026-04-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-04-01T00:00:00.000Z');
    clock.set(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it('hands out copies: mutating a returned Date does not move the clock', () => {
    const clock = new FakeClock();
    const d = clock.now();
    d.setTime(d.getTime() + DAY_MS);
    expect(clock.now().toISOString()).toBe(DEFAULT_FAKE_CLOCK_START);
  });

  it('rejects negative, fractional and invalid inputs', () => {
    const clock = new FakeClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(0.5)).toThrow(RangeError);
    expect(() => clock.set('not a date')).toThrow(RangeError);
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe(DEFAULT_FAKE_CLOCK_START);
  });
});
