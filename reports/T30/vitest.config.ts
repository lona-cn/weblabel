import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['reports/T30/production-smoke.test.ts'],passWithNoTests:false,reporters:['default','json'],outputFile:'reports/T30/production-smoke-results.json'}});
