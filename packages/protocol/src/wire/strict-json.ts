/**
 * Strict JSON recognizer shared (algorithm for algorithm) with apps/agent/internal/protocol/strictjson.go.
 *
 * JSON.parse and Go's encoding/json disagree on inputs the protocol never needs: non-integer numbers
 * (JS rounds 5.0000000000000001 to the integer 5), integers above 2^53, duplicate keys, lone UTF-16
 * surrogate escapes, a byte-order mark, invalid UTF-8 and very deep nesting. This recognizer rejects
 * all of them BEFORE parsing, so whatever passes is parsed identically by both languages.
 *
 * Rules (PROTOCOL.md "엄격 JSON"):
 * - input is valid UTF-8 without BOM; whitespace is only space, \t, \n, \r
 * - numbers are integers: -?(0|[1-9][0-9]*), at most 16 digits, no fraction, no exponent
 * - strings: no raw control characters, only the standard escapes, \u surrogates must pair
 * - no duplicate keys within one object (compared after unescaping)
 * - at most MAX_DEPTH nested objects/arrays; nothing after the top-level value
 */

export const MAX_DEPTH = 32;
export const MAX_INTEGER_DIGITS = 16;

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; reason: string };

class StrictJsonError extends Error {}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True if a JS string holds an unpaired UTF-16 surrogate (it has no UTF-8 encoding). */
export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE_RE.test(s);
}

const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 bytes (fatal on invalid sequences, BOM kept so the recognizer rejects it). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Checks `text` against the strict rules; on success parses it with JSON.parse. */
export function parseStrictJson(input: string | Uint8Array): StrictJsonResult {
  let text: string;
  if (typeof input === 'string') {
    if (hasLoneSurrogate(input)) return { ok: false, reason: 'lone surrogate in input string' };
    text = input;
  } else {
    const decoded = decodeUtf8(input);
    if (decoded === null) return { ok: false, reason: 'invalid UTF-8' };
    text = decoded;
  }
  try {
    new Recognizer(text).run();
  } catch (e) {
    if (e instanceof StrictJsonError) return { ok: false, reason: e.message };
    throw e;
  }
  return { ok: true, value: JSON.parse(text) as unknown };
}

const isHex = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

class Recognizer {
  private pos = 0;
  constructor(private readonly s: string) {}

  run(): void {
    this.ws();
    this.value(0);
    this.ws();
    if (this.pos !== this.s.length) this.fail('trailing data');
  }

  private fail(why: string): never {
    throw new StrictJsonError(`${why} at offset ${this.pos}`);
  }

  private peek(): number {
    return this.pos < this.s.length ? this.s.charCodeAt(this.pos) : -1;
  }

  private ws(): void {
    for (;;) {
      const c = this.peek();
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }

  private value(depth: number): void {
    const c = this.peek();
    if (c === 0x7b) this.object(depth + 1);
    else if (c === 0x5b) this.array(depth + 1);
    else if (c === 0x22) this.string();
    else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) this.number();
    else if (c === 0x74) this.literal('true');
    else if (c === 0x66) this.literal('false');
    else if (c === 0x6e) this.literal('null');
    else this.fail('unexpected character');
  }

  private literal(word: string): void {
    if (this.s.startsWith(word, this.pos)) this.pos += word.length;
    else this.fail('invalid literal');
  }

  private object(depth: number): void {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    this.pos++; // {
    this.ws();
    if (this.peek() === 0x7d) {
      this.pos++;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      if (this.peek() !== 0x22) this.fail('expected key');
      const start = this.pos;
      this.string();
      const key = JSON.parse(this.s.slice(start, this.pos)) as string;
      if (keys.has(key)) this.fail('duplicate key');
      keys.add(key);
      this.ws();
      if (this.peek() !== 0x3a) this.fail('expected colon');
      this.pos++;
      this.ws();
      this.value(depth);
      this.ws();
      const c = this.peek();
      if (c === 0x2c) {
        this.pos++;
        this.ws();
      } else if (c === 0x7d) {
        this.pos++;
        return;
      } else this.fail('expected comma or closing brace');
    }
  }

  private array(depth: number): void {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    this.pos++; // [
    this.ws();
    if (this.peek() === 0x5d) {
      this.pos++;
      return;
    }
    for (;;) {
      this.value(depth);
      this.ws();
      const c = this.peek();
      if (c === 0x2c) {
        this.pos++;
        this.ws();
      } else if (c === 0x5d) {
        this.pos++;
        return;
      } else this.fail('expected comma or closing bracket');
    }
  }

  private hex4(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.peek();
      if (!isHex(c)) this.fail('invalid unicode escape');
      v = v * 16 + Number.parseInt(String.fromCharCode(c), 16);
      this.pos++;
    }
    return v;
  }

  private string(): void {
    this.pos++; // opening quote
    for (;;) {
      const c = this.peek();
      if (c === -1) this.fail('unterminated string');
      if (c === 0x22) {
        this.pos++;
        return;
      }
      if (c < 0x20) this.fail('control character in string');
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      this.pos++; // backslash
      const e = this.peek();
      if (
        e === 0x22 ||
        e === 0x5c ||
        e === 0x2f ||
        e === 0x62 ||
        e === 0x66 ||
        e === 0x6e ||
        e === 0x72 ||
        e === 0x74
      ) {
        this.pos++;
        continue;
      }
      if (e !== 0x75) this.fail('invalid escape');
      this.pos++;
      const cu = this.hex4();
      if (cu >= 0xdc00 && cu <= 0xdfff) this.fail('lone low surrogate escape');
      if (cu >= 0xd800 && cu <= 0xdbff) {
        if (this.peek() !== 0x5c || this.s.charCodeAt(this.pos + 1) !== 0x75) {
          this.fail('lone high surrogate escape');
        }
        this.pos += 2;
        const low = this.hex4();
        if (low < 0xdc00 || low > 0xdfff) this.fail('lone high surrogate escape');
      }
    }
  }

  private number(): void {
    if (this.peek() === 0x2d) this.pos++;
    const start = this.pos;
    const first = this.peek();
    if (first === 0x30) this.pos++;
    else if (first >= 0x31 && first <= 0x39) {
      while (this.peek() >= 0x30 && this.peek() <= 0x39) this.pos++;
    } else this.fail('invalid number');
    if (this.pos - start > MAX_INTEGER_DIGITS) this.fail('integer has too many digits');
    const next = this.peek();
    if (next === 0x2e || next === 0x65 || next === 0x45) this.fail('non-integer number');
  }
}
