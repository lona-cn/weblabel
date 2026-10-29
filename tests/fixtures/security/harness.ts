import { execFileSync, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { ApiClient, ApiResponse, TestApp } from '../../support/app';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, key: string): string {
  const item = object(value)[key];
  if (typeof item !== 'string') throw new Error(`Missing string ${key}`);
  return item;
}
export interface Login { cookie: string; csrf: string; client: ApiClient }
export async function raw(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<Record<string, unknown>>> {
  const url = new URL(path, base);
  if (url.hostname !== '127.0.0.1') throw new Error('Synthetic router requests must remain loopback');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const responseResult = Promise.withResolvers<ApiResponse<Record<string, unknown>>>();
  const request = httpRequest(url, {
    method,
    headers: { origin: base, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers },
  }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.once('error', responseResult.reject);
    response.once('end', () => {
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
      const data = Buffer.concat(chunks).toString();
      try { responseResult.resolve({ status: response.statusCode!, headers: responseHeaders, json: data ? object(JSON.parse(data)) : {} }); }
      catch (error) { responseResult.reject(error); }
    });
  });
  request.setTimeout(5000, () => request.destroy(new Error('Synthetic router deadline')));
  request.once('error', responseResult.reject);
  request.end(payload);
  return responseResult.promise;
}
export function loginClient(base: string, cookie: string, csrf: string): ApiClient {
  return {
    request: async <T>(method: string, path: string, body?: unknown) => {
      const result = await raw(base, method, path, body, { cookie, 'x-csrf-token': csrf });
      return { ...result, json: result.json as T };
    },
    upload: async <T>(path: string, bytes: Uint8Array, filename: string, operationId = crypto.randomUUID(), mediaType = 'application/octet-stream') => {
      const form = new FormData();
      form.append('images', new Blob([Uint8Array.from(bytes).buffer], { type: mediaType }), filename);
      const response = await fetch(new URL(path, base), { method: 'POST', headers: { origin: base, cookie, 'x-csrf-token': csrf, 'idempotency-key': operationId }, body: form });
      return { status: response.status, headers: response.headers, json: await response.json() as T };
    },
  };
}
export function session(base: string, response: ApiResponse<Record<string, unknown>>): Login {
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
  const csrf = text(response.json, 'csrf_token');
  return { cookie, csrf, client: loginClient(base, cookie, csrf) };
}
export interface SecurityApp extends TestApp {
  directory: string;
  admin: Login;
  issue(runId: string, projectId: string, ttlMs?: number): Promise<string>;
  extractArchive(bytes: Uint8Array, maximumUncompressedBytes?: number): Promise<Record<string, unknown>>;
  logs(): string;
}
// Compile current fixture sources once per worker, outside behavioral deadlines.
const routerTarget = resolve(root, process.env.WEBLABEL_T29_ROUTER_TARGET_DIR ?? process.env.CARGO_TARGET_DIR ?? 'target');
let compiledRouter: string | undefined;
export function prepareSecurityRouter(): string {
  if (compiledRouter) return compiledRouter;
  execFileSync('cargo', ['build', '--locked', '--manifest-path', join(root, 'Cargo.toml'), '--target-dir', routerTarget, '-p', 'weblabel-api', '--example', 'security-router-fixture'], {
    cwd: root, env: process.env, stdio: 'inherit',
  });
  const binary = join(routerTarget, 'debug/examples', process.platform === 'win32' ? 'security-router-fixture.exe' : 'security-router-fixture');
  compiledRouter = binary;
  return binary;
}
export async function startSecurityApp(): Promise<SecurityApp> {
  const binary = prepareSecurityRouter();
  const directory = await mkdtemp(join(tmpdir(), 'weblabel-t29-'));
  const child = spawn(binary, [directory], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', chunk => { logs += String(chunk); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const result = await lines.next();
    if (result.done) throw new Error(`Router exited: ${logs}`);
    return object(JSON.parse(result.value));
  };
  const info = await next();
  const base_url = text(info, 'base_url');
  const bootstrap = await raw(base_url, 'POST', '/api/session/bootstrap', { launch_code: text(info, 'launch_code'), password: 'T29-synthetic-admin-password' });
  if (bootstrap.status !== 200) throw new Error(`Bootstrap failed: ${JSON.stringify(bootstrap.json)}`);
  const admin = session(base_url, bootstrap);
  return {
    directory, base_url, admin, logs: () => logs,
    async issue(runId, projectId, ttlMs = 60_000) {
      child.stdin.write(JSON.stringify({ run_id: runId, project_id: projectId, ttl_ms: ttlMs }) + '\n');
      return text(await next(), 'token');
    },
    async extractArchive(bytes, maximumUncompressedBytes) {
      child.stdin.write(JSON.stringify({ archive_bytes: Array.from(bytes), max_uncompressed_bytes: maximumUncompressedBytes }) + '\n');
      return next();
    },
    async as_user(role) {
      const username = `t29-${crypto.randomUUID()}`;
      const password = 'T29-synthetic-user-password';
      const created = await admin.client.request('POST', '/api/users', { username, password });
      if (created.status !== 201) throw new Error('Failed to create synthetic user');
      const project = await admin.client.request('POST', '/api/projects', { name: username, description: 'T29 isolated project', allow_self_review: false });
      const member = await admin.client.request('POST', `/api/projects/${text(project.json, 'project_id')}/members`, { user_id: text(created.json, 'user_id'), role });
      if (member.status !== 200) throw new Error('Failed to create synthetic membership');
      const loggedIn = await raw(base_url, 'POST', '/api/session/login', { username, password });
      return session(base_url, loggedIn).client;
    },
    async stop() {
      const closed = Promise.withResolvers<void>();
      child.once('close', () => closed.resolve());
      child.stdin.end();
      await closed.promise;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
