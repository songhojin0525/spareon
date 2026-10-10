import { fileURLToPath } from 'node:url';

import { defineSpareonVitestConfig } from '@spareon/testkit/vitest-config';

export default defineSpareonVitestConfig({
  useTestDatabase: true,
  globalSetup: fileURLToPath(new URL('./test/global-setup.ts', import.meta.url)),
});
