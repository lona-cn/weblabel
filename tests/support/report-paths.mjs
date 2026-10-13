import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const defaultRoot = path.join(projectRoot, 'target/test-artifacts', `${process.pid}-${randomUUID()}`);

// Resolve existing ancestors before creating anything: junctions cannot redirect output.
export function projectOutputPath(candidate) {
  const absolute = path.resolve(projectRoot, candidate);
  let ancestor = absolute;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('OUTPUT_ROOT_UNRESOLVABLE');
    ancestor = parent;
  }
  const actual = path.join(fs.realpathSync(ancestor), ...suffix);
  const relative = path.relative(projectRoot, actual);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('OUTPUT_OUTSIDE_PROJECT');
  }
  return actual;
}

export function ownedReportRoot(candidate) {
  const output = projectOutputPath(candidate);
  const relative = path.relative(projectRoot, output).replaceAll('\\', '/');
  if (/^reports\/T\d{2}$/.test(relative) || ['reports/T33/active-host-shutdown', 'reports/T32/interactive-closure', 'reports/T32/programmatic-inputs'].some(old => relative === old || relative.startsWith(old + '/'))) throw new Error('HISTORICAL_REPORT_ROOT_REFUSED');
  const marker = '.weblabel-evidence-root.json';
  let ancestor = output;
  let owned = false;
  while (ancestor !== projectRoot) {
    const file = path.join(ancestor, marker);
    if (fs.existsSync(file)) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      owned = value.schema_version === 1 && value.evidence_kind === 'owned_verification_output_root' && path.resolve(projectRoot, value.root) === ancestor;
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  if (!owned && fs.existsSync(output) && fs.readdirSync(output).length !== 0) throw new Error('EXISTING_UNOWNED_OUTPUT_REFUSED');
  fs.mkdirSync(output, { recursive: true });
  if (!owned) fs.writeFileSync(path.join(output, marker), JSON.stringify({ schema_version: 1, evidence_kind: 'owned_verification_output_root', root: relative, run_id: randomUUID() }), { flag: 'wx' });
  return output;
}

export function taskReportPath(taskId, ...segments) {
  if (!/^T\d{2}$/.test(taskId)) throw new Error('INVALID_TASK_REPORT_ID');
  const base = ownedReportRoot(process.env.WEBLABEL_TEST_REPORT_DIR ?? defaultRoot);
  const taskRoot = path.join(base, taskId);
  const output = projectOutputPath(path.join(taskRoot, ...segments));
  const relative = path.relative(taskRoot, output);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('OUTPUT_OUTSIDE_TASK');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return output;
}
