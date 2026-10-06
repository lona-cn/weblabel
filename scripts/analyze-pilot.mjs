import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

export const ARMS = ['human_only', 'current_tool_same_AI', 'this_tool_same_AI'];
const HUMAN_KINDS = ['task', 'annotation', 'correction', 'review', 'switch'];
const KINDS = [...HUMAN_KINDS, 'model_wait'];
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function ids(value, field) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id || id.length > 128) || new Set(value).size !== value.length) throw new Error(`Invalid ${field}`);
  return value;
}

export function analyzePilot(input) {
  if (input?.schema_version !== 1 || !Array.isArray(input.samples)) throw new Error('Expected schema_version 1 and samples');
  const unique = new Set();
  const records = input.samples.map((sample) => {
    if (!ARMS.includes(sample.arm) || typeof sample.synthetic !== 'boolean' || typeof sample.sample_id !== 'string' || !sample.sample_id || !['image', 'object', 'task'].includes(sample.sample_unit)) throw new Error('Invalid arm/sample identity');
    const key = `${sample.arm}:${sample.sample_id}`;
    if (unique.has(key)) throw new Error('Duplicate arm/sample');
    unique.add(key);
    for (const field of ['image_id', 'task_id', 'seed', 'auditor', 'quality_method']) if (typeof sample[field] !== 'string' || !sample[field]) throw new Error(`Missing ${field}`);
    if (!/^[a-f0-9]{64}$/.test(sample.image_sha256)) throw new Error('Invalid image_sha256');
    if (sample.arm === 'human_only' ? sample.ai_configuration !== null : typeof sample.ai_configuration !== 'string' || !sample.ai_configuration) throw new Error('AI arm needs fixed configuration, human_only needs null');
    for (const kind of KINDS) if (!integer(sample.durations_ms?.[kind])) throw new Error(`Invalid duration ${kind}`);
    const gt = ids(sample.ground_truth_object_ids, 'ground_truth_object_ids');
    const final = ids(sample.final_ground_truth_object_ids, 'final_ground_truth_object_ids');
    const proposed = sample.ai_proposed_ground_truth_object_ids === null ? null : ids(sample.ai_proposed_ground_truth_object_ids, 'ai_proposed_ground_truth_object_ids');
    if (final.some((id) => !gt.includes(id)) || proposed?.some((id) => !gt.includes(id))) throw new Error('Ground truth matches must reference GT inventory');
    if (sample.arm === 'human_only' ? proposed !== null : proposed === null) throw new Error('AI proposal inventory must be explicit in AI arms');
    for (const field of ['wrong_objects', 'wrong_labels', 'wrong_attributes', 'returned_tasks', 'reviewed_tasks']) if (sample[field] !== null && !integer(sample[field])) throw new Error(`Invalid ${field}`);
    if ((sample.returned_tasks === null) !== (sample.reviewed_tasks === null) || (sample.returned_tasks !== null && sample.returned_tasks > sample.reviewed_tasks)) throw new Error('Invalid return denominator');
    if (sample.fees_usd !== null && (typeof sample.fees_usd !== 'number' || !Number.isFinite(sample.fees_usd) || sample.fees_usd < 0)) throw new Error('Invalid fees_usd');
    const missed = gt.filter((id) => !final.includes(id));
    return { ...sample, human_total_ms: HUMAN_KINDS.reduce((sum, kind) => sum + sample.durations_ms[kind], 0), missed_objects: missed.length, missed_object_ids: missed, ai_never_proposed_gt: proposed === null ? null : gt.filter((id) => !proposed.includes(id)).length };
  });
  const sums = (rows, field) => rows.length && rows.every((row) => row[field] !== null) ? rows.reduce((sum, row) => sum + row[field], 0) : null;
  const arms = Object.fromEntries(ARMS.map((arm) => {
    const rows = records.filter((row) => row.arm === arm);
    const reviewed = sums(rows, 'reviewed_tasks');
    const returned = sums(rows, 'returned_tasks');
    return [arm, {
      samples: rows.length, sample_units: [...new Set(rows.map((row) => row.sample_unit))], image_count: new Set(rows.map((row) => row.image_id)).size,
      object_count: rows.reduce((sum, row) => sum + row.ground_truth_object_ids.length, 0), task_count: new Set(rows.map((row) => row.task_id)).size,
      seeds: [...new Set(rows.map((row) => row.seed))], auditors: [...new Set(rows.map((row) => row.auditor))], quality_methods: [...new Set(rows.map((row) => row.quality_method))], ai_configurations: [...new Set(rows.map((row) => row.ai_configuration))],
      durations_ms: Object.fromEntries(KINDS.map((kind) => [kind, rows.reduce((sum, row) => sum + row.durations_ms[kind], 0)])),
      human_total_ms: rows.reduce((sum, row) => sum + row.human_total_ms, 0), missed_objects: rows.reduce((sum, row) => sum + row.missed_objects, 0),
      ai_never_proposed_gt: sums(rows, 'ai_never_proposed_gt'), wrong_objects: sums(rows, 'wrong_objects'), wrong_labels: sums(rows, 'wrong_labels'), wrong_attributes: sums(rows, 'wrong_attributes'),
      returned_tasks: returned, reviewed_tasks: reviewed, return_rate: reviewed ? returned / reviewed : null, fees_usd: sums(rows, 'fees_usd'),
    }];
  }));
  const configurations = records.filter((row) => row.arm !== 'human_only').map((row) => row.ai_configuration);
  if (new Set(configurations).size > 1) throw new Error('AI control arms must use the same fixed AI configuration');
  for (const id of new Set(records.map((row) => row.sample_id))) {
    const paired = records.filter((row) => row.sample_id === id);
    if (new Set(paired.map((row) => `${row.image_sha256}:${row.seed}:${row.sample_unit}:${JSON.stringify(row.ground_truth_object_ids)}`)).size > 1) throw new Error('Paired sample inventory differs');
  }
  return { schema_version: 1, status: records.length ? 'descriptive_only' : 'noData', evidence_kind: records.length && records.every((row) => row.synthetic) ? 'SYNTHETIC_FORMAT_DEMO' : records.some((row) => row.synthetic) ? 'mixed_not_a_trial' : records.length ? 'operator_supplied_unverified' : 'no_data', goal_human_time_reduction: 0.30, roi: null, conclusion: null, arms, records };
}

