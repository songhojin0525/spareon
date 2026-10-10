// Regenerates TS types, Go types and the embedded bundles from packages/protocol/schemas.
// Usage: pnpm --filter @spareon/protocol gen   (test/generated.test.ts fails when the outputs are stale)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { generateAll } from '../src/codegen/generate.js';
import { PACKAGE_ROOT, readSchemaSources } from '../src/schema-source.js';

const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
for (const [rel, content] of generateAll(readSchemaSources())) {
  const file = path.join(repoRoot, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote ${rel}`);
}
