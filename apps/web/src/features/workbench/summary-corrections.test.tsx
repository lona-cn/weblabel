import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSaveSummary } from './ProjectSaveSummary';
import { SaveQueue } from '../../lib/persistence/save-queue';
import { InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import type { DraftBranchEnvelope, DraftRecord } from '../../lib/persistence/types';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
const asset: MediaRevision = { asset_id: 'a', asset_revision_id: 'asset', project_id: 'project', original_name: 'image', original_sha256: '', canonical_sha256: '', canonical_width: 640, canonical_height: 480, exif_orientation: 1, original_to_canonical: [], source_group_id: 'g' };
function branch(id: string, synced = false): DraftBranchEnvelope {
  const record: DraftRecord = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 1, synced_generation: synced ? 1 : 0, synced_intent_seq: 0, intent_journal: [], pending: null, draft_owner: { actor_id: 'actor', project_id: 'project' }, document: { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 }, completion: 'in_progress', objects: [] }, updated_at: '2026-10-13T00:00:00Z' };
  return { asset_revision_id: 'asset', draft_id: id, write_token: id + '-token', record, sources: [] };
}
async function show(branches: DraftBranchEnvelope[]) {
  const storage = new InMemoryDraftStorage();
  for (const row of branches) await storage.put(row);
  const queue = new SaveQueue({ storage, owner: { token: {}, actor_id: 'actor', project_id: 'project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }, transport: { async save() { throw new Error('Unexpected send'); }, async fetchHead() { return null; }, async fetchRevision() { throw new Error('Unexpected read'); } } });
  render(<ProjectSaveSummary assets={[asset]} projectId="project" actorId="actor" queue={queue} onSelect={vi.fn()} />);
  await screen.findByText('重新检查本地摘要');
  await vi.waitFor(() => expect(screen.queryByText(/正在只读检查/)).toBeNull());
}
afterEach(cleanup);
it.each(['recover', 'use_server'] as const)('does not count %s sources as unresolved', async action => {
  const a = branch('A'), b = branch('B', true);
  b.sources = [{ draft_id: 'A', write_token: 'A-token', action }];
  await show([a, b]);
  expect(screen.getByText('项目保存队列 · 待同步 0 · 失败 0')).toBeInTheDocument();
});
it('does not accept a stale source token', async () => {
  const a = branch('A'), b = branch('B', true);
  b.sources = [{ draft_id: 'A', write_token: 'wrong-token', action: 'recover' }];
  await show([a, b]);
  expect(screen.getByText('项目保存队列 · 待同步 1 · 失败 0')).toBeInTheDocument();
});
it('locates owned invalid records as rescue-only without exposing raw contents', async () => {
  const a = branch('A');
  a.record = { schema_version: 99, draft_owner: { actor_id: 'actor', project_id: 'project' }, secret: 'do-not-display' };
  await show([a]);
  expect(screen.getByRole('button', { name: 'image · 本地记录未知 / 需救援' })).toBeInTheDocument();
  expect(screen.queryByText('do-not-display')).toBeNull();
});
it('marks identity-unknown summaries incomplete without guessing a locator', async () => {
  const a = branch('A'); a.record = { schema_version: 99, secret: 'unknown-secret' };
  await show([a]);
  expect(screen.getByText(/计数不完整/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /image/ })).toBeNull();
});
it.each([false, true])('overrides an old disk pending after ACK with receipt failure=%s', async failure => {
  const storage = new InMemoryDraftStorage();
  const put = storage.put.bind(storage);
  storage.put = async (row, guard) => { const raw = row.record; if (failure && raw && typeof raw === 'object' && 'synced_generation' in raw && raw.synced_generation === 1) throw new Error('quota'); return put(row, guard); };
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const queue = new SaveQueue({ storage, debounceMs: 60000, owner: { token: {}, actor_id: 'actor', project_id: 'project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }, transport: { async save(request) { entered(); await held; return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: 'ack', parent_revision_id: 'base', revision_no: 2, document: request.document, created_at: '2026-10-13T00:00:00Z', created_by: 'actor', content_hash: 'hash' } }; }, async fetchHead() { return null; }, async fetchRevision() { throw new Error('Unexpected read'); } } });
  const source = branch('seed').record;
  if (!source || typeof source !== 'object' || !('document' in source)) throw new Error('Bad fixture');
  const record = source as DraftRecord; // Locally constructed fixture.
  queue.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: 'base', generation: 1, document: record.document });
  const saving = queue.flush('asset'); await started;
  render(<ProjectSaveSummary assets={[asset]} projectId="project" actorId="actor" queue={queue} onSelect={vi.fn()} />);
  await vi.waitFor(() => expect(screen.queryByText(/正在只读检查/)).toBeNull());
  expect(screen.getByText('项目保存队列 · 待同步 1 · 失败 1')).toBeInTheDocument();
  release(); await saving;
  await vi.waitFor(() => expect(screen.getByText('项目保存队列 · 待同步 0 · 失败 ' + (failure ? '1' : '0'))).toBeInTheDocument());
});
it('never admits or displays another authors invalid raw record', async () => {
  const a = branch('A'); a.record = { schema_version: 99, draft_owner: { actor_id: 'other', project_id: 'project' }, secret: 'foreign-secret' };
  await show([a]);
  expect(screen.queryByRole('button', { name: /image/ })).toBeNull();
  expect(screen.queryByText(/计数不完整/)).toBeNull();
});
it.each([0, 29])('keeps repeated unowned snapshots at generation %s in collapsed history, not alerts', async generation => {
  const rows = [branch('reload-1', true), branch('reload-2', true), branch('reload-3', true)];
  for (const row of rows) { admitSnapshot(row, generation); }
  await show(rows);
  expect(screen.getByText('项目保存队列 · 待同步 0 · 失败 0')).toBeInTheDocument();
  expect(screen.queryByText(/计数不完整/)).toBeNull();
  const history = screen.getByText('只读快照留档 · 3 条（无待处理操作）').closest('details')!;
  expect(history).not.toHaveAttribute('open');
  expect(screen.getAllByText('规范 ontology · base base · 只读留档')).toHaveLength(3);
});
function admitSnapshot(row: DraftBranchEnvelope, generation: number) {
  // Locally constructed fixture, not disk admission.
  const raw = row.record as DraftRecord;
  raw.draft_owner = null; raw.pending_owner = null;
  raw.generation = generation; raw.synced_generation = generation;
  raw.pending_outcome = 'prepared'; raw.save_error = null; raw.writes_paused = false;
}
it.each(['unknown', 'rejected', 'dirty', 'failed', 'malformed'])('keeps unowned %s records visible as incomplete warnings', async kind => {
  const row = branch('warning', true); admitSnapshot(row, 29);
  const raw = row.record as DraftRecord; // Locally constructed fixture.
  if (kind === 'unknown' || kind === 'rejected') raw.pending_outcome = kind;
  if (kind === 'dirty') raw.synced_generation = 0;
  if (kind === 'failed') raw.save_error = { kind: 'network', code: 'OFFLINE', message: 'offline', status: null, request_id: null };
  if (kind === 'malformed') row.record = { ...raw, schema_version: 99 };
  await show([row]);
  expect(screen.getByText(/计数不完整/)).toBeInTheDocument();
  expect(screen.queryByText(/只读快照留档/)).toBeNull();
});
it('excludes a valid synchronized snapshot with a concrete foreign author', async () => {
  const row = branch('foreign', true);
  const raw = row.record as DraftRecord; // Locally constructed fixture.
  raw.draft_owner = { actor_id: 'other', project_id: 'project' };
  raw.pending_owner = null;
  await show([row]);
  expect(screen.queryByText(/只读快照留档/)).toBeNull();
  expect(screen.queryByRole('button', { name: /image/ })).toBeNull();
  expect(screen.queryByText(/计数不完整/)).toBeNull();
});
