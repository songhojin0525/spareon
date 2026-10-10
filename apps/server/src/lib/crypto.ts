import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 of a string (UTF-8) or bytes. */
export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * A purpose-bound subkey of a configured secret, so one environment secret can serve several uses
 * (CSRF tokens, IP hashes) without one use's outputs helping to forge another's.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  return hmacSha256(secret, `spareon-subkey-v1\n${purpose}`);
}

/** URL-safe random token of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniformly random base62 string (crypto RNG, no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62.charAt(randomInt(62));
  return out;
}

/** Constant-time string equality (lengths may differ; compares fixed-size digests). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Keyed hash of a client IP for audit and session rows: correlatable, never reversible without the key. */
export function ipHashHex(key: Uint8Array, ip: string): string {
  return hmacSha256(key, `ip\n${ip}`).toString('hex');
}
