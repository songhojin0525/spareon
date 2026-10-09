import { readFileSync } from 'node:fs';

import { isUuidV7, uuidV7TimeMs } from '@binjari/shared';
import { describe, expect, it } from 'vitest';

import {
  authSigningBytes,
  DEV_NODE_ID_EPOCH_MS,
  devAgentIdentity,
  DevIdentityError,
  devModelSha256,
  devNodePublicKey,
  isAcceptablePublicKey,
  signEd25519,
  verifyEd25519,
} from '../src/index.js';

interface Vectors {
  cases: {
    secret: string;
    name: string;
    nodeId: string;
    seedHex: string;
    publicKey: string;
    fpStore: string;
    fpGlobal: string;
    authNonce: string;
    authProtocolHash: string;
    authSignature: string;
  }[];
  models: { id: string; sha256: string }[];
  invalidNames: string[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/vectors/dev-identity.json', import.meta.url), 'utf8'),
) as Vectors;

describe('development identity (vectors shared with Go internal/devauth)', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('derives %s', (_n, c) => {
    const id = devAgentIdentity(c.secret, c.name);
    expect(id).toEqual({
      name: c.name,
      nodeId: c.nodeId,
      seedHex: c.seedHex,
      publicKey: c.publicKey,
      fpStore: c.fpStore,
      fpGlobal: c.fpGlobal,
    });
    // Independent properties: a canonical UUIDv7 at the fixed epoch, an acceptable key that the server
    // re-derives from the node id alone, and a signature over the real auth.prove bytes that verifies.
    expect(isUuidV7(id.nodeId)).toBe(true);
    expect(uuidV7TimeMs(id.nodeId)).toBe(DEV_NODE_ID_EPOCH_MS);
    expect(isAcceptablePublicKey(id.publicKey)).toBe(true);
    expect(devNodePublicKey(c.secret, id.nodeId)).toBe(id.publicKey);
    const bytes = authSigningBytes(c.authNonce, id.nodeId, c.authProtocolHash);
    expect(signEd25519(id.seedHex, bytes)).toBe(c.authSignature);
    expect(verifyEd25519(id.publicKey, bytes, c.authSignature)).toBe(true);
  });

  it('gives different nodes, keys and fingerprints for different names and secrets', () => {
    const a = devAgentIdentity('secret-aaaaaaaaaaaaaaaaaaaaaaaa', 'pc-1');
    const b = devAgentIdentity('secret-aaaaaaaaaaaaaaaaaaaaaaaa', 'pc-2');
    const c = devAgentIdentity('secret-bbbbbbbbbbbbbbbbbbbbbbbb', 'pc-1');
    for (const k of ['nodeId', 'publicKey', 'fpStore', 'fpGlobal'] as const) {
      expect(new Set([a[k], b[k], c[k]]).size).toBe(3);
    }
    // A key derived with the wrong secret does not verify the right node's signature.
    const bytes = authSigningBytes('ab'.repeat(32), a.nodeId, 'cd'.repeat(32));
    const sig = signEd25519(a.seedHex, bytes);
    expect(
      verifyEd25519(devNodePublicKey('secret-bbbbbbbbbbbbbbbbbbbbbbbb', a.nodeId), bytes, sig),
    ).toBe(false);
  });

  it.each(vectors.invalidNames)('rejects the node name %j', (name) => {
    expect(() => devAgentIdentity('secret-aaaaaaaaaaaaaaaaaaaaaaaa', name)).toThrow(
      DevIdentityError,
    );
  });

  it('rejects an empty secret', () => {
    expect(() => devAgentIdentity('', 'pc-1')).toThrow(DevIdentityError);
  });

  it.each(vectors.models.map((m) => [m.id, m.sha256] as const))('model digest %s', (id, sha) => {
    expect(devModelSha256(id)).toBe(sha);
  });
});
