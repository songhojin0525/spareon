import { randomBytes } from 'node:crypto';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_UNIX_MS = 2 ** 48 - 1;

/** True for a lowercase, canonical UUIDv7 string (the only ID form the system accepts). */
export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/**
 * Builds a UUIDv7 (RFC 9562) from an explicit timestamp and at least 10 random bytes.
 * Pure: callers inject time (server Clock) and randomness, so tests are deterministic.
 */
export function uuidV7(unixMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs > MAX_UNIX_MS) {
    throw new RangeError('uuidV7: unixMs must be an integer in [0, 2^48)');
  }
  if (random.length < 10) throw new RangeError('uuidV7: need at least 10 random bytes');
  const b = new Uint8Array(16);
  let ts = unixMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  const r = (i: number): number => random[i] ?? 0;
  b[6] = 0x70 | (r(0) & 0x0f);
  b[7] = r(1);
  b[8] = 0x80 | (r(2) & 0x3f);
  for (let i = 0; i < 7; i++) b[9 + i] = r(3 + i);
  const hex = Buffer.from(b).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** New UUIDv7 for the given wall-clock instant (pass the injected Clock's now()). */
export function newUuidV7(now: Date): string {
  return uuidV7(now.getTime(), randomBytes(10));
}

/** Millisecond timestamp embedded in a UUIDv7. Throws on anything that is not a canonical UUIDv7. */
export function uuidV7TimeMs(id: string): number {
  if (!isUuidV7(id)) throw new TypeError('not a canonical UUIDv7');
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
