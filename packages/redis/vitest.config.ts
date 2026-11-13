import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['../../scripts/test/throwaway-notice.ts'],
    setupFiles: ['../../scripts/test/throwaway-guard.ts'],
  },
});
