import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeBundle, type ProtocolBundle } from './bundle.js';
import { parseStrictJson } from './wire/strict-json.js';

/** packages/protocol (the package root), resolved from this file. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = path.join(PACKAGE_ROOT, 'schemas');
export const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'fixtures');

function listJson(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...listJson(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.json')) out.push(rel);
  }
  return out.sort();
}

/**
 * Reads every schema/data file under `dir` with the strict JSON rules (the same rules Go applies when it
 * recomputes the hash from these files).
 */
export function readSchemaSources(dir: string = SCHEMA_DIR): ProtocolBundle {
  const files: Record<string, unknown> = {};
  for (const rel of listJson(dir)) {
    const parsed = parseStrictJson(readFileSync(path.join(dir, ...rel.split('/'))));
    if (!parsed.ok) throw new Error(`${rel}: not strict JSON: ${parsed.reason}`);
    files[rel] = parsed.value;
  }
  return makeBundle(files);
}
