// Engineering process-lifecycle fixture, NOT a provider/model implementation.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const config = JSON.parse(fs.readFileSync(process.env.WEBLABEL_HOST_CONFIG, 'utf8'));
const record = (name, value) => fs.writeFileSync(`${config.marker}.${name}.json`, JSON.stringify(value));
process.on('SIGINT', () => record('root-sigint', { pid: process.pid, ignored: true, at: Date.now() }));
const keepAlive = setInterval(() => {}, 1000);
let started = false;
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'probe') {
    process.stdout.write(JSON.stringify({ ...request, kind: 'response', payload: { ok: true } }) + '\n');
    return;
  }
  if (request.method !== 'start_run' || started) throw new Error('fixture expects one authorized start');
  started = true;
  const api = new URL(config.apiBase);
  if (api.hostname !== '127.0.0.1') throw new Error('owned loopback only');
  const response = await fetch(`${api.origin}/internal/agent-tools/get_context`, { method: 'POST', headers: { authorization: `Bearer ${process.env.WEBLABEL_RUN_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
  const context = await response.json();
  if (response.status !== 200) throw new Error('actual run grant rejected: ' + JSON.stringify(context));
  const code = `const fs=require('node:fs');process.on('SIGINT',()=>fs.writeFileSync(${JSON.stringify(config.marker + '.desc-sigint.json')},JSON.stringify({pid:process.pid,ignored:true})));require('node:http').createServer((q,r)=>r.end('T33-owned-stubborn-descendant')).listen(0,'127.0.0.1',function(){console.log(JSON.stringify({pid:process.pid,port:this.address().port}));});`;
  // Detached from the PTY's console group; an OS tree reclaim must kill it.
  const child = spawn(process.execPath, ['-e', code], { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.once('data', bytes => {
    const leaf = JSON.parse(String(bytes));
    record('started', { fixture_kind: 'synthetic_controlled_ndjson_host_no_inference', root_pid: process.pid, descendant_pid: leaf.pid, port: leaf.port, run_id: request.payload.run_id, request: request.payload.request, profile: request.payload.profile, execution_profile_config: request.payload.execution_profile_config, profile_configuration_hash: request.payload.profile_configuration_hash, actual_run_token_context_status: response.status, actual_run_token_context: context, descendant_detached: true, root_ignores_ctrl_c: true, descendant_ignores_ctrl_c: true });
    process.stdout.write(JSON.stringify({ protocol_version: 1, id: 't33-active-marker', kind: 'event', method: 'run_event', payload: { run_id: request.payload.run_id, seq: 1, type: 'progress', message: 'Engineering lifecycle fixture active; no inference', data: { fixture_kind: 'synthetic_controlled_ndjson_host_no_inference' } } }) + '\n');
  });
  child.stderr.on('data', bytes => process.stderr.write(bytes));
});
// Intentionally no terminal response: the real worker must be interrupted mid-run.
void keepAlive;
