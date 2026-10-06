import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const report = path.join(import.meta.dirname, 'producer');
const profile = JSON.parse(await readFile(path.join(report, 'actual-dense-100.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
const frames = new Map();
const classes = new Map();
function chain(id) { const frames = []; for (let current = id; current !== undefined; current = parents.get(current)) frames.push(nodes.get(current).callFrame); return frames; }
function classify(id) {
  const stack = chain(id);
  const self = stack[0];
  const has = (pattern) => stack.some(frame => pattern.test(`${frame.functionName} ${frame.url}`));
  if (has(/get_snapshot|editorfacade_get_snapshot/)) return 'full_native_snapshot_serialization';
  if (has(/frozenCopy/)) return 'JSON_roundtrip_frozenCopy';
  if (has(/freezeDeep/)) return 'recursive_deepFreeze';
  if (has(/get_commit_readback|editorfacade_get_commit_readback/)) return 'bounded_native_header_positions_readback';
  if (has(/IDBObjectStore\.put|IndexedDbDraftStorage\.put|store\.put/) || (self.functionName === 'put' && /draft-store/.test(self.url))) return 'actual_IDB_put_serialization_request';
  if (has(/addObjectDiffToProperties|updateFiberProps|diffProperties|setInitialProperties/) || /react.*devtools/i.test(self.url)) return 'React_DEV_prop_diff_or_devtools';
  if (/\(idle\)/.test(self.functionName)) return 'idle';
  if (/garbage collector/.test(self.functionName)) return 'garbage_collection';
  if (has(/updateMirror/)) return 'producer_mirror_update';
  return 'other';
}
for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index];
  const delta = profile.timeDeltas[index] / 1000;
  const frame = nodes.get(id).callFrame;
  const key = `${frame.functionName || '(anonymous)'} | ${frame.url}:${frame.lineNumber + 1}`;
  frames.set(key, (frames.get(key) ?? 0) + delta);
  const category = classify(id);
  classes.set(category, (classes.get(category) ?? 0) + delta);
}
const result = {
  method: 'CDP 100us sampling; exclusive self-time summed using timeDeltas by observed stack. All categories retained; no percentile, gate rerun or pass prediction. Sampling absence is not a zero-cost claim.',
  samples: profile.samples.length,
  observed_exclusive_time_ms_over_100_commits: Object.fromEntries([...classes.entries()].map(([name, value]) => [name, Math.round(value * 1000) / 1000])),
  top_frames: [...frames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([frame, ms]) => ({ frame, exclusive_ms: Math.round(ms * 1000) / 1000 })),
};
await writeFile(path.join(report, 'attribution.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
