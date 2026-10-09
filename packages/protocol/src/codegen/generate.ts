import { type ProtocolBundle, protocolHashOf } from '../bundle.js';
import { lintSchema } from '../schema-lint.js';
import { canonicalJson } from '../wire/canonical-json.js';
import { emitGo } from './emit-go.js';
import { emitTs, emitTsBundle } from './emit-ts.js';
import { buildIR } from './ir.js';

/** Data files in the bundle that are not JSON Schemas (still hashed, never compiled). */
export const DATA_FILES = new Set(['registry.json', 'limits.json', 'defs/error-codes.json']);

/** Generated outputs, keyed by path relative to the repository root (forward slashes). */
export const OUTPUTS = {
  tsTypes: 'packages/protocol/src/generated/protocol.ts',
  tsBundle: 'packages/protocol/src/generated/bundle.ts',
  goTypes: 'apps/agent/internal/protocol/zz_generated.go',
  goBundle: 'apps/agent/internal/protocol/bundle.json',
} as const;

/**
 * Lints the schemas and renders every generated file in memory. Pure: the gen script writes the result,
 * the freshness test compares it with what is on disk.
 */
export function generateAll(bundle: ProtocolBundle): Map<string, string> {
  const problems = Object.entries(bundle.files).flatMap(([rel, doc]) =>
    DATA_FILES.has(rel) ? [] : lintSchema(rel, doc),
  );
  if (problems.length > 0) throw new Error(`schema rule violations:\n${problems.join('\n')}`);
  const canonical = canonicalJson(bundle);
  const hash = protocolHashOf(bundle);
  const ir = buildIR(bundle);
  return new Map([
    [OUTPUTS.tsTypes, emitTs(ir, hash)],
    [OUTPUTS.tsBundle, emitTsBundle(canonical)],
    [OUTPUTS.goTypes, emitGo(ir, hash)],
    [OUTPUTS.goBundle, `${canonical}\n`],
  ]);
}
