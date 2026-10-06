import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { expect, test as fixtureTest } from './fixtures';
import { database_path_for_test, start_test_app } from '../support/app';
import type { AnnotationDocument } from '../../packages/contracts/generated/AnnotationDocument';
import type { SuggestionSet } from '../../packages/contracts/generated/SuggestionSet';

const origin = 'http://127.0.0.1:5173';
const test = fixtureTest.extend({
  app: async ({}, use) => {
    const app = await start_test_app('false', 'background');
    try { await use(app); } finally { await app.stop(); }
  },
});

test('T25 unavailable real-profile gate remains on the actual hardware WebGPU workbench', async ({ adminPage: page, seededProject, app }) => {
  const db = new DatabaseSync(database_path_for_test(app));
  try {
    db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('profile-unavailable-real','openai_api','unconfigured-model','api_key',?,'needs_configuration','not_run',NULL,NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({ image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: true }));
  } finally { db.close(); }
  const runPosts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/runs') runPosts.push(request.url()); });
  await page.reload();
  await page.getByTestId(`asset-item-${seededProject.assets[0].asset_revision_id}`).click();
  const gpu = page.getByTestId('gpu-status');
  await expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu', { timeout: 30_000 });
  await expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 30_000 });
  await expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
  await page.getByTestId('ai-prompt').fill('Real unavailable provider cannot use a mock fallback');
  await page.getByTestId('ai-run').click();
  await expect(page.getByTestId('ai-panel').getByRole('alert')).toBeVisible();
  expect(runPosts).toEqual([]);
});