export function reportCsv(report) {
  const fields = ['arm', 'status', 'evidence_kind', 'samples', 'sample_units', 'image_count', 'object_count', 'task_count', 'seeds', 'auditors', 'quality_methods', 'human_total_ms', ...KINDS.map((kind) => `${kind}_ms`), 'missed_objects', 'ai_never_proposed_gt', 'wrong_objects', 'wrong_labels', 'wrong_attributes', 'returned_tasks', 'reviewed_tasks', 'return_rate', 'fees_usd', 'goal_human_time_reduction', 'roi'];
  const cell = (value) => {
    let text = value === null ? 'null' : Array.isArray(value) ? JSON.stringify(value) : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `${fields.join(',')}\n${ARMS.map((arm) => {
    const metrics = report.arms[arm];
    const row = { ...metrics, arm, status: report.status, evidence_kind: report.evidence_kind, ...Object.fromEntries(KINDS.map((kind) => [`${kind}_ms`, metrics.durations_ms[kind]])), goal_human_time_reduction: report.goal_human_time_reduction, roi: null };
    return fields.map((field) => cell(row[field])).join(',');
  }).join('\n')}\n`;
}

export async function generateDemo(directory) {
  await mkdir(directory, { recursive: true });
  const images = [], samples = [];
  const seed = 'T34-public-synthetic-20261006';
  for (let index = 0; index < 20; index++) {
    const width = 160, height = 120, count = 2 + index % 4;
    const gt = Array.from({ length: count }, (_, object) => ({ object_id: `gt-${index}-${object}`, label: 'synthetic_rectangle', bbox_xyxy: [8 + object * 35, 10 + index % 10, 28 + object * 35, 35 + index % 10] }));
    const rgba = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) { rgba[pixel * 4] = 220; rgba[pixel * 4 + 1] = 230; rgba[pixel * 4 + 2] = 240; rgba[pixel * 4 + 3] = 255; }
    for (const [object, item] of gt.entries()) for (let y = item.bbox_xyxy[1]; y < item.bbox_xyxy[3]; y++) for (let x = item.bbox_xyxy[0]; x < item.bbox_xyxy[2]; x++) {
      const offset = (y * width + x) * 4; rgba[offset] = 20 + index * 7; rgba[offset + 1] = 40 + object * 40; rgba[offset + 2] = 100;
    }
    const image_id = `SYNTHETIC-image-${String(index + 1).padStart(2, '0')}`, path = `${image_id}.png`;
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    await writeFile(join(directory, path), png);
    const image_sha256 = createHash('sha256').update(png).digest('hex');
    images.push({ image_id, path, image_sha256, seed, synthetic: true, width, height, ground_truth: gt });
    for (const [armIndex, arm] of ARMS.entries()) samples.push({ sample_id: image_id, sample_unit: 'image', image_id, image_sha256, task_id: `synthetic-task-${index}`, seed, synthetic: true, auditor: 'programmatic_synthetic_inventory', quality_method: 'exact_synthetic_ID_inventory_not_human_audit', arm, ai_configuration: armIndex ? 'SYNTHETIC_same_AI_no_model_called' : null,
      durations_ms: { task: 1000, annotation: 10000 + index * 10 - armIndex * 1000, correction: armIndex * 900, review: 2000, switch: 100, model_wait: armIndex ? 5000 : 0 },
      ground_truth_object_ids: gt.map((item) => item.object_id), final_ground_truth_object_ids: gt.slice(0, count - (index % 7 === 0 ? 1 : 0)).map((item) => item.object_id), ai_proposed_ground_truth_object_ids: armIndex ? gt.slice(0, count - 1).map((item) => item.object_id) : null,
      wrong_objects: 0, wrong_labels: index % 11 === 0 ? 1 : 0, wrong_attributes: 0, returned_tasks: index % 7 === 0 ? 1 : 0, reviewed_tasks: 1, fees_usd: null });
  }
  const input = { schema_version: 1, samples };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ evidence_kind: 'SYNTHETIC_FORMAT_DEMO', seed, images }, null, 2)}\n`);
  await writeFile(join(directory, 'samples.json'), `${JSON.stringify(input, null, 2)}\n`);
  return input;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--empty') options.empty = true;
    else if (['--input', '--demo', '--format', '--out'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) options[key.slice(2)] = args[++index];
    else throw new Error('Usage: node scripts/analyze-pilot.mjs (--empty | --input FILE | --demo DIRECTORY) [--format json|csv] [--out FILE]');
  }
  if ([options.empty, options.input, options.demo].filter(Boolean).length !== 1) throw new Error('Choose exactly one input mode');
  if (options.format && !['json', 'csv'].includes(options.format)) throw new Error('Format must be json or csv');
  const input = options.demo ? await generateDemo(resolve(options.demo)) : options.input ? JSON.parse(await readFile(resolve(options.input), 'utf8')) : { schema_version: 1, samples: [] };
  const report = analyzePilot(input);
  const output = options.format === 'csv' ? reportCsv(report) : `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(resolve(options.out), output); else process.stdout.write(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
