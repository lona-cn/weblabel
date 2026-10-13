import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: 'D:/workspace/src/weblabel/target/ux23-publish-fence/vitest', test: { include: ['apps/web/src/features/workbench/ux23-binding.test.tsx', 'apps/web/src/features/workbench/t34_activity.test.tsx'], environment: 'jsdom', maxWorkers: 1 } });
