import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the monorepo root `.env` for local CLI usage (drizzle-kit, seed, migrate, tests).
 * The root is found by walking up from the working directory to `pnpm-workspace.yaml`.
 * In containers the environment is injected by docker compose and no file exists.
 * Variables that are already present in the environment always win.
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (existsSync(file)) {
        const before = { ...process.env };
        process.loadEnvFile(file);
        for (const [key, value] of Object.entries(before)) process.env[key] = value;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
