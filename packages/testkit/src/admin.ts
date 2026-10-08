import pg from 'pg';

import { quoteIdent, runDatabasesLikePattern, templateName } from './naming.js';

/** Run fn with a short-lived client; always closes the connection. */
export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(
  adminUrl: string,
  name: string,
  template?: string,
): Promise<void> {
  const tpl = template === undefined ? '' : ` TEMPLATE ${quoteIdent(template)}`;
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${quoteIdent(name)}${tpl}`));
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, (c) =>
    c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
  );
}

/**
 * Drop every database created by one run (isolated copies, then the template). Only names with this
 * run's prefix are touched, so pointing tests at a shared server never deletes anything else.
 */
export async function dropRunDatabases(adminUrl: string, runId: string): Promise<string[]> {
  const isolated = await withClient(adminUrl, async (c) => {
    const res = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1 ESCAPE '\\' ORDER BY datname",
      [runDatabasesLikePattern(runId)],
    );
    return res.rows.map((r) => r.datname);
  });
  const all = [...isolated, templateName(runId)];
  for (const name of all) {
    await dropDatabase(adminUrl, name);
  }
  return all;
}
