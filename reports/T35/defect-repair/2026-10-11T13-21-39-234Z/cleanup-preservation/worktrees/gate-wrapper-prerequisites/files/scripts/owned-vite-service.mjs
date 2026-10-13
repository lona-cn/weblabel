import { pathToFileURL } from 'node:url';

// The parent owns this pipe. EOF requests shutdown even if startup is still pending.
const [viteModule, configFile, webRoot, port] = process.argv.slice(2);
let requestStop;
const stopped = new Promise(resolve => { requestStop = resolve; });
process.stdin.once('end', requestStop);
process.stdin.once('error', error => { console.error(error); process.exitCode = 1; requestStop(); });
process.stdin.resume();
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
let server;
try {
  const { createServer } = await import(pathToFileURL(viteModule).href);
  server = await createServer({ root: webRoot, configFile, mode: 'test', server: { host: '127.0.0.1', port: Number(port), strictPort: true } });
  await server.listen();
  server.printUrls();
  await stopped;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
  if (server) {
    try { await server.close(); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
}
