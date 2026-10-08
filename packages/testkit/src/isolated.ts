import { inject } from 'vitest';

import { createDatabase, dropDatabase } from './admin.js';
import { isolatedName, withDatabase } from './naming.js';

/** Values the global setup provides to every test file. */
export interface TestDatabaseInfo {
  readonly adminUrl: string;
  readonly template: string;
  readonly runId: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    binjariTestDb: TestDatabaseInfo;
  }
}

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  /** Drop the database (forcibly closes remaining connections). Safe to call twice. */
  drop(): Promise<void>;
}

/**
 * Create a fresh database for one test file by cloning this run's template database.
 * Requires `defineBinjariVitestConfig({ useTestDatabase: true })` in the package's vitest config
 * and a `*.int.test.ts` file name.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const info = inject('binjariTestDb') as TestDatabaseInfo | undefined;
  if (info === undefined) {
    throw new Error(
      'Test database is not available. Use defineBinjariVitestConfig({ useTestDatabase: true }) and name the test *.int.test.ts.',
    );
  }
  const name = isolatedName(info.runId);
  await createDatabase(info.adminUrl, name, info.template);
  let dropped = false;
  return {
    name,
    url: withDatabase(info.adminUrl, name),
    async drop() {
      if (dropped) return;
      dropped = true;
      await dropDatabase(info.adminUrl, name);
    },
  };
}
