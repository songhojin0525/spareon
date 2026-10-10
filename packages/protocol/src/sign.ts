/**
 * Signed byte strings and ed25519 helpers. apps/agent/internal/protocol/sign.go is the Go twin; both are
 * pinned by fixtures/vectors/signatures.json.
 *
 * Every signed message starts with a domain string and a newline so a signature made for one purpose can
 * never verify for another. Every component is validated against a format that cannot contain "\n"
 * BEFORE the bytes are built, so field boundaries are unambiguous.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

import type { ProtocolCodec } from './codec.js';
import type { ManifestKind, ManifestMap, SignedManifest } from './generated/protocol.js';
import { canonicalJson } from './wire/canonical-json.js';
import { parseStrictJson } from './wire/strict-json.js';

export const AUTH_DOMAIN = 'spareon-auth-v1';
export const ENROLL_DOMAIN = 'spareon-enroll-v1';
export const MANIFEST_DOMAINS: Readonly<Record<ManifestKind, string>> = {
  model: 'spareon-model-manifest-v1',
  release: 'spareon-release-manifest-v1',
};

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SigningInputError extends Error {}

function need(re: RegExp, value: string, what: string): string {
  if (!re.test(value)) throw new SigningInputError(`${what} has the wrong format`);
  return value;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** "spareon-auth-v1\n" + nonce + "\n" + nodeId + "\n" + protocolHash (ADR 0008). */
export function authSigningBytes(nonce: string, nodeId: string, protocolHash: string): Uint8Array {
  return utf8(
    [
      AUTH_DOMAIN,
      need(HEX32, nonce, 'nonce'),
      need(UUID_V7, nodeId, 'nodeId'),
      need(HEX32, protocolHash, 'protocolHash'),
    ].join('\n'),
  );
}

export interface EnrollSigningInput {
  readonly nonce: string;
  readonly enrollId: string;
  readonly publicKey: string;
  readonly fpStore: string;
  readonly fpGlobal: string;
}

/** "spareon-enroll-v1\n" + nonce + "\n" + enrollId + "\n" + publicKey + "\n" + fpStore + "\n" + fpGlobal. */
export function enrollSigningBytes(i: EnrollSigningInput): Uint8Array {
  return utf8(
    [
      ENROLL_DOMAIN,
      need(HEX32, i.nonce, 'nonce'),
      need(UUID_V7, i.enrollId, 'enrollId'),
      need(HEX32, i.publicKey, 'publicKey'),
      need(HEX32, i.fpStore, 'fpStore'),
      need(HEX32, i.fpGlobal, 'fpGlobal'),
    ].join('\n'),
  );
}

/** "spareon-<kind>-manifest-v1\n" + the manifest's canonical JSON text, exactly as transmitted. */
export function manifestSigningBytes(kind: ManifestKind, manifestJson: string): Uint8Array {
  return utf8(`${MANIFEST_DOMAINS[kind]}\n${manifestJson}`);
}

// DER prefixes that wrap a raw 32-byte ed25519 seed / public key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Group order L of edwards25519, little-endian. Signatures with S >= L are rejected (malleability). */
const ORDER_L = Buffer.from(
  'edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010',
  'hex',
);

