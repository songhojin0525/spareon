import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression: async-exit-hook (pulled in by embedded-postgres) turned failing Vitest runs into exit 0.
// Runs a tiny fixture project that starts the test database, once failing and once passing.
const require = createRequire(import.meta.url);
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const config = fileURLToPath(new URL('./fixtures/exit-code/vitest.config.ts', import.meta.url));

function runFixture(shouldPass: boolean): number | null {
  const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_SHOULD_PASS: shouldPass ? '1' : '0' };
  // Force the embedded path so the regression is exercised even when a URL is configured.
  delete env['TEST_DATABASE_URL'];
  delete env['DATABASE_URL'];
  delete env['VITEST'];
  delete env['VITEST_POOL_ID'];
  delete env['VITEST_WORKER_ID'];
  const r = spawnSync(process.execPath, [vitestBin, 'run', '--config', config], {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  });
  return r.status;
}

describe('exit code with the test database running', () => {
  it('is non-zero when a test fails', { timeout: 150_000 }, () => {
    expect(runFixture(false)).toBe(1);
  });

  it('is zero when all tests pass', { timeout: 150_000 }, () => {
    expect(runFixture(true)).toBe(0);
  });
});
