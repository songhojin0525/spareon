import { describe, expect, it } from 'vitest';

import { createPayloadCipher, payloadAad, PayloadCipherError } from './payload-cipher.js';

const KEY = '0f'.repeat(32);

describe('PayloadCipher (AES-256-GCM)', () => {
  const cipher = createPayloadCipher(KEY, 'k1');
  const aad = payloadAad('01920000-0000-7000-8000-000000000001', 'input');

  it('round-trips and never stores the plaintext as-is', () => {
    const plain = Buffer.from('{"messages":[{"role":"user","content":"안녕"}]}');
    const blob = cipher.seal(plain, aad);
    expect(blob.length).toBe(plain.length + 28);
    expect(blob.includes(plain)).toBe(false);
    expect(cipher.open(blob, aad).equals(plain)).toBe(true);
  });

  it('uses a fresh nonce each time', () => {
    const plain = Buffer.from('same');
    expect(cipher.seal(plain, aad).equals(cipher.seal(plain, aad))).toBe(false);
  });

  it('rejects tampering, another job binding, another key and short blobs', () => {
    const blob = cipher.seal(Buffer.from('secret prompt'), aad);
    const flipped = Buffer.from(blob);
    flipped[14] = (flipped[14] ?? 0) ^ 1;
    expect(() => cipher.open(flipped, aad)).toThrow(PayloadCipherError);
    expect(() =>
      cipher.open(blob, payloadAad('01920000-0000-7000-8000-000000000002', 'input')),
    ).toThrow(PayloadCipherError);
    expect(() => createPayloadCipher('1e'.repeat(32), 'k2').open(blob, aad)).toThrow(
      PayloadCipherError,
    );
    expect(() => cipher.open(Buffer.alloc(27), aad)).toThrow(/too short/);
  });

  it('error messages never contain the plaintext', () => {
    const blob = cipher.seal(Buffer.from('TOP-SECRET-PROMPT'), aad);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    try {
      cipher.open(blob, aad);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('TOP-SECRET');
    }
  });

  it('refuses a malformed key', () => {
    expect(() => createPayloadCipher('abc', 'k1')).toThrow(PayloadCipherError);
  });
});
