import { fileURLToPath } from 'node:url';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

/** Integration tests (need a database or other heavy resources) use this suffix and are skipped by `pnpm verify --quick`. */
export const INTEGRATION_TEST_PATTERN = '**/*.int.test.ts';

/** Environment variable set by scripts/verify.mjs for `--quick`. */
export const QUICK_ENV = 'BINJARI_TEST_QUICK';

export function isQuickMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[QUICK_ENV] === '1';
}

export interface BinjariVitestOptions {
  /** Start the shared test PostgreSQL once per run (packages/testkit/src/global-setup.ts). */
  readonly useTestDatabase?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const GLOBAL_SETUP_PATH = fileURLToPath(new URL('./global-setup.ts', import.meta.url));

/** Shared Vitest config for every package, so `--quick` and DB setup behave the same everywhere. */
export function defineBinjariVitestConfig(options: BinjariVitestOptions = {}): ViteUserConfig {
  const quick = isQuickMode(options.env);
  return defineConfig({
    test: {
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', ...(quick ? [INTEGRATION_TEST_PATTERN] : [])],
      globalSetup: options.useTestDatabase === true && !quick ? [GLOBAL_SETUP_PATH] : [],
      // In quick mode a package may legitimately have only integration tests.
      passWithNoTests: quick,
      testTimeout: 20_000,
      hookTimeout: 60_000,
    },
  });
}
