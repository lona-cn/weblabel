// 49913c52992f0976c38f743fa976977a49f50e37
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapReplays = new WeakMap();
const bootstrapClients = new WeakMap();
const bootstrapLogins = new WeakMap();
const databasePaths = new WeakMap();
const launchCodes = new WeakMap();
const downloads = new WeakMap();
export async function download_for_test(client, path) {
  const download = downloads.get(client);
  if (!download) throw new Error('ApiClient was not created by this test helper');
  return download(path);
}
let builtDefaultApiBinary = null;
async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}
function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} response was not an object`);
  }
  return value;
}
function fieldString(value, ...keys) {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key];
  throw new Error(`Response did not contain ${keys.join(' or ')}`);
}
function responseClient(baseUrl, cookie, csrf, onCookie) {
  const clientOrigin = new URL(baseUrl).origin;
  async function send(method, path, body, contentType, idempotencyKey) {
    var _setCookie$split$;
    const url = new URL(path, baseUrl);
    if (url.origin !== clientOrigin || url.username || url.password) throw new Error('Test request must remain same-origin without URL credentials');
    const headers = new Headers();
    const activeCookie = cookie();
    if (activeCookie) headers.set('cookie', activeCookie);
    const token = csrf();
    if (token && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) headers.set('x-csrf-token', token);
    headers.set('origin', baseUrl);
    if (contentType) headers.set('content-type', contentType);
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'error'
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) onCookie === null || onCookie === void 0 || onCookie((_setCookie$split$ = setCookie.split(';', 1)[0]) !== null && _setCookie$split$ !== void 0 ? _setCookie$split$ : '');
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`API ${method} ${path} returned non-JSON (${response.status})`);
      }
    }
    return {
      status: response.status,
      json: json,
      headers: response.headers
    };
  }
  const client = {
    request(method, path, body) {
      return send(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
    },
    async upload(path, bytes, filename, idempotencyKey = crypto.randomUUID(), mediaType = 'application/octet-stream') {
      const form = new FormData();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      form.append('images', new Blob([buffer], {
        type: mediaType
      }), filename);
      return send('POST', path, form, undefined, idempotencyKey);
    }
  };
  downloads.set(client, async path => {
    var _setCookie$split$2;
    const url = new URL(path, baseUrl);
    if (url.origin !== clientOrigin || url.username || url.password) throw new Error('Test download must remain same-origin without URL credentials');
    const headers = new Headers({
      origin: baseUrl
    });
    const activeCookie = cookie();
    if (activeCookie) headers.set('cookie', activeCookie);
    const response = await fetch(url, {
      headers,
      redirect: 'error'
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) onCookie === null || onCookie === void 0 || onCookie((_setCookie$split$2 = setCookie.split(';', 1)[0]) !== null && _setCookie$split$2 !== void 0 ? _setCookie$split$2 : '');
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers
    };
  });
  return client;
}
/** Authenticates only caller-owned synthetic loopback installations. */
export async function login_at_origin_for_test(baseUrl, credentials) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Synthetic fixture requires a loopback HTTP origin');
  let cookie = '';
  let csrf = '';
  const client = responseClient(origin.origin, () => cookie, () => csrf, value => {
    cookie = value;
  });
  const response = await client.request('POST', 'launch_code' in credentials ? '/api/session/bootstrap' : '/api/session/login', credentials);
  if (response.status < 200 || response.status >= 300) throw new Error('Synthetic login failed (' + response.status + '): ' + JSON.stringify(response.json));
  csrf = fieldString(record(response.json, 'synthetic login'), 'csrf_token');
  if (!cookie) throw new Error('Synthetic login did not return a session cookie');
  return client;
}
export function prepare_test_api() {
  var _process$env$CARGO_TA;
  const configuredBinary = process.env.WEBLABEL_API_BINARY;
  const targetDirectory = resolve(repoRoot, (_process$env$CARGO_TA = process.env.CARGO_TARGET_DIR) !== null && _process$env$CARGO_TA !== void 0 ? _process$env$CARGO_TA : 'target');
  const binary = configuredBinary !== null && configuredBinary !== void 0 ? configuredBinary : resolve(targetDirectory, 'debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
  if (!configuredBinary && builtDefaultApiBinary !== binary) {
    // Build once per worker; an existing executable may predate the tested sources.
    execFileSync('cargo', ['build', '--locked', '--manifest-path', resolve(repoRoot, 'Cargo.toml'), '--target-dir', targetDirectory, '-p', 'weblabel-api', '--bin', 'weblabel-api'], {
      cwd: repoRoot,
      stdio: 'inherit'
    });
    builtDefaultApiBinary = binary;
  }
  return binary;
}
export async function start_test_app(cookieSecure = 'false', modelWorker = 'manual') {
  var _child$stdout, _child$stderr;
  const binary = prepare_test_api();
  const root = await mkdtemp(resolve(tmpdir(), 'weblabel-t10-'));
  const port = await freeLoopbackPort();
  const base_url = `http://127.0.0.1:${port}`;
  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WEBLABEL_BIND: `127.0.0.1:${port}`,
      WEBLABEL_DATABASE_URL: `sqlite:${resolve(root, 'api.sqlite')}`,
      WEBLABEL_OBJECT_ROOT: resolve(root, 'objects'),
      WEBLABEL_ENV: 'development',
      WEBLABEL_TEST_MANUAL_MODEL_WORKER: modelWorker === 'manual' ? '1' : '0',
      WEBLABEL_COOKIE_SECURE: cookieSecure
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const exited = Promise.withResolvers();
  child.once('exit', () => exited.resolve());
  child.once('error', error => {
    output += `API process error: ${error.message}\n`;
    exited.resolve();
  });
  let stdoutRemainder = '';
  const launchCodeResult = Promise.withResolvers();
  let launchCodeReceived = false;
  (_child$stdout = child.stdout) === null || _child$stdout === void 0 || _child$stdout.on('data', chunk => {
    var _lines$pop;
    const lines = `${stdoutRemainder}${String(chunk)}`.split(/\r?\n/);
    stdoutRemainder = (_lines$pop = lines.pop()) !== null && _lines$pop !== void 0 ? _lines$pop : '';
    for (const line of lines) {
      if (line.startsWith('WEBLABEL_BOOTSTRAP_CODE=') && !launchCodeReceived) {
        const code = line.slice('WEBLABEL_BOOTSTRAP_CODE='.length);
        launchCodeReceived = true;
        launchCodeResult.resolve(code);
      } else {
        output += `${line}\n`;
      }
    }
  });
  (_child$stderr = child.stderr) === null || _child$stderr === void 0 || _child$stderr.on('data', chunk => {
    output += String(chunk);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      await exited.promise;
      clearTimeout(timeout);
    }
    await rm(root, {
      recursive: true,
      force: true
    });
  };
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API process exited early:\n${output}`);
      try {
        const response = await fetch(`${base_url}/health`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.status === 204) break;
      } catch {/* The service is still starting. */}
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (Date.now() >= deadline) throw new Error(`API did not become ready:\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
  async function readLaunchCode() {
    const timeoutResult = Promise.withResolvers();
    const timer = setTimeout(() => timeoutResult.reject(new Error('API did not emit its bootstrap code on stdout')), 10000);
    try {
      const code = await Promise.race([launchCodeResult.promise, timeoutResult.promise]);
      if (!code) throw new Error('API emitted an empty bootstrap code');
      return code;
    } finally {
      clearTimeout(timer);
    }
  }
  let bootstrapClientPromise;
  let bootstrapPassword = '';
  async function getBootstrapClient() {
    if (!bootstrapClientPromise) {
      bootstrapClientPromise = (async () => {
        const launchCode = await readLaunchCode();
        bootstrapPassword = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        let sessionCookie = '';
        let csrfToken = '';
        const client = responseClient(base_url, () => sessionCookie, () => csrfToken, value => {
          sessionCookie = value;
        });
        const result = await client.request('POST', '/api/session/bootstrap', {
          launch_code: launchCode,
          password: bootstrapPassword
        });
        if (result.status < 200 || result.status >= 300) throw new Error(`Real bootstrap failed (${result.status}): ${JSON.stringify(result.json)}`);
        const bootstrapResponse = record(result.json, 'bootstrap');
        if (Object.hasOwn(bootstrapResponse, 'password')) throw new Error('Bootstrap response exposed the chosen password');
        if (fieldString(bootstrapResponse, 'username') !== 'local-admin') throw new Error('Bootstrap administrator username was not returned');
        csrfToken = fieldString(bootstrapResponse, 'csrf_token');
        return client;
      })();
    }
    return bootstrapClientPromise;
  }
  const app = {
    base_url,
    async as_user(role) {
      try {
        var _login$headers$get, _setCookie$split$3;
        const bootstrapClient = await getBootstrapClient();
        const password = crypto.randomUUID();
        const username = `t10-${crypto.randomUUID()}`;
        const created = await bootstrapClient.request('POST', '/api/users', {
          username,
          password
        });
        if (created.status < 200 || created.status >= 300) throw new Error(`Real user creation failed (${created.status}): ${JSON.stringify(created.json)}`);
        const userId = fieldString(record(created.json, 'user creation'), 'user_id', 'id');
        const projectResponse = await bootstrapClient.request('POST', '/api/projects', {
          name: `T10 ${role} ${crypto.randomUUID()}`,
          description: 'Ephemeral isolated API test project',
          allow_self_review: false
        });
        if (projectResponse.status < 200 || projectResponse.status >= 300) throw new Error(`Real project creation failed (${projectResponse.status}): ${JSON.stringify(projectResponse.json)}`);
        const projectId = fieldString(record(projectResponse.json, 'project creation'), 'project_id', 'id');
        const membership = await bootstrapClient.request('POST', `/api/projects/${encodeURIComponent(projectId)}/members`, {
          user_id: userId,
          role
        });
        if (membership.status < 200 || membership.status >= 300) throw new Error(`Real membership creation failed (${membership.status})`);
        const login = await responseClient(base_url, () => '', () => '').request('POST', '/api/session/login', {
          username,
          password
        });
        if (login.status < 200 || login.status >= 300) throw new Error(`Real login failed (${login.status}): ${JSON.stringify(login.json)}`);
        const setCookie = (_login$headers$get = login.headers.get('set-cookie')) !== null && _login$headers$get !== void 0 ? _login$headers$get : '';
        if (setCookie.includes('; Secure') !== (cookieSecure === 'true')) {
          throw new Error('API session cookie Secure attribute did not match WEBLABEL_COOKIE_SECURE');
        }
        let userCookie = (_setCookie$split$3 = setCookie.split(';', 1)[0]) !== null && _setCookie$split$3 !== void 0 ? _setCookie$split$3 : '';
        let userCsrf = fieldString(record(login.json, 'login'), 'csrf_token');
        return responseClient(base_url, () => userCookie, () => userCsrf, value => {
          userCookie = value;
        });
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop
  };
  launchCodes.set(app, readLaunchCode);
  bootstrapClients.set(app, getBootstrapClient);
  bootstrapLogins.set(app, async () => {
    var _login$headers$get2, _setCookie$split$4;
    await getBootstrapClient();
    const login = await responseClient(base_url, () => '', () => '').request('POST', '/api/session/login', {
      username: 'local-admin',
      password: bootstrapPassword
    });
    if (login.status < 200 || login.status >= 300) throw new Error(`Bootstrap administrator login failed (${login.status})`);
    const setCookie = (_login$headers$get2 = login.headers.get('set-cookie')) !== null && _login$headers$get2 !== void 0 ? _login$headers$get2 : '';
    if (setCookie.includes('; Secure') !== (cookieSecure === 'true')) {
      throw new Error('API session cookie Secure attribute did not match WEBLABEL_COOKIE_SECURE');
    }
    let sessionCookie = (_setCookie$split$4 = setCookie.split(';', 1)[0]) !== null && _setCookie$split$4 !== void 0 ? _setCookie$split$4 : '';
    let csrfToken = fieldString(record(login.json, 'bootstrap administrator login'), 'csrf_token');
    return responseClient(base_url, () => sessionCookie, () => csrfToken, value => {
      sessionCookie = value;
    });
  });
  bootstrapReplays.set(app, async () => {
    await getBootstrapClient();
    const launchCode = await readLaunchCode();
    const response = await fetch(`${base_url}/api/session/bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        launch_code: launchCode,
        password: bootstrapPassword
      })
    });
    return response.status;
  });
  databasePaths.set(app, resolve(root, 'api.sqlite'));
  return app;
}

/** Only the isolated synthetic database created by start_test_app; not a production API. */
export function database_path_for_test(app) {
  const path = databasePaths.get(app);
  if (path === undefined) throw new Error('Unknown test app database');
  return path;
}
export async function replay_bootstrap_code_for_test(app) {
  const replay = bootstrapReplays.get(app);
  if (!replay) throw new Error('TestApp was not created by this test helper');
  return replay();
}
export async function bootstrap_admin_for_test(app) {
  const getClient = bootstrapClients.get(app);
  if (!getClient) throw new Error('TestApp was not created by this test helper');
  return getClient();
}
export async function relogin_bootstrap_admin_for_test(app) {
  const login = bootstrapLogins.get(app);
  if (!login) throw new Error('TestApp was not created by this test helper');
  return login();
}

/** Read stdout from this helper-owned app without consuming its bootstrap code. */
export async function launch_code_for_test(app) {
  const readCode = launchCodes.get(app);
  if (!readCode) throw new Error('TestApp was not created by this test helper');
  return readCode();
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJleGVjRmlsZVN5bmMiLCJzcGF3biIsImNyZWF0ZVNlcnZlciIsIm1rZHRlbXAiLCJybSIsInRtcGRpciIsImRpcm5hbWUiLCJyZXNvbHZlIiwiZmlsZVVSTFRvUGF0aCIsInJlcG9Sb290IiwiaW1wb3J0IiwibWV0YSIsInVybCIsImJvb3RzdHJhcFJlcGxheXMiLCJXZWFrTWFwIiwiYm9vdHN0cmFwQ2xpZW50cyIsImJvb3RzdHJhcExvZ2lucyIsImRhdGFiYXNlUGF0aHMiLCJsYXVuY2hDb2RlcyIsImRvd25sb2FkcyIsImRvd25sb2FkX2Zvcl90ZXN0IiwiY2xpZW50IiwicGF0aCIsImRvd25sb2FkIiwiZ2V0IiwiRXJyb3IiLCJidWlsdERlZmF1bHRBcGlCaW5hcnkiLCJmcmVlTG9vcGJhY2tQb3J0Iiwic2VydmVyIiwiUHJvbWlzZSIsInJlc29sdmVMaXN0ZW4iLCJyZWplY3QiLCJvbmNlIiwibGlzdGVuIiwiYWRkcmVzcyIsInBvcnQiLCJyZXNvbHZlQ2xvc2UiLCJjbG9zZSIsImVycm9yIiwicmVjb3JkIiwidmFsdWUiLCJsYWJlbCIsIkFycmF5IiwiaXNBcnJheSIsImZpZWxkU3RyaW5nIiwia2V5cyIsImtleSIsImpvaW4iLCJyZXNwb25zZUNsaWVudCIsImJhc2VVcmwiLCJjb29raWUiLCJjc3JmIiwib25Db29raWUiLCJjbGllbnRPcmlnaW4iLCJVUkwiLCJvcmlnaW4iLCJzZW5kIiwibWV0aG9kIiwiYm9keSIsImNvbnRlbnRUeXBlIiwiaWRlbXBvdGVuY3lLZXkiLCJfc2V0Q29va2llJHNwbGl0JCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJoZWFkZXJzIiwiSGVhZGVycyIsImFjdGl2ZUNvb2tpZSIsInNldCIsInRva2VuIiwiaW5jbHVkZXMiLCJ0b1VwcGVyQ2FzZSIsInJlc3BvbnNlIiwiZmV0Y2giLCJyZWRpcmVjdCIsInNldENvb2tpZSIsInNwbGl0IiwidGV4dCIsImpzb24iLCJKU09OIiwicGFyc2UiLCJzdGF0dXMiLCJyZXF1ZXN0IiwidW5kZWZpbmVkIiwic3RyaW5naWZ5IiwidXBsb2FkIiwiYnl0ZXMiLCJmaWxlbmFtZSIsImNyeXB0byIsInJhbmRvbVVVSUQiLCJtZWRpYVR5cGUiLCJmb3JtIiwiRm9ybURhdGEiLCJidWZmZXIiLCJBcnJheUJ1ZmZlciIsImJ5dGVMZW5ndGgiLCJVaW50OEFycmF5IiwiYXBwZW5kIiwiQmxvYiIsInR5cGUiLCJfc2V0Q29va2llJHNwbGl0JDIiLCJhcnJheUJ1ZmZlciIsImxvZ2luX2F0X29yaWdpbl9mb3JfdGVzdCIsImNyZWRlbnRpYWxzIiwicHJvdG9jb2wiLCJob3N0bmFtZSIsInBhdGhuYW1lIiwic2VhcmNoIiwiaGFzaCIsInByZXBhcmVfdGVzdF9hcGkiLCJfcHJvY2VzcyRlbnYkQ0FSR09fVEEiLCJjb25maWd1cmVkQmluYXJ5IiwicHJvY2VzcyIsImVudiIsIldFQkxBQkVMX0FQSV9CSU5BUlkiLCJ0YXJnZXREaXJlY3RvcnkiLCJDQVJHT19UQVJHRVRfRElSIiwiYmluYXJ5IiwicGxhdGZvcm0iLCJjd2QiLCJzdGRpbyIsInN0YXJ0X3Rlc3RfYXBwIiwiY29va2llU2VjdXJlIiwibW9kZWxXb3JrZXIiLCJfY2hpbGQkc3Rkb3V0IiwiX2NoaWxkJHN0ZGVyciIsInJvb3QiLCJiYXNlX3VybCIsImNoaWxkIiwiV0VCTEFCRUxfQklORCIsIldFQkxBQkVMX0RBVEFCQVNFX1VSTCIsIldFQkxBQkVMX09CSkVDVF9ST09UIiwiV0VCTEFCRUxfRU5WIiwiV0VCTEFCRUxfVEVTVF9NQU5VQUxfTU9ERUxfV09SS0VSIiwiV0VCTEFCRUxfQ09PS0lFX1NFQ1VSRSIsIm91dHB1dCIsImV4aXRlZCIsIndpdGhSZXNvbHZlcnMiLCJtZXNzYWdlIiwic3Rkb3V0UmVtYWluZGVyIiwibGF1bmNoQ29kZVJlc3VsdCIsImxhdW5jaENvZGVSZWNlaXZlZCIsInN0ZG91dCIsIm9uIiwiY2h1bmsiLCJfbGluZXMkcG9wIiwibGluZXMiLCJTdHJpbmciLCJwb3AiLCJsaW5lIiwic3RhcnRzV2l0aCIsImNvZGUiLCJzbGljZSIsImxlbmd0aCIsInN0ZGVyciIsInN0b3BwZWQiLCJzdG9wIiwiZXhpdENvZGUiLCJzaWduYWxDb2RlIiwidGltZW91dCIsInNldFRpbWVvdXQiLCJraWxsIiwicHJvbWlzZSIsImNsZWFyVGltZW91dCIsInJlY3Vyc2l2ZSIsImZvcmNlIiwiZGVhZGxpbmUiLCJEYXRlIiwibm93Iiwic2lnbmFsIiwiQWJvcnRTaWduYWwiLCJyZXNvbHZlV2FpdCIsInJlYWRMYXVuY2hDb2RlIiwidGltZW91dFJlc3VsdCIsInRpbWVyIiwicmFjZSIsImJvb3RzdHJhcENsaWVudFByb21pc2UiLCJib290c3RyYXBQYXNzd29yZCIsImdldEJvb3RzdHJhcENsaWVudCIsImxhdW5jaENvZGUiLCJzZXNzaW9uQ29va2llIiwiY3NyZlRva2VuIiwicmVzdWx0IiwibGF1bmNoX2NvZGUiLCJib290c3RyYXBSZXNwb25zZSIsIk9iamVjdCIsImhhc093biIsImFwcCIsImFzX3VzZXIiLCJyb2xlIiwiX2xvZ2luJGhlYWRlcnMkZ2V0IiwiX3NldENvb2tpZSRzcGxpdCQzIiwiYm9vdHN0cmFwQ2xpZW50IiwiY3JlYXRlZCIsInVzZXJJZCIsInByb2plY3RSZXNwb25zZSIsIm5hbWUiLCJkZXNjcmlwdGlvbiIsImFsbG93X3NlbGZfcmV2aWV3IiwicHJvamVjdElkIiwibWVtYmVyc2hpcCIsImVuY29kZVVSSUNvbXBvbmVudCIsInVzZXJfaWQiLCJsb2dpbiIsInVzZXJDb29raWUiLCJ1c2VyQ3NyZiIsIl9sb2dpbiRoZWFkZXJzJGdldDIiLCJfc2V0Q29va2llJHNwbGl0JDQiLCJkYXRhYmFzZV9wYXRoX2Zvcl90ZXN0IiwicmVwbGF5X2Jvb3RzdHJhcF9jb2RlX2Zvcl90ZXN0IiwicmVwbGF5IiwiYm9vdHN0cmFwX2FkbWluX2Zvcl90ZXN0IiwiZ2V0Q2xpZW50IiwicmVsb2dpbl9ib290c3RyYXBfYWRtaW5fZm9yX3Rlc3QiLCJsYXVuY2hfY29kZV9mb3JfdGVzdCIsInJlYWRDb2RlIl0sInNvdXJjZXMiOlsiYXBwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGV4ZWNGaWxlU3luYywgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgY3JlYXRlU2VydmVyIH0gZnJvbSAnbm9kZTpuZXQnO1xyXG5pbXBvcnQgeyBta2R0ZW1wLCBybSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgZGlybmFtZSwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCc7XHJcblxyXG5leHBvcnQgdHlwZSBSb2xlID0gJ2FkbWluJyB8ICdhbm5vdGF0b3InIHwgJ3Jldmlld2VyJyB8ICd2aWV3ZXInO1xyXG5leHBvcnQgaW50ZXJmYWNlIEFwaVJlc3BvbnNlPFQgPSB1bmtub3duPiB7IHN0YXR1czogbnVtYmVyOyBqc29uOiBUOyBoZWFkZXJzOiBIZWFkZXJzIH1cclxuZXhwb3J0IGludGVyZmFjZSBBcGlDbGllbnQge1xyXG4gIHJlcXVlc3Q8VCA9IHVua25vd24+KG1ldGhvZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcsIGJvZHk/OiB1bmtub3duKTogUHJvbWlzZTxBcGlSZXNwb25zZTxUPj47XHJcbiAgdXBsb2FkPFQgPSB1bmtub3duPihwYXRoOiBzdHJpbmcsIGJ5dGVzOiBVaW50OEFycmF5LCBmaWxlbmFtZTogc3RyaW5nLCBpZGVtcG90ZW5jeUtleT86IHN0cmluZywgbWVkaWFUeXBlPzogc3RyaW5nKTogUHJvbWlzZTxBcGlSZXNwb25zZTxUPj47XHJcbn1cclxuZXhwb3J0IGludGVyZmFjZSBUZXN0QXBwIHtcclxuICBiYXNlX3VybDogc3RyaW5nO1xyXG4gIGFzX3VzZXIocm9sZTogUm9sZSk6IFByb21pc2U8QXBpQ2xpZW50PjtcclxuICBzdG9wKCk6IFByb21pc2U8dm9pZD47XHJcbn1cclxuXHJcbnR5cGUgSnNvblJlY29yZCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG5jb25zdCByZXBvUm9vdCA9IHJlc29sdmUoZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpLCAnLi4vLi4nKTtcclxuY29uc3QgYm9vdHN0cmFwUmVwbGF5cyA9IG5ldyBXZWFrTWFwPFRlc3RBcHAsICgpID0+IFByb21pc2U8bnVtYmVyPj4oKTtcclxuY29uc3QgYm9vdHN0cmFwQ2xpZW50cyA9IG5ldyBXZWFrTWFwPFRlc3RBcHAsICgpID0+IFByb21pc2U8QXBpQ2xpZW50Pj4oKTtcclxuY29uc3QgYm9vdHN0cmFwTG9naW5zID0gbmV3IFdlYWtNYXA8VGVzdEFwcCwgKCkgPT4gUHJvbWlzZTxBcGlDbGllbnQ+PigpO1xyXG5jb25zdCBkYXRhYmFzZVBhdGhzID0gbmV3IFdlYWtNYXA8VGVzdEFwcCwgc3RyaW5nPigpO1xyXG5jb25zdCBsYXVuY2hDb2RlcyA9IG5ldyBXZWFrTWFwPFRlc3RBcHAsICgpID0+IFByb21pc2U8c3RyaW5nPj4oKTtcclxudHlwZSBEb3dubG9hZFJlc3BvbnNlID0geyBzdGF0dXM6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IGhlYWRlcnM6IEhlYWRlcnMgfTtcclxuY29uc3QgZG93bmxvYWRzID0gbmV3IFdlYWtNYXA8QXBpQ2xpZW50LCAocGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPERvd25sb2FkUmVzcG9uc2U+PigpO1xyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkX2Zvcl90ZXN0KGNsaWVudDogQXBpQ2xpZW50LCBwYXRoOiBzdHJpbmcpOiBQcm9taXNlPERvd25sb2FkUmVzcG9uc2U+IHtcclxuICBjb25zdCBkb3dubG9hZCA9IGRvd25sb2Fkcy5nZXQoY2xpZW50KTtcclxuICBpZiAoIWRvd25sb2FkKSB0aHJvdyBuZXcgRXJyb3IoJ0FwaUNsaWVudCB3YXMgbm90IGNyZWF0ZWQgYnkgdGhpcyB0ZXN0IGhlbHBlcicpO1xyXG4gIHJldHVybiBkb3dubG9hZChwYXRoKTtcclxufVxyXG5sZXQgYnVpbHREZWZhdWx0QXBpQmluYXJ5OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZyZWVMb29wYmFja1BvcnQoKTogUHJvbWlzZTxudW1iZXI+IHtcclxuICBjb25zdCBzZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKTtcclxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZUxpc3RlbiwgcmVqZWN0KSA9PiB7XHJcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xyXG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgcmVzb2x2ZUxpc3Rlbik7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKCFhZGRyZXNzIHx8IHR5cGVvZiBhZGRyZXNzID09PSAnc3RyaW5nJykgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3QgcmVzZXJ2ZSBhIGxvb3BiYWNrIHBvcnQnKTtcclxuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xyXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlQ2xvc2UsIHJlamVjdCkgPT4gc2VydmVyLmNsb3NlKGVycm9yID0+IGVycm9yID8gcmVqZWN0KGVycm9yKSA6IHJlc29sdmVDbG9zZSgpKSk7XHJcbiAgcmV0dXJuIHBvcnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlY29yZCh2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZyk6IEpzb25SZWNvcmQge1xyXG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IHZhbHVlID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7bGFiZWx9IHJlc3BvbnNlIHdhcyBub3QgYW4gb2JqZWN0YCk7XHJcbiAgfVxyXG4gIHJldHVybiB2YWx1ZSBhcyBKc29uUmVjb3JkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWVsZFN0cmluZyh2YWx1ZTogSnNvblJlY29yZCwgLi4ua2V5czogc3RyaW5nW10pOiBzdHJpbmcge1xyXG4gIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIGlmICh0eXBlb2YgdmFsdWVba2V5XSA9PT0gJ3N0cmluZycgJiYgdmFsdWVba2V5XSkgcmV0dXJuIHZhbHVlW2tleV0gYXMgc3RyaW5nO1xyXG4gIHRocm93IG5ldyBFcnJvcihgUmVzcG9uc2UgZGlkIG5vdCBjb250YWluICR7a2V5cy5qb2luKCcgb3IgJyl9YCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc3BvbnNlQ2xpZW50KFxyXG4gIGJhc2VVcmw6IHN0cmluZyxcclxuICBjb29raWU6ICgpID0+IHN0cmluZyxcclxuICBjc3JmOiAoKSA9PiBzdHJpbmcsXHJcbiAgb25Db29raWU/OiAoY29va2llOiBzdHJpbmcpID0+IHZvaWQsXHJcbik6IEFwaUNsaWVudCB7XHJcbiAgY29uc3QgY2xpZW50T3JpZ2luID0gbmV3IFVSTChiYXNlVXJsKS5vcmlnaW47XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VuZDxUPihtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nLCBib2R5OiBCb2R5SW5pdCB8IHVuZGVmaW5lZCwgY29udGVudFR5cGU/OiBzdHJpbmcsIGlkZW1wb3RlbmN5S2V5Pzogc3RyaW5nKTogUHJvbWlzZTxBcGlSZXNwb25zZTxUPj4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChwYXRoLCBiYXNlVXJsKTtcclxuICAgIGlmICh1cmwub3JpZ2luICE9PSBjbGllbnRPcmlnaW4gfHwgdXJsLnVzZXJuYW1lIHx8IHVybC5wYXNzd29yZCkgdGhyb3cgbmV3IEVycm9yKCdUZXN0IHJlcXVlc3QgbXVzdCByZW1haW4gc2FtZS1vcmlnaW4gd2l0aG91dCBVUkwgY3JlZGVudGlhbHMnKTtcclxuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xyXG4gICAgY29uc3QgYWN0aXZlQ29va2llID0gY29va2llKCk7XHJcbiAgICBpZiAoYWN0aXZlQ29va2llKSBoZWFkZXJzLnNldCgnY29va2llJywgYWN0aXZlQ29va2llKTtcclxuICAgIGNvbnN0IHRva2VuID0gY3NyZigpO1xyXG4gICAgaWYgKHRva2VuICYmICFbJ0dFVCcsICdIRUFEJywgJ09QVElPTlMnXS5pbmNsdWRlcyhtZXRob2QudG9VcHBlckNhc2UoKSkpIGhlYWRlcnMuc2V0KCd4LWNzcmYtdG9rZW4nLCB0b2tlbik7XHJcbiAgICBoZWFkZXJzLnNldCgnb3JpZ2luJywgYmFzZVVybCk7XHJcbiAgICBpZiAoY29udGVudFR5cGUpIGhlYWRlcnMuc2V0KCdjb250ZW50LXR5cGUnLCBjb250ZW50VHlwZSk7XHJcbiAgICBpZiAoaWRlbXBvdGVuY3lLZXkpIGhlYWRlcnMuc2V0KCdpZGVtcG90ZW5jeS1rZXknLCBpZGVtcG90ZW5jeUtleSk7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCwgeyBtZXRob2QsIGhlYWRlcnMsIGJvZHksIHJlZGlyZWN0OiAnZXJyb3InIH0pO1xyXG4gICAgY29uc3Qgc2V0Q29va2llID0gcmVzcG9uc2UuaGVhZGVycy5nZXQoJ3NldC1jb29raWUnKTtcclxuICAgIGlmIChzZXRDb29raWUpIG9uQ29va2llPy4oc2V0Q29va2llLnNwbGl0KCc7JywgMSlbMF0gPz8gJycpO1xyXG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuICAgIGxldCBqc29uOiB1bmtub3duID0gbnVsbDtcclxuICAgIGlmICh0ZXh0KSB7XHJcbiAgICAgIHRyeSB7IGpzb24gPSBKU09OLnBhcnNlKHRleHQpOyB9XHJcbiAgICAgIGNhdGNoIHsgdGhyb3cgbmV3IEVycm9yKGBBUEkgJHttZXRob2R9ICR7cGF0aH0gcmV0dXJuZWQgbm9uLUpTT04gKCR7cmVzcG9uc2Uuc3RhdHVzfSlgKTsgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGpzb246IGpzb24gYXMgVCwgaGVhZGVyczogcmVzcG9uc2UuaGVhZGVycyB9O1xyXG4gIH1cclxuXHJcbiAgY29uc3QgY2xpZW50OiBBcGlDbGllbnQgPSB7XHJcbiAgICByZXF1ZXN0PFQgPSB1bmtub3duPihtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nLCBib2R5PzogdW5rbm93bik6IFByb21pc2U8QXBpUmVzcG9uc2U8VD4+IHtcclxuICAgICAgcmV0dXJuIHNlbmQ8VD4obWV0aG9kLCBwYXRoLCBib2R5ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBKU09OLnN0cmluZ2lmeShib2R5KSwgYm9keSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogJ2FwcGxpY2F0aW9uL2pzb24nKTtcclxuICAgIH0sXHJcbiAgICBhc3luYyB1cGxvYWQ8VCA9IHVua25vd24+KHBhdGg6IHN0cmluZywgYnl0ZXM6IFVpbnQ4QXJyYXksIGZpbGVuYW1lOiBzdHJpbmcsIGlkZW1wb3RlbmN5S2V5ID0gY3J5cHRvLnJhbmRvbVVVSUQoKSwgbWVkaWFUeXBlID0gJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScpOiBQcm9taXNlPEFwaVJlc3BvbnNlPFQ+PiB7XHJcbiAgICAgIGNvbnN0IGZvcm0gPSBuZXcgRm9ybURhdGEoKTtcclxuICAgICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKGJ5dGVzLmJ5dGVMZW5ndGgpO1xyXG4gICAgICBuZXcgVWludDhBcnJheShidWZmZXIpLnNldChieXRlcyk7XHJcbiAgICAgIGZvcm0uYXBwZW5kKCdpbWFnZXMnLCBuZXcgQmxvYihbYnVmZmVyXSwgeyB0eXBlOiBtZWRpYVR5cGUgfSksIGZpbGVuYW1lKTtcclxuICAgICAgcmV0dXJuIHNlbmQ8VD4oJ1BPU1QnLCBwYXRoLCBmb3JtLCB1bmRlZmluZWQsIGlkZW1wb3RlbmN5S2V5KTtcclxuICAgIH0sXHJcbiAgfTtcclxuICBkb3dubG9hZHMuc2V0KGNsaWVudCwgYXN5bmMgcGF0aCA9PiB7XHJcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHBhdGgsIGJhc2VVcmwpO1xyXG4gICAgaWYgKHVybC5vcmlnaW4gIT09IGNsaWVudE9yaWdpbiB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkKSB0aHJvdyBuZXcgRXJyb3IoJ1Rlc3QgZG93bmxvYWQgbXVzdCByZW1haW4gc2FtZS1vcmlnaW4gd2l0aG91dCBVUkwgY3JlZGVudGlhbHMnKTtcclxuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycyh7IG9yaWdpbjogYmFzZVVybCB9KTtcclxuICAgIGNvbnN0IGFjdGl2ZUNvb2tpZSA9IGNvb2tpZSgpO1xyXG4gICAgaWYgKGFjdGl2ZUNvb2tpZSkgaGVhZGVycy5zZXQoJ2Nvb2tpZScsIGFjdGl2ZUNvb2tpZSk7XHJcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCwgeyBoZWFkZXJzLCByZWRpcmVjdDogJ2Vycm9yJyB9KTtcclxuICAgIGNvbnN0IHNldENvb2tpZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdzZXQtY29va2llJyk7XHJcbiAgICBpZiAoc2V0Q29va2llKSBvbkNvb2tpZT8uKHNldENvb2tpZS5zcGxpdCgnOycsIDEpWzBdID8/ICcnKTtcclxuICAgIHJldHVybiB7IHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBieXRlczogbmV3IFVpbnQ4QXJyYXkoYXdhaXQgcmVzcG9uc2UuYXJyYXlCdWZmZXIoKSksIGhlYWRlcnM6IHJlc3BvbnNlLmhlYWRlcnMgfTtcclxuICB9KTtcclxuICByZXR1cm4gY2xpZW50O1xyXG59XHJcbi8qKiBBdXRoZW50aWNhdGVzIG9ubHkgY2FsbGVyLW93bmVkIHN5bnRoZXRpYyBsb29wYmFjayBpbnN0YWxsYXRpb25zLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9naW5fYXRfb3JpZ2luX2Zvcl90ZXN0KGJhc2VVcmw6IHN0cmluZywgY3JlZGVudGlhbHM6IHsgdXNlcm5hbWU6IHN0cmluZzsgcGFzc3dvcmQ6IHN0cmluZyB9IHwgeyBsYXVuY2hfY29kZTogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nIH0pOiBQcm9taXNlPEFwaUNsaWVudD4ge1xyXG4gIGNvbnN0IG9yaWdpbiA9IG5ldyBVUkwoYmFzZVVybCk7XHJcbiAgaWYgKG9yaWdpbi5wcm90b2NvbCAhPT0gJ2h0dHA6JyB8fCAhWycxMjcuMC4wLjEnLCAnbG9jYWxob3N0JywgJ1s6OjFdJ10uaW5jbHVkZXMob3JpZ2luLmhvc3RuYW1lKSB8fCBvcmlnaW4ucGF0aG5hbWUgIT09ICcvJyB8fCBvcmlnaW4uc2VhcmNoIHx8IG9yaWdpbi5oYXNoIHx8IG9yaWdpbi51c2VybmFtZSB8fCBvcmlnaW4ucGFzc3dvcmQpIHRocm93IG5ldyBFcnJvcignU3ludGhldGljIGZpeHR1cmUgcmVxdWlyZXMgYSBsb29wYmFjayBIVFRQIG9yaWdpbicpO1xyXG4gIGxldCBjb29raWUgPSAnJzsgbGV0IGNzcmYgPSAnJztcclxuICBjb25zdCBjbGllbnQgPSByZXNwb25zZUNsaWVudChvcmlnaW4ub3JpZ2luLCAoKSA9PiBjb29raWUsICgpID0+IGNzcmYsIHZhbHVlID0+IHsgY29va2llID0gdmFsdWU7IH0pO1xyXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2xpZW50LnJlcXVlc3Q8SnNvblJlY29yZD4oJ1BPU1QnLCAnbGF1bmNoX2NvZGUnIGluIGNyZWRlbnRpYWxzID8gJy9hcGkvc2Vzc2lvbi9ib290c3RyYXAnIDogJy9hcGkvc2Vzc2lvbi9sb2dpbicsIGNyZWRlbnRpYWxzKTtcclxuICBpZiAocmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcignU3ludGhldGljIGxvZ2luIGZhaWxlZCAoJyArIHJlc3BvbnNlLnN0YXR1cyArICcpOiAnICsgSlNPTi5zdHJpbmdpZnkocmVzcG9uc2UuanNvbikpO1xyXG4gIGNzcmYgPSBmaWVsZFN0cmluZyhyZWNvcmQocmVzcG9uc2UuanNvbiwgJ3N5bnRoZXRpYyBsb2dpbicpLCAnY3NyZl90b2tlbicpO1xyXG4gIGlmICghY29va2llKSB0aHJvdyBuZXcgRXJyb3IoJ1N5bnRoZXRpYyBsb2dpbiBkaWQgbm90IHJldHVybiBhIHNlc3Npb24gY29va2llJyk7XHJcbiAgcmV0dXJuIGNsaWVudDtcclxufVxyXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZV90ZXN0X2FwaSgpOiBzdHJpbmcge1xyXG4gIGNvbnN0IGNvbmZpZ3VyZWRCaW5hcnkgPSBwcm9jZXNzLmVudi5XRUJMQUJFTF9BUElfQklOQVJZO1xyXG4gIGNvbnN0IHRhcmdldERpcmVjdG9yeSA9IHJlc29sdmUocmVwb1Jvb3QsIHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVIgPz8gJ3RhcmdldCcpO1xyXG4gIGNvbnN0IGJpbmFyeSA9IGNvbmZpZ3VyZWRCaW5hcnkgPz8gcmVzb2x2ZSh0YXJnZXREaXJlY3RvcnksICdkZWJ1ZycsIHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicgPyAnd2VibGFiZWwtYXBpLmV4ZScgOiAnd2VibGFiZWwtYXBpJyk7XHJcbiAgaWYgKCFjb25maWd1cmVkQmluYXJ5ICYmIGJ1aWx0RGVmYXVsdEFwaUJpbmFyeSAhPT0gYmluYXJ5KSB7XHJcbiAgICAvLyBCdWlsZCBvbmNlIHBlciB3b3JrZXI7IGFuIGV4aXN0aW5nIGV4ZWN1dGFibGUgbWF5IHByZWRhdGUgdGhlIHRlc3RlZCBzb3VyY2VzLlxyXG4gICAgZXhlY0ZpbGVTeW5jKCdjYXJnbycsIFsnYnVpbGQnLCAnLS1sb2NrZWQnLCAnLS1tYW5pZmVzdC1wYXRoJywgcmVzb2x2ZShyZXBvUm9vdCwgJ0NhcmdvLnRvbWwnKSwgJy0tdGFyZ2V0LWRpcicsIHRhcmdldERpcmVjdG9yeSwgJy1wJywgJ3dlYmxhYmVsLWFwaScsICctLWJpbicsICd3ZWJsYWJlbC1hcGknXSwge1xyXG4gICAgICBjd2Q6IHJlcG9Sb290LFxyXG4gICAgICBzdGRpbzogJ2luaGVyaXQnLFxyXG4gICAgfSk7XHJcbiAgICBidWlsdERlZmF1bHRBcGlCaW5hcnkgPSBiaW5hcnk7XHJcbiAgfVxyXG4gIHJldHVybiBiaW5hcnk7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydF90ZXN0X2FwcChjb29raWVTZWN1cmU6ICd0cnVlJyB8ICdmYWxzZScgPSAnZmFsc2UnLCBtb2RlbFdvcmtlcjogJ21hbnVhbCcgfCAnYmFja2dyb3VuZCcgPSAnbWFudWFsJyk6IFByb21pc2U8VGVzdEFwcD4ge1xyXG4gIGNvbnN0IGJpbmFyeSA9IHByZXBhcmVfdGVzdF9hcGkoKTtcclxuICBjb25zdCByb290ID0gYXdhaXQgbWtkdGVtcChyZXNvbHZlKHRtcGRpcigpLCAnd2VibGFiZWwtdDEwLScpKTtcclxuICBjb25zdCBwb3J0ID0gYXdhaXQgZnJlZUxvb3BiYWNrUG9ydCgpO1xyXG4gIGNvbnN0IGJhc2VfdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWA7XHJcbiAgY29uc3QgY2hpbGQ6IENoaWxkUHJvY2VzcyA9IHNwYXduKGJpbmFyeSwgW10sIHtcclxuICAgIGN3ZDogcmVwb1Jvb3QsXHJcbiAgICBlbnY6IHtcclxuICAgICAgLi4ucHJvY2Vzcy5lbnYsXHJcbiAgICAgIFdFQkxBQkVMX0JJTkQ6IGAxMjcuMC4wLjE6JHtwb3J0fWAsXHJcbiAgICAgIFdFQkxBQkVMX0RBVEFCQVNFX1VSTDogYHNxbGl0ZToke3Jlc29sdmUocm9vdCwgJ2FwaS5zcWxpdGUnKX1gLFxyXG4gICAgICBXRUJMQUJFTF9PQkpFQ1RfUk9PVDogcmVzb2x2ZShyb290LCAnb2JqZWN0cycpLFxyXG4gICAgICBXRUJMQUJFTF9FTlY6ICdkZXZlbG9wbWVudCcsXHJcbiAgICAgIFdFQkxBQkVMX1RFU1RfTUFOVUFMX01PREVMX1dPUktFUjogbW9kZWxXb3JrZXIgPT09ICdtYW51YWwnID8gJzEnIDogJzAnLFxyXG4gICAgICBXRUJMQUJFTF9DT09LSUVfU0VDVVJFOiBjb29raWVTZWN1cmUsXHJcbiAgICB9LFxyXG4gICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxyXG4gIH0pO1xyXG4gIGxldCBvdXRwdXQgPSAnJztcclxuICBjb25zdCBleGl0ZWQgPSBQcm9taXNlLndpdGhSZXNvbHZlcnM8dm9pZD4oKTtcclxuICBjaGlsZC5vbmNlKCdleGl0JywgKCkgPT4gZXhpdGVkLnJlc29sdmUoKSk7XHJcbiAgY2hpbGQub25jZSgnZXJyb3InLCBlcnJvciA9PiB7XHJcbiAgICBvdXRwdXQgKz0gYEFQSSBwcm9jZXNzIGVycm9yOiAke2Vycm9yLm1lc3NhZ2V9XFxuYDtcclxuICAgIGV4aXRlZC5yZXNvbHZlKCk7XHJcbiAgfSk7XHJcbiAgbGV0IHN0ZG91dFJlbWFpbmRlciA9ICcnO1xyXG4gIGNvbnN0IGxhdW5jaENvZGVSZXN1bHQgPSBQcm9taXNlLndpdGhSZXNvbHZlcnM8c3RyaW5nPigpO1xyXG4gIGxldCBsYXVuY2hDb2RlUmVjZWl2ZWQgPSBmYWxzZTtcclxuICBjaGlsZC5zdGRvdXQ/Lm9uKCdkYXRhJywgY2h1bmsgPT4ge1xyXG4gICAgY29uc3QgbGluZXMgPSBgJHtzdGRvdXRSZW1haW5kZXJ9JHtTdHJpbmcoY2h1bmspfWAuc3BsaXQoL1xccj9cXG4vKTtcclxuICAgIHN0ZG91dFJlbWFpbmRlciA9IGxpbmVzLnBvcCgpID8/ICcnO1xyXG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XHJcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ1dFQkxBQkVMX0JPT1RTVFJBUF9DT0RFPScpICYmICFsYXVuY2hDb2RlUmVjZWl2ZWQpIHtcclxuICAgICAgICBjb25zdCBjb2RlID0gbGluZS5zbGljZSgnV0VCTEFCRUxfQk9PVFNUUkFQX0NPREU9Jy5sZW5ndGgpO1xyXG4gICAgICAgIGxhdW5jaENvZGVSZWNlaXZlZCA9IHRydWU7XHJcbiAgICAgICAgbGF1bmNoQ29kZVJlc3VsdC5yZXNvbHZlKGNvZGUpO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIG91dHB1dCArPSBgJHtsaW5lfVxcbmA7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9KTtcclxuICBjaGlsZC5zdGRlcnI/Lm9uKCdkYXRhJywgY2h1bmsgPT4geyBvdXRwdXQgKz0gU3RyaW5nKGNodW5rKTsgfSk7XHJcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcclxuICBjb25zdCBzdG9wID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgaWYgKHN0b3BwZWQpIHJldHVybjtcclxuICAgIHN0b3BwZWQgPSB0cnVlO1xyXG4gICAgaWYgKGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY2hpbGQua2lsbCgnU0lHS0lMTCcpLCAzMDAwKTtcclxuICAgICAgY2hpbGQua2lsbCgnU0lHVEVSTScpO1xyXG4gICAgICBhd2FpdCBleGl0ZWQucHJvbWlzZTtcclxuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgcm0ocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDIwXzAwMDtcclxuICB0cnkge1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBBUEkgcHJvY2VzcyBleGl0ZWQgZWFybHk6XFxuJHtvdXRwdXR9YCk7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtiYXNlX3VybH0vaGVhbHRoYCwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSB9KTtcclxuICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSAyMDQpIGJyZWFrO1xyXG4gICAgICB9IGNhdGNoIHsgLyogVGhlIHNlcnZpY2UgaXMgc3RpbGwgc3RhcnRpbmcuICovIH1cclxuICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZVdhaXQgPT4gc2V0VGltZW91dChyZXNvbHZlV2FpdCwgMTAwKSk7XHJcbiAgICB9XHJcbiAgICBpZiAoRGF0ZS5ub3coKSA+PSBkZWFkbGluZSkgdGhyb3cgbmV3IEVycm9yKGBBUEkgZGlkIG5vdCBiZWNvbWUgcmVhZHk6XFxuJHtvdXRwdXR9YCk7XHJcbiAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgIGF3YWl0IHN0b3AoKTtcclxuICAgIHRocm93IGVycm9yO1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gcmVhZExhdW5jaENvZGUoKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICAgIGNvbnN0IHRpbWVvdXRSZXN1bHQgPSBQcm9taXNlLndpdGhSZXNvbHZlcnM8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRpbWVvdXRSZXN1bHQucmVqZWN0KG5ldyBFcnJvcignQVBJIGRpZCBub3QgZW1pdCBpdHMgYm9vdHN0cmFwIGNvZGUgb24gc3Rkb3V0JykpLCAxMF8wMDApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgY29kZSA9IGF3YWl0IFByb21pc2UucmFjZShbbGF1bmNoQ29kZVJlc3VsdC5wcm9taXNlLCB0aW1lb3V0UmVzdWx0LnByb21pc2VdKTtcclxuICAgICAgaWYgKCFjb2RlKSB0aHJvdyBuZXcgRXJyb3IoJ0FQSSBlbWl0dGVkIGFuIGVtcHR5IGJvb3RzdHJhcCBjb2RlJyk7XHJcbiAgICAgIHJldHVybiBjb2RlO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcclxuICAgIH1cclxuICB9XHJcbiAgbGV0IGJvb3RzdHJhcENsaWVudFByb21pc2U6IFByb21pc2U8QXBpQ2xpZW50PiB8IHVuZGVmaW5lZDtcclxuICBsZXQgYm9vdHN0cmFwUGFzc3dvcmQgPSAnJztcclxuICBhc3luYyBmdW5jdGlvbiBnZXRCb290c3RyYXBDbGllbnQoKTogUHJvbWlzZTxBcGlDbGllbnQ+IHtcclxuICAgIGlmICghYm9vdHN0cmFwQ2xpZW50UHJvbWlzZSkge1xyXG4gICAgICBib290c3RyYXBDbGllbnRQcm9taXNlID0gKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBsYXVuY2hDb2RlID0gYXdhaXQgcmVhZExhdW5jaENvZGUoKTtcclxuICAgICAgICBib290c3RyYXBQYXNzd29yZCA9IGAke2NyeXB0by5yYW5kb21VVUlEKCl9JHtjcnlwdG8ucmFuZG9tVVVJRCgpfWA7XHJcbiAgICAgICAgbGV0IHNlc3Npb25Db29raWUgPSAnJztcclxuICAgICAgICBsZXQgY3NyZlRva2VuID0gJyc7XHJcbiAgICAgICAgY29uc3QgY2xpZW50ID0gcmVzcG9uc2VDbGllbnQoYmFzZV91cmwsICgpID0+IHNlc3Npb25Db29raWUsICgpID0+IGNzcmZUb2tlbiwgdmFsdWUgPT4geyBzZXNzaW9uQ29va2llID0gdmFsdWU7IH0pO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5yZXF1ZXN0PEpzb25SZWNvcmQ+KCdQT1NUJywgJy9hcGkvc2Vzc2lvbi9ib290c3RyYXAnLCB7IGxhdW5jaF9jb2RlOiBsYXVuY2hDb2RlLCBwYXNzd29yZDogYm9vdHN0cmFwUGFzc3dvcmQgfSk7XHJcbiAgICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPCAyMDAgfHwgcmVzdWx0LnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcihgUmVhbCBib290c3RyYXAgZmFpbGVkICgke3Jlc3VsdC5zdGF0dXN9KTogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQuanNvbil9YCk7XHJcbiAgICAgICAgY29uc3QgYm9vdHN0cmFwUmVzcG9uc2UgPSByZWNvcmQocmVzdWx0Lmpzb24sICdib290c3RyYXAnKTtcclxuICAgICAgICBpZiAoT2JqZWN0Lmhhc093bihib290c3RyYXBSZXNwb25zZSwgJ3Bhc3N3b3JkJykpIHRocm93IG5ldyBFcnJvcignQm9vdHN0cmFwIHJlc3BvbnNlIGV4cG9zZWQgdGhlIGNob3NlbiBwYXNzd29yZCcpO1xyXG4gICAgICAgIGlmIChmaWVsZFN0cmluZyhib290c3RyYXBSZXNwb25zZSwgJ3VzZXJuYW1lJykgIT09ICdsb2NhbC1hZG1pbicpIHRocm93IG5ldyBFcnJvcignQm9vdHN0cmFwIGFkbWluaXN0cmF0b3IgdXNlcm5hbWUgd2FzIG5vdCByZXR1cm5lZCcpO1xyXG4gICAgICAgIGNzcmZUb2tlbiA9IGZpZWxkU3RyaW5nKGJvb3RzdHJhcFJlc3BvbnNlLCAnY3NyZl90b2tlbicpO1xyXG4gICAgICAgIHJldHVybiBjbGllbnQ7XHJcbiAgICAgIH0pKCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gYm9vdHN0cmFwQ2xpZW50UHJvbWlzZTtcclxuICB9XHJcbiAgY29uc3QgYXBwOiBUZXN0QXBwID0ge1xyXG4gICAgYmFzZV91cmwsXHJcbiAgICBhc3luYyBhc191c2VyKHJvbGU6IFJvbGUpOiBQcm9taXNlPEFwaUNsaWVudD4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGJvb3RzdHJhcENsaWVudCA9IGF3YWl0IGdldEJvb3RzdHJhcENsaWVudCgpO1xyXG4gICAgICAgIGNvbnN0IHBhc3N3b3JkID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcclxuICAgICAgICBjb25zdCB1c2VybmFtZSA9IGB0MTAtJHtjcnlwdG8ucmFuZG9tVVVJRCgpfWA7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IGJvb3RzdHJhcENsaWVudC5yZXF1ZXN0PEpzb25SZWNvcmQ+KCdQT1NUJywgJy9hcGkvdXNlcnMnLCB7IHVzZXJuYW1lLCBwYXNzd29yZCB9KTtcclxuICAgICAgICBpZiAoY3JlYXRlZC5zdGF0dXMgPCAyMDAgfHwgY3JlYXRlZC5zdGF0dXMgPj0gMzAwKSB0aHJvdyBuZXcgRXJyb3IoYFJlYWwgdXNlciBjcmVhdGlvbiBmYWlsZWQgKCR7Y3JlYXRlZC5zdGF0dXN9KTogJHtKU09OLnN0cmluZ2lmeShjcmVhdGVkLmpzb24pfWApO1xyXG4gICAgICAgIGNvbnN0IHVzZXJJZCA9IGZpZWxkU3RyaW5nKHJlY29yZChjcmVhdGVkLmpzb24sICd1c2VyIGNyZWF0aW9uJyksICd1c2VyX2lkJywgJ2lkJyk7XHJcbiAgICAgICAgY29uc3QgcHJvamVjdFJlc3BvbnNlID0gYXdhaXQgYm9vdHN0cmFwQ2xpZW50LnJlcXVlc3Q8SnNvblJlY29yZD4oJ1BPU1QnLCAnL2FwaS9wcm9qZWN0cycsIHtcclxuICAgICAgICAgIG5hbWU6IGBUMTAgJHtyb2xlfSAke2NyeXB0by5yYW5kb21VVUlEKCl9YCxcclxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnRXBoZW1lcmFsIGlzb2xhdGVkIEFQSSB0ZXN0IHByb2plY3QnLFxyXG4gICAgICAgICAgYWxsb3dfc2VsZl9yZXZpZXc6IGZhbHNlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChwcm9qZWN0UmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHByb2plY3RSZXNwb25zZS5zdGF0dXMgPj0gMzAwKSB0aHJvdyBuZXcgRXJyb3IoYFJlYWwgcHJvamVjdCBjcmVhdGlvbiBmYWlsZWQgKCR7cHJvamVjdFJlc3BvbnNlLnN0YXR1c30pOiAke0pTT04uc3RyaW5naWZ5KHByb2plY3RSZXNwb25zZS5qc29uKX1gKTtcclxuICAgICAgICBjb25zdCBwcm9qZWN0SWQgPSBmaWVsZFN0cmluZyhyZWNvcmQocHJvamVjdFJlc3BvbnNlLmpzb24sICdwcm9qZWN0IGNyZWF0aW9uJyksICdwcm9qZWN0X2lkJywgJ2lkJyk7XHJcbiAgICAgICAgY29uc3QgbWVtYmVyc2hpcCA9IGF3YWl0IGJvb3RzdHJhcENsaWVudC5yZXF1ZXN0KCdQT1NUJywgYC9hcGkvcHJvamVjdHMvJHtlbmNvZGVVUklDb21wb25lbnQocHJvamVjdElkKX0vbWVtYmVyc2AsIHsgdXNlcl9pZDogdXNlcklkLCByb2xlIH0pO1xyXG4gICAgICAgIGlmIChtZW1iZXJzaGlwLnN0YXR1cyA8IDIwMCB8fCBtZW1iZXJzaGlwLnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcihgUmVhbCBtZW1iZXJzaGlwIGNyZWF0aW9uIGZhaWxlZCAoJHttZW1iZXJzaGlwLnN0YXR1c30pYCk7XHJcblxyXG4gICAgICAgIGNvbnN0IGxvZ2luID0gYXdhaXQgcmVzcG9uc2VDbGllbnQoYmFzZV91cmwsICgpID0+ICcnLCAoKSA9PiAnJykucmVxdWVzdDxKc29uUmVjb3JkPihcclxuICAgICAgICAgICdQT1NUJywgJy9hcGkvc2Vzc2lvbi9sb2dpbicsIHsgdXNlcm5hbWUsIHBhc3N3b3JkIH0sXHJcbiAgICAgICAgKTtcclxuICAgICAgICBpZiAobG9naW4uc3RhdHVzIDwgMjAwIHx8IGxvZ2luLnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcihgUmVhbCBsb2dpbiBmYWlsZWQgKCR7bG9naW4uc3RhdHVzfSk6ICR7SlNPTi5zdHJpbmdpZnkobG9naW4uanNvbil9YCk7XHJcbiAgICAgICAgY29uc3Qgc2V0Q29va2llID0gbG9naW4uaGVhZGVycy5nZXQoJ3NldC1jb29raWUnKSA/PyAnJztcclxuICAgICAgICBpZiAoc2V0Q29va2llLmluY2x1ZGVzKCc7IFNlY3VyZScpICE9PSAoY29va2llU2VjdXJlID09PSAndHJ1ZScpKSB7XHJcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FQSSBzZXNzaW9uIGNvb2tpZSBTZWN1cmUgYXR0cmlidXRlIGRpZCBub3QgbWF0Y2ggV0VCTEFCRUxfQ09PS0lFX1NFQ1VSRScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgdXNlckNvb2tpZSA9IHNldENvb2tpZS5zcGxpdCgnOycsIDEpWzBdID8/ICcnO1xyXG4gICAgICAgIGxldCB1c2VyQ3NyZiA9IGZpZWxkU3RyaW5nKHJlY29yZChsb2dpbi5qc29uLCAnbG9naW4nKSwgJ2NzcmZfdG9rZW4nKTtcclxuICAgICAgICByZXR1cm4gcmVzcG9uc2VDbGllbnQoYmFzZV91cmwsICgpID0+IHVzZXJDb29raWUsICgpID0+IHVzZXJDc3JmLCB2YWx1ZSA9PiB7IHVzZXJDb29raWUgPSB2YWx1ZTsgfSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYXdhaXQgc3RvcCgpO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICB9XHJcbiAgICB9LFxyXG4gICAgc3RvcCxcclxuICB9O1xyXG4gIGxhdW5jaENvZGVzLnNldChhcHAsIHJlYWRMYXVuY2hDb2RlKTtcclxuICBib290c3RyYXBDbGllbnRzLnNldChhcHAsIGdldEJvb3RzdHJhcENsaWVudCk7XHJcbiAgYm9vdHN0cmFwTG9naW5zLnNldChhcHAsIGFzeW5jICgpID0+IHtcclxuICAgIGF3YWl0IGdldEJvb3RzdHJhcENsaWVudCgpO1xyXG4gICAgY29uc3QgbG9naW4gPSBhd2FpdCByZXNwb25zZUNsaWVudChiYXNlX3VybCwgKCkgPT4gJycsICgpID0+ICcnKS5yZXF1ZXN0PEpzb25SZWNvcmQ+KFxyXG4gICAgICAnUE9TVCcsXHJcbiAgICAgICcvYXBpL3Nlc3Npb24vbG9naW4nLFxyXG4gICAgICB7IHVzZXJuYW1lOiAnbG9jYWwtYWRtaW4nLCBwYXNzd29yZDogYm9vdHN0cmFwUGFzc3dvcmQgfSxcclxuICAgICk7XHJcbiAgICBpZiAobG9naW4uc3RhdHVzIDwgMjAwIHx8IGxvZ2luLnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcihgQm9vdHN0cmFwIGFkbWluaXN0cmF0b3IgbG9naW4gZmFpbGVkICgke2xvZ2luLnN0YXR1c30pYCk7XHJcbiAgICBjb25zdCBzZXRDb29raWUgPSBsb2dpbi5oZWFkZXJzLmdldCgnc2V0LWNvb2tpZScpID8/ICcnO1xyXG4gICAgaWYgKHNldENvb2tpZS5pbmNsdWRlcygnOyBTZWN1cmUnKSAhPT0gKGNvb2tpZVNlY3VyZSA9PT0gJ3RydWUnKSkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FQSSBzZXNzaW9uIGNvb2tpZSBTZWN1cmUgYXR0cmlidXRlIGRpZCBub3QgbWF0Y2ggV0VCTEFCRUxfQ09PS0lFX1NFQ1VSRScpO1xyXG4gICAgfVxyXG4gICAgbGV0IHNlc3Npb25Db29raWUgPSBzZXRDb29raWUuc3BsaXQoJzsnLCAxKVswXSA/PyAnJztcclxuICAgIGxldCBjc3JmVG9rZW4gPSBmaWVsZFN0cmluZyhyZWNvcmQobG9naW4uanNvbiwgJ2Jvb3RzdHJhcCBhZG1pbmlzdHJhdG9yIGxvZ2luJyksICdjc3JmX3Rva2VuJyk7XHJcbiAgICByZXR1cm4gcmVzcG9uc2VDbGllbnQoYmFzZV91cmwsICgpID0+IHNlc3Npb25Db29raWUsICgpID0+IGNzcmZUb2tlbiwgdmFsdWUgPT4geyBzZXNzaW9uQ29va2llID0gdmFsdWU7IH0pO1xyXG4gIH0pO1xyXG4gIGJvb3RzdHJhcFJlcGxheXMuc2V0KGFwcCwgYXN5bmMgKCkgPT4ge1xyXG4gICAgYXdhaXQgZ2V0Qm9vdHN0cmFwQ2xpZW50KCk7XHJcbiAgICBjb25zdCBsYXVuY2hDb2RlID0gYXdhaXQgcmVhZExhdW5jaENvZGUoKTtcclxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7YmFzZV91cmx9L2FwaS9zZXNzaW9uL2Jvb3RzdHJhcGAsIHtcclxuICAgICAgbWV0aG9kOiAnUE9TVCcsIGhlYWRlcnM6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGxhdW5jaF9jb2RlOiBsYXVuY2hDb2RlLCBwYXNzd29yZDogYm9vdHN0cmFwUGFzc3dvcmQgfSksXHJcbiAgICB9KTtcclxuICAgIHJldHVybiByZXNwb25zZS5zdGF0dXM7XHJcbiAgfSk7XHJcbiAgZGF0YWJhc2VQYXRocy5zZXQoYXBwLCByZXNvbHZlKHJvb3QsICdhcGkuc3FsaXRlJykpO1xyXG4gIHJldHVybiBhcHA7XHJcbn1cclxuXHJcbi8qKiBPbmx5IHRoZSBpc29sYXRlZCBzeW50aGV0aWMgZGF0YWJhc2UgY3JlYXRlZCBieSBzdGFydF90ZXN0X2FwcDsgbm90IGEgcHJvZHVjdGlvbiBBUEkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBkYXRhYmFzZV9wYXRoX2Zvcl90ZXN0KGFwcDogVGVzdEFwcCk6IHN0cmluZyB7XHJcbiAgY29uc3QgcGF0aCA9IGRhdGFiYXNlUGF0aHMuZ2V0KGFwcCk7XHJcbiAgaWYgKHBhdGggPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHRlc3QgYXBwIGRhdGFiYXNlJyk7XHJcbiAgcmV0dXJuIHBhdGg7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXBsYXlfYm9vdHN0cmFwX2NvZGVfZm9yX3Rlc3QoYXBwOiBUZXN0QXBwKTogUHJvbWlzZTxudW1iZXI+IHtcclxuICBjb25zdCByZXBsYXkgPSBib290c3RyYXBSZXBsYXlzLmdldChhcHApO1xyXG4gIGlmICghcmVwbGF5KSB0aHJvdyBuZXcgRXJyb3IoJ1Rlc3RBcHAgd2FzIG5vdCBjcmVhdGVkIGJ5IHRoaXMgdGVzdCBoZWxwZXInKTtcclxuICByZXR1cm4gcmVwbGF5KCk7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBib290c3RyYXBfYWRtaW5fZm9yX3Rlc3QoYXBwOiBUZXN0QXBwKTogUHJvbWlzZTxBcGlDbGllbnQ+IHtcclxuICBjb25zdCBnZXRDbGllbnQgPSBib290c3RyYXBDbGllbnRzLmdldChhcHApO1xyXG4gIGlmICghZ2V0Q2xpZW50KSB0aHJvdyBuZXcgRXJyb3IoJ1Rlc3RBcHAgd2FzIG5vdCBjcmVhdGVkIGJ5IHRoaXMgdGVzdCBoZWxwZXInKTtcclxuICByZXR1cm4gZ2V0Q2xpZW50KCk7XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWxvZ2luX2Jvb3RzdHJhcF9hZG1pbl9mb3JfdGVzdChhcHA6IFRlc3RBcHApOiBQcm9taXNlPEFwaUNsaWVudD4ge1xyXG4gIGNvbnN0IGxvZ2luID0gYm9vdHN0cmFwTG9naW5zLmdldChhcHApO1xyXG4gIGlmICghbG9naW4pIHRocm93IG5ldyBFcnJvcignVGVzdEFwcCB3YXMgbm90IGNyZWF0ZWQgYnkgdGhpcyB0ZXN0IGhlbHBlcicpO1xyXG4gIHJldHVybiBsb2dpbigpO1xyXG59XHJcblxyXG4vKiogUmVhZCBzdGRvdXQgZnJvbSB0aGlzIGhlbHBlci1vd25lZCBhcHAgd2l0aG91dCBjb25zdW1pbmcgaXRzIGJvb3RzdHJhcCBjb2RlLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGF1bmNoX2NvZGVfZm9yX3Rlc3QoYXBwOiBUZXN0QXBwKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICBjb25zdCByZWFkQ29kZSA9IGxhdW5jaENvZGVzLmdldChhcHApO1xyXG4gIGlmICghcmVhZENvZGUpIHRocm93IG5ldyBFcnJvcignVGVzdEFwcCB3YXMgbm90IGNyZWF0ZWQgYnkgdGhpcyB0ZXN0IGhlbHBlcicpO1xyXG4gIHJldHVybiByZWFkQ29kZSgpO1xyXG59XHJcbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EsWUFBWSxFQUFFQyxLQUFLLFFBQTJCLG9CQUFvQjtBQUMzRSxTQUFTQyxZQUFZLFFBQVEsVUFBVTtBQUN2QyxTQUFTQyxPQUFPLEVBQUVDLEVBQUUsUUFBUSxrQkFBa0I7QUFDOUMsU0FBU0MsTUFBTSxRQUFRLFNBQVM7QUFDaEMsU0FBU0MsT0FBTyxFQUFFQyxPQUFPLFFBQVEsV0FBVztBQUM1QyxTQUFTQyxhQUFhLFFBQVEsVUFBVTtBQWV4QyxNQUFNQyxRQUFRLEdBQUdGLE9BQU8sQ0FBQ0QsT0FBTyxDQUFDRSxhQUFhLENBQUNFLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDQyxHQUFHLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQztBQUMxRSxNQUFNQyxnQkFBZ0IsR0FBRyxJQUFJQyxPQUFPLENBQWlDLENBQUM7QUFDdEUsTUFBTUMsZ0JBQWdCLEdBQUcsSUFBSUQs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