import assert from 'node:assert/strict';
import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_ROOT = 'D:/workspace/src/weblabel';
export async function rootPath(value, { createDirectory = false } = {}) {
  assert.equal(typeof value, 'string', 'A supplied absolute Root-owned path is required');
  assert(path.isAbsolute(value), 'Paths must be absolute');
  const root = await realpath(SOURCE_ROOT);
  const candidate = path.resolve(value);
  const inside = actual => {
    const relative = path.relative(root, actual);
    assert(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Path must be physically inside the immutable source Root: ' + value);
  };
  inside(candidate);
  let ancestor = candidate;
  for (;;) {
    try { inside(await realpath(ancestor)); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
      if (ancestor === root) break;
    }
  }
  if (createDirectory) {
    await mkdir(candidate, { recursive: true });
    inside(await realpath(candidate));
  }
  return candidate;
}

export async function prepareScaleEnvironment(evidenceDir) {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Node 24 is required');
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) await rootPath(process.env[key]);
  await rootPath(tmpdir());
  return rootPath(evidenceDir, { createDirectory: true });
}

export async function seedFormalFixture({ base_url, admin }, count = 1301) {
  assert(Number.isInteger(count) && count >= 1024, 'Formal fixture count must be at least 1024');
  await rootPath(tmpdir());
  const helper = await rootPath(path.join(SOURCE_ROOT, 'tests/support/dataset-delivery.ts'));
  const { createDeliveryFixture } = await import(pathToFileURL(helper).href);
  return createDeliveryFixture({ base_url, admin }, count, 4);
}

export function fixtureEvidence(fixture) {
  return { project_id: fixture.projectId, ontology_id: fixture.ontologyId, ontology: fixture.ontology,
    actor_ids: { annotator: fixture.annotatorId, reviewer: fixture.reviewerId }, count: fixture.assets.length };
}

export async function runFormalScales({ base_url, admin, fixture, count = 1301, evidenceDir }) {
  const directory = await prepareScaleEnvironment(evidenceDir);
  const helperPath = await rootPath(path.join(SOURCE_ROOT, 'tests/support/dataset-delivery.ts'));
  const { freezeDelivery, mutateDeliveryHead, exportAndVerifyDelivery } = await import(pathToFileURL(helperPath).href);
  const activeFixture = fixture ?? await seedFormalFixture({ base_url, admin }, count);
  assert(activeFixture.assets.length >= 1024, 'Fixture must contain both scales');
  const frozen513 = await freezeDelivery(activeFixture, Array.from({ length: 513 }, (_, i) => i));
  const frozen1024 = await freezeDelivery(activeFixture, Array.from({ length: 1024 }, (_, i) => i));
  const original = activeFixture.assets[1];
  const laterId = await mutateDeliveryHead(activeFixture, 1);
  const report = { origin: base_url, ...fixtureEvidence(activeFixture),
    mutation: { index: 1, asset_id: original.media.asset_revision_id, frozen_revision_id: original.revision.annotation_revision_id, later_revision_id: laterId },
    snapshots: [frozen513, frozen1024].map(frozen => ({ count: frozen.expected.length, dataset_id: frozen.datasetId, snapshot_hash: frozen.snapshotHash,
      stable_origins: frozen.expected.map(item => ({ asset_id: item.media.asset_revision_id, annotation_revision_id: item.revision.annotation_revision_id,
        object_origins: item.revision.document.objects.map(object => ({ object_id: object.object_id, origin: object.origin })) })) })), receipts: [] };
  const reportPath = await rootPath(path.join(directory, 'formal-scale-results.json'));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const frozen of [frozen513, frozen1024]) {
    for (const format of ['native', 'yolo', 'coco']) {
      const receipt = await exportAndVerifyDelivery(frozen, format);
      report.receipts.push({ scale: frozen.expected.length, ...receipt });
      await rootPath(reportPath);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  return report;
}
