import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalizeJsonText, canonicalJson } from '../src/wire/canonical-json.js';
import { parseStrictJson } from '../src/wire/strict-json.js';

interface JsonVector {
  name: string;
  input?: string;
  inputHex?: string;
  strict: 'ok' | 'reject';
  canonical: string | null;
}

const vectors = (
  JSON.parse(readFileSync(new URL('../fixtures/vectors/json.json', import.meta.url), 'utf8')) as {
    cases: JsonVector[];
  }
).cases;

const inputBytes = (v: JsonVector): Uint8Array =>
  v.inputHex !== undefined
    ? Uint8Array.from(Buffer.from(v.inputHex, 'hex'))
    : new TextEncoder().encode(v.input ?? '');

describe('strict JSON / canonical JSON vectors (shared with Go)', () => {
  it('has a meaningful number of cases', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(50);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const parsed = parseStrictJson(inputBytes(v));
    expect(parsed.ok).toBe(v.strict === 'ok');
    if (v.canonical === null) {
      expect(() => canonicalizeJsonText(inputBytes(v))).toThrow();
    } else {
      expect(canonicalizeJsonText(inputBytes(v))).toBe(v.canonical);
    }
  });
});

const jsonInt = fc.integer({ min: -(2 ** 53 - 1), max: 2 ** 53 - 1 });
const { value: jsonValue } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    jsonInt,
    fc.string({ unit: 'binary' }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ unit: 'binary' }), tie('value'), { maxKeys: 4 }),
  ),
}));

describe('canonical JSON properties', () => {
  it('is a fixed point: canonicalize(canonical(x)) === canonical(x)', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const c = canonicalJson(v);
        expect(canonicalizeJsonText(c)).toBe(c);
      }),
    );
  });

  it('round-trips through the strict parser to an equal value', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const parsed = parseStrictJson(canonicalJson(v));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(canonicalJson(parsed.value)).toBe(canonicalJson(v));
      }),
    );
  });

  it('rejects values JSON cannot carry exactly', () => {
    expect(() => canonicalJson(1.5)).toThrow();
    expect(() => canonicalJson(2 ** 53)).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
    expect(() => canonicalJson('\uD800')).toThrow();
  });

  it('rejects lone surrogates in JS string input to the strict parser', () => {
    expect(parseStrictJson('["\uD800"]').ok).toBe(false);
  });
});
