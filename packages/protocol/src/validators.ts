import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { type ProtocolBundle, SCHEMA_BASE_URI } from './bundle.js';
import { isSchemaFile } from './schema-lint.js';

export interface CompiledValidators {
  readonly envelope: ValidateFunction;
  /** messages/<type>.json, keyed by message type. */
  readonly messages: ReadonlyMap<string, ValidateFunction>;
  /** http/<name>.json, keyed by body name. */
  readonly http: ReadonlyMap<string, ValidateFunction>;
  /** manifests/<kind>.json, keyed by manifest kind. */
  readonly manifests: ReadonlyMap<string, ValidateFunction>;
}

const stem = (rel: string, dir: string): string | null =>
  rel.startsWith(`${dir}/`) && rel.endsWith('.json')
    ? rel.slice(dir.length + 1, -'.json'.length)
    : null;

/**
 * Compiles every schema in the bundle with one Ajv instance. Strict mode turns schema mistakes into
 * compile errors; no formats, no remote loading (all `$id`s are under the never-resolving base URI).
 */
export function compileValidators(bundle: ProtocolBundle): CompiledValidators {
  const ajv = new Ajv2020({
    strict: true,
    // Message schemas $ref the envelope for their object type and require `corr` declared there; Ajv does not
    // follow $ref for these two checks. schema-lint.ts enforces the type rules instead.
    strictRequired: false,
    strictTypes: false,
    allErrors: false,
    validateFormats: false,
    unicodeRegExp: true,
  });
  for (const [rel, doc] of Object.entries(bundle.files)) {
    if (!isSchemaFile(doc)) continue;
    const id = (doc as { $id?: unknown }).$id;
    if (id !== SCHEMA_BASE_URI + rel)
      throw new Error(`${rel}: $id must be ${SCHEMA_BASE_URI}${rel}`);
    ajv.addSchema(doc as object);
  }
  const get = (rel: string): ValidateFunction => {
    const v = ajv.getSchema(SCHEMA_BASE_URI + rel);
    if (v === undefined) throw new Error(`schema not found: ${rel}`);
    return v;
  };
  const messages = new Map<string, ValidateFunction>();
  const http = new Map<string, ValidateFunction>();
  const manifests = new Map<string, ValidateFunction>();
  for (const rel of Object.keys(bundle.files)) {
    const m = stem(rel, 'messages');
    if (m !== null) messages.set(m, get(rel));
    const h = stem(rel, 'http');
    if (h !== null) http.set(h, get(rel));
    const k = stem(rel, 'manifests');
    if (k !== null) manifests.set(k, get(rel));
  }
  return { envelope: get('envelope.json'), messages, http, manifests };
}
