import path from 'node:path';
import applicationConfig from '../../apps/web/vite.config';

// Keep dependency optimization writes inside this isolated worktree even when
// node_modules is an explicitly provisioned junction to an existing install.
export default {
  ...applicationConfig,
  cacheDir: path.resolve(import.meta.dirname, '../../target/t31-vite-cache'),
};
