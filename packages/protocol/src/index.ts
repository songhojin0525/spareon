// Agent <-> server protocol contract (S02). Source of truth: packages/protocol/schemas (docs/PROTOCOL.md).

/** JSON Schema dialect used by every protocol schema (single source of truth for TS and Go). */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export {
  canonicalBundle,
  makeBundle,
  type ProtocolBundle,
  protocolHashOf,
  sha256Hex,
} from './bundle.js';
export {
  createCodec,
  type Decoded,
  type DecodeOptions,
  defaultBundle,
  defaultCodec,
  inlineTextBytes,
  makeMessage,
  type MessageMeta,
  type ProtocolCodec,
  ProtocolEncodeError,
  receiversOf,
  type Side,
  type VerdictCode,
} from './codec.js';
export { isSupportedProtocolHash, SUPPORTED_PROTOCOL_HASHES } from './compat.js';
export { capabilitiesDigest } from './digest.js';
export * from './generated/protocol.js';
export {
  AUTH_DOMAIN,
  authSigningBytes,
  ENROLL_DOMAIN,
  enrollSigningBytes,
  type EnrollSigningInput,
  isAcceptablePublicKey,
  MANIFEST_DOMAINS,
  manifestSigningBytes,
  type ManifestVerdict,
  publicKeyFromSeed,
  signEd25519,
  SigningInputError,
  signManifest,
  verifyEd25519,
  verifySignedManifest,
} from './sign.js';
export { canonicalizeJsonText, canonicalJson, CanonicalJsonError } from './wire/canonical-json.js';
export { parseStrictJson, type StrictJsonResult } from './wire/strict-json.js';
