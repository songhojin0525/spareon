import type { TestProject } from 'vitest/node';

import { createDatabase, dropRunDatabases } from './admin.js';
import { startTestDatabase } from './db.js';
import type { TestDatabaseInfo } from './isolated.js';
import { newRunId, templateName, withDatabase } from './naming.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TestDatabaseSetupOptions {
  /**
   * Runs once per test run against the freshly created template database (for example: apply the
   * server's migrations). Every isolated database cloned afterwards starts from the result.
   * It must close all of its connections before returning: CREATE DATABASE ... TEMPLATE fails while
   * anyone is connected to the template.
   */
  readonly prepareTemplate?: (templateUrl: string) => Promise<void>;
}

export type GlobalSetup = (project: TestProject) => Promise<() => Promise<void>>;

/**
 * Build a Vitest globalSetup: start (or connect to) one Postgres per test run, create this run's
 * template database and prepare it. Each test file then clones the template via
 * createIsolatedDatabase(), so files never share state.
 */
export function createTestDatabaseSetup(options: TestDatabaseSetupOptions = {}): GlobalSetup {
  return async (project) => {
    const db = await startTestDatabase();
    const runId = newRunId();
    const template = templateName(runId);
    try {
      await createDatabase(db.adminUrl, template);
      if (options.prepareTemplate !== undefined) {
        await options.prepareTemplate(withDatabase(db.adminUrl, template));
      }
    } catch (err) {
      // Do not leave this run's databases behind on a shared server.
      await dropRunDatabases(db.adminUrl, runId).catch(() => undefined);
      await db.stop();
      throw err;
    }
    const info: TestDatabaseInfo = { adminUrl: db.adminUrl, template, runId };
    project.provide('spareonTestDb', info);

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
  };
}

/** Default global setup: an empty template database (packages without a schema). */
export default createTestDatabaseSetup();
