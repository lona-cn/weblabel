import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Projects } from './Projects';
import { api, ApiFailure } from '../../lib/t15/api';
import type { DraftRecord } from '../../lib/persistence/types';
import { Workbench } from '../workbench/Workbench';
import { IndexedDbDraftStorage, InMemoryDraftStorage, exportNativeDraft } from '../../lib/persistence/draft-store';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import { EditorHost } from '../../lib/editor/EditorHost';
function storageFor(asset: string, record: unknown) {
  const storage = new InMemoryDraftStorage();
  const envelope = { asset_revision_id: asset, draft_id: 'fixture', write_token: 'fixture-token', record: structuredClone(record), sources: [] };
  void storage.put(envelope);
  vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(storage.list.bind(storage));
  vi.spyOn(IndexedDbDraftStorage.prototype, 'get').mockImplementation(storage.get.bind(storage));
  return { storage, envelope };
}
vi.mock('../../app/providers', () => ({ useSession: () => ({ entry: { kind: 'authenticated', session: { user_id: 'user', username: 'tester', platform_admin: false, project_roles: [{ project_id: 'p', role: 'admin' }] } }, logout: vi.fn() }) }));
vi.mock('../workbench/CanvasView', () => ({ CanvasView: () => null }));
vi.mock('../ai/WorkbenchAi', () => ({ WorkbenchAi: () => null }));
vi.mock('../review/ReviewPanel', () => ({ ReviewPanel: () => null }));
vi.mock('../workbench/ActivityPanel', () => ({ ActivityPanel: () => null }));
vi.mock('../../lib/editor/loader', () => ({ decodeCanonicalFrame: async () => ({ width: 20, height: 20, rgba: new Uint8Array(1600) }) }));
expect.extend(matchers);
const project = { project_id: 'p', name: '测试项目', description: '', allow_self_review: false, role: 'admin' };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('object-viewport') ? 320 : 0; });
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(api, 'createProject').mockResolvedValue(project);
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(api, 'publishOntology').mockImplementation(async (_id, body) => ({ ...body, ontology_version_id: 'o', project_id: 'p', version_no: 1, allow_out_of_bounds: false }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
async function start() {
  render(<Projects onOpen={() => {}} createdUsername={null} />);
  await userEvent.setup().type(screen.getByTestId('project-name'), project.name);
}
it('edits two categories with all four typed attribute constraints before publishing', async () => {
  const user = userEvent.setup(); await start();
  await user.click(screen.getByRole('button', { name: '添加类别' }));
  const labels = screen.getAllByTestId('ontology-label');
  for (const [index, kind] of ['enum', 'boolean', 'number', 'text'].entries()) {
    const group = within(labels[index % 2]);
    await user.click(group.getByRole('button', { name: '添加属性' }));
    const rows = group.getAllByTestId('ontology-attribute');
    const row = within(rows.at(-1)!);
    await user.type(row.getByLabelText('属性键'), `key${index}`);
    await user.selectOptions(row.getByLabelText('类型'), kind);
    await user.click(row.getByLabelText('必填'));
    await user.click(row.getByLabelText('默认值为空'));
    if (kind === 'enum') { await user.type(row.getByLabelText('枚举值（每行一个）'), '是\n否'); await user.type(row.getByLabelText('默认值'), '是'); }
    if (kind === 'boolean') await user.selectOptions(row.getByLabelText('默认值'), 'true');
    if (kind === 'number') { await user.type(row.getByLabelText('默认值'), '0.5'); await user.type(row.getByLabelText('最小值'), '0'); await user.type(row.getByLabelText('最大值'), '1'); }
    if (kind === 'text') await user.type(row.getByLabelText('默认值'), ' 原样中文 ');
  }
  await user.type(within(labels[1]).getByLabelText('类别名称'), '第二类');
  await user.click(screen.getByTestId('project-submit'));
  await waitFor(() => expect(api.publishOntology).toHaveBeenCalled());
  const body = vi.mocked(api.publishOntology).mock.calls[0][1];
  expect(body.labels.map(l => l.attributes.map(a => a.default_value))).toEqual([['是', 0.5], [true, ' 原样中文 ']]);
  expect(body.labels[0].attributes[1]).toMatchObject({ min: 0, max: 1, required: true });
  expect(new Set(body.labels.map(l => l.label_id)).size).toBe(2);
});
it('retains UTF8-over-budget draft without creating anything', async () => {
  await start(); const input = screen.getByLabelText('类别名称');
  await userEvent.setup().clear(input); await userEvent.setup().type(input, '中'.repeat(43));
  await userEvent.setup().click(screen.getByTestId('project-submit'));
  expect(await within(screen.getAllByTestId('ontology-label')[0]).findByRole('alert')).toHaveTextContent('128');
  expect(input).toHaveValue('中'.repeat(43)); expect(api.createProject).not.toHaveBeenCalled();
});
it('only supplements ontology after confirmed project creation and rejected publication', async () => {
  vi.mocked(api.publishOntology).mockRejectedValueOnce(new ApiFailure(422, 'INVALID_ONTOLOGY', 'invalid'));
  await start(); await userEvent.setup().click(screen.getByTestId('project-submit'));
  await screen.findByRole('alert'); await userEvent.setup().click(screen.getByTestId('project-submit'));
  await waitFor(() => expect(api.publishOntology).toHaveBeenCalledTimes(2));
  expect(api.createProject).toHaveBeenCalledTimes(1);
});
it('does not resend an unknown project acknowledgement, including ambiguous readback', async () => {
  vi.mocked(api.createProject).mockRejectedValueOnce(new TypeError('network'));
  await start(); await userEvent.setup().click(screen.getByTestId('project-submit'));
  await screen.findByRole('alert'); expect(screen.getByTestId('project-submit')).toBeDisabled();
  vi.mocked(api.projects).mockResolvedValue({ items: [project, { ...project, project_id: 'other' }], next_cursor: null });
  await userEvent.setup().click(screen.getByRole('button', { name: '只读核对结果' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('未知'));
  expect(api.createProject).toHaveBeenCalledTimes(1); expect(api.publishOntology).not.toHaveBeenCalled();
});

it('retains unknown ontology publication without reposting or recreating', async () => {
  vi.mocked(api.publishOntology).mockRejectedValueOnce(new TypeError('network'));
  await start(); await userEvent.setup().click(screen.getByTestId('project-submit'));
  await screen.findByRole('alert'); expect(screen.getByTestId('project-submit')).toBeDisabled();
  await userEvent.setup().click(screen.getByRole('button', { name: '只读核对结果' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('未知'));
  expect(api.createProject).toHaveBeenCalledTimes(1); expect(api.publishOntology).toHaveBeenCalledTimes(1);
});
it('shows existing members their fixed definitions but permits only actual admins to publish', async () => {
  vi.mocked(api.projects).mockResolvedValue({ items: [{ ...project, role: 'viewer' }], next_cursor: null });
  render(<Projects onOpen={() => {}} createdUsername={null} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看规范：测试项目' }));
  await waitFor(() => expect(screen.getByTestId('project-submit')).toBeDisabled());
  expect(screen.getByText(/只读：权限未知/)).toBeInTheDocument();
  expect(api.publishOntology).not.toHaveBeenCalled();
});
it('does not expose malformed heads or members as valid domain data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ ontology_version_id: 'o' }], next_cursor: null }), { status: 200 })));
  await expect(api.annotationHeads('a')).rejects.toMatchObject({ status: 502, code: 'INVALID_ANNOTATION_HEAD_PAGE' });
  await expect(api.members('p')).rejects.toMatchObject({ status: 502, code: 'INVALID_PROJECT_MEMBER_PAGE' });
});
it('renders old draft attributes using its old fixed ontology despite a newer publication', async () => {
  const old = { ontology_version_id: 'old', project_id: 'p', version_no: 1, labels: [{ label_id: 'old-label', name: '旧类别', color: '#ffcc00', shortcut: null, allowed_geometry_types: ['bbox_xyxy'] as ['bbox_xyxy'], attributes: [{ key: 'old_score', kind: 'number' as const, required: false, default_value: null, enum_values: [], min: 0, max: 1 }] }], guidelines_markdown: '', allow_out_of_bounds: false as const };
  const document = { schema_version: 1 as const, asset_revision_id: 'asset', ontology_version_id: 'old', coordinate_space: { type: 'canonical_image_pixels' as const, width: 20, height: 20 }, completion: 'in_progress' as const, objects: [{ object_id: 'object', label_id: 'old-label', geometry: { type: 'bbox_xyxy' as const, x_min: 1, y_min: 1, x_max: 10, y_max: 10 }, attributes: { old_score: 0.75 }, origin: { type: 'manual' as const, prediction_id: null, model_run_id: null, import_batch_id: null } }] };
  const draft: DraftRecord = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'old', base_revision_id: 'base', generation: 1, synced_generation: 0, synced_intent_seq: 0, intent_journal: [], pending: null, document, updated_at: '2026-10-10T00:00:00Z' };
  const { storage } = storageFor('asset', draft);
  vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(storage.put.bind(storage));
  vi.mocked(api.projects).mockResolvedValue({ items: [{ ...project, role: 'viewer' }], next_cursor: null });
  vi.mocked(api.ontologies).mockResolvedValue({ items: [{ ...old, ontology_version_id: 'new', version_no: 2, labels: [{ ...old.labels[0], label_id: 'new-label', name: '新类别', attributes: [] }] }, old], next_cursor: null });
  vi.spyOn(api, 'assets').mockResolvedValue([{ asset_id: 'asset-id', asset_revision_id: 'asset', project_id: 'p', original_name: 'old.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' }]);
  vi.spyOn(api, 'annotationHeads').mockResolvedValue({ items: [{ ontology_version_id: 'old', annotation_revision_id: 'base', revision_no: 1, content_hash: 'a'.repeat(64), completion: 'in_progress', object_count: 1, approved_review_id: null }], next_cursor: null });
  vi.spyOn(api, 'annotation').mockImplementation(async (_asset, ontologyId) => {
    if (ontologyId !== 'old') throw new ApiFailure(404, 'NOT_FOUND', 'not found');
    return { annotation_revision_id: 'base', parent_revision_id: null, revision_no: 1, document, content_hash: 'a'.repeat(64), created_at: '2026-10-10T00:00:00Z', created_by: 'user' };
  });
  vi.spyOn(api, 'image').mockResolvedValue(new Blob());
  vi.spyOn(api, 'externalProcessingPolicy').mockResolvedValue({ allow_external_processing: false });
  render(<Workbench projectId="p" />);
  await waitFor(() => expect(screen.getByTestId('ontology-selector')).not.toBeDisabled());
  await waitFor(() => expect((screen.getByTestId('ontology-selector') as HTMLSelectElement).querySelector('option[value="old"]')).not.toBeNull());
  await userEvent.setup().selectOptions(screen.getByTestId('ontology-selector'), 'old');
  const object = await screen.findByTestId("object-item-object");
  await userEvent.setup().click(object);
  expect(await screen.findByTestId('attribute-old_score')).toBeDisabled();
  expect(screen.queryByText('新类别')).not.toBeInTheDocument();
});
it('does not claim a unique unassociated project candidate after an unknown POST', async () => {
  vi.mocked(api.createProject).mockRejectedValueOnce(new TypeError('network'));
  await start(); const user = userEvent.setup(); await user.click(screen.getByTestId('project-submit'));
  await screen.findByRole('alert');
  vi.mocked(api.projects).mockResolvedValue({ items: [project], next_cursor: null });
  await user.click(screen.getByRole('button', { name: '只读核对结果' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '只读核对结果' })).toBeEnabled());
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('project-submit')).toBeDisabled();
  expect(screen.getByRole('button', { name: '查看规范：测试项目' })).toBeEnabled();
  expect(api.createProject).toHaveBeenCalledTimes(1); expect(api.publishOntology).not.toHaveBeenCalled();
});
it('rescues the requested missing asset without selecting another asset or losing its queued operation', async () => {
  history.replaceState(null, '', '?asset_revision_id=missing');
  const document: DraftRecord['document'] = { schema_version: 1, asset_revision_id: 'missing', ontology_version_id: 'old', coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: 'in_progress', objects: [] };
  const intent = { suggestion_set_id: 'suggestion', change_ids: ['change'], decision: 'accept' as const };
  const draft: DraftRecord = { schema_version: 1, asset_revision_id: 'missing', ontology_version_id: 'old', base_revision_id: 'base', generation: 1, synced_generation: 0, synced_intent_seq: 0, document, intent_journal: [{ seq: 1, generation: 1, intent, recorded_at: '2026-10-10T00:00:00Z' }], pending: { operation_id: 'operation', generation: 1, journal_seq_end: 1, edit_seq: 1, prepared_at: '2026-10-10T00:00:00Z', request: { operation_id: 'operation', base_revision_id: 'base', document, lease: null, suggestion_decisions: [intent] } }, updated_at: '2026-10-10T00:00:00Z' };
  const originalDiskRecord = structuredClone(draft);
  const { storage, envelope } = storageFor('missing', draft);
  const persisted = vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(storage.put.bind(storage));
  vi.mocked(api.projects).mockResolvedValue({ items: [project], next_cursor: null });
  vi.mocked(api.ontologies).mockResolvedValue({ items: [{ ontology_version_id: 'old', project_id: 'p', version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }], next_cursor: null });
  vi.spyOn(api, 'assets').mockResolvedValue([{ asset_id: 'first-id', asset_revision_id: 'first', project_id: 'p', original_name: 'first.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' }]);
  const heads = vi.spyOn(api, 'annotationHeads').mockResolvedValue({ items: [], next_cursor: null });
  const image = vi.spyOn(api, 'image').mockResolvedValue(new Blob());
  vi.spyOn(api, 'externalProcessingPolicy').mockResolvedValue({ allow_external_processing: false });
  let downloaded: Blob | null = null;
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:rescue'; } static revokeObjectURL() {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  render(<Workbench projectId="p" />);
  await userEvent.setup().click(await screen.findByRole('radio'));
  const rescue = screen.getByRole('button', { name: '下载选中分支原始草稿' });

  expect(screen.getByTestId('asset-item-first')).toHaveAttribute('aria-pressed', 'false');
  await userEvent.setup().click(rescue);
  expect(downloaded).not.toBeNull();
  const text = typeof downloaded!.text === 'function' ? await downloaded!.text() : await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(downloaded!); });
  expect(JSON.parse(text)).toEqual(originalDiskRecord);
  expect(persisted).not.toHaveBeenCalled();
  expect((await storage.get('missing', envelope.draft_id))?.record).toEqual(originalDiskRecord);
  expect(screen.getByTestId('asset-item-first')).toHaveAttribute('aria-pressed', 'false');
  expect(heads).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
});
it('does not publish or navigate when creation ACK arrives after leaving Projects', async () => {
  let acknowledge!: (value: Awaited<ReturnType<typeof api.createProject>>) => void;
  vi.mocked(api.createProject).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  const onOpen = vi.fn(); const user = userEvent.setup();
  const view = render(<Projects onOpen={onOpen} createdUsername={null} />);
  await user.type(screen.getByTestId('project-name'), project.name);
  await user.click(screen.getByTestId('project-submit'));
  await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { acknowledge(project); });
  expect(api.publishOntology).not.toHaveBeenCalled();
  expect(api.ontologies).not.toHaveBeenCalled();
  expect(api.projects).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});
