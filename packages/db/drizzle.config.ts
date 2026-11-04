import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from './src/env';

loadRootEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://invalid',
  },
  strict: true,
  verbose: true,
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
});
