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
    spareonTestDb: TestDatabaseInfo;
  }
}

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  /** Drop the database (forcibly closes remaining connections). Safe to call twice. */
  drop(): Promise<void>;
}

export interface IsolatedDatabaseOptions {
  /**
   * true: an empty database (Postgres' default template) instead of a clone of this run's prepared
   * template. For tests that apply or roll back migrations themselves.
   */
  readonly empty?: boolean;
}

/**
 * Create a fresh database for one test file by cloning this run's template database.
 * Requires `defineSpareonVitestConfig({ useTestDatabase: true })` in the package's vitest config
 * and a `*.int.test.ts` file name.
 */
export async function createIsolatedDatabase(
  options: IsolatedDatabaseOptions = {},
): Promise<IsolatedDatabase> {
  const info = inject('spareonTestDb') as TestDatabaseInfo | undefined;
  if (info === undefined) {
    throw new Error(
      'Test database is not available. Use defineSpareonVitestConfig({ useTestDatabase: true }) and name the test *.int.test.ts.',
    );
  }
  const name = isolatedName(info.runId);
  await createDatabase(info.adminUrl, name, options.empty === true ? 'template0' : info.template);
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
