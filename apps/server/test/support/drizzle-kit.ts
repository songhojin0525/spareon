import * as api from 'drizzle-kit/api';

/**
 * The two drizzle-kit API functions the drift tests use, with explicit narrow types: drizzle-kit's
 * declarations pull in optional driver types that typescript-eslint cannot resolve.
 */
export interface SchemaSnapshot {
  readonly id: string;
  readonly [key: string]: unknown;
}

interface KitApi {
  generateDrizzleJson(imports: Record<string, unknown>, prevId?: string): SchemaSnapshot;
  generateMigration(prev: SchemaSnapshot, cur: SchemaSnapshot): Promise<string[]>;
}

const kit = api as unknown as KitApi;

/** drizzle-kit's snapshot of a Drizzle schema module (what `drizzle-kit generate` stores in meta/). */
export function snapshotOf(imports: Record<string, unknown>, prevId?: string): SchemaSnapshot {
  return kit.generateDrizzleJson(imports, prevId);
}

/** The SQL statements drizzle-kit would generate to go from `prev` to `cur`. */
export function migrationBetween(prev: SchemaSnapshot, cur: SchemaSnapshot): Promise<string[]> {
  return kit.generateMigration(prev, cur);
}
