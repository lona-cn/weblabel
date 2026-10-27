// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { SessionController } from '../../app/session';
import { readRoute } from '../../app/route-state';
import { api, ApiFailure, setCsrfToken, type ApiMedia, type AnnotationImportPreview } from '../../lib/t15/api';
import type { TransfersMountContext } from '../workbench/workbench-context';
import { mountTransfersPanel } from './transfers-panel';
import { getOutboxSnapshot, removeExportIntent, removeImportIntent } from './outbox';
import { parseCocoSource } from './annotation-import-view';
import { reviewApi } from '../review/api';
let serial = 0; const owners: AbortController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.abort()); for (const record of getOutboxSnapshot().imports) removeImportIntent(record); for (const record of getOutboxSnapshot().exports) removeExportIntent(record); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(empty = false) {
  const project = `native-transfers-${++serial}`;
  const asset: ApiMedia = { asset_id: 'asset', asset_revision_id: 'image', project_id: project, original_name: 'same.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'a'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' };
  const ontology: OntologyVersion = { ontology_version_id: 'ontology', project_id: project, version_no: 1, labels: [{ label_id: 'label', name: '对象', color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }], guidelines_markdown: '', allow_out_of_bounds: false };
  const document = { schema_version: 1 as const, asset_revision_id: 'image', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels' as const, width: 20, height: 20 }, completion: 'in_progress' as const, objects: [] };
  const revision: AnnotationRevision = { annotation_revision_id: 'revision', parent_revision_id: null, revision_no: 1, document, created_at: '2026-10-10T00:00:00Z', created_by: 'actor', content_hash: 'a'.repeat(64) };
  const preview: AnnotationImportPreview = { import_batch_id: 'batch', document, base_revision_id: null, base_revision_no: 0, loss_report: { losses: [] } };
  const session = { user_id: 'actor', username: 'actor', platform_admin: false, project_roles: [{ project_id: project, role: 'admin' }] };
  const authListeners = new Set<() => void>();
  const controller: SessionController = { getSnapshot: () => ({ kind: 'authenticated', session, createdUsername: null }), subscribe: listener => { authListeners.add(listener); return () => authListeners.delete(listener); }, login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  const originalKey = Object.freeze({}); let scope = { asset: empty ? null : asset, ontology, scopeKey: originalKey, canWrite: !empty, canExport: !empty, canUploadMedia: true }; const listeners = new Set<() => void>();
  const owner = new AbortController(); owners.push(owner); const root = window.document.createElement('div'); window.document.body.append(root);
  const context: TransfersMountContext = { session: controller, signal: owner.signal, route: readRoute(new URL('http://localhost')), navigate: vi.fn(), projectId: project, getScope: () => scope, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, prepareImport: vi.fn(async () => ({ asset_revision_id: 'image', ontology_version_id: 'ontology', base_revision_id: null, lease: null })), releaseImport: vi.fn(), commitImport: vi.fn(async () => {}), prepareExport: vi.fn(async () => revision), refreshAssets: vi.fn(async () => {}) };
  vi.spyOn(api, 'image').mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  const NativeURL = URL; vi.stubGlobal('URL', class extends NativeURL { static createObjectURL() { return 'blob:synthetic'; } static revokeObjectURL() {} });
  const dispose = mountTransfersPanel(root, context);
  return { root, context, originalKey, preview, revision, dispose, remount() { return mountTransfersPanel(root, context); }, revokeRole() { session.project_roles[0].role = 'viewer'; authListeners.forEach(listener => listener()); }, move() { scope = { ...scope, scopeKey: Object.freeze({}) }; listeners.forEach(listener => listener()); } };
}
function button(root: HTMLElement, name: string) { const value = [...root.querySelectorAll('button')].find(button => button.textContent === name); if (!value) throw new Error(`Missing ${name}`); return value; }
function control<T extends HTMLElement>(root: HTMLElement, text: string): T { const label = [...root.querySelectorAll('label')].find(label => label.firstChild?.textContent === text); if (!label?.control) throw new Error(`Missing ${text}`); return label.control as T; }
function chooseFile(input: HTMLInputElement, files: File[]) { Object.defineProperty(input, 'files', { configurable: true, value: files }); input.dispatchEvent(new Event('change', { bubbles: true })); }
async function nativePreview(view: { root: HTMLElement }) {
  const format = control<HTMLSelectElement>(view.root, '标注格式'); format.value = 'native'; format.dispatchEvent(new Event('change', { bubbles: true }));
  chooseFile(control(view.root, '标注源文件'), [new File(['synthetic'], 'native.zip', { type: 'application/zip' })]); button(view.root, '生成只读预览').click();
  await vi.waitFor(() => expect(button(view.root, '确认导入').hidden).toBe(false));
}
it('uses a nullable fresh-media base and the identical opaque scope for commit and local receipt re-adoption', async () => {
  const view = fixture(); vi.spyOn(api, 'previewAnnotationImport').mockResolvedValue(view.preview); const write = vi.spyOn(api, 'commitAnnotationImport').mockResolvedValue({ import_batch_id: 'batch', revision: view.revision, idempotent_replay: false });
  vi.mocked(view.context.commitImport).mockRejectedValueOnce(new Error('IDB quota failure')).mockResolvedValueOnce(undefined);
  await nativePreview(view); button(view.root, '确认导入').click();
  await vi.waitFor(() => expect(button(view.root, '重新采用已确认导入版本')).toBeDefined());
  expect(view.context.prepareImport).toHaveBeenCalledTimes(1); expect(view.context.commitImport).toHaveBeenCalledWith(view.revision, view.originalKey); expect(view.context.releaseImport).not.toHaveBeenCalled();
  button(view.root, '重新采用已确认导入版本').click(); await vi.waitFor(() => expect(view.context.commitImport).toHaveBeenCalledTimes(2));
  expect(write).toHaveBeenCalledTimes(1); expect(view.context.prepareImport).toHaveBeenCalledTimes(1); expect(getOutboxSnapshot().imports).toHaveLength(0);
});
it('releases only the original opaque preview fence when scope changes before a preview ACK', async () => {
  const view = fixture(); let finish!: (value: AnnotationImportPreview) => void; vi.spyOn(api, 'previewAnnotationImport').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const format = control<HTMLSelectElement>(view.root, '标注格式'); format.value = 'native'; format.dispatchEvent(new Event('change')); chooseFile(control(view.root, '标注源文件'), [new File(['x'], 'native.zip')]); button(view.root, '生成只读预览').click();
  await vi.waitFor(() => expect(api.previewAnnotationImport).toHaveBeenCalledTimes(1)); view.move(); finish(view.preview);
  await vi.waitFor(() => expect(view.context.releaseImport).toHaveBeenCalledWith(view.originalKey)); expect(view.context.commitImport).not.toHaveBeenCalled();
});
it('retains an unknown import original payload and never POSTs again on readonly reconciliation or disposal', async () => {
  const view = fixture(); vi.spyOn(api, 'previewAnnotationImport').mockResolvedValue(view.preview); const write = vi.spyOn(api, 'commitAnnotationImport').mockRejectedValue(new TypeError('ACK lost')); vi.spyOn(api, 'annotation').mockResolvedValue(view.revision);
  await nativePreview(view); button(view.root, '确认导入').click(); await vi.waitFor(() => expect(button(view.root, '只读重新核对原导入版本')).toBeDefined());
  const original = getOutboxSnapshot().imports[0]; button(view.root, '只读重新核对原导入版本').click(); await vi.waitFor(() => expect(api.annotation).toHaveBeenCalledTimes(1));
  expect(getOutboxSnapshot().imports[0].payload).toBe(original.payload); expect(getOutboxSnapshot().imports[0].scope).toBe(view.originalKey); expect(write).toHaveBeenCalledTimes(1); view.dispose(); expect(view.context.releaseImport).not.toHaveBeenCalled();
});
it('keeps same-name media outcomes indexed and rechecks only the acknowledged job', async () => {
  const view = fixture(); const upload = vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'job', duplicate: false }); const read = vi.spyOn(api, 'job').mockResolvedValue({ job_id: 'job', kind: 'media_import', state: 'failed', progress_completed: 2, progress_total: 2, result: { items: [{ item_index: 1, state: 'failed', error: 'arbitrary provider text', error_code: 'MULTIPLE_FRAMES' }, { item_index: 0, state: 'succeeded', error: null, error_code: null }] } });
  chooseFile(control(view.root, '媒体文件'), [new File(['a'], 'same.png'), new File(['b'], 'same.png')]); button(view.root, '上传媒体').click();
  await vi.waitFor(() => expect(view.root.textContent).toContain('部分成功')); const rows = view.root.querySelectorAll('[data-testid=media-import-item]'); expect(rows[0].textContent).toContain('成功'); expect(rows[1].textContent).toContain('多帧');
  button(view.root, '重新检查状态').click(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); expect(upload).toHaveBeenCalledTimes(1);
});
it('does not upload twice after an unknown upload without a job identity', async () => {
  const view = fixture(); const upload = vi.spyOn(api, 'importAssets').mockRejectedValue(new TypeError('network lost')); chooseFile(control(view.root, '媒体文件'), [new File(['a'], 'same.png')]); button(view.root, '上传媒体').click();
  await vi.waitFor(() => expect(button(view.root, '只读刷新媒体列表').hidden).toBe(false)); button(view.root, '只读刷新媒体列表').click(); await vi.waitFor(() => expect(view.context.refreshAssets).toHaveBeenCalledTimes(1));
  expect(button(view.root, '上传媒体').disabled).toBe(true); button(view.root, '上传媒体').click(); expect(upload).toHaveBeenCalledTimes(1);
});
it('requires unique COCO image/category identities and preserves the complete source document', () => {
  const raw = { images: [{ id: 1, file_name: '<script>.png', width: 20, height: 20 }], categories: [{ id: 9, name: 'untrusted' }], annotations: [{ id: 1, image_id: 1 }], custom: 'preserved' };
  expect(parseCocoSource(raw).raw).toBe(raw); expect(() => parseCocoSource({ ...raw, images: [...raw.images, ...raw.images] })).toThrow('唯一整数'); expect(() => parseCocoSource({ ...raw, categories: [...raw.categories, ...raw.categories] })).toThrow('唯一整数');
});
it('exports the same fixed revision after explicit actual loss acknowledgement without saving a newer head', async () => {
  const view = fixture(); const report = { losses: [{ field: 'attributes', reason: 'YOLO omits attributes' }] };
  const write = vi.spyOn(api, 'createRevisionExport').mockRejectedValueOnce(new ApiFailure(422, 'LOSS_ACK_REQUIRED', 'loss', { loss_report: report }, 'request')).mockResolvedValueOnce({ export_id: 'export', format: 'yolo', download_url: '/api/exports/export/download', byte_size: 22, object_sha256: 'a'.repeat(64), loss_report: report });
  const format = control<HTMLSelectElement>(view.root, '导出格式'); format.value = 'yolo'; format.dispatchEvent(new Event('change')); button(view.root, '检查损失并导出').click();
  await vi.waitFor(() => expect(button(view.root, '确认损失并继续导出').hidden).toBe(false)); expect(button(view.root, '确认损失并继续导出').disabled).toBe(true);
  vi.mocked(view.context.prepareExport).mockResolvedValue({ ...view.revision, annotation_revision_id: 'new-current-head' });
  const ack = control<HTMLInputElement>(view.root, '我已阅读并确认导出损失'); ack.checked = true; ack.dispatchEvent(new Event('change')); button(view.root, '确认损失并继续导出').click();
  await vi.waitFor(() => expect(button(view.root, '重新下载已有产物')).toBeDefined()); expect(view.context.prepareExport).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.map(call => call[0])).toEqual(['revision', 'revision']); expect(write.mock.calls[1][1]).toEqual({ ...write.mock.calls[0][1], loss_ack: true });
});
it('keeps unknown export scope and original operation unchanged through readonly checking', async () => {
  const view = fixture(); const write = vi.spyOn(api, 'createRevisionExport').mockRejectedValue(new TypeError('ACK lost')); vi.spyOn(reviewApi, 'revision').mockResolvedValue(view.revision);
  button(view.root, '检查损失并导出').click(); await vi.waitFor(() => expect(button(view.root, '只读核对原固定版本')).toBeDefined());
  const original = getOutboxSnapshot().exports[0]; button(view.root, '只读核对原固定版本').click(); await vi.waitFor(() => expect(reviewApi.revision).toHaveBeenCalledTimes(1));
  expect(control<HTMLSelectElement>(view.root, '导出格式').disabled).toBe(true); expect(getOutboxSnapshot().exports[0].payload).toBe(original.payload); expect(getOutboxSnapshot().exports[0].scope).toBe(view.originalKey);
  view.move(); expect(button(view.root, '检查损失并导出').disabled).toBe(true); button(view.root, '检查损失并导出').click(); expect(write).toHaveBeenCalledTimes(1);
});
it('allows catalog media upload in an empty project without granting annotation import permission', async () => {
  const view = fixture(true); const upload = vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'job', duplicate: false });
  vi.spyOn(api, 'job').mockResolvedValue({ job_id: 'job', kind: 'media_import', state: 'succeeded', progress_completed: 1, progress_total: 1, result: { items: [{ item_index: 0, state: 'succeeded', error: null, error_code: null }] } });
  expect(control<HTMLInputElement>(view.root, '媒体文件').disabled).toBe(false); chooseFile(control(view.root, '媒体文件'), [new File(['synthetic'], 'fresh.png')]); button(view.root, '上传媒体').click();
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1)); expect(view.context.prepareImport).not.toHaveBeenCalled(); expect(view.context.getScope().canWrite).toBe(false);
});
it('retains an unknown upload fence and filename metadata across disposal and remount without another POST', async () => {
  const view = fixture(); const upload = vi.spyOn(api, 'importAssets').mockRejectedValue(new TypeError('lost original ACK'));
  chooseFile(control(view.root, '媒体文件'), [new File(['original-bytes'], 'unsettled.png')]); button(view.root, '上传媒体').click();
  await vi.waitFor(() => expect(button(view.root, '只读刷新媒体列表').hidden).toBe(false)); view.dispose(); view.remount();
  expect(view.root.textContent).toContain('unsettled.png'); expect(control<HTMLInputElement>(view.root, '媒体文件').disabled).toBe(true);
  chooseFile(control(view.root, '媒体文件'), [new File(['new-bytes'], 'replacement.png')]); button(view.root, '上传媒体').click();
  expect(button(view.root, '选择新的导入批次').hidden || button(view.root, '选择新的导入批次').disabled).toBe(true);
  button(view.root, '只读刷新媒体列表').click(); await vi.waitFor(() => expect(view.context.refreshAssets).toHaveBeenCalledTimes(1)); expect(upload).toHaveBeenCalledTimes(1);
});
it('reuses only the acknowledged media job after remount and permits an explicit new batch only after terminal proof', async () => {
  const view = fixture(); const upload = vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'original-job', duplicate: false });
  const read = vi.spyOn(api, 'job').mockResolvedValue({ job_id: 'original-job', kind: 'media_import', state: 'queued', progress_completed: 0, progress_total: 1, result: null });
  chooseFile(control(view.root, '媒体文件'), [new File(['a'], 'original.png')]); button(view.root, '上传媒体').click(); await vi.waitFor(() => expect(button(view.root, '重新检查状态').disabled).toBe(false));
  view.dispose(); view.remount(); expect(button(view.root, '上传媒体').disabled).toBe(true);
  read.mockResolvedValue({ job_id: 'original-job', kind: 'media_import', state: 'succeeded', progress_completed: 1, progress_total: 1, result: { items: [{ item_index: 0, state: 'succeeded', error: null, error_code: null }] } });
  button(view.root, '重新检查状态').click(); await vi.waitFor(() => expect(button(view.root, '选择新的导入批次').hidden).toBe(false)); button(view.root, '选择新的导入批次').click();
  expect(control<HTMLInputElement>(view.root, '媒体文件').disabled).toBe(false); expect(upload).toHaveBeenCalledTimes(1); expect(read.mock.calls.every(call => call[0] === 'original-job')).toBe(true);
});
it.each(['role', 'epoch'] as const)('aborts pending media reads and polling after same-user %s revocation', async kind => {
  const view = fixture(); vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'revoked-job', duplicate: false });
  let signal: AbortSignal | undefined; let finish!: (value: { job_id: string; kind: string; state: string; progress_completed: number; progress_total: number; result: unknown }) => void;
  const read = vi.spyOn(api, 'job').mockImplementation((_id, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { finish = resolve; }); });
  chooseFile(control(view.root, '媒体文件'), [new File(['a'], 'revoked.png')]); button(view.root, '上传媒体').click(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  if (kind === 'role') view.revokeRole(); else setCsrfToken(`revoked-epoch-${serial}`);
  expect(signal?.aborted).toBe(true); vi.useFakeTimers(); finish({ job_id: 'revoked-job', kind: 'media_import', state: 'queued', progress_completed: 0, progress_total: 1, result: null });
  await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1); expect(view.context.refreshAssets).not.toHaveBeenCalled();
});
