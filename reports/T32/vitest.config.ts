import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/live/t32_provider.spec.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
