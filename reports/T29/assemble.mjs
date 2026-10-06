import { readFile, writeFile } from 'node:fs/promises';
const records = JSON.parse(await readFile('reports/T29/commands.json', 'utf8'));
const sections = [];
for (const record of records) {
  const log = await readFile(record.log_path, 'utf8');
  const counts = [...log.matchAll(/^\s*Tests\s+([^\r\n]+)\s+\(\d+\)/gm)];
  for (const [field, kind] of [['tests_passed', 'passed'], ['tests_failed', 'failed'], ['tests_filtered', 'skipped']]) record[field] = counts.length ? counts.reduce((sum, match) => sum + Number(match[1].match(new RegExp(`(\\d+)\\s+${kind}`))?.[1] ?? 0), 0) : null;
  sections.push(`===== ${record.log_path} =====\n${log}`);
}
const final = records.find(record => record.log_path === 'reports/T29/registered-standard-final.log');
const scan = JSON.parse(await readFile('reports/T29/production-scan.json', 'utf8'));
if (final?.exit_code !== 0 || final.tests_passed !== 42 || final.tests_failed !== 0 || final.tests_filtered !== 0) throw new Error('Final unfiltered T29 gate is not 42/42');
if (scan.status !== 'passed' || scan.files.length !== 13 || scan.sourcemaps !== 3) throw new Error('Actual final product scan evidence is incomplete');
await writeFile('reports/T29/commands.json', JSON.stringify(records, null, 2) + '\n');
await writeFile('reports/T29/tests.log', 'T29 complete historical command output\nFinal authority: registered-standard-final.log 42/42, zero failures/filters and no manual RUSTC; production-toolchain-final.log actual final source products.\nEarlier environment/fixture failures and pre-fix Reds remain historical evidence, not final results.\nNon-test commands have no fabricated test counts. Main-imported logs in the baseline are separate provenance, not writer executions.\n\n' + sections.join('\n\n') + '\n');
const result = JSON.parse(await readFile('reports/T29/result.json', 'utf8'));
result.verification_source_commit = scan.source_commit;
result.artifact_ref.owned_source_commits = [...new Set([...result.artifact_ref.owned_source_commits, '50ef819201df7b094cf100703273b5741942ae5a'])];
for (const command of result.commands) {
  if (command.command === 'pnpm test:task T29') command.log = 'reports/T29/registered-standard-final.log';
  if (command.command.startsWith('pnpm --filter')) command.log = 'reports/T29/types-toolchain-final.log';
  if (command.command.startsWith('node tests/fixtures')) command.log = 'reports/T29/production-toolchain-final.log';
  if (command.command === 'node reports/T29/assemble.mjs') {
    command.recorded_writer_verification_commands = records.length;
    command.output = `Assembled ${records.length} complete writer command logs; final 42/42 and 13 products / 3 maps.`;
  }
}
result.environment.toolchain = scan.toolchain;
result.known_limits.push('Standard final run has no manual RUSTC/RUSTUP_TOOLCHAIN. Only the private C: checkout retains a fresh API_BINARY override to bypass unrelated global prepare-api ancestor Cargo configuration; the actual fixture recompiles and links the repository-pinned library. Root D: standard entry is re-run by Main.');
result.changed_files = [...new Set([...result.changed_files.filter(path => path !== 'reports/T29/*.log'), ...records.map(record => record.log_path), 'reports/T29/release-smoke.log'])];
await writeFile('reports/T29/result.json', JSON.stringify(result, null, 2) + '\n');
console.log(`Assembled ${records.length} complete writer command logs; final 42/42 and ${scan.files.length} products / ${scan.sourcemaps} maps.`);
