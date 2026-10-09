/**
 * Canonical JSON (a subset of RFC 8785 JCS), shared with apps/agent/internal/protocol/canonical.go.
 *
 * - object keys sorted by UTF-16 code units (JS default string order), no insignificant whitespace
 * - strings escape only `"`, `\`, and control characters below U+0020 (\b \t \n \f \r, others \u00xx
 *   lowercase); everything else, including non-ASCII, is written as UTF-8
 * - numbers must be safe integers (|n| <= 2^53 - 1), written in plain decimal; -0 becomes 0
 *
 * Used for the protocol hash (schema bundle) and signed manifests. Anything else throws.
 */
import { hasLoneSurrogate, parseStrictJson } from './strict-json.js';

export class CanonicalJsonError extends Error {}

export function canonicalJson(value: unknown): string {
  return write(value);
}

/** Strict-parses JSON text (see strict-json.ts) and returns its canonical form. */
export function canonicalizeJsonText(text: string | Uint8Array): string {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw new CanonicalJsonError(`not strict JSON: ${parsed.reason}`);
  return write(parsed.value);
}

function write(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new CanonicalJsonError('only safe integers are allowed');
      return Object.is(v, -0) ? '0' : String(v);
    case 'string':
      if (hasLoneSurrogate(v)) throw new CanonicalJsonError('lone surrogate in string');
      // For well-formed strings JSON.stringify escapes exactly the JCS set.
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects are allowed');
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${write(k)}:${write(obj[k])}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported value type: ${typeof v}`);
  }
}
