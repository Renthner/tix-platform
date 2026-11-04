// Bundles the worker and the database CLIs into self-contained ESM files.
// The runtime image then needs nothing but Node.js, dist/ and the SQL migrations.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: {
    index: 'src/index.ts',
    migrate: '../../packages/db/src/cli/migrate.ts',
    seed: '../../packages/db/src/cli/seed.ts',
    'create-admin': '../../packages/db/src/cli/create-admin.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  // Optional native/edge drivers of `pg` that are never loaded on Node.js.
  external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
  // CommonJS dependencies (pg, ioredis, pino) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
