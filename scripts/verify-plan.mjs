import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPack } from '../tools/check-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = checkPack(root);
if (process.argv.includes('--provider-evidence')) {
  const at = process.argv.indexOf('--provider-evidence');
  const evidencePath = process.argv[at + 1];
  if (!evidencePath || !fs.existsSync(path.resolve(root, evidencePath))) {
    result.ok = false;
    result.errors.push(`missing provider evidence: ${evidencePath ?? '<path required>'}`);
  }
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