function privateKeyFromSeed(seedHex: string) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(need(HEX32, seedHex, 'seed'), 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Lowercase-hex public key for a lowercase-hex 32-byte seed. */
export function publicKeyFromSeed(seedHex: string): string {
  const der = createPublicKey(privateKeyFromSeed(seedHex)).export({ format: 'der', type: 'spki' });
  return der.subarray(SPKI_PREFIX.length).toString('hex');
}

/** Deterministic ed25519 signature (lowercase hex). */
export function signEd25519(seedHex: string, message: Uint8Array): string {
  return nodeSign(null, message, privateKeyFromSeed(seedHex)).toString('hex');
}

function scalarIsCanonical(sLittleEndian: Buffer): boolean {
  for (let i = 31; i >= 0; i--) {
    const a = sLittleEndian[i] ?? 0;
    const b = ORDER_L[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false; // S == L
}

/** Field prime p = 2^255 - 19, little-endian. */
const FIELD_P = Buffer.from('ed' + 'ff'.repeat(30) + '7f', 'hex');
/**
 * y-coordinates (little-endian, sign bit clear) of the 8 small-order points of edwards25519: y = 1
 * (identity), y = p - 1 (order 2), y = 0 (order 4, two points) and the two order-8 y values (four points).
 */
const SMALL_ORDER_Y: readonly string[] = [
  '01' + '00'.repeat(31),
  'ec' + 'ff'.repeat(30) + '7f',
  '00'.repeat(32),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
];

/**
 * True when a public key may be enrolled and used: lowercase hex of 32 bytes, canonically encoded
 * (y < p) and not one of the 8 small-order points. Plain RFC 8032 verification (OpenSSL, Go) accepts
 * small-order keys, for which anyone can forge signatures without a private key, and non-canonical
 * encodings, which give one key several spellings. Go's IsAcceptablePublicKey is the twin.
 */
export function isAcceptablePublicKey(publicKeyHex: string): boolean {
  if (!HEX32.test(publicKeyHex)) return false;
  const y = Buffer.from(publicKeyHex, 'hex');
  y[31] = (y[31] ?? 0) & 0x7f;
  let belowP = false;
  for (let i = 31; i >= 0; i--) {
    const a = y[i] ?? 0;
    const b = FIELD_P[i] ?? 0;
    if (a !== b) {
      belowP = a < b;
      break;
    }
  }
  return belowP && !SMALL_ORDER_Y.includes(y.toString('hex'));
}

/**
 * Verifies an ed25519 signature. Inputs must be lowercase hex of the exact length; anything else is
 * false (never throws), as is a non-canonical S or a public key that isAcceptablePublicKey refuses. Go
 * applies the same rules.
 */
export function verifyEd25519(
  publicKeyHex: string,
  message: Uint8Array,
  signatureHex: string,
): boolean {
  if (!isAcceptablePublicKey(publicKeyHex) || !HEX64.test(signatureHex)) return false;
  const sig = Buffer.from(signatureHex, 'hex');
  if (!scalarIsCanonical(sig.subarray(32))) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return nodeVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

export type ManifestVerdict<K extends ManifestKind> =
  | { readonly ok: true; readonly manifest: ManifestMap[K] }
  | { readonly ok: false; readonly code: 'manifest_signature_invalid' | 'manifest_invalid' };

/**
 * Verify-then-parse: (1) known keyId, (2) signature over the exact transmitted bytes, (3) strict JSON,
 * (4) the text is already canonical (so no parser can see different content), (5) manifest schema.
 */
export function verifySignedManifest<K extends ManifestKind>(
  codec: ProtocolCodec,
  kind: K,
  signed: SignedManifest,
  trustedKeys: Readonly<Record<string, string>>,
): ManifestVerdict<K> {
  const key = Object.hasOwn(trustedKeys, signed.keyId) ? trustedKeys[signed.keyId] : undefined;
  if (key === undefined) return { ok: false, code: 'manifest_signature_invalid' };
  if (!verifyEd25519(key, manifestSigningBytes(kind, signed.manifest), signed.signature)) {
    return { ok: false, code: 'manifest_signature_invalid' };
  }
  const parsed = parseStrictJson(signed.manifest);
  if (!parsed.ok) return { ok: false, code: 'manifest_invalid' };
  let canonical: string;
  try {
    canonical = canonicalJson(parsed.value);
  } catch {
    return { ok: false, code: 'manifest_invalid' };
  }
  if (canonical !== signed.manifest) return { ok: false, code: 'manifest_invalid' };
  if (!codec.isValidManifest(kind, parsed.value)) return { ok: false, code: 'manifest_invalid' };
  return { ok: true, manifest: parsed.value };
}

/** Signs a manifest object: returns its canonical text and signature (for tools and tests). */
export function signManifest<K extends ManifestKind>(
  kind: K,
  manifest: ManifestMap[K],
  seedHex: string,
  keyId: string,
): SignedManifest {
  const text = canonicalJson(manifest);
  return {
    manifest: text,
    signature: signEd25519(seedHex, manifestSigningBytes(kind, text)),
    keyId,
  };
}
