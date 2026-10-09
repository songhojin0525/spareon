import { defineConfig } from 'drizzle-kit';

// drizzle-kit is used only to GENERATE migrations from src/db/schema (pnpm db:generate).
// Migrations are applied by our own runner (src/db/migrate.ts), which also supports down files.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
