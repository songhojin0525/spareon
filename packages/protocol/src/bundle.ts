import { createHash } from 'node:crypto';

import { canonicalJson } from './wire/canonical-json.js';

/** Base URI of every schema `$id`. `.invalid` can never resolve, so no validator fetches anything. */
export const SCHEMA_BASE_URI = 'https://schemas.binjari.invalid/protocol/';
export const BUNDLE_FORMAT = 'binjari-protocol-bundle/1';

/**
 * The protocol bundle: every file under packages/protocol/schemas, keyed by its path relative to that
 * folder (forward slashes), as parsed JSON. `protocolHash` = SHA-256 of the bundle's canonical JSON, so
 * formatting, key order and line endings never change the hash; any semantic change does.
 */
export interface ProtocolBundle {
  readonly format: typeof BUNDLE_FORMAT;
  readonly files: Readonly<Record<string, unknown>>;
}

export function makeBundle(files: Readonly<Record<string, unknown>>): ProtocolBundle {
  for (const rel of Object.keys(files)) {
    if (!/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*\.json$/.test(rel)) {
      throw new Error(`bundle path must be lowercase relative JSON path: ${rel}`);
    }
  }
  return { format: BUNDLE_FORMAT, files };
}

export function canonicalBundle(bundle: ProtocolBundle): string {
  return canonicalJson(bundle);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function protocolHashOf(bundle: ProtocolBundle): string {
  return sha256Hex(canonicalBundle(bundle));
}
