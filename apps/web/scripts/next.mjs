// Starts the Next.js CLI with the monorepo-root `.env` loaded into the environment.
// Next.js only reads `.env*` files next to the app and re-creates process.env from the initial
// environment, so the root file must be loaded *before* the CLI process starts.
// Variables already set in the shell win over the file. Containers don't use this script.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) {
  const preset = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, preset);
}

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
