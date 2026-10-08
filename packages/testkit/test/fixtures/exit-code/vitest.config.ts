import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Fixture project used by exit-code.int.test.ts: a run that starts the test database must still
// report failing tests with a non-zero exit code.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.fixture.ts'],
    globalSetup: [fileURLToPath(new URL('../../../src/global-setup.ts', import.meta.url))],
    hookTimeout: 60_000,
  },
});
