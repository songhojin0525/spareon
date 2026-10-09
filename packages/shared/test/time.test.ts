import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatTimestamp, parseTimestamp } from '../src/index.js';

describe('wire timestamps', () => {
  it('formats with exactly millisecond precision in UTC', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 9, 9, 4, 36, 0, 7)))).toBe(
      '2026-10-09T04:36:00.007Z',
    );
  });

  it('round-trips every representable instant in years 0000-9999', () => {
    fc.assert(
      fc.property(fc.integer({ min: -62_167_219_200_000, max: 253_402_300_799_999 }), (ms) => {
        const s = formatTimestamp(new Date(ms));
        expect(parseTimestamp(s)?.getTime()).toBe(ms);
      }),
    );
  });

  it.each([
    '2026-02-30T00:00:00.000Z',
    '2026-10-09T24:00:00.000Z',
    '2026-12-31T23:59:60.000Z',
    '2026-10-09T04:36:00Z',
    '2026-10-09T04:36:00.000+09:00',
    '2026-10-09t04:36:00.000z',
    '2026-10-09T04:36:00.0000Z',
    ' 2026-10-09T04:36:00.000Z',
  ])('rejects %s', (s) => {
    expect(parseTimestamp(s)).toBeNull();
  });

  it('refuses to format invalid dates and years beyond 9999', () => {
    expect(() => formatTimestamp(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => formatTimestamp(new Date(253_402_300_800_000))).toThrow(RangeError);
  });
});
