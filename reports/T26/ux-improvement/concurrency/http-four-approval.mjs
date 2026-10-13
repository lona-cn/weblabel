import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run from the ux-edit worktree after building target/api/debug/weblabel-api.exe.
const root = process.cwd();
const evidence = join(root, 'reports/T26/ux-improvement/concurrency');
const data = join(root, 'target/admission-http', randomUUID());
await mkdir(join(data, 'tmp'), { recursive: true });
process.env.TEMP = process.env.TMP = join(data, 'tmp');
const binary = join(root, 'target/api/debug/weblabel-api.exe');
const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const origin = `http://127.0.0.1:${port}`;
const { login_at_origin_for_test } = await import(pathToFileURL(join(root, 'tests/support/app.ts')).href);
const { createDeliveryFixture } = await import(pathToFileURL(join(root, 'tests/support/dataset-delivery.ts')).href);
let output = '';
const child = spawn(binary, [], { cwd: root, env: { ...process.env,
  WEBLABEL_BIND: `127.0.0.1:${port}`, WEBLABEL_DATABASE_URL: `sqlite:${join(data, 'api.sqlite')}`,
  WEBLABEL_OBJECT_ROOT: join(data, 'objects'), WEBLABEL_ENV: 'development', WEBLABEL_COOKIE_SECURE: 'false',
  WEBLABEL_SQLITE_WRITE_TIMEOUT_MS: '2000', WEBLABEL_MODEL_WORKER: 'manual'
}, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => output += b);
child.stderr.on('data', b => output += b);
const originalFetch = globalThis.fetch;
const approvals = [], queued = [];
let barrierTimeout;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    assert.equal(child.exitCode, null, 'Isolated API exited');
    let ready = false;
    try { ready = (await originalFetch(origin + '/health')).status === 204; } catch {}
    if (ready) break;
    assert(Date.now() < deadline, 'Readiness deadline exceeded');
    await new Promise(r => setTimeout(r, 50));
  }
  const code = output.match(/WEBLABEL_BOOTSTRAP_CODE=([a-f0-9]+)/)?.[1];
  assert(code, 'Bootstrap code missing');
  const admin = await login_at_origin_for_test(origin, { launch_code: code, password: randomUUID() + randomUUID() });
  // Hold the four prepared decision requests only in the client, then send all
  // four real HTTP requests together. No server mocks and no decision retries.
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (options?.method === 'POST' && /^\/api\/reviews\/[^/]+\/decision$/.test(path)) {
      const pending = Promise.withResolvers();
      queued.push({ url, options, pending });
      if (queued.length === 1) barrierTimeout = setTimeout(() => queued.forEach(q => q.pending.reject(Error('Four-approval client barrier deadline'))), 30000);
      if (queued.length === 4) {
        clearTimeout(barrierTimeout);
        for (const request of queued) {
          const started = performance.now();
          originalFetch(request.url, request.options).then(async response => {
            approvals.push({ path: new URL(request.url).pathname, request: JSON.parse(request.options.body), status: response.status,
              elapsed_ms: performance.now() - started, response: await response.clone().json() });
            request.pending.resolve(response);
          }, request.pending.reject);
        }
      }
      return pending.promise;
    }
    return originalFetch(url, options);
  };
  const fixture = await createDeliveryFixture({ base_url: origin, admin }, 4, 4);
  assert.equal(approvals.length, 4);
  assert(approvals.every(a => a.status === 200 && a.response.decision === 'approve'));
  assert.notEqual(fixture.annotatorId, fixture.reviewerId);
  for (const approval of approvals) assert.deepEqual(approval.response.revision_ids, approval.request.revision_ids);
  globalThis.fetch = originalFetch;
  const repeated = await fixture.reviewer.request('POST', approvals[0].path, approvals[0].request);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.json.code, 'REVIEW_ALREADY_DECIDED');
  const report = { result: 'passed', origin, data, timeout_ms: 2000, concurrent_approvals: 4,
    api_binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    source_hashes: Object.fromEntries(await Promise.all(['crates/weblabel-api/src/storage/db.rs', 'crates/weblabel-api/src/storage/transactions.rs'].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]))),
    project_id: fixture.projectId, annotator_id: fixture.annotatorId, reviewer_id: fixture.reviewerId,
    approvals, repeated_decision: { status: repeated.status, response: repeated.json },
    limitations: 'Four synthetic HTTP approvals; does not claim original 1099 failure has the same root cause, cross-process fairness, or model execution.' };
  await writeFile(join(evidence, 'http-four-approval.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  globalThis.fetch = originalFetch;
  clearTimeout(barrierTimeout);
  child.kill();
  await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
  await writeFile(join(evidence, 'http-api.log'), output.replace(/WEBLABEL_BOOTSTRAP_CODE=[a-f0-9]+/g, 'WEBLABEL_BOOTSTRAP_CODE=[redacted]'));
}
