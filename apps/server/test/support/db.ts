import { createIsolatedDatabase, type IsolatedDatabaseOptions, withClient } from '@binjari/testkit';
import type pg from 'pg';

import { createDb, type DbHandle } from '../../src/db/client.js';

export interface TestDb extends DbHandle {
  readonly url: string;
  readonly name: string;
  /** Run fn with a dedicated client (raw SQL, transactions, SET ROLE). */
  withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  /** Close the pool and drop the database. */
  cleanup(): Promise<void>;
}

/** A fresh database for one test (a clone of the migrated template unless `empty: true`). */
export async function openTestDb(options: IsolatedDatabaseOptions = {}): Promise<TestDb> {
  const iso = await createIsolatedDatabase(options);
  const handle = createDb({ url: iso.url, maxConnections: 4 });
  return {
    ...handle,
    url: iso.url,
    name: iso.name,
    withClient: (fn) => withClient(iso.url, fn),
    async cleanup() {
      await handle.close();
      await iso.drop();
    },
  };
}
