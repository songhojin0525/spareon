import { Writable } from 'node:stream';

import { FakeClock } from '@spareon/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { API_KEY_RE, generateApiKey, hashApiKey } from '../api-keys/api-keys.js';
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  PasswordPolicyError,
  UNUSABLE_PASSWORD_HASH,
  verifyPassword,
} from '../auth/password.js';
import { cookieNames, parseCookies, serializeCookie } from '../http/cookies.js';
import { constantTimeEqual, deriveKey, ipHashHex, randomBase62 } from './crypto.js';
import { canonicalJson, requestHash } from './idempotency.js';
import { createLogger, REDACTED, redactPaths } from './logger.js';
import { ConcurrencyLimiter, MemoryRateLimiter } from './rate-limit.js';

describe('MemoryRateLimiter', () => {
  it('allows `limit` hits per window, then refuses with the time left, then resets', async () => {
    const clock = new FakeClock();
    const rl = new MemoryRateLimiter({ clock });
    const rule = { limit: 3, windowMs: 60_000 };
    for (let i = 1; i <= 3; i++) expect((await rl.hit('k', rule)).allowed).toBe(true);
    const refused = await rl.hit('k', rule);
    expect(refused).toMatchObject({ allowed: false, count: 4, retryAfterMs: 60_000 });
    expect((await rl.peek('k', rule)).allowed).toBe(false);
    expect((await rl.hit('other', rule)).allowed).toBe(true);
    clock.advance(60_000);
    expect((await rl.peek('k', rule)).allowed).toBe(true);
    expect((await rl.hit('k', rule)).count).toBe(1);
    await rl.reset('k');
    expect((await rl.peek('k', rule)).count).toBe(0);
  });

  it('stays bounded under a flood of distinct keys', async () => {
    const rl = new MemoryRateLimiter({ clock: new FakeClock(), maxKeys: 100 });
    for (let i = 0; i < 1_000; i++) await rl.hit(`k${String(i)}`, { limit: 1, windowMs: 60_000 });
    expect(rl.size).toBeLessThanOrEqual(100);
  });
});

describe('ConcurrencyLimiter', () => {
  it('admits up to max per key and releases once', () => {
    const c = new ConcurrencyLimiter();
    const a = c.tryAcquire('k', 2);
    const b = c.tryAcquire('k', 2);
    expect(c.tryAcquire('k', 2)).toBeUndefined();
    expect(c.tryAcquire('j', 2)).toBeDefined();
    a?.();
    a?.();
    expect(c.inFlight('k')).toBe(1);
    expect(c.tryAcquire('k', 2)).toBeDefined();
    b?.();
  });
});

describe('passwords', () => {
  it('uses argon2id with the OWASP minimum parameters', async () => {
    expect(ARGON2_PARAMS).toEqual({
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword(UNUSABLE_PASSWORD_HASH, '')).toBe(false);
    expect(await verifyPassword('$argon2id$garbage', 'x')).toBe(false);
  });

  it('requires 12..256 characters (code points)', () => {
    expect(() => {
      checkPasswordPolicy('elevenchars');
    }).toThrow(PasswordPolicyError);
    expect(() => {
      checkPasswordPolicy('😀'.repeat(12));
    }).not.toThrow();
    expect(() => {
      checkPasswordPolicy('x'.repeat(257));
    }).toThrow(PasswordPolicyError);
  });
});

describe('API key format', () => {
  it('generates sp_test_ keys with a 16-character public prefix', () => {
    const { key, prefix } = generateApiKey('test');
    expect(key).toMatch(API_KEY_RE);
    expect(prefix).toMatch(/^sp_test_[0-9A-Za-z]{8}$/);
    expect(key.startsWith(`${prefix}_`)).toBe(true);
    expect(hashApiKey('p'.repeat(32), key)).toHaveLength(32);
    expect(hashApiKey('p'.repeat(32), key).equals(hashApiKey('q'.repeat(32), key))).toBe(false);
  });

  it('base62 is uniform enough to use every symbol', () => {
    const seen = new Set(randomBase62(5_000));
    expect(seen.size).toBe(62);
  });
});

describe('crypto helpers', () => {
  it('derives independent subkeys and keyed IP hashes', () => {
    const a = deriveKey('secret-1', 'csrf');
    expect(a.equals(deriveKey('secret-1', 'ip-hash'))).toBe(false);
    expect(a.equals(deriveKey('secret-2', 'csrf'))).toBe(false);
    expect(ipHashHex(a, '10.0.0.1')).toMatch(/^[0-9a-f]{64}$/);
    expect(ipHashHex(a, '10.0.0.1')).not.toBe(ipHashHex(deriveKey('x', 'ip'), '10.0.0.1'));
  });

  it('compares strings of any length in constant time', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('cookies', () => {
  it('round-trips and refuses unsafe values', () => {
    const c = serializeCookie('n', 'v-1_2.3', { httpOnly: true, secure: true, maxAgeS: 10 });
    expect(c).toBe('n=v-1_2.3; Path=/; SameSite=Lax; Max-Age=10; HttpOnly; Secure');
    expect(parseCookies('a=1; b="2"; a=3').get('a')).toBe('1');
    expect(parseCookies('a=1; b="2"').get('b')).toBe('2');
    expect(() =>
      serializeCookie('n', 'a;b', { httpOnly: true, secure: false, maxAgeS: 1 }),
    ).toThrow();
    expect(cookieNames(true).session.startsWith('__Host-')).toBe(true);
  });
});

describe('canonical request hash (idempotency)', () => {
  it('ignores key order and formatting, not values', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
    expect(requestHash({ a: 1, b: [1, 2] }).equals(requestHash({ b: [1, 2], a: 1 }))).toBe(true);
    expect(requestHash({ a: 1 }).equals(requestHash({ a: 2 }))).toBe(false);
    expect(requestHash({ a: [1, 2] }).equals(requestHash({ a: [2, 1] }))).toBe(false);
  });
});

describe('logger redaction', () => {
  it('redacts credentials and buyer content at every depth and level', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _e, cb) {
          lines.push(chunk.toString());
          cb();
        },
      }),
    });
    const MARK = 'MARKER-REDACT-9';
    log.trace({
      headers: {
        authorization: `Bearer ${MARK}`,
        cookie: MARK,
        'set-cookie': MARK,
        'x-api-key': MARK,
      },
      body: { messages: [{ content: MARK }], prompt: MARK, input: MARK, password: MARK },
      res: { body: { choices: [MARK], output: MARK } },
      deep: { a: { b: { messages: MARK } } },
    });
    log.error({ err: new SyntaxError(`Unexpected token in JSON at "${MARK}"`) }, 'bad');
    const text = lines.join('');
    expect(text).not.toContain(MARK);
    expect(text).toContain(REDACTED);
    expect(redactPaths(['set-cookie'])).toContain('*.*["set-cookie"]');
  });
});
