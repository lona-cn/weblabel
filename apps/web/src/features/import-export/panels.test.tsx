import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiFailure } from '../../lib/t15/api';
import { MediaImportPanel } from './MediaImportPanel';
import { AnnotationImportPanel } from './AnnotationImportPanel';
import { RevisionExportPanel } from './RevisionExportPanel';
expect.extend(matchers);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const media = { asset_id: 'a', asset_revision_id: 'm', project_id: 'p', original_name: 'same.png', original_sha256: 'h', canonical_sha256: 'h', canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1,0,0,0,1,0,0,0,1], source_group_id: 'g' };
const ontology = { ontology_version_id: 'o', project_id: 'p', version_no: 1, labels: [{ label_id: 'l', name: '人', color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy' as const], attributes: [] }], guidelines_markdown: '', allow_out_of_bounds: false as const };
const document = { schema_version: 1 as const, asset_revision_id: 'm', ontology_version_id: 'o', coordinate_space: { type: 'canonical_image_pixels' as const, width: 20, height: 20 }, completion: 'in_progress' as const, objects: [] };
const revision = { annotation_revision_id: 'r', parent_revision_id: null, revision_no: 1, document, created_at: '2026-10-10T00:00:00Z', created_by: 'u', content_hash: 'h' };
it('keeps same-name files separate by server item_index and only GETs on status recheck', async () => {
  const upload = vi.spyOn(api, 'importAssets').mockResolvedValue({ import_job_id: 'j', duplicate: false });
  vi.spyOn(api, 'job').mockResolvedValue({ job_id: 'j', kind: 'media_import', state: 'failed', progress_completed: 2, progress_total: 2, result: { items: [{ item_index: 1, state: 'failed', error: 'English arbitrary', error_code: 'MULTIPLE_FRAMES' }, { item_index: 0, state: 'succeeded', asset_id: 'a', asset_revision_id: 'm', error: null, error_code: null }] } });
  render(<MediaImportPanel projectId="p" canImport onImported={async () => {}} />);
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('媒体文件'), [new File(['a'], 'same.png', { type: 'image/png' }), new File(['b'], 'same.png', { type: 'image/png' })]);
  await user.click(screen.getByRole('button', { name: '上传媒体' }));
  await screen.findByText('部分成功');
  const rows = screen.getAllByTestId('media-import-item');
  expect(within(rows[0]).getByText('成功')).toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('多帧');
  await user.click(screen.getByRole('button', { name: '重新检查状态' }));
  expect(upload).toHaveBeenCalledTimes(1);
});
it('never automatically resends unknown media upload', async () => {
  const upload = vi.spyOn(api, 'importAssets').mockRejectedValue(new TypeError('network'));
  render(<MediaImportPanel projectId="p" canImport onImported={async () => {}} />);
  const user = userEvent.setup(); await user.upload(screen.getByLabelText('媒体文件'), new File(['a'], 'a.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: '上传媒体' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未知');
  expect(screen.getByRole('button', { name: '上传媒体' })).toBeDisabled(); expect(upload).toHaveBeenCalledTimes(1);
});
it('commits only acknowledged preview and replays an unknown commit with identical lease and operation', async () => {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    posts.push({ url, body: init.body });
    if (url.includes('annotation-import-previews') && !url.endsWith('/commit')) return new Response(JSON.stringify({ import_batch_id: 'b', document, base_revision_id: 'r', base_revision_no: 1, loss_report: { losses: [{ field: 'attributes', reason: 'not represented' }] } }));
    if (posts.filter(p => p.url.endsWith('/commit')).length === 1) throw new TypeError('network');
    return new Response(JSON.stringify({ import_batch_id: 'b', revision, idempotent_replay: true }));
  }));
  const release = vi.fn(); const committed = vi.fn(async () => {});
  render(<AnnotationImportPanel scopeKey="s" media={media} ontology={ontology} canWrite prepareImport={async () => ({ asset_revision_id: 'm', ontology_version_id: 'o', base_revision_id: 'r', lease: { task_id: 't', fencing_token: 7 } })} onCommit={committed} releaseImport={release} />);
  const user = userEvent.setup(); await user.selectOptions(screen.getByLabelText('标注格式'), 'yolo');
  await user.upload(screen.getByLabelText('标注源文件'), new File([''], 'a.txt', { type: 'text/plain' }));
  await user.click(screen.getByRole('button', { name: '生成只读预览' }));
  await screen.findByText('attributes'); expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled();
  await user.click(screen.getByLabelText('我已阅读并确认导入损失'));
  await user.click(screen.getByRole('button', { name: '确认导入' }));
  await screen.findByRole('button', { name: '重放同一导入请求' }); expect(release).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '重放同一导入请求' }));
  await waitFor(() => expect(committed).toHaveBeenCalledWith(revision, 's'));
  const bodies = posts.filter(p => p.url.endsWith('/commit')).map(p => JSON.parse(p.body as string));
  expect(bodies[0]).toEqual(bodies[1]); expect(bodies[0]).toMatchObject({ loss_ack: true, lease: { task_id: 't', fencing_token: 7 } });
});
it('shows actual export loss and retains fixed intent; download failure never creates another artifact', async () => {
  const writes: { format: string; loss_ack: boolean; operation_id: string }[] = []; vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(init.body as string); writes.push(body); if (!body.loss_ack) return new Response(JSON.stringify({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: 'req', details: { loss_report: { losses: [{ field: 'origin', reason: 'not represented' }] } } }), { status: 422 });
      return new Response(JSON.stringify({ export_id: 'e', format: 'coco', download_url: '/api/exports/e/download', byte_size: 3, object_sha256: 'h', loss_report: { losses: [{ field: 'origin', reason: 'not represented' }] } })); }
    throw new TypeError('download');
  }));
  const prepare = vi.fn(async () => revision);
  const view = render(<RevisionExportPanel scopeKey="loss-download-loading" canStart={false} media={{ ...media, project_id: 'loss-download-project' }} prepareExport={prepare} />);
  const user = userEvent.setup(); await user.selectOptions(screen.getByLabelText('导出格式'), 'coco');
  await user.click(screen.getByRole('button', { name: '检查损失并导出' }));
  expect(screen.getByRole('button', { name: '检查损失并导出' })).toBeDisabled();
  expect(prepare).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  // Settled initialization, including a terminal Native diagnostic, permits read-only export.
  view.rerender(<RevisionExportPanel scopeKey="loss-download-settled" canStart media={{ ...media, project_id: 'loss-download-project' }} prepareExport={prepare} />);
  await user.click(screen.getByRole('button', { name: '检查损失并导出' }));
  await screen.findByText('origin');
  await user.click(screen.getByLabelText('我已阅读并确认导出损失')); await user.click(screen.getByRole('button', { name: '确认损失并继续导出' }));
  await screen.findByRole('button', { name: '重新下载已有产物' }); await user.click(screen.getByRole('button', { name: '重新下载已有产物' }));
  expect(writes).toHaveLength(2); expect(writes[0].loss_ack).toBe(false); expect(writes[1]).toEqual({ ...writes[0], loss_ack: true });
});

