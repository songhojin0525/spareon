import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '../src/random.js';

describe('createSeededRandom', () => {
  it('is deterministic for a seed and pinned across platforms', () => {
    // The seed is only test input: the golden values below were computed for 'binjari' (the project's old
    // codename) and must stay pinned to it so a real algorithm change still shows up here.
    const a = createSeededRandom('binjari');
    const b = createSeededRandom('binjari');
    const seqA = Array.from({ length: 5 }, () => a.uint32());
    const seqB = Array.from({ length: 5 }, () => b.uint32());
    expect(seqA).toEqual(seqB);
    // Golden values: a change in the algorithm silently changes every seeded test, so pin it.
    expect(createSeededRandom(42).hex(8)).toBe(createSeededRandom('42').hex(8));
    expect(seqA).toEqual([272415374, 1772166364, 2263284908, 4280291437, 3910081787]);
  });

  it('different seeds give different sequences', () => {
    expect(createSeededRandom('a').hex(16)).not.toBe(createSeededRandom('b').hex(16));
  });

  it('int stays inside the inclusive range and hits both ends', () => {
    const r = createSeededRandom('range');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = r.int(-3, 3);
      expect(x).toBeGreaterThanOrEqual(-3);
      expect(x).toBeLessThanOrEqual(3);
      seen.add(x);
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(r.int(5, 5)).toBe(5);
    expect(() => r.int(2, 1)).toThrow(RangeError);
    expect(() => r.int(0, 2 ** 33)).toThrow(RangeError);
  });

  it('int is roughly uniform (chi-square sanity check)', () => {
    const r = createSeededRandom('uniform');
    const buckets = new Array<number>(10).fill(0);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const k = r.int(0, 9);
      buckets[k] = (buckets[k] ?? 0) + 1;
    }
    const expected = n / 10;
    const chi = buckets.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    // 9 degrees of freedom: p = 0.001 critical value is 27.9.
    expect(chi).toBeLessThan(27.9);
  });

  it('float is in [0, 1), chance respects its bounds', () => {
    const r = createSeededRandom('float');
    for (let i = 0; i < 1000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
    for (let i = 0; i < 100; i++) {
      expect(r.chance(0, 7)).toBe(false);
      expect(r.chance(7, 7)).toBe(true);
    }
    expect(() => r.chance(2, 1)).toThrow(RangeError);
  });

  it('shuffle is a permutation and does not modify its input', () => {
    const r = createSeededRandom('shuffle');
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = r.shuffle(input);
    expect([...out].sort((x, y) => x - y)).toEqual([...input]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => r.pick([])).toThrow(RangeError);
    expect(input).toContain(r.pick(input));
  });

  it('bytes have the requested length; fork streams are stable and independent', () => {
    const r = createSeededRandom('bytes');
    expect(r.bytes(0)).toHaveLength(0);
    expect(r.bytes(7)).toHaveLength(7);
    expect(r.hex(10)).toMatch(/^[0-9a-f]{20}$/);
    // fork depends only on (seed, label), not on how much of the parent was consumed.
    const parent1 = createSeededRandom('p');
    const parent2 = createSeededRandom('p');
    parent2.bytes(100);
    expect(parent1.fork('x').hex(8)).toBe(parent2.fork('x').hex(8));
    expect(parent1.fork('x').hex(8)).not.toBe(parent1.fork('y').hex(8));
  });
});
