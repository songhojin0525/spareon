import { createTestDatabaseSetup } from '@spareon/testkit/global-setup';

import { migrate } from '../src/db/migrate.js';

// One template database per test run with every migration applied; each test file clones it.
export default createTestDatabaseSetup({
  prepareTemplate: async (url) => {
    await migrate({ url });
  },
});