it('discards an old project upload acknowledgement instead of querying or refreshing the new project', async () => {
  let finish!: (value: { import_job_id: string; duplicate: boolean }) => void;
  vi.spyOn(api, 'importAssets').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const job = vi.spyOn(api, 'job'); const imported = vi.fn(async () => {});
  const view = render(<MediaImportPanel projectId="old" canImport onImported={imported} />);
  const user = userEvent.setup(); await user.upload(screen.getByLabelText('媒体文件'), new File(['a'], 'old.png', { type: 'image/png' }));
  await user.click(screen.getByRole('button', { name: '上传媒体' }));
  view.rerender(<MediaImportPanel projectId="new" canImport onImported={imported} />);
  await act(async () => { finish({ import_job_id: 'old-job', duplicate: false }); });
  expect(job).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled(); expect(screen.queryByText('old.png')).not.toBeInTheDocument();
});
it('does not describe malformed export loss as lossless or offer acknowledgement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: 'bad-report', details: { loss_report: { losses: [{ field: 'origin', reason: 7 }] } } }), { status: 422 })));
  render(<RevisionExportPanel canStart scopeKey="malformed-loss-scope" media={{ ...media, project_id: 'malformed-loss-project' }} prepareExport={async () => revision} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '检查损失并导出' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('损失报告');
  expect(screen.queryByLabelText('我已阅读并确认导出损失')).not.toBeInTheDocument();
  expect(screen.queryByText('无损')).not.toBeInTheDocument();
});
it('requires an explicit COCO source image and maps categories only in the upload copy', async () => {
  const original = JSON.stringify({ images: [{ id: 1, file_name: 'first.png', width: 20, height: 20 }, { id: 2, file_name: 'second.png', width: 20, height: 20 }], categories: [{ id: 9, name: 'source-person' }], annotations: [] });
  const file = new File([original], 'source.json', { type: 'application/json' });
  let uploaded: FormData | null = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { uploaded = init.body as FormData; return new Response(JSON.stringify({ import_batch_id: 'b', document, base_revision_id: 'r', base_revision_no: 1, loss_report: { losses: [] } })); }));
  render(<AnnotationImportPanel scopeKey="s" media={media} ontology={ontology} canWrite prepareImport={async () => ({ asset_revision_id: 'm', ontology_version_id: 'o', base_revision_id: 'r', lease: null })} onCommit={async () => {}} releaseImport={() => {}} />);
  const user = userEvent.setup(); await user.upload(screen.getByLabelText('标注源文件'), file);
  const mapping = await screen.findByLabelText('类别映射 source-person'); await user.selectOptions(mapping, 'l');
  await user.click(screen.getByRole('button', { name: '生成只读预览' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('来源图'); expect(uploaded).toBeNull();
  await user.selectOptions(screen.getByLabelText('COCO 来源图'), '2'); await user.click(screen.getByRole('button', { name: '生成只读预览' }));
  await screen.findByText('只读预览');
  const body = uploaded as FormData | null; expect(body?.get('source_image_id')).toBe('2'); expect(body?.get('category_map')).toBeNull();
  const read = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob); });
  const data = body?.get('data'); expect(data).toBeInstanceOf(File);
  const mapped = JSON.parse(await read(data as File)); expect(mapped.categories[0]).toEqual({ id: 9, name: 'source-person', label_id: 'l' });
  expect(await read(file)).toBe(original);
});
it('keeps an unknown export operation immutable and refuses format changes until same-payload replay', async () => {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { bodies.push(String(init.body)); if (bodies.length === 1) throw new TypeError('network'); return new Response(JSON.stringify({ export_id: 'e', format: 'native', download_url: '/api/exports/e/download', byte_size: 3, object_sha256: 'h', loss_report: { losses: [] } })); }
    throw new TypeError('download');
  }));
  render(<RevisionExportPanel canStart scopeKey="unknown-export-scope" media={{ ...media, project_id: 'unknown-export-project' }} prepareExport={async () => revision} />);
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '检查损失并导出' }));
  await screen.findByRole('button', { name: '重放同一导出请求' }); expect(screen.getByLabelText('导出格式')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重放同一导出请求' }));
  await screen.findByRole('button', { name: '重新下载已有产物' }); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});
it('retains the source and definite preview failure when releasing only advances the same-target epoch', async () => {
  const preview = vi.spyOn(api, 'previewAnnotationImport').mockRejectedValue(new ApiFailure(422, 'INVALID_CLASS_MAPPING', 'invalid'));
  const context = { asset_revision_id: 'm', ontology_version_id: 'o', base_revision_id: 'r', lease: null };
  let epoch = 1;
  const panel = () => <AnnotationImportPanel scopeKey={`s${epoch}`} media={media} ontology={ontology} canWrite prepareImport={async () => context} onCommit={async () => {}} releaseImport={() => { epoch++; view.rerender(panel()); }} />;
  const view = render(panel()); const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('标注格式'), 'yolo');
  await user.upload(screen.getByLabelText('标注源文件'), new File(['0 0.5 0.5 0.1 0.1'], 'source.txt', { type: 'text/plain' }));
  await user.click(screen.getByRole('button', { name: '生成只读预览' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('INVALID_CLASS_MAPPING');
  expect(screen.getByRole('button', { name: '生成只读预览' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '生成只读预览' }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  expect((preview.mock.calls[1][1].get('data') as File).name).toBe('source.txt');
});