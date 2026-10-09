import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultCodec } from '../src/codec.js';
import type { ManifestKind, SignedManifest } from '../src/generated/protocol.js';
import { FIXTURE_DIR } from '../src/schema-source.js';
import {
  authSigningBytes,
  enrollSigningBytes,
  publicKeyFromSeed,
  signEd25519,
  SigningInputError,
  signManifest,
  verifyEd25519,
  verifySignedManifest,
} from '../src/sign.js';
import { canonicalJson } from '../src/wire/canonical-json.js';

interface AuthCase {
  name: string;
  publicKey: string;
  nonce: string;
  nodeId: string;
  protocolHash: string;
  signature: string;
  valid: boolean;
}
interface EnrollCase {
  name: string;
  nonce: string;
  enrollId: string;
  publicKey: string;
  fpStore: string;
  fpGlobal: string;
  signature: string;
  valid: boolean;
}
interface Vectors {
  key: { seed: string; publicKey: string };
  otherKey: { seed: string; publicKey: string };
  auth: {
    input: { nonce: string; nodeId: string; protocolHash: string };
    bytesHex: string;
    signature: string;
    verify: AuthCase[];
    badInputs: { name: string; nonce: string; nodeId: string; protocolHash: string }[];
  };
  enroll: {
    input: Omit<EnrollCase, 'name' | 'signature' | 'valid'>;
    bytesHex: string;
    signature: string;
    verify: EnrollCase[];
  };
  manifests: {
    trustedKeys: Record<string, string>;
    cases: {
      name: string;
      kind: ManifestKind;
      signed: SignedManifest;
      expect: 'ok' | 'manifest_signature_invalid' | 'manifest_invalid';
      manifest?: unknown;
    }[];
  };
}

const vectors = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, 'vectors', 'signatures.json'), 'utf8'),
) as Vectors;
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('ed25519 keys (RFC 8032 test vectors)', () => {
  it('derives the RFC public keys from the seeds', () => {
    expect(publicKeyFromSeed(vectors.key.seed)).toBe(vectors.key.publicKey);
    expect(publicKeyFromSeed(vectors.otherKey.seed)).toBe(vectors.otherKey.publicKey);
    expect(vectors.key.publicKey).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });
});

describe('auth.prove signing bytes (S02 acceptance 4)', () => {
  const { nonce, nodeId, protocolHash } = vectors.auth.input;

  it('builds exactly the documented bytes', () => {
    const bytes = authSigningBytes(nonce, nodeId, protocolHash);
    expect(hex(bytes)).toBe(vectors.auth.bytesHex);
    expect(new TextDecoder().decode(bytes)).toBe(
      `binjari-auth-v1\n${nonce}\n${nodeId}\n${protocolHash}`,
    );
  });

  it('signs deterministically to the vector signature', () => {
    expect(signEd25519(vectors.key.seed, authSigningBytes(nonce, nodeId, protocolHash))).toBe(
      vectors.auth.signature,
    );
  });

  it.each(vectors.auth.verify.map((c) => [c.name, c] as const))('verify: %s', (_n, c) => {
    let ok: boolean;
    try {
      ok = verifyEd25519(
        c.publicKey,
        authSigningBytes(c.nonce, c.nodeId, c.protocolHash),
        c.signature,
      );
    } catch {
      ok = false;
    }
    expect(ok).toBe(c.valid);
  });

  it.each(vectors.auth.badInputs.map((c) => [c.name, c] as const))(
    'refuses to build bytes: %s',
    (_n, c) => {
      expect(() => authSigningBytes(c.nonce, c.nodeId, c.protocolHash)).toThrow(SigningInputError);
    },
  );
});

describe('enroll.complete signing bytes', () => {
  it('builds exactly the documented bytes and signature', () => {
    const bytes = enrollSigningBytes(vectors.enroll.input);
    expect(hex(bytes)).toBe(vectors.enroll.bytesHex);
    expect(signEd25519(vectors.key.seed, bytes)).toBe(vectors.enroll.signature);
  });

  it.each(vectors.enroll.verify.map((c) => [c.name, c] as const))('verify: %s', (_n, c) => {
    expect(verifyEd25519(c.publicKey, enrollSigningBytes(c), c.signature)).toBe(c.valid);
  });
});

describe('signed manifests (verify-then-parse)', () => {
  const codec = defaultCodec();
  it.each(vectors.manifests.cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const r = verifySignedManifest(codec, c.kind, c.signed, vectors.manifests.trustedKeys);
    expect(r.ok ? 'ok' : r.code).toBe(c.expect);
    if (r.ok) expect(canonicalJson(r.manifest)).toBe(canonicalJson(c.manifest));
  });

  it('signManifest reproduces the vector for the valid model manifest', () => {
    const c = vectors.manifests.cases.find((x) => x.name === 'valid model manifest');
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(signManifest('model', c.manifest as never, vectors.key.seed, c.signed.keyId)).toEqual(
      c.signed,
    );
  });

  it('a trusted-key map inherited property is not a key', () => {
    const c = vectors.manifests.cases[0];
    if (c === undefined) throw new Error('no cases');
    const r = verifySignedManifest(codec, c.kind, { ...c.signed, keyId: 'constructor' }, {});
    expect(r.ok).toBe(false);
  });
});
