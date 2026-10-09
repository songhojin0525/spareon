import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isUuidV7, newUuidV7, uuidV7, uuidV7TimeMs } from '../src/index.js';

describe('uuidV7', () => {
  it('matches the RFC 9562 layout for a fixed input', () => {
    const id = uuidV7(0x0189_8f2b_2c3d, Uint8Array.from([0xff, 0x01, 0xff, 2, 3, 4, 5, 6, 7, 8]));
    expect(id).toBe('01898f2b-2c3d-7f01-bf02-030405060708');
    expect(isUuidV7(id)).toBe(true);
  });

  it('round-trips the timestamp and always sets version 7 and variant 10', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 1 }),
        fc.uint8Array({ minLength: 10, maxLength: 10 }),
        (ms, rnd) => {
          const id = uuidV7(ms, rnd);
          expect(isUuidV7(id)).toBe(true);
          expect(uuidV7TimeMs(id)).toBe(ms);
        },
      ),
    );
  });

  it('sorts by time as plain strings', () => {
    const a = uuidV7(1_000, new Uint8Array(10).fill(0xff));
    const b = uuidV7(1_001, new Uint8Array(10));
    expect(a < b).toBe(true);
  });

  it('rejects out-of-range timestamps and short randomness', () => {
    expect(() => uuidV7(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidV7(2 ** 48, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidV7(1.5, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidV7(1, new Uint8Array(9))).toThrow(RangeError);
  });

  it('newUuidV7 uses the injected instant', () => {
    const at = new Date('2026-10-09T04:36:00.000Z');
    expect(uuidV7TimeMs(newUuidV7(at))).toBe(at.getTime());
  });

  it('isUuidV7 rejects other versions, uppercase and malformed strings', () => {
    expect(isUuidV7('01898f2b-2c3d-4f01-bf02-030405060708')).toBe(false); // v4
    expect(isUuidV7('01898F2B-2C3D-7F01-BF02-030405060708')).toBe(false); // uppercase
    expect(isUuidV7('01898f2b-2c3d-7f01-cf02-030405060708')).toBe(false); // variant 110
    expect(isUuidV7('01898f2b2c3d7f01bf02030405060708')).toBe(false);
    expect(() => uuidV7TimeMs('nope')).toThrow(TypeError);
  });
});