test('T25 Engineering Mock G2: actual flush/freeze, consent, background prediction, accept/save and one native undo/save', async ({ adminPage: page, seededProject, app }, testInfo) => {
  test.setTimeout(90_000);
  const db = new DatabaseSync(database_path_for_test(app));
  try {
    db.prepare("INSERT INTO model_profiles(profile_id,provider_id,model_id,auth_kind,capabilities_json,availability,verification,runtime_version,verified_at,config_json,secret_ref,created_at) VALUES('profile_mock_local','mock','weblabel-mock-source-v1','none',?,'ready','mock_only','builtin-mock-1',NULL,'{}',NULL,'2026-10-06T00:00:00Z')").run(JSON.stringify({ image_input: true, tools: false, structured_output: true, bbox_output: true, attributes: true }));
  } finally { db.close(); }
  await page.reload();
  const asset = seededProject.assets.find(item => item.width === 320 && item.exif_orientation === 1)!;
  const head = async () => {
    const result = await seededProject.api.request<{ annotation_revision_id: string; document: AnnotationDocument }>('GET', `/api/assets/${asset.asset_revision_id}/annotation?ontology_version_id=${seededProject.ontology_version_id}`);
    expect(result.status).toBe(200);
    return result.json;
  };
  await page.getByTestId(`asset-item-${asset.asset_revision_id}`).click();
  const gpu = page.getByTestId('gpu-status');
  await expect(gpu).toHaveAttribute('data-actual-backend', 'webgpu', { timeout: 30_000 });
  await expect(gpu).toHaveAttribute('data-device-state', 'ready', { timeout: 30_000 });
  await expect(gpu).toHaveAttribute('data-adapter-kind', 'hardware');
  const canvas = await page.getByTestId('annotation-canvas').boundingBox();
  if (!canvas) throw new Error('No actual editor canvas');
  const scale = Math.min(canvas.width / asset.width, canvas.height / asset.height);
  const point = (x: number, y: number): [number, number] => [canvas.x + (canvas.width - asset.width * scale) / 2 + x * scale, canvas.y + (canvas.height - asset.height * scale) / 2 + y * scale];
  const saveRelease = Promise.withResolvers<void>();
  let saveHeld = false;
  let previewPosts = 0;
  await page.route(`**/api/assets/${asset.asset_revision_id}/annotation`, async route => {
    if (route.request().method() === 'PUT' && !saveHeld) { saveHeld = true; await saveRelease.promise; }
    await route.fallback();
  });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/previews') previewPosts += 1; });
  await page.getByTestId('tool-box').click();
  await page.mouse.move(...point(30, 40));
  await page.mouse.down();
  await page.mouse.move(...point(90, 110), { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(1);
  await page.getByLabel('Run intent').selectOption('detect');
  await page.getByTestId('ai-prompt').fill('Engineering Mock only: add synthetic candidate for G2, not real inference');
  const runPosts: unknown[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/runs') runPosts.push(request.postDataJSON()); });
  await expect.poll(() => saveHeld).toBe(true);
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/previews' && response.request().method() === 'POST');
  await page.getByTestId('ai-run').click();
  await expect(page.getByTestId('ai-run')).toBeDisabled();
  expect(previewPosts).toBe(0);
  expect(runPosts).toEqual([]);
  saveRelease.resolve();
  const previewHttp = await previewResponse;
  expect(previewHttp.status()).toBe(201);
  const preview = await previewHttp.json();
  const original = await head();
  expect(preview.request.context).toMatchObject({ asset_revision_id: asset.asset_revision_id, annotation_revision_id: original.annotation_revision_id, ontology_version_id: seededProject.ontology_version_id });
  const originalDocument = original.document;
  expect(originalDocument.objects).toHaveLength(1);
  expect(runPosts).toEqual([]);
  await expect(page.getByTestId('ai-consent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize and run now' })).toBeDisabled();
  await page.getByTestId('ai-consent').getByRole('checkbox').check();
  const queuedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/runs' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Authorize and run now' }).click();
  const queuedHttp = await queuedResponse;
  expect(queuedHttp.status()).toBe(202);
  const queued = await queuedHttp.json();
  expect(queued).toMatchObject({ source: 'mock', verification: 'mock_only' });
  const candidate = page.locator('[data-testid^="candidate-"]').filter({ has: page.getByRole('checkbox') });
  await expect(candidate).toHaveCount(1, { timeout: 20_000 });
  const suggestionsResponse = await seededProject.api.request<{ items: SuggestionSet[] }>('GET', `/api/ai/runs/${queued.run_id}/suggestions`);
  expect(suggestionsResponse.status).toBe(200);
  const suggestion = suggestionsResponse.json.items[0];
  const change = suggestion.changes[0];
  if (change.kind !== 'create') throw new Error('Engineering Mock detect must return a validated create candidate');
  expect(suggestion.context).toEqual(preview.request.context);
  expect(await head()).toEqual(original);
  const journal = () => {
    const database = new DatabaseSync(database_path_for_test(app));
    try { return database.prepare('SELECT decision, bound_revision_id, change_id FROM suggestion_decisions WHERE suggestion_set_id=? ORDER BY rowid').all(suggestion.suggestion_set_id); } finally { database.close(); }
  };
  expect(journal()).toEqual([]);
  await candidate.getByRole('checkbox').check();
  const acceptedSave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/annotation') && response.request().postDataJSON().suggestion_decisions?.some((decision: { decision: string }) => decision.decision === 'accept'));
  await page.getByTestId('accept-selected').click();
  const acceptedHttp = await acceptedSave;
  expect(acceptedHttp.status()).toBe(200);
  const accepted = await head();
  expect(accepted.annotation_revision_id).not.toBe(original.annotation_revision_id);
  const acceptedDocument = accepted.document;
  expect(acceptedDocument.objects).toEqual([...originalDocument.objects, change.object]);
  expect(journal()).toEqual([{ decision: 'accept', bound_revision_id: accepted.annotation_revision_id, change_id: suggestion.changes[0].change_id }]);
  await page.screenshot({ path: testInfo.outputPath('composed-accepted.png'), fullPage: true });
  const undoSave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/annotation') && response.request().postDataJSON().suggestion_decisions?.some((decision: { decision: string }) => decision.decision === 'revert'));
  await page.getByTestId('undo').click();
  const undoHttp = await undoSave;
  expect(undoHttp.status()).toBe(200);
  const undone = await head();
  expect(undone.annotation_revision_id).not.toBe(accepted.annotation_revision_id);
  expect(undone.document).toEqual(original.document);
  expect(journal()).toEqual([
    { decision: 'accept', bound_revision_id: accepted.annotation_revision_id, change_id: suggestion.changes[0].change_id },
    { decision: 'revert', bound_revision_id: undone.annotation_revision_id, change_id: suggestion.changes[0].change_id },
  ]);
  await page.screenshot({ path: testInfo.outputPath('composed-undone.png'), fullPage: true });
  const evidencePath = testInfo.outputPath('composed-http-revisions.json');
  await writeFile(evidencePath, JSON.stringify({ preview, queued, original, accepted, undone, journal: journal() }, null, 2));
  await testInfo.attach('composed-http-revisions.json', { path: evidencePath, contentType: 'application/json' });
  const other = seededProject.assets.find(item => item.asset_revision_id !== asset.asset_revision_id)!;
  const otherPath = `/api/assets/${other.asset_revision_id}/annotation?ontology_version_id=${seededProject.ontology_version_id}`;
  const otherBefore = await seededProject.api.request('GET', otherPath);
  const replyRelease = Promise.withResolvers<void>();
  let replyHeld = false;
  await page.route('**/api/ai/runs/*/suggestions*', async route => { replyHeld = true; await replyRelease.promise; await route.fallback(); });
  await page.getByTestId('ai-prompt').fill('Engineering Mock delayed result remains pinned to the original asset');
  await page.getByTestId('ai-run').click();
  await page.getByTestId('ai-consent').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Authorize and run now' }).click();
  await expect.poll(() => replyHeld).toBe(true);
  await page.getByTestId(`asset-item-${other.asset_revision_id}`).click();
  await expect(page.getByTestId('object-list').getByRole('option')).toHaveCount(0);
  replyRelease.resolve();
  await expect(page.getByTestId('accept-selected')).toHaveCount(2);
  for (const button of await page.getByTestId('accept-selected').all()) await expect(button).toBeDisabled();
  expect((await seededProject.api.request('GET', otherPath)).json).toEqual(otherBefore.json);
  expect(await head()).toEqual(undone);
});
