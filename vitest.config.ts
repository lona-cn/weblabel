import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], setupFiles: ['tests/support/prepare-api.ts'] } },
      { test: { name: 'web', include: ['apps/web/src/features/**/*.test.tsx', 'apps/web/src/lib/**/*.test.ts'], environment: 'jsdom' } },
      { test: { name: 'agent-host', include: ['apps/agent-host/test/**/*.test.ts'] } },
      { test: { name: 'live-engineering', include: ['tests/live/**/*.spec.ts'], setupFiles: ['tests/support/prepare-api.ts'] } },
    ],
    passWithNoTests: false,
  },
});