it('does not refresh or steal navigation when publication ACK arrives after leaving Projects', async () => {
  let acknowledge!: (value: Awaited<ReturnType<typeof api.publishOntology>>) => void;
  vi.mocked(api.publishOntology).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  const onOpen = vi.fn(); const user = userEvent.setup();
  const view = render(<Projects onOpen={onOpen} createdUsername={null} />);
  await user.type(screen.getByTestId('project-name'), project.name);
  await user.click(screen.getByTestId('project-submit'));
  await waitFor(() => expect(api.publishOntology).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { acknowledge({ ontology_version_id: 'o', project_id: 'p', version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }); });
  expect(api.createProject).toHaveBeenCalledTimes(1);
  expect(api.ontologies).not.toHaveBeenCalled();
  expect(api.projects).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});
it('republishes an existing single empty-string enum option without adding enum options to other kinds', async () => {
  const version = { ontology_version_id: 'old', project_id: 'p', version_no: 1, allow_out_of_bounds: false, guidelines_markdown: ' 原样指南 ', labels: [{ label_id: 'stable-id', name: '合法类别', color: '#ff0000', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [
    { key: 'empty-enum', kind: 'enum', required: false, default_value: '', enum_values: [''], min: null, max: null },
    { key: 'text', kind: 'text', required: false, default_value: '', enum_values: [], min: null, max: null },
    { key: 'boolean', kind: 'boolean', required: false, default_value: true, enum_values: [], min: null, max: null },
    { key: 'number', kind: 'number', required: false, default_value: 0.5, enum_values: [], min: 0, max: 1 },
  ] }] } satisfies Awaited<ReturnType<typeof api.publishOntology>>;
  vi.mocked(api.projects).mockResolvedValue({ items: [project], next_cursor: null });
  vi.mocked(api.ontologies).mockResolvedValue({ items: [version], next_cursor: null });
  const user = userEvent.setup(); render(<Projects onOpen={() => {}} createdUsername={null} />);
  await user.click(await screen.findByRole('button', { name: '查看规范：测试项目' }));
  await screen.findByDisplayValue('empty-enum');
  await user.click(screen.getByTestId('project-submit'));
  await waitFor(() => expect(api.publishOntology).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.publishOntology).mock.calls[0][1]).toEqual({ labels: version.labels, guidelines_markdown: version.guidelines_markdown });
  expect(api.createProject).not.toHaveBeenCalled();
});
it.each(['absent', 'older-supported'] as const)('rescues full physical schema-2 draft after catalog 503 with %s memory without granting write authority', async memory => {
  const projectId = 'catalog-failure-' + memory;
  const assetId = 'physical-' + memory;
  history.replaceState(null, '', '?asset_revision_id=' + assetId);
  const document: DraftRecord['document'] = { schema_version: 1, asset_revision_id: assetId, ontology_version_id: 'fixed-old', coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: 'in_progress', objects: [] };
  const intent = { suggestion_set_id: 'physical-suggestion', change_ids: ['physical-change'], decision: 'accept' as const };
  const supported: DraftRecord = { schema_version: 1, asset_revision_id: assetId, ontology_version_id: 'fixed-old', base_revision_id: 'physical-base', generation: 7, synced_generation: 3, synced_intent_seq: 0, draft_owner: { actor_id: 'original-author', project_id: projectId }, pending_owner: { actor_id: 'original-sender', project_id: projectId }, document, intent_journal: [{ seq: 1, generation: 7, intent, recorded_at: '2026-10-10T00:00:00Z' }], pending: { operation_id: 'physical-operation', generation: 7, journal_seq_end: 1, edit_seq: 9, prepared_at: '2026-10-10T00:00:00Z', request: { operation_id: 'physical-operation', base_revision_id: 'physical-base', document, lease: null, suggestion_decisions: [intent] } }, pending_outcome: 'unknown', used_operation_ids: ['earlier-operation', 'physical-operation'], edit_seq: 9, writes_paused: true, updated_at: '2026-10-10T00:00:00Z' };
  // The physical record is deliberately newer than this client's DraftRecord contract.
  const raw = { ...supported, schema_version: 2, future_metadata: { authors: ['original-author', 'original-sender'], migration: { version: 2, keep: ['unknown', { nested: true }] } }, document: { ...document, future_metadata: { source: 'physical-document' } }, pending: { ...supported.pending!, future_metadata: { receipt: 'retain-verbatim' } }, intent_journal: [{ ...supported.intent_journal[0], future_metadata: { audit: ['do-not-drop'] } }] };
  const originalRaw = structuredClone(raw);
  const stale: DraftRecord = { ...supported, base_revision_id: 'stale-base', generation: 3, synced_generation: 3, document: { ...document, completion: 'unprocessed' }, intent_journal: [], pending: null, pending_owner: null, pending_outcome: 'prepared', used_operation_ids: [], edit_seq: 3 };
  const staleExport = exportNativeDraft(stale, { now: () => Date.parse('2026-10-09T00:00:00Z'), setTimeout: () => 0, clearTimeout: () => {} });
  // Separate retained memory from the physical read to exercise stale-export precedence.
  const originalToRecord = SaveQueue.prototype.toRecord;
  vi.spyOn(SaveQueue.prototype, 'toRecord').mockImplementation(function (this: SaveQueue, id) { return id === assetId ? (memory === 'older-supported' ? structuredClone(stale) : null) : originalToRecord.call(this, id); });
  vi.spyOn(SaveQueue.prototype, 'exportDraft').mockImplementation(id => id === assetId && memory === 'older-supported' ? structuredClone(staleExport) : null);
  let rescueQueue: SaveQueue | null = null;
  const { storage, envelope } = storageFor(assetId, raw);
  const readDraft = vi.spyOn(SaveQueue.prototype, 'readDraftBranches').mockImplementation(async function (this: SaveQueue, id) { rescueQueue = this; return id === assetId ? [structuredClone(envelope)] : []; });
  const restore = vi.spyOn(SaveQueue.prototype, 'forkFromRecord');
  const initialize = vi.spyOn(SaveQueue.prototype, 'initializeFromServerRevision');
  const enqueue = vi.spyOn(SaveQueue.prototype, 'enqueue');
  const persisted = vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(storage.put.bind(storage));
  const nativeLoad = vi.spyOn(EditorHost.prototype, 'loadAsset');
  const save = vi.spyOn(FetchSaveTransport.prototype, 'save');
  const fetchBoundary = vi.fn().mockRejectedValue(new Error('Unexpected HTTP request during raw rescue'));
  vi.stubGlobal('fetch', fetchBoundary);
  vi.mocked(api.projects).mockResolvedValue({ items: [{ ...project, project_id: projectId }], next_cursor: null });
  vi.mocked(api.ontologies).mockRejectedValue(new ApiFailure(503, 'CATALOG_UNAVAILABLE', 'Catalog temporarily unavailable'));
  vi.spyOn(api, 'assets').mockResolvedValue([]);
  const heads = vi.spyOn(api, 'annotationHeads').mockResolvedValue({ items: [], next_cursor: null });
  const annotation = vi.spyOn(api, 'annotation');
  const image = vi.spyOn(api, 'image').mockResolvedValue(new Blob());
  vi.spyOn(api, 'externalProcessingPolicy').mockResolvedValue({ allow_external_processing: false });
  let downloaded: Blob | null = null;
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:physical-rescue'; } static revokeObjectURL() {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  render(<Workbench projectId={projectId} />);
  await userEvent.setup().click(await screen.findByRole('radio'));
  const rescue = screen.getByRole('button', { name: '下载选中分支原始草稿' });
  expect(screen.getByText(/CATALOG_UNAVAILABLE/)).toBeInTheDocument();
  await userEvent.setup().click(rescue);
  expect(downloaded).not.toBeNull();
  const text = typeof downloaded!.text === 'function' ? await downloaded!.text() : await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(downloaded!); });
  expect(JSON.parse(text)).toEqual(originalRaw);
  expect(raw).toEqual(originalRaw);
  expect(restore).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  expect(rescueQueue).not.toBeNull();
  expect(rescueQueue!.getStatus(assetId).local_commit ?? null).toBeNull();
  expect(nativeLoad).not.toHaveBeenCalled(); expect(persisted).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(heads).not.toHaveBeenCalled(); expect(annotation).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
  expect(api.createProject).not.toHaveBeenCalled(); expect(api.publishOntology).not.toHaveBeenCalled();
  expect(fetchBoundary).not.toHaveBeenCalled();
});
it('locates invalid category configuration and retains input without creating editable preview geometry', async () => {
  await start(); const user = userEvent.setup();
  const label = within(screen.getAllByTestId('ontology-label')[0]);
  await user.clear(label.getByLabelText('类别名称')); await user.click(screen.getByTestId('project-submit'));
  expect(label.getByRole('alert')).toHaveTextContent('类别名称');
  expect(label.getByLabelText('类别名称')).toHaveValue(''); expect(label.getByLabelText('类别名称')).toHaveFocus();
  expect(api.createProject).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: '默认对象属性只读预览' })).not.toContainElement(screen.queryByRole('textbox', { name: '几何' }));
});
