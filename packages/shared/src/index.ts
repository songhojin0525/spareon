// SKELETON(S06): bigint money helpers (minimal-unit parsing and formatting) arrive with the ledger.

export { isUuidV7, newUuidV7, uuidV7, uuidV7TimeMs } from './ids.js';
export { formatTimestamp, parseTimestamp, TIMESTAMP_PATTERN } from './time.js';

/** 1 CR = 1,000,000 µCR (CLAUDE.md glossary). Money is always bigint minimal units. */
export const MICRO_CR_PER_CR = 1_000_000n;
