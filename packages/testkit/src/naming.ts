import { randomBytes } from 'node:crypto';

/** Postgres identifiers we create are restricted to this shape, so they never need quoting tricks. */
const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RUN_ID_RE = /^[a-z0-9]{1,20}$/;

export const TEMPLATE_PREFIX = 'binjari_tpl_';
export const ISOLATED_PREFIX = 'binjari_t_';

export function assertSafeIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Unsafe database identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Quote an identifier that already passed assertSafeIdentifier (defense in depth). */
export function quoteIdent(name: string): string {
  return `"${assertSafeIdentifier(name)}"`;
}

function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/** Short random id for one test run; scopes every database the run creates. */
export function newRunId(): string {
  return randomBytes(5).toString('hex');
}

export function templateName(runId: string): string {
  return assertSafeIdentifier(`${TEMPLATE_PREFIX}${assertRunId(runId)}`);
}

export function isolatedName(
  runId: string,
  suffix: string = randomBytes(6).toString('hex'),
): string {
  return assertSafeIdentifier(`${ISOLATED_PREFIX}${assertRunId(runId)}_${suffix}`);
}

/** LIKE pattern (backslash is the escape char) that matches only isolated databases created by this run. */
export function runDatabasesLikePattern(runId: string): string {
  const literal = `${ISOLATED_PREFIX}${assertRunId(runId)}_`;
  return `${literal.replaceAll('_', '\\_')}%`;
}

/** Return a copy of a postgres URL pointing at another database, keeping credentials and query params. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`Not a postgres URL (protocol ${u.protocol})`);
  }
  u.pathname = `/${assertSafeIdentifier(database)}`;
  return u.toString();
}

/** Remove the password from a URL so it can be logged. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== '') u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}
