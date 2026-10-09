// Writes fixtures/vectors/dev-identity.json (the Go devauth tests read the same file).
// Run: pnpm --filter @binjari/protocol exec tsx scripts/gen-dev-identity-vectors.ts
import { writeFileSync } from 'node:fs';

import {
  authSigningBytes,
  devAgentIdentity,
  devModelSha256,
  PROTOCOL_HASH,
  signEd25519,
} from '../src/index.js';

const NONCE = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const cases = [
  { secret: 'dev-agent-secret-0123456789abcdef', name: 'friend-pc-1' },
  { secret: 'dev-agent-secret-0123456789abcdef', name: 'friend-pc-2' },
  { secret: '한글 비밀값도 UTF-8 바이트로 쓴다 0123456789', name: 'A.b_c-9' },
  { secret: 'x'.repeat(256), name: 'n'.repeat(64) },
].map(({ secret, name }) => {
  const id = devAgentIdentity(secret, name);
  return {
    secret,
    name,
    nodeId: id.nodeId,
    seedHex: id.seedHex,
    publicKey: id.publicKey,
    fpStore: id.fpStore,
    fpGlobal: id.fpGlobal,
    authNonce: NONCE,
    authProtocolHash: PROTOCOL_HASH,
    authSignature: signEd25519(id.seedHex, authSigningBytes(NONCE, id.nodeId, PROTOCOL_HASH)),
  };
});
const models = ['fake-echo', 'qwen2.5-0.5b'].map((id) => ({ id, sha256: devModelSha256(id) }));
const invalidNames = ['', 'has space', 'colon:name', 'n'.repeat(65), '한글'];
writeFileSync(
  new URL('../fixtures/vectors/dev-identity.json', import.meta.url),
  JSON.stringify(
    {
      description:
        'S04 development identity (SKELETON(S10)); TS dev-identity.ts and Go internal/devauth must agree.',
      cases,
      models,
      invalidNames,
    },
    null,
    2,
  ) + '\n',
);
