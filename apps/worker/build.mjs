// Bundles the worker and the database CLIs into self-contained ESM files.
// The runtime image then needs nothing but Node.js, dist/ and the SQL migrations.
import { build } from 'esbuild';
import { cp, readdir, readFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: {
    index: 'src/index.ts',
    // Pre-update backup + lock-timeout migrations (the dev CLI packages/db/src/cli/migrate.ts stays plain).
    migrate: 'src/migrate.ts',
    seed: '../../packages/db/src/cli/seed.ts',
    'create-admin': '../../packages/db/src/cli/create-admin.ts',
    // Demo/test installations only: realistic orders through the shop / box-office code paths.
    'demo-orders': 'src/cli/demo-orders.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  // Optional native/edge drivers of `pg` that are never loaded on Node.js; `sharp` is native
  // (WebP -> PNG for ticket PDFs) and is installed next to dist/ in the worker image.
  external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets', 'sharp'],
  // CommonJS dependencies (pg, ioredis, pino) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Guard: no workspace module may end up in a lazy `__esm` initialiser. That happens when one is
// reached through a dynamic import(); callers that come in through the `export *` barrels
// (`sideEffects: false`) never run the initialiser, so the module's constants stay undefined at run
// time (alpha.36–alpha.43: "ALERT_TEMPLATE_KEYS is not iterable", "attemptKey is not a function").
const lazyWorkspaceModules = [];
for (const file of await readdir('dist')) {
  if (!file.endsWith('.mjs')) continue;
  const code = await readFile(`dist/${file}`, 'utf8');
  for (const m of code.matchAll(/= __esm\(\{\s*"([^"]*packages\/[^"]+\/src\/[^"]+)"/g)) {
    lazyWorkspaceModules.push(`${file}: ${m[1]}`);
  }
}
if (lazyWorkspaceModules.length > 0) {
  console.error(
    'Workspace modules are lazily initialised in the bundle (remove dynamic import() of workspace code):\n  ' +
      lazyWorkspaceModules.join('\n  '),
  );
  process.exit(1);
}

// Noto Sans for invoice/ticket PDFs: resolved at runtime from dist/fonts (or TIX_FONT_DIR).
await cp('../../packages/core/assets/fonts', 'dist/fonts', { recursive: true });
