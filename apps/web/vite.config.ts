import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

const wasmBridgeDir = path.resolve(import.meta.dirname, '../../crates/wasm-bridge/target/weblabel-web-public/wasm');

function wasmBridgeAssets(): Plugin {
  return {
    name: 'weblabel-wasm-bridge',
    configureServer(server) {
      server.middlewares.use('/wasm', (request, response, next) => {
        const filename = path.posix.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (filename !== 'wasm_bridge.js' && filename !== 'wasm_bridge_bg.wasm') {
          next();
          return;
        }
        try {
          response.statusCode = 200;
          response.setHeader('content-type', filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
          response.setHeader('cache-control', 'no-cache');
          response.end(readFileSync(path.join(wasmBridgeDir, filename)));
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle() {
      for (const filename of readdirSync(wasmBridgeDir).filter((name) => name === 'wasm_bridge.js' || name === 'wasm_bridge_bg.wasm')) {
        this.emitFile({ type: 'asset', fileName: `wasm/${filename}`, source: readFileSync(path.join(wasmBridgeDir, filename)) });
      }
    },
  };
}
export default defineConfig({
  plugins: [react(), wasmBridgeAssets()],
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:48100', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    restoreMocks: true,
  },
});
