import { randomBytes } from 'node:crypto';

/**
 * Required server variables filled with fresh random secrets, for development tools and tests. Values
 * already present in `given` (non-blank) win. Never used by the production entry point.
 */
export function withGeneratedSecrets(
  given: Readonly<Record<string, string | undefined>>,
  defaults: { databaseUrl: string; port?: number },
): { env: Record<string, string | undefined>; generated: string[] } {
  const generated: string[] = [];
  const has = (k: string): boolean => {
    const v = given[k];
    return v !== undefined && v.trim() !== '';
  };
  const fill = (k: string, make: () => string): [string, string] | [] => {
    if (has(k)) return [];
    generated.push(k);
    return [k, make()];
  };
  const hex = (n: number) => () => randomBytes(n).toString('hex');
  const port = String(defaults.port ?? 8080);
  const env: Record<string, string | undefined> = {
    ...given,
    ...Object.fromEntries(
      [
        fill('DATABASE_URL', () => defaults.databaseUrl),
        fill('SESSION_SECRET', hex(32)),
        fill('API_KEY_PEPPER', hex(32)),
        fill('DATA_ENCRYPTION_KEY', hex(32)),
        fill('DATA_ENCRYPTION_KEY_ID', () => 'dev'),
        fill('PUBLIC_BASE_URL', () => `http://127.0.0.1:${port}`),
        fill('WEB_ORIGIN', () => 'http://localhost:3000'),
      ].filter((e) => e.length === 2),
    ),
  };
  return { env, generated };
}
