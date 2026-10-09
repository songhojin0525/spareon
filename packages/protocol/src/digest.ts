import { sha256Hex } from './bundle.js';
import type { CapabilitiesPayload } from './generated/protocol.js';
import { canonicalJson } from './wire/canonical-json.js';

/** hello.capabilitiesDigest: SHA-256 of the canonical JSON of the capabilities payload (Go twin: CapabilitiesDigest). */
export function capabilitiesDigest(payload: CapabilitiesPayload): string {
  return sha256Hex(canonicalJson(payload));
}
