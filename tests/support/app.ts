import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Role = 'admin' | 'annotator' | 'reviewer' | 'viewer';
export interface ApiResponse<T = unknown> { status: number; json: T; headers: Headers }
export interface ApiClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  upload<T = unknown>(path: string, bytes: Uint8Array, filename: string): Promise<ApiResponse<T>>;
}
export interface TestApp {
  base_url: string;
  as_user(role: Role): Promise<ApiClient>;
  stop(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} response was not an object`);
  }
  return value as JsonRecord;
}

function fieldString(value: JsonRecord, ...keys: string[]): string {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  throw new Error(`Response did not contain ${keys.join(' or ')}`);
}

function responseClient(
  baseUrl: string,
  cookie: () => string,
  csrf: () => string,
  onCookie?: (cookie: string) => void,
): ApiClient {
  async function send<T>(method: string, path: string, body: BodyInit | undefined, contentType?: string): Promise<ApiResponse<T>> {
    const headers = new Headers();
    const activeCookie = cookie();
    if (activeCookie) headers.set('cookie', activeCookie);
    const token = csrf();
    if (token && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) headers.set('x-csrf-token', token);
    if (contentType) headers.set('content-type', contentType);
    const response = await fetch(new URL(path, baseUrl), { method, headers, body });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) onCookie?.(setCookie.split(';', 1)[0] ?? '');
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); }
      catch { throw new Error(`API ${method} ${path} returned non-JSON (${response.status})`); }
    }
    return { status: response.status, json: json as T, headers: response.headers };
  }

  return {
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
      return send<T>(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
    },
    async upload<T = unknown>(path: string, bytes: Uint8Array, filename: string): Promise<ApiResponse<T>> {
      const form = new FormData();
      form.append('file', new Blob([bytes]), filename);
      return send<T>('POST', path, form);
    },
  };
}

export async function start_test_app(): Promise<TestApp> {
  const configuredBinary = process.env.WEBLABEL_API_BINARY;
  const targetDirectory = resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? 'target');
  const binary = configuredBinary ?? resolve(targetDirectory, 'debug', process.platform === 'win32' ? 'weblabel-api.exe' : 'weblabel-api');
  if (!configuredBinary && !existsSync(binary)) {
    execFileSync('cargo', ['build', '--manifest-path', resolve(repoRoot, 'Cargo.toml'), '-p', 'weblabel-api', '--bin', 'weblabel-api'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  const root = await mkdtemp(resolve(tmpdir(), 'weblabel-t06-'));
  const port = await freeLoopbackPort();
  const base_url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WEBLABEL_BIND: `127.0.0.1:${port}`,
      WEBLABEL_DATABASE_URL: `sqlite:${resolve(root, 'api.sqlite')}`,
      WEBLABEL_OBJECT_ROOT: resolve(root, 'objects'),
      WEBLABEL_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.once('error', error => {
    output += `API process error: ${error.message}\n`;
    exited.resolve();
  });
  let stdoutRemainder = '';
  const launchCodeResult = Promise.withResolvers<string>();
  let launchCodeReceived = false;
  child.stdout?.on('data', chunk => {
    const lines = `${stdoutRemainder}${String(chunk)}`.split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? '';
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
  child.stderr?.on('data', chunk => { output += String(chunk); });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      await exited.promise;
      clearTimeout(timeout);
    }
    await rm(root, { recursive: true, force: true });
  };

  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API process exited early:\n${output}`);
      try {
        const response = await fetch(`${base_url}/health`, { signal: AbortSignal.timeout(500) });
        if (response.status === 204) break;
      } catch { /* The service is still starting. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (Date.now() >= deadline) throw new Error(`API did not become ready:\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }

  async function readLaunchCode(): Promise<string> {
    const timeoutResult = Promise.withResolvers<string>();
    const timer = setTimeout(() => timeoutResult.reject(new Error('API did not emit its bootstrap code on stdout')), 10_000);
    try {
      const code = await Promise.race([launchCodeResult.promise, timeoutResult.promise]);
      if (!code) throw new Error('API emitted an empty bootstrap code');
      return code;
    } finally {
      clearTimeout(timer);
    }
  }

  let bootstrapClientPromise: Promise<ApiClient> | undefined;
  async function getBootstrapClient(): Promise<ApiClient> {
    if (!bootstrapClientPromise) {
      bootstrapClientPromise = (async () => {
        const launchCode = await readLaunchCode();
        let sessionCookie = '';
        let csrfToken = '';
        const client = responseClient(base_url, () => sessionCookie, () => csrfToken, value => { sessionCookie = value; });
        const result = await client.request<JsonRecord>('POST', '/api/session/bootstrap', { launch_code: launchCode });
        if (result.status < 200 || result.status >= 300) throw new Error(`Real bootstrap failed (${result.status}): ${JSON.stringify(result.json)}`);
        csrfToken = fieldString(record(result.json, 'bootstrap'), 'csrf_token');
        return client;
      })();
    }
    return bootstrapClientPromise;
  }

  return {
    base_url,
    async as_user(role: Role): Promise<ApiClient> {
      try {
        const bootstrapClient = await getBootstrapClient();
        const password = crypto.randomUUID();
        const username = `t06-${crypto.randomUUID()}`;
        const created = await bootstrapClient.request<JsonRecord>('POST', '/api/users', { username, password });
        if (created.status < 200 || created.status >= 300) throw new Error(`Real user creation failed (${created.status}): ${JSON.stringify(created.json)}`);
        const userId = fieldString(record(created.json, 'user creation'), 'user_id', 'id');
        const projectResponse = await bootstrapClient.request<JsonRecord>('POST', '/api/projects', {
          name: `T06 ${role} ${crypto.randomUUID()}`,
          description: 'Ephemeral isolated API test project',
          allow_self_review: false,
        });
        if (projectResponse.status < 200 || projectResponse.status >= 300) throw new Error(`Real project creation failed (${projectResponse.status}): ${JSON.stringify(projectResponse.json)}`);
        const projectId = fieldString(record(projectResponse.json, 'project creation'), 'project_id', 'id');
        const membership = await bootstrapClient.request('POST', `/api/projects/${encodeURIComponent(projectId)}/members`, { user_id: userId, role });
        if (membership.status < 200 || membership.status >= 300) throw new Error(`Real membership creation failed (${membership.status})`);

        const login = await responseClient(base_url, () => '', () => '').request<JsonRecord>(
          'POST', '/api/session/login', { username, password },
        );
        if (login.status < 200 || login.status >= 300) throw new Error(`Real login failed (${login.status}): ${JSON.stringify(login.json)}`);
        let userCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        let userCsrf = fieldString(record(login.json, 'login'), 'csrf_token');
        return responseClient(base_url, () => userCookie, () => userCsrf, value => { userCookie = value; });
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
  };
}
