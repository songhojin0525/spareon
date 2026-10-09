/**
 * Development identity for the S04 walking skeleton. apps/agent/internal/devauth is the Go twin; both are
 * pinned by fixtures/vectors/dev-identity.json.
 *
 * SKELETON(S10): enrollment (enroll.start/complete, stored device keys, hardware fingerprints) replaces
 * this. Until then an agent and the server that share DEV_AGENT_SECRET derive the same node id,
 * fingerprints and ed25519 device key, so the real hello -> auth.challenge -> auth.prove handshake
 * (signature over a one-time nonce) runs unchanged. Anyone who knows the secret can act as any node:
 * development only (the server refuses DEV_AGENT_SECRET in production).
 */
import { createHmac } from 'node:crypto';

import { uuidV7 } from '@binjari/shared';

import { sha256Hex } from './bundle.js';
import { publicKeyFromSeed } from './sign.js';

/** Node names: what the founder types on a friend's PC (`--name`). */
export const DEV_NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Timestamp embedded in derived node ids (2026-01-01T00:00:00Z): fixed so the id is deterministic. */
export const DEV_NODE_ID_EPOCH_MS = 1_767_225_600_000;

const DOMAIN = {
  nodeId: 'binjari-dev-node-id-v1',
  nodeKey: 'binjari-dev-node-key-v1',
  fpStore: 'binjari-dev-fp-store-v1',
  fpGlobal: 'binjari-dev-fp-global-v1',
  model: 'binjari-dev-model-v1',
} as const;

export class DevIdentityError extends Error {}

function hmac(secret: string, domain: string, value: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${domain}\n${value}`, 'utf8')
    .digest();
}

function needName(name: string): string {
  if (!DEV_NODE_NAME_RE.test(name)) {
    throw new DevIdentityError('node name must be 1..64 characters of A-Z a-z 0-9 . _ -');
  }
  return name;
}

function needSecret(secret: string): string {
  if (secret.length === 0) throw new DevIdentityError('secret is empty');
  return secret;
}

/** ed25519 seed (lowercase hex) of a node: what the server re-derives to check auth.prove. */
export function devNodeSeed(secret: string, nodeId: string): string {
  return hmac(needSecret(secret), DOMAIN.nodeKey, nodeId).toString('hex');
}

/** Lowercase-hex public key of a node's derived device key. */
export function devNodePublicKey(secret: string, nodeId: string): string {
  return publicKeyFromSeed(devNodeSeed(secret, nodeId));
}

export interface DevAgentIdentity {
  readonly name: string;
  readonly nodeId: string;
  readonly seedHex: string;
  readonly publicKey: string;
  readonly fpStore: string;
  readonly fpGlobal: string;
}

/** Everything an agent named `name` needs for hello/auth.prove, derived from the shared secret. */
export function devAgentIdentity(secret: string, name: string): DevAgentIdentity {
  needSecret(secret);
  needName(name);
  const nodeId = uuidV7(DEV_NODE_ID_EPOCH_MS, hmac(secret, DOMAIN.nodeId, name));
  const seedHex = devNodeSeed(secret, nodeId);
  return {
    name,
    nodeId,
    seedHex,
    publicKey: publicKeyFromSeed(seedHex),
    fpStore: hmac(secret, DOMAIN.fpStore, name).toString('hex'),
    fpGlobal: hmac(secret, DOMAIN.fpGlobal, name).toString('hex'),
  };
}

/**
 * SKELETON(S09): placeholder model digest until the registry publishes signed model manifests. Agents
 * report it in capabilities.cachedModels and the server puts it in job.offer.model.
 */
export function devModelSha256(modelId: string): string {
  return sha256Hex(`${DOMAIN.model}\n${modelId}`);
}
