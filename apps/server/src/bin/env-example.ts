// `pnpm --filter @spareon/server env:example` — writes apps/server/.env.example from the zod schema in
// src/config.ts (descriptions included). A test fails when the committed file is stale.
import { writeFileSync } from 'node:fs';

import { renderEnvExample } from '../config.js';

const target = new URL('../../.env.example', import.meta.url);
writeFileSync(target, renderEnvExample());
process.stdout.write(`wrote ${target.pathname}\n`);
