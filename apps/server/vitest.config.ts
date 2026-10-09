import { fileURLToPath } from 'node:url';

import { defineBinjariVitestConfig } from '@binjari/testkit/vitest-config';

export default defineBinjariVitestConfig({
  useTestDatabase: true,
  globalSetup: fileURLToPath(new URL('./test/global-setup.ts', import.meta.url)),
});
