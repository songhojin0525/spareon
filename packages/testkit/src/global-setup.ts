import type { TestProject } from 'vitest/node';

import { createDatabase, dropRunDatabases } from './admin.js';
import { startTestDatabase } from './db.js';
import type { TestDatabaseInfo } from './isolated.js';
import { newRunId, templateName } from './naming.js';

/**
 * Vitest globalSetup: start (or connect to) one Postgres per test run and create this run's template
 * database. Each test file then clones the template via createIsolatedDatabase(), so files never share state.
 * SKELETON(S03): apply migrations to the template once migrations exist.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await startTestDatabase();
  const runId = newRunId();
  const template = templateName(runId);
  try {
    await createDatabase(db.adminUrl, template);
  } catch (err) {
    await db.stop();
    throw err;
  }
  const info: TestDatabaseInfo = { adminUrl: db.adminUrl, template, runId };
  project.provide('binjariTestDb', info);

  return async () => {
    try {
      await dropRunDatabases(db.adminUrl, runId);
    } finally {
      await db.stop();
    }
  };
}
