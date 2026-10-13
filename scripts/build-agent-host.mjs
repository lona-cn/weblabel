import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = options(process.argv.slice(2), ['--out-dir']);
const outdir = resolve(root, args['--out-dir'] ?? 'target/agent-host');
const require = createRequire(new URL('../apps/agent-host/package.json', import.meta.url));
const { build } = require('esbuild');
await build({
  absWorkingDir: root,
  entryPoints: { runtime: 'apps/agent-host/src/runtime/main.ts', mcp: 'apps/agent-host/src/mcp/main.ts' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
});
