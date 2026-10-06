import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
const ledger=(await readFile(path.join(directory,'commands.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const commands=[];const output=[];
for(const record of ledger){
  const text=await readFile(path.resolve(root,record.log_path),'utf8');
  const clean=text.replace(/\u001b\[[0-9;]*m/g,'');
  let counts={passed:0,failed:0,skipped:0};let collected=null;
  const vitest=[...clean.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1);
  if(vitest){for(const match of vitest[1].matchAll(/(\d+)\s+(passed|failed|skipped)/g))counts[match[2]]=Number(match[1]);collected=counts.passed+counts.failed+counts.skipped;}
  else if(record.mode==='browser'){for(const match of clean.matchAll(/^\s*(\d+)\s+(passed|failed|skipped)(?:\s|$)/gm))counts[match[2]]=Number(match[1]);collected=counts.passed+counts.failed+counts.skipped;}
  commands.push({...record,test_counts:counts,collected,filtered:record.argv.includes('-t')||record.argv.includes('--grep'),counts_source:collected===null?'not a test invocation or collection did not complete':'actual terminal summary'});
  output.push(`\n===== ${record.mode} | exit ${record.exit_code} | ${record.log_path} =====\n${text}`);
}
await writeFile(path.join(directory,'command-summary.json'),JSON.stringify(commands,null,2));
await writeFile(path.join(directory,'tests.log'),output.join('\n'));
console.log(JSON.stringify({records:commands.length,full_logs:'reports/T30/tests.log',summary:'reports/T30/command-summary.json'},null,2));
