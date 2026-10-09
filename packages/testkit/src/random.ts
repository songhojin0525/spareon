/**
 * Seeded, deterministic pseudo-random numbers for tests and dev tooling (sfc32 seeded by cyrb128).
 * NOT cryptographically secure: never use it for keys, tokens or anything an attacker could predict.
 * The same seed always yields the same sequence on every platform (32-bit integer math only).
 */
export interface SeededRandom {
  readonly seed: string;
  /** Uniform integer in [0, 2^32). */
  uint32(): number;
  /** Uniform integer in [min, max] (inclusive). Both must be safe integers and max - min < 2^32. */
  int(min: number, max: number): number;
  /** Uniform float in [0, 1). For simulations and shuffles only, never for money. */
  float(): number;
  /** true with probability numerator / denominator (integers, 0 <= numerator <= denominator). */
  chance(numerator: number, denominator: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** New array with the items in random order (Fisher-Yates). The input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  bytes(length: number): Uint8Array;
  /** Lowercase hex string of `byteLength` random bytes. */
  hex(byteLength: number): string;
  /** An independent stream derived from this seed and a label (stable regardless of call order). */
  fork(label: string): SeededRandom;
}

/** cyrb128: hashes a string into four 32-bit seeds. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const TWO_POW_32 = 0x1_0000_0000;

export function createSeededRandom(seed: string | number): SeededRandom {
  const seedText = String(seed);
  let [a, b, c, d] = cyrb128(seedText);

  // sfc32
  const uint32 = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Warm up: the first outputs of sfc32 are correlated with the seed.
  for (let i = 0; i < 15; i++) uint32();

  /** Unbiased integer in [0, n) for 1 <= n <= 2^32 (rejection sampling). */
  const below = (n: number): number => {
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    for (;;) {
      const x = uint32();
      if (x < limit) return x % n;
    }
  };

  const rng: SeededRandom = {
    seed: seedText,
    uint32,
    int(min, max) {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
        throw new RangeError(`int: invalid range [${String(min)}, ${String(max)}]`);
      }
      const span = max - min + 1;
      if (span > TWO_POW_32) throw new RangeError('int: range wider than 2^32');
      return min + below(span);
    },
    float() {
      return uint32() / TWO_POW_32;
    },
    chance(numerator, denominator) {
      if (
        !Number.isSafeInteger(numerator) ||
        !Number.isSafeInteger(denominator) ||
        denominator <= 0 ||
        numerator < 0 ||
        numerator > denominator
      ) {
        throw new RangeError(
          'chance: need integers with 0 <= numerator <= denominator, denominator > 0',
        );
      }
      return below(denominator) < numerator;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick: empty array');
      return items[below(items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = below(i + 1);
        const tmp = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = tmp;
      }
      return out;
    },
    bytes(length) {
      if (!Number.isSafeInteger(length) || length < 0)
        throw new RangeError('bytes: invalid length');
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 4) {
        let x = uint32();
        for (let k = 0; k < 4 && i + k < length; k++) {
          out[i + k] = x & 0xff;
          x >>>= 8;
        }
      }
      return out;
    },
    hex(byteLength) {
      return Buffer.from(rng.bytes(byteLength)).toString('hex');
    },
    fork(label) {
      return createSeededRandom(`${seedText}/${label}`);
    },
  };
  return rng;
}
