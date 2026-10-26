// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetAnnotationHead } from '../../../../../packages/contracts/generated/AssetAnnotationHead';
import type { SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api, ApiFailure } from '../../lib/t15/api';
import { mountDatasetsPage, type DatasetsPageContext } from './datasets-page';
import { eligible, readArtifact, ZIP_CAP } from './delivery-protocol';
let serial = 0; const owners: AbortController[] = [];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => { owners.splice(0).forEach(owner => owner.abort()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(total = 3, size = 2) {
  vi.stubGlobal('crypto', webcrypto); const project = `native-datasets-${++serial}`, ontologyId = uuid(4), snapshotId = uuid(5), jobId = uuid(6), digest = 'a'.repeat(64);
  const rows: AssetAnnotationHead[] = Array.from({ length: total }, (_, index) => ({ media: { project_id: project, asset_id: uuid(1000 + index), asset_revision_id: uuid(2000 + index), original_name: `image-${index}.png`, original_sha256: digest, canonical_sha256: digest, canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: uuid(10) }, head: { ontology_version_id: ontologyId, annotation_revision_id: uuid(3000 + index), revision_no: 1, content_hash: digest, completion: 'complete', object_count: 1, approved_review_id: uuid(4000 + index) } }));
  const session = { user_id: 'actor', username: 'actor', platform_admin: false, project_roles: [{ project_id: project, role: 'admin' }] };
  const authListeners = new Set<() => void>();
  const controller: SessionController = { getSnapshot: () => ({ kind: 'authenticated', session, createdUsername: null }), subscribe: listener => { authListeners.add(listener); return () => authListeners.delete(listener); }, login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [{ project_id: project, ontology_version_id: ontologyId, version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }], next_cursor: null });
  const heads = vi.spyOn(api, 'projectAnnotationHeads').mockImplementation(async (_project, _ontology, cursor) => { const offset = Number(cursor ?? 0); return { items: rows.slice(offset, offset + size), next_cursor: offset + size < total ? String(offset + size) : null }; });
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let intercept: ((path: string, body: Record<string, unknown>) => unknown) | null = null;
  const request = vi.spyOn(api, 'request').mockImplementation(async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; writes.push({ path, body });
    if (intercept) return await intercept(path, body) as T;
    return (path.endsWith('/dataset-versions') ? { dataset_version_id: uuid(500 + writes.length), manifest_sha256: digest } : { job_id: jobId, format: body.format, state: 'queued', loss_report: { losses: [] } }) as T;
  });
  const owner = new AbortController(); owners.push(owner); const root = document.createElement('div'); document.body.append(root); const onWorkbench = vi.fn();
  const context: DatasetsPageContext = { session: controller, signal: owner.signal, navigate: vi.fn(), route: readRoute(new URL('http://localhost')), projectId: project, onWorkbench };
  const dispose = mountDatasetsPage(root, context);
  return { root, owner, rows, ontologyId, snapshotId, jobId, digest, heads, request, writes, dispose, remount() { return mountDatasetsPage(root, context); }, revoke() { session.project_roles = []; authListeners.forEach(listener => listener()); }, intercept(handler: (path: string, body: Record<string, unknown>) => unknown) { intercept = handler; } };
}
function button(root: HTMLElement, name: string) { const node = [...root.querySelectorAll('button')].find(button => button.textContent === name); if (!node) throw new Error(`Missing ${name}`); return node; }
function testId<T extends HTMLElement>(root: HTMLElement, id: string): T { const node = root.querySelector(`[data-testid="${id}"]`); if (!node) throw new Error(`Missing testid ${id}`); return node as T; }
function select(input: HTMLSelectElement, value: string) { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }
async function browse(view: { root: HTMLElement; ontologyId: string }) {
  await vi.waitFor(() => expect(testId<HTMLSelectElement>(view.root, 'dataset-ontology').options.length).toBe(2)); select(testId(view.root, 'dataset-ontology'), view.ontologyId); button(view.root, '读取图片范围').click();
  await vi.waitFor(() => expect(view.root.querySelector('[data-testid^=dataset-disposition-]')).not.toBeNull());
}
it('requires explicit ontology and include/exclude choices, never adding unbrowsed assets', async () => {
  const view = fixture(); expect(view.heads).not.toHaveBeenCalled(); await browse(view);
  select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); select(testId(view.root, `dataset-disposition-${view.rows[1].media.asset_revision_id}`), 'exclude');
  const freeze = testId<HTMLButtonElement>(view.root, 'snapshot-create'); freeze.click(); expect(view.writes).toHaveLength(0); expect(view.root.querySelector('[aria-label=本批完整固定范围]')).not.toBeNull(); freeze.click();
  await vi.waitFor(() => expect(view.writes).toHaveLength(1)); const body = view.writes[0].body;
  expect(body.items).toEqual([{ asset_revision_id: view.rows[0].media.asset_revision_id, annotation_revision_id: view.rows[0].head!.annotation_revision_id, split: 'train' }]); expect(body.excluded).toEqual([{ asset_revision_id: view.rows[1].media.asset_revision_id, reason: 'user_excluded' }]);
  expect(JSON.stringify(body)).not.toContain(view.rows[2].media.asset_revision_id); expect(testId<HTMLSelectElement>(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`).disabled).toBe(true);
});
it('keeps source groups in the same split when members are explicitly included on later pages', async () => {
  const view = fixture(); await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); select(testId(view.root, `dataset-split-${view.rows[0].media.asset_revision_id}`), 'val');
  button(view.root, '下一页').click(); await vi.waitFor(() => expect(view.root.textContent).toContain('image-2.png')); select(testId(view.root, `dataset-disposition-${view.rows[2].media.asset_revision_id}`), 'include');
  expect(testId<HTMLSelectElement>(view.root, `dataset-split-${view.rows[2].media.asset_revision_id}`).value).toBe('val');
  testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); await vi.waitFor(() => expect(view.writes).toHaveLength(1));
  expect((view.writes[0].body.items as { split: string }[]).map(item => item.split)).toEqual(['val', 'val']);
});
it('retains unknown snapshot operation and only reads on reconciliation', async () => {
  const view = fixture(); view.intercept(() => { throw new TypeError('ACK lost'); }); await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(button(view.root, '只读核对原请求')).toBeDefined()); const original = view.writes[0].body.operation_id; button(view.root, '只读核对原请求').click();
  await vi.waitFor(() => expect(view.heads).toHaveBeenCalledTimes(2)); expect(view.writes).toHaveLength(1); expect(view.root.textContent).toContain(String(original)); expect(testId<HTMLButtonElement>(view.root, 'snapshot-create').disabled).toBe(true);
});
it('freezes immutable revision identities before loss acknowledgement and export job creation', async () => {
  const view = fixture(); const loss = { losses: [{ field: 'attributes', reason: 'target has no attributes' }] };
  view.intercept((path, body) => { if (path.endsWith('/dataset-versions')) return { dataset_version_id: view.snapshotId, manifest_sha256: view.digest }; if (!body.loss_ack) throw new ApiFailure(422, 'LOSS_ACK_REQUIRED', 'loss', { loss_report: loss }, uuid(90)); return { job_id: view.jobId, format: body.format, state: 'queued', loss_report: loss }; });
  vi.spyOn(api, 'job').mockResolvedValue({ job_id: view.jobId, kind: 'dataset_export', state: 'failed', progress_completed: 0, progress_total: 1, result: { code: 'EXPORT_FAILED' } });
  await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); await vi.waitFor(() => expect(view.writes).toHaveLength(1));
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false));
  const frozen = JSON.stringify(view.writes[0].body); view.rows[0].head = { ...view.rows[0].head!, annotation_revision_id: uuid(9999), approved_review_id: null };
  select(testId(view.root, 'export-format'), 'yolo'); testId<HTMLButtonElement>(view.root, 'export-start').click(); await vi.waitFor(() => expect(view.root.textContent).toContain('target has no attributes'));
  expect(testId<HTMLButtonElement>(view.root, 'export-confirm').disabled).toBe(true); const ack = testId<HTMLInputElement>(view.root, 'export-loss-ack'); ack.checked = true; ack.dispatchEvent(new Event('change')); testId<HTMLButtonElement>(view.root, 'export-confirm').click();
  await vi.waitFor(() => expect(view.writes).toHaveLength(3)); expect(view.writes[2].path).toBe(`/api/dataset-versions/${view.snapshotId}/exports`); expect(view.writes[2].body.loss_ack).toBe(true); expect(JSON.stringify(view.writes[0].body)).toBe(frozen);
});
it('plans and freezes every selected item across 1024-item batches with no omissions or duplicates', async () => {
  const view = fixture(1025, 100); await browse(view);
  for (let page = 0; page < 11; page++) { button(view.root, '纳入本页').click(); if (page < 10) { button(view.root, '下一页').click(); await vi.waitFor(() => expect(view.heads).toHaveBeenCalledTimes(page + 2)); await vi.waitFor(() => expect(button(view.root, '纳入本页').disabled).toBe(false)); } }
  button(view.root, '预览整组划分与分批范围').click(); await vi.waitFor(() => expect(button(view.root, '确认整组划分').disabled).toBe(false)); button(view.root, '确认整组划分').click();
  testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false)); const firstRequest = JSON.stringify(view.writes[0]);
  button(view.root, '查看并导出此固定版本').click();
  const batches = [...view.root.querySelectorAll('label')].find(label => label.firstChild?.textContent === '当前交付批次')!.control as HTMLSelectElement; select(batches, '1');
  expect(testId<HTMLButtonElement>(view.root, 'snapshot-create').disabled).toBe(false);
  testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false));
  const items = view.writes.flatMap(write => write.body.items as { asset_revision_id: string; split: string }[]); expect(items).toHaveLength(1025); expect(new Set(items.map(item => item.asset_revision_id)).size).toBe(1025); expect(new Set(items.map(item => item.split)).size).toBe(1);
  for (const write of view.writes) expect((write.body.items as unknown[]).length).toBeGreaterThan(0); expect((view.writes[0].body.items as unknown[]).length).toBeLessThanOrEqual(1024); expect((view.writes[1].body.items as unknown[]).length).toBeLessThanOrEqual(1024);
  vi.spyOn(api, 'job').mockResolvedValue({ job_id: view.jobId, kind: 'dataset_export', state: 'failed', progress_completed: 0, progress_total: 1, result: { code: 'EXPORT_FAILED' } });
  testId<HTMLButtonElement>(view.root, 'export-start').click(); await vi.waitFor(() => expect(view.writes).toHaveLength(3));
  expect(view.writes[2].path).toBe(`/api/dataset-versions/${uuid(502)}/exports`); expect(JSON.stringify(view.writes[0])).toBe(firstRequest);
});
it('does not inherit approval on a new head and rejects oversized or mismatched ZIP artifacts', () => {
  const view = fixture(); expect(eligible(view.rows[0], view.ontologyId)).toBe(true); expect(eligible({ ...view.rows[0], head: { ...view.rows[0].head!, annotation_revision_id: uuid(9999), approved_review_id: null } }, view.ontologyId)).toBe(false);
  const artifact = { export_id: view.jobId, format: 'native', download_url: `/api/exports/${view.jobId}/download`, byte_size: ZIP_CAP + 1, object_sha256: view.digest, loss_report: { losses: [] } };
  expect(() => readArtifact(artifact, view.jobId, 'native')).toThrow('校验信息'); expect(() => readArtifact({ ...artifact, byte_size: 22, export_id: 'different-job' }, view.jobId, 'native')).toThrow('校验信息');
});
it('aborts a pending dataset page on permission revocation and ignores the late response', async () => {
  const view = fixture(); let signal: AbortSignal | undefined; let finish!: (page: { items: AssetAnnotationHead[]; next_cursor: null }) => void;
  view.heads.mockImplementation((_project, _ontology, _cursor, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  await vi.waitFor(() => expect(testId<HTMLSelectElement>(view.root, 'dataset-ontology').options.length).toBe(2)); select(testId(view.root, 'dataset-ontology'), view.ontologyId); button(view.root, '读取图片范围').click();
  expect(view.heads).toHaveBeenCalledTimes(1); view.revoke(); expect(signal?.aborted).toBe(true); finish({ items: view.rows, next_cursor: null }); await Promise.resolve(); await Promise.resolve();
  expect(view.root.querySelector('[data-testid^=dataset-row-]')).toBeNull(); expect(view.request).not.toHaveBeenCalled();
});
it('starts a new explicit delivery range after remount while retaining prior immutable snapshots and ready artifacts', async () => {
  const view = fixture(); const artifact = { export_id: view.jobId, format: 'native', download_url: `/api/exports/${view.jobId}/download`, byte_size: 22, object_sha256: view.digest, loss_report: { losses: [] } };
  vi.spyOn(api, 'job').mockResolvedValue({ job_id: view.jobId, kind: 'dataset_export', state: 'succeeded', progress_completed: 1, progress_total: 1, result: artifact });
  await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false)); const original = JSON.stringify(view.writes[0]); testId<HTMLButtonElement>(view.root, 'export-start').click();
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-status-check').disabled).toBe(false)); testId<HTMLButtonElement>(view.root, 'export-status-check').click();
  await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-download').disabled).toBe(false)); view.dispose(); view.remount();
  await vi.waitFor(() => expect(button(view.root, '开始新的交付范围').disabled).toBe(false)); button(view.root, '开始新的交付范围').click();
  expect(testId<HTMLSelectElement>(view.root, 'dataset-ontology').disabled).toBe(false); expect(view.root.textContent).toContain(view.jobId); expect(view.root.textContent).toContain(view.digest); expect(testId<HTMLButtonElement>(view.root, 'export-download').disabled).toBe(false);
  view.rows[0].head = { ...view.rows[0].head!, annotation_revision_id: uuid(9999) }; await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include');
  button(view.root, '查看并导出此固定版本').click(); expect(testId<HTMLButtonElement>(view.root, 'snapshot-create').disabled).toBe(true);
  button(view.root, '返回当前交付范围').click(); expect(testId<HTMLButtonElement>(view.root, 'snapshot-create').disabled).toBe(false);
  testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(view.writes.filter(write => write.path.endsWith('/dataset-versions'))).toHaveLength(2));
  expect(JSON.stringify(view.writes[0])).toBe(original); expect((view.writes.at(-1)!.body.items as { annotation_revision_id: string }[])[0].annotation_revision_id).toBe(uuid(9999));
});
it('does not use new delivery or remount to unlock an unknown snapshot original request', async () => {
  const view = fixture(); view.intercept(() => { throw new TypeError('ACK lost'); }); await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include'); testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  await vi.waitFor(() => expect(button(view.root, '只读核对原请求')).toBeDefined()); const original = JSON.stringify(view.writes[0]); view.dispose(); view.remount();
  expect(button(view.root, '开始新的交付范围').disabled).toBe(true); button(view.root, '开始新的交付范围').click(); expect(testId<HTMLSelectElement>(view.root, 'dataset-ontology').disabled).toBe(true);
  expect(view.writes).toHaveLength(1); expect(JSON.stringify(view.writes[0])).toBe(original);
});
it.each(['snapshot', 'export'] as const)('publishes the original %s ACK to the current remount without sending again', async kind => {
  const view = fixture(); await browse(view); select(testId(view.root, `dataset-disposition-${view.rows[0].media.asset_revision_id}`), 'include');
  let finish!: (value: unknown) => void; const pending = new Promise(resolve => { finish = resolve; });
  if (kind === 'snapshot') view.intercept(() => pending);
  testId<HTMLButtonElement>(view.root, 'snapshot-create').click(); testId<HTMLButtonElement>(view.root, 'snapshot-create').click();
  const job = vi.spyOn(api, 'job').mockResolvedValue({ job_id: view.jobId, kind: 'dataset_export', state: 'failed', progress_completed: 0, progress_total: 1, result: { code: 'EXPORT_FAILED' } });
  if (kind === 'export') {
    await vi.waitFor(() => expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false));
    view.intercept(() => pending); testId<HTMLButtonElement>(view.root, 'export-start').click();
  }
  const count = kind === 'snapshot' ? 1 : 2; await vi.waitFor(() => expect(view.writes).toHaveLength(count)); const original = JSON.stringify(view.writes);
  view.dispose(); view.remount(); expect(button(view.root, '开始新的交付范围').disabled).toBe(true);
  finish(kind === 'snapshot' ? { dataset_version_id: view.snapshotId, manifest_sha256: view.digest } : { job_id: view.jobId, format: 'native', state: 'queued', loss_report: { losses: [] } });
  await vi.waitFor(() => expect(button(view.root, '开始新的交付范围').disabled).toBe(false));
  if (kind === 'snapshot') expect(testId<HTMLButtonElement>(view.root, 'export-start').disabled).toBe(false);
  else { await vi.waitFor(() => expect(job).toHaveBeenCalledWith(view.jobId, expect.any(AbortSignal))); expect(view.root.textContent).toContain(view.jobId); }
  expect(view.writes).toHaveLength(count); expect(JSON.stringify(view.writes)).toBe(original); expect(view.root.querySelector('[aria-label=原请求核对]')).toBeNull();
});
