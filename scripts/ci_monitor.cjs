#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const help = "Usage: node scripts/ci_monitor.cjs <command>\n  runs [--branch main] [--commit SHA]\n  watch RUN_ID\n  log-failed RUN_ID\n  test-summary RUN_ID\n  dispatch WORKFLOW --ref main [-f key=value]\n  download RUN_ID --dir DIRECTORY\n  release [gh release flags]\n  api ENDPOINT [gh api flags]\n  api-status ENDPOINT\n  check-actions WORKFLOW_FILE\nOfficial gh CLI is invoked without a shell. No account tokens are read or printed.";
function gh(args, capture = false) {
  const result = spawnSync('gh', args, { shell: false, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (capture) process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }
  return capture ? result.stdout : '';
}
const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'lona-cn/weblabel';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid repository');
const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help') { console.log(help); process.exit(0); }
switch (command) {
  case 'runs': gh(['run', 'list', '--repo', repository, '--limit', '20', '--json', 'databaseId,headSha,workflowName,status,conclusion,url,event', ...args]); break;
  case 'watch': if (!/^\d+$/.test(args[0] || '')) throw Error('run ID required'); gh(['run', 'watch', args[0], '--repo', repository, '--exit-status']); break;
  case 'log-failed': gh(['run', 'view', args[0], '--repo', repository, '--log-failed']); break;
  case 'test-summary': gh(['run', 'view', args[0], '--repo', repository, '--json', 'jobs,status,conclusion,url,headSha']); break;
  case 'dispatch': gh(['workflow', 'run', ...args, '--repo', repository]); break;
  case 'download': gh(['run', 'download', ...args, '--repo', repository]); break;
  case 'release': gh(['release', ...args, '--repo', repository]); break;
  case 'api': gh(['api', ...args]); break;
  case 'api-status': {
    if (args.length !== 1) throw Error('one API endpoint required');
    const result = spawnSync('gh', ['api', args[0], '--include', '--silent'], { shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    const match = result.stdout.match(/^HTTP\/\S+\s+(\d{3})\b/m);
    if (!match) throw Error('GitHub API did not return an HTTP status: ' + (result.stderr || result.status));
    const status = Number(match[1]);
    if ((result.status === 0) !== (status < 400)) throw Error('GitHub API transport failed: ' + (result.stderr || result.status));
    console.log(JSON.stringify({ status }));
    break;
  }
  case 'check-actions': {
    const filename = args[0];
    if (!filename) throw Error('workflow filename required');
    const source = fs.readFileSync(path.resolve(filename), 'utf8');
    const references = [...source.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([^\s#]+)(?:\s*#\s*(v[\w.-]+))?/g)];
    if (!references.length) throw Error('No external action references');
    for (const [, repository, revision, tag] of references) {
      if (!/^[0-9a-f]{40}$/.test(revision) || !tag) throw Error('Action must use immutable SHA and version comment: ' + repository);
      const data = JSON.parse(gh(['api', 'repos/' + repository + '/commits/' + tag], true));
      if (data.sha !== revision) throw Error('Official action tag/SHA mismatch: ' + repository + '@' + tag);
      console.log(JSON.stringify({ repository, tag, sha: revision, verified: true }));
    }
    break;
  }
  default: throw Error('Unknown command: ' + command);
}
