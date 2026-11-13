import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const AUTH_FILE = path.resolve(__dirname, '.auth/admin.json');
const ci = !!process.env.CI;

/**
 * End-to-end suite against a running stack (`pnpm test:e2e` starts an isolated one, see
 * scripts/e2e/run.mjs). Order matters: the admin project checks the order the shop project placed.
 */
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:18090',
    trace: 'on-first-retry',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'shop',
      testMatch: /(shop|not-found|fonts|cookies)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      dependencies: ['setup'],
    },
    {
      name: 'admin',
      testMatch: /(admin|csp)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: AUTH_FILE,
      },
      dependencies: ['shop'],
    },
    {
      // Changes the global default language: must run after everything else.
      name: 'default-locale',
      testMatch: /default-locale\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: AUTH_FILE,
      },
      dependencies: ['admin'],
    },
  ],
});
