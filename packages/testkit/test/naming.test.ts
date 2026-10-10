import { describe, expect, it } from 'vitest';

import { resolveDatabaseSource } from '../src/db.js';
import {
  assertSafeIdentifier,
  isolatedName,
  quoteIdent,
  redactUrl,
  runDatabasesLikePattern,
  templateName,
  withDatabase,
} from '../src/naming.js';
import { defineSpareonVitestConfig, isQuickMode } from '../src/vitest-config.js';

describe('resolveDatabaseSource', () => {
  it('prefers TEST_DATABASE_URL over DATABASE_URL', () => {
    expect(
      resolveDatabaseSource({
        TEST_DATABASE_URL: 'postgres://t@h/db1',
        DATABASE_URL: 'postgres://d@h/db2',
      }),
    ).toEqual({ kind: 'external', url: 'postgres://t@h/db1', envVar: 'TEST_DATABASE_URL' });
  });

  it('falls back to DATABASE_URL, then to embedded', () => {
    expect(resolveDatabaseSource({ DATABASE_URL: 'postgresql://d@localhost/db' })).toMatchObject({
      kind: 'external',
      envVar: 'DATABASE_URL',
    });
    expect(resolveDatabaseSource({ DATABASE_URL: 'postgres://d@127.0.0.1:5433/db' })).toMatchObject(
      {
        kind: 'external',
      },
    );
    expect(resolveDatabaseSource({})).toEqual({ kind: 'embedded' });
    expect(resolveDatabaseSource({ TEST_DATABASE_URL: '  ', DATABASE_URL: '' })).toEqual({
      kind: 'embedded',
    });
  });

  it('refuses a remote DATABASE_URL unless explicitly allowed (tests create/drop databases)', () => {
    const remote = 'postgres://u:secret@db.example.com/app';
    expect(() => resolveDatabaseSource({ DATABASE_URL: remote })).toThrow(/remote host/);
    expect(() => resolveDatabaseSource({ DATABASE_URL: remote })).not.toThrow(/secret/);
    expect(
      resolveDatabaseSource({ DATABASE_URL: remote, SPAREON_ALLOW_REMOTE_TEST_DB: '1' }),
    ).toMatchObject({ kind: 'external' });
    // Host overrides that pg honours, and an empty host (PGHOST decides), count as possibly remote.
    expect(() =>
      resolveDatabaseSource({ DATABASE_URL: 'postgres://u@localhost/db?host=prod.example.com' }),
    ).toThrow(/remote host/);
    expect(() => resolveDatabaseSource({ DATABASE_URL: 'postgres:///db' })).toThrow(/remote host/);
    // A dedicated TEST_DATABASE_URL is always trusted.
    expect(resolveDatabaseSource({ TEST_DATABASE_URL: remote })).toMatchObject({
      kind: 'external',
    });
  });

  it('rejects non-postgres URLs without echoing the password', () => {
    expect(() => resolveDatabaseSource({ DATABASE_URL: 'mysql://u:secret@h/db' })).toThrow(
      /must be a postgres/,
    );
    expect(() => resolveDatabaseSource({ DATABASE_URL: 'mysql://u:secret@h/db' })).not.toThrow(
      /secret/,
    );
  });
});

describe('database naming', () => {
  it('builds run-scoped names that are safe identifiers', () => {
    expect(templateName('abc123')).toBe('spareon_tpl_abc123');
    expect(isolatedName('abc123', 'ff00')).toBe('spareon_t_abc123_ff00');
    expect(isolatedName('abc123')).toMatch(/^spareon_t_abc123_[0-9a-f]{12}$/);
  });

  it('rejects identifiers that could break out of quoting', () => {
    for (const bad of ['a"b', 'A', '1abc', 'a;drop', 'a b', '', 'x'.repeat(64)]) {
      expect(() => assertSafeIdentifier(bad)).toThrow(/Unsafe/);
    }
    expect(() => templateName('BAD-ID')).toThrow(/run id/);
    expect(quoteIdent('ok_name')).toBe('"ok_name"');
  });

  it('LIKE pattern escapes underscores (behaviour is checked against Postgres in db.int.test.ts)', () => {
    expect(runDatabasesLikePattern('r1')).toBe(String.raw`spareon\_t\_r1\_%`);
  });

  it('withDatabase swaps only the database and keeps credentials and params', () => {
    expect(
      withDatabase('postgres://u:p%40ss@127.0.0.1:5433/postgres?sslmode=disable', 'db_x'),
    ).toBe('postgres://u:p%40ss@127.0.0.1:5433/db_x?sslmode=disable');
    expect(() => withDatabase('http://h/db', 'db_x')).toThrow(/Not a postgres URL/);
  });

  it('redactUrl hides the password', () => {
    expect(redactUrl('postgres://u:secret@h/db')).toBe('postgres://u:***@h/db');
    expect(redactUrl('not a url')).toBe('<invalid url>');
  });
});

describe('defineSpareonVitestConfig', () => {
  it('excludes integration tests and DB setup only in quick mode', () => {
    const full = defineSpareonVitestConfig({ useTestDatabase: true, env: {} });
    const quick = defineSpareonVitestConfig({
      useTestDatabase: true,
      env: { SPAREON_TEST_QUICK: '1' },
    });
    expect(full.test?.exclude).not.toContain('**/*.int.test.ts');
    expect(full.test?.globalSetup).toHaveLength(1);
    expect(quick.test?.exclude).toContain('**/*.int.test.ts');
    expect(quick.test?.globalSetup).toEqual([]);
    expect(isQuickMode({ SPAREON_TEST_QUICK: 'true' })).toBe(false);
  });
});
