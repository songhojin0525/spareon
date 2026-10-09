import { PROTOCOL_HASH } from './generated/protocol.js';

/**
 * Protocol hashes the server accepts in `hello`. The current hash is always first. When a schema change
 * ships, the previous bundle is archived in packages/protocol/history/<hash>.json and its hash stays here
 * until every node has updated (PROTOCOL.md "버전 정책"); the server then talks to each session with the
 * codec of that session's hash (createCodec(bundle)).
 */
export const SUPPORTED_PROTOCOL_HASHES: readonly string[] = [PROTOCOL_HASH];

/** Unknown hash -> the server answers auth.fail(code = protocol_unsupported). */
export function isSupportedProtocolHash(
  hash: string,
  supported: readonly string[] = SUPPORTED_PROTOCOL_HASHES,
): boolean {
  return supported.includes(hash);
}
