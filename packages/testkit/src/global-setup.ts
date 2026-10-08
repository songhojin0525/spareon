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
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    const problems: string[] = [];
    try {
      await dropRunDatabases(db.adminUrl, runId);
    } catch (err) {
      problems.push(`dropping run databases failed: ${errorMessage(err)}`);
    }
    try {
      await db.stop();
    } catch (err) {
      problems.push(`stopping the test database failed: ${errorMessage(err)}`);
    }
    if (problems.length > 0) {
      // Vitest prints teardown errors but still exits 0 (it calls process.exit(0) itself). Overriding the
      // exit code in an exit listener runs after that, so the run really fails.
      process.exitCode = 1;
      process.once('exit', () => {
        process.exitCode = 1;
      });
      throw new Error(`[testkit] teardown failed:\n- ${problems.join('\n- ')}`);
    }
  };
}
