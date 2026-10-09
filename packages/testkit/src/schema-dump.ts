import type pg from 'pg';

/**
 * A deterministic, text description of a database schema built from the system catalogs.
 * Used to prove that migrations are reproducible (up -> down -> up gives the same schema) without
 * depending on a pg_dump binary, so it works the same against embedded Postgres and DATABASE_URL.
 *
 * Covered: schemas, tables (kind, persistence, RLS), columns (type, nullability, default, identity,
 * generated), constraints (definition, deferrability), indexes, triggers (definition, enabled mode),
 * functions (full definition, security, ACL), sequences, views, enum types, policies, table/column
 * privileges and schema privileges. OIDs and other physical details are excluded on purpose.
 */
export interface DumpSchemaOptions {
  /** Schemas to include (default: every schema except pg_catalog, information_schema, pg_toast*). */
  readonly schemas?: readonly string[];
}

type Row = Record<string, unknown>;

async function rows(client: pg.ClientBase, sql: string, params: unknown[]): Promise<Row[]> {
  const res = await client.query<Row>(sql, params);
  return res.rows;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

function line(section: string, row: Row): string {
  const parts = Object.entries(row).map(([k, v]) => `${k}=${show(v)}`);
  return `${section} | ${parts.join(' | ')}`;
}

export async function dumpSchema(
  client: pg.ClientBase,
  options: DumpSchemaOptions = {},
): Promise<string> {
  const schemaRows = await rows(
    client,
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
      ORDER BY nspname`,
    [],
  );
  const all = schemaRows.map((r) => String(r['nspname']));
  const schemas =
    options.schemas === undefined ? all : all.filter((s) => options.schemas?.includes(s));
  const p = [schemas];
  const out: string[] = [];
  const add = (section: string, list: Row[]): void => {
    for (const r of list) out.push(line(section, r));
  };

  add(
    'schema',
    await rows(
      client,
      `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
              array_to_string(ARRAY(SELECT x::text FROM unnest(n.nspacl) x ORDER BY 1), ',') AS acl
         FROM pg_namespace n WHERE n.nspname = ANY($1) ORDER BY 1`,
      p,
    ),
  );
  add(
    'relation',
    await rows(
      client,
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
              array_to_string(ARRAY(SELECT x::text FROM unnest(c.relacl) x ORDER BY 1), ',') AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        ORDER BY 1, 2`,
      p,
    ),
  );
  add(
    'column',
    await rows(
      client,
      `SELECT n.nspname AS schema, c.relname AS table, a.attnum AS pos, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default, a.attidentity AS identity,
              a.attgenerated AS generated, co.collname AS collation,
              array_to_string(ARRAY(SELECT x::text FROM unnest(a.attacl) x ORDER BY 1), ',') AS acl
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 100
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2, 3`,
      p,
    ),
  );
  add(
    'constraint',
    await rows(
      client,
      `SELECT n.nspname AS schema, c.relname AS table, k.conname AS name, k.contype AS type,
              pg_get_constraintdef(k.oid, true) AS definition,
              k.condeferrable AS deferrable, k.condeferred AS deferred
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)
        ORDER BY 1, 2, 3`,
      p,
    ),
  );
  add(
    'index',
    await rows(
      client,
      `SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition
         FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
      p,
    ),
  );
  add(
    'trigger',
    await rows(
      client,
      `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name, t.tgenabled AS enabled,
              pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND NOT t.tgisinternal
        ORDER BY 1, 2, 3`,
      p,
    ),
  );
  add(
    'function',
    await rows(
      client,
      `SELECT n.nspname AS schema, p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS security_definer,
              pg_get_userbyid(p.proowner) AS owner,
              array_to_string(ARRAY(SELECT x::text FROM unnest(p.proacl) x ORDER BY 1), ',') AS acl,
              pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')
        ORDER BY 1, 2, 3`,
      p,
    ),
  );
  add(
    'sequence',
    await rows(
      client,
      `SELECT schemaname AS schema, sequencename AS name, data_type AS type, start_value AS start,
              min_value AS min, max_value AS max, increment_by AS increment, cycle
         FROM pg_sequences WHERE schemaname = ANY($1) ORDER BY 1, 2`,
      p,
    ),
  );
  add(
    'view',
    await rows(
      client,
      `SELECT schemaname AS schema, viewname AS name, definition
         FROM pg_views WHERE schemaname = ANY($1) ORDER BY 1, 2`,
      p,
    ),
  );
  add(
    'enum',
    await rows(
      client,
      `SELECT n.nspname AS schema, t.typname AS name,
              array_to_string(ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder), ',') AS labels
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ANY($1) AND t.typtype = 'e'
        ORDER BY 1, 2`,
      p,
    ),
  );
  add(
    'policy',
    await rows(
      client,
      `SELECT schemaname AS schema, tablename AS table, policyname AS name, permissive, cmd,
              array_to_string(roles, ',') AS roles, qual, with_check
         FROM pg_policies WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
      p,
    ),
  );
  return out.join('\n');
}
