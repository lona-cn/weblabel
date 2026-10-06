import { execFileSync, spawn } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { root, object } from './harness';

let built = false;
export function buildHost(): void {
  if (built) return;
  execFileSync(process.execPath, ['scripts/build-agent-host.mjs'], { cwd: root, stdio: 'inherit' });
  built = true;
}
export type SyntheticProviderId = 'mimo_api' | 'openai_api' | 'anthropic_api' | 'codex_local';
export interface HostInput {
  directory: string; apiBase: string; token: string; secret: string;
  provider: SyntheticProviderId; config: Record<string, unknown>;
  runId: string; request: Record<string, unknown>; profile: Record<string, unknown>;
}
export async function runHost(input: HostInput): Promise<{ stdout: string; stderr: string; terminal: Record<string, unknown>; events: Record<string, unknown>[]; exitCode: number | null; shellExecuted: boolean }> {
  buildHost();
  const configPath = join(input.directory, 'host.json');
  await writeFile(configPath, JSON.stringify({ apiBase: input.apiBase, timeoutMs: 8000, providers: [{ provider: input.provider, config: input.config }] }));
  await writeFile(join(input.directory, '.secret'), input.secret);
  const child = spawn(process.execPath, [join(root, 'target/agent-host/runtime.mjs')], {
    cwd: input.directory, env: { SystemRoot: process.env.SystemRoot, WEBLABEL_HOST_CONFIG: configPath, WEBLABEL_RUN_TOKEN: input.token, T29_SYNTHETIC_KEY: input.secret }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let buffer = '';
  const messages: Record<string, unknown>[] = [];
  const closed = Promise.withResolvers<number | null>();
  const terminal = Promise.withResolvers<Record<string, unknown>>();
  child.once('error', error => terminal.reject(error));
  child.once('close', code => { closed.resolve(code); if (!messages.some(message => message.id === 't29-start')) terminal.reject(new Error(`Host exited before terminal response (${code}): ${stderr}`)); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk); buffer += String(chunk);
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = object(JSON.parse(line)); messages.push(message);
      if (message.id === 't29-start') terminal.resolve(object(message.payload));
    }
  });
  child.stdin.write(JSON.stringify({ protocol_version: 1, id: 't29-probe', kind: 'request', method: 'probe', payload: {} }) + '\n');
  child.stdin.write(JSON.stringify({ protocol_version: 1, id: 't29-start', kind: 'request', method: 'start_run', payload: {
    run_id: input.runId, request: input.request, profile: input.profile,
    execution_profile_config: input.config, profile_configuration_hash: 'T29-private-approved-snapshot',
  } }) + '\n');
  const timer = setTimeout(() => terminal.reject(new Error(`Host deadline exceeded: ${stderr}`)), 12_000);
  try {
    const result = await terminal.promise;
    child.stdin.end();
    const exitCode = await closed.promise;
    const shellExecuted = await access(join(input.directory, 'forbidden-shell-marker')).then(() => true, () => false);
    return { stdout, stderr, terminal: result, events: messages.filter(message => message.kind === 'event').map(message => object(message.payload)), exitCode, shellExecuted };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed.promise; }
  }
}
export function maliciousSse(tool: string, args: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'injected-call', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
}

/** Valid provider framing; both call metadata and usage reach actual parsers. */
export function toolSse(provider: SyntheticProviderId, name: string, id: string, args: unknown): string {
  const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  if (provider === 'openai_api') return frame({ type: 'response.output_item.added', item: { type: 'function_call', id: 'T29-item', call_id: id, name, arguments: JSON.stringify(args) } }) + frame({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 5 } } });
  if (provider === 'anthropic_api') return frame({ type: 'message_start', message: { usage: { input_tokens: 17 } } }) + frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } }) + frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } }) + frame({ type: 'message_delta', usage: { output_tokens: 5 } }) + frame({ type: 'message_stop' });
  return frame({ usage: { prompt_tokens: 17, completion_tokens: 5 }, choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
}
