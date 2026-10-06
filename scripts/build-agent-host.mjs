import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/agent-host/package.json', import.meta.url));
const { build } = require('esbuild');
await build({
  absWorkingDir: root,
  entryPoints: { runtime: 'apps/agent-host/src/runtime/main.ts', mcp: 'apps/agent-host/src/mcp/main.ts' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'target/agent-host',
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
});
