import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { SaveStatus } from './SaveStatus';
import { ProjectSaveSummary } from './ProjectSaveSummary';
import { DraftComparison } from './DraftComparison';
import type { MediaRevision } from '../../../../../packages/contracts/generated/MediaRevision';
import { InMemoryDraftStorage, serializeNativeDraft } from '../../lib/persistence/draft-store';
import { runRecovery } from '../../lib/persistence/recovery';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import { SAVE_DEBOUNCE_MS, StorageError, TransportError } from '../../lib/persistence/types';
import type {
  AnnotationDocument, AnnotationRevision, ConflictAction, ConflictResolution,
  DraftRecord, DraftStorage, DraftBranchEnvelope, SaveRequest, SaveResponse, SaveTransport,
} from '../../lib/persistence/types';

expect.extend(matchers);
async function seedBranch(storage: DraftStorage, record: DraftRecord) {
  const envelope = { asset_revision_id: record.asset_revision_id, draft_id: crypto.randomUUID(), write_token: crypto.randomUUID(), record, sources: [] };
  await storage.put(envelope);
  return envelope;
}

const asset = 'asset_revision_golden';
const scope = 'project-a/asset-a/user-a/host-a';
const intent = { suggestion_set_id: 'suggestion-a', change_ids: ['change-a'], decision: 'accept' as const };
function document(completion: AnnotationDocument['completion'] = 'in_progress'): AnnotationDocument {
  return {
    schema_version: 1, asset_revision_id: asset, ontology_version_id: 'ontology_v1',
    coordinate_space: { type: 'canonical_image_pixels', width: 640, height: 480 },
    completion, objects: [],
  };
}
function revision(id = 'server-r9'): AnnotationRevision {
  return {
    annotation_revision_id: id, parent_revision_id: 'r7', revision_no: 9,
    document: document(), created_at: '2026-10-10T00:00:00Z', created_by: 'user-a', content_hash: `hash-${id}`,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}
const network = () => new TransportError({ kind: 'network', code: 'NETWORK_UNREACHABLE', message: 'connection lost after send' });
function failure(status: number, code: string) {
  return new TransportError({
    kind: status === 409 ? 'conflict' : 'http', status, code, message: 'server denied this request',
    api_error: { code, message: 'server denied this request', request_id: 'request-save-17', details: null },
  });
}
interface SaveFeedbackFixture {
  queue: SaveQueue;
  storage: DraftStorage;
  transport: {
    save: Mock<SaveTransport['save']>;
    fetchHead: Mock<SaveTransport['fetchHead']>;
    fetchRevision: Mock<SaveTransport['fetchRevision']>;
  };
  enqueue: (generation?: number, completion?: AnnotationDocument['completion']) => void;
  setLease: (lease: SaveRequest['lease']) => void;
}
function fixture(storage: DraftStorage = new InMemoryDraftStorage()): SaveFeedbackFixture {
  let count = 0;
  let lease: SaveRequest['lease'] = null;
  const transport = {
    save: vi.fn<SaveTransport['save']>(async () => { throw network(); }),
    fetchHead: vi.fn<SaveTransport['fetchHead']>(async () => revision()),
    fetchRevision: vi.fn<SaveTransport['fetchRevision']>(async (id) => revision(id)),
  };
  const queue = new SaveQueue({ storage, transport, newOperationId: () => `op-${++count}`,
    owner: { token: {}, actor_id: 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => lease } });
  const enqueue = (generation = 8, completion: AnnotationDocument['completion'] = 'in_progress') => queue.enqueue({
    asset_revision_id: asset, ontology_version_id: 'ontology_v1', base_revision_id: 'r7',
    generation, document: document(completion), suggestion_decisions: [intent],
  });
  return { queue, transport, storage, enqueue, setLease: (next: SaveRequest['lease']) => { lease = next; } };
}
it('locates a previous image failure while the current image is synced, without exposing another author', async () => {
  const f = fixture(), select = vi.fn();
  f.enqueue(); await f.queue.flush(asset);
  const media = (id: string): MediaRevision => ({ asset_id: id, asset_revision_id: id, project_id: 'test-project', original_name: id + '.png', original_sha256: 'original', canonical_sha256: 'canonical', canonical_width: 640, canonical_height: 480, exif_orientation: 1, original_to_canonical: [1,0,0,0,1,0,0,0,1], source_group_id: 'group' });
  const original = f.queue.toRecord(asset)!; await seedBranch(f.storage, { ...original, asset_revision_id: 'foreign', document: { ...original.document, asset_revision_id: 'foreign' }, draft_owner: { actor_id: 'other', project_id: 'test-project' } });
  const current = media('current'), previous = media(asset);
  render(<ProjectSaveSummary assets={[previous, current, media('foreign')]} projectId="test-project" actorId="test-actor" queue={f.queue} onSelect={select} />);
  await act(async () => { await drain(); });
  const button = screen.getByRole('button', { name: asset + '.png · 保存失败 / 结果待核对' });
  expect(screen.queryByRole('button', { name: /foreign.png/ })).toBeNull();
  fireEvent.click(button); expect(select).toHaveBeenCalledExactlyOnceWith(previous);
  expect(f.queue.getOwnedSummary(asset, 'other-project', 'test-actor')).toBeNull();
  expect(f.queue.getOwnedSummary(asset, 'test-project', 'other')).toBeNull();
  expect(f.queue.toRecord(asset)).toEqual(original);
});
it('compares object attributes and completion read-only without rewriting a paused raw branch', async () => {
  const f = fixture(); f.enqueue(); await f.queue.flush(asset);
  const object: AnnotationDocument['objects'][number] = { object_id: 'difference', label_id: 'label', geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 1, x_max: 2, y_max: 2 }, attributes: { flag: false, text: null }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } };
  const raw = { ...f.queue.toRecord(asset)!, writes_paused: true, document: { ...document('complete'), objects: [object] }, extra_future_field: { retain: true } };
  const serverDocument = { ...document(), objects: [{ ...object, attributes: { flag: null, text: '' } }] };
  const envelope = { asset_revision_id: asset, draft_id: 'comparison', write_token: 'token', record: raw, sources: [] }; const before = structuredClone(raw);
  const view = render(<DraftComparison envelope={envelope} server={serverDocument} readable />);
  const detail = screen.getByText(/只读文档差异/).closest('details')!; detail.open = true; fireEvent(detail, new Event('toggle'));
  await act(async () => { await drain(); });
  expect(screen.getByRole('button', { name: '下一页差异' })).toBeDisabled();
  const comparison = [...view.container.querySelectorAll('pre')].map(node => JSON.parse(node.textContent!));
  expect(comparison).toEqual([serverDocument.objects[0], object]);
  expect(raw).toEqual(before); expect(raw.writes_paused).toBe(true);
});

function resolve(queue: SaveQueue, action: ConflictAction, guard: () => boolean = () => true): Promise<ConflictResolution> {
  return queue.resolveConflict(asset, action, guard);
}
function panel(f: SaveFeedbackFixture, extra = {}) {
  const props = { queue: f.queue, asset_revision_id: asset, scopeKey: scope,
    isCurrentScope: (key: string) => key === scope, canWrite: (key: string) => key === scope, canReconcileInScope: (key: string) => key === scope, canRetryOwnedFuture: () => false, ...extra };
  return createElement(SaveStatus, props);
}
function recordContent(record: DraftRecord | null) {
  if (!record) throw new Error('expected a retained draft');
  const { updated_at: _timestamp, ...content } = record;
  return content;
}
function nestedObjects(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(nestedObjects)];
}
function openDiagnostic(code: string) {
  const region = screen.getAllByTestId('save-diagnostic').find(candidate => within(candidate).queryByText(code, { selector: 'dd' }));
  if (!region) throw new Error(`Missing diagnostic for ${code}`);
  const summary = region.querySelector('summary');
  if (!summary) throw new Error('Diagnostic has no disclosure control');
  fireEvent.click(summary);
  return within(region);
}

async function retainedRejected(f: SaveFeedbackFixture, future = false, unknown = false) {
  f.enqueue();
  f.transport.save.mockRejectedValueOnce(failure(422, 'INVALID_DOCUMENT'));
  await f.queue.flush(asset);
  const record = f.queue.toRecord(asset)!;
  record.writes_paused = true;
  record.save_error = { kind: 'http', code: 'PENDING_OWNER_MISMATCH', message: 'original author retained', status: null, request_id: null };
  if (future) {
    record.generation = 9;
    record.document = document('confirmed_negative');
    record.intent_journal.push({ seq: 2, generation: 9, intent: { ...intent, decision: 'revert' }, recorded_at: record.updated_at });
  }
  if (unknown) record.pending_outcome = 'unknown';
  let nextOperation = 0;
  f.queue = new SaveQueue({ storage: f.storage, transport: f.transport, newOperationId: () => `restored-op-${++nextOperation}`,
    owner: { token: {}, actor_id: 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null } });
  await f.queue.forkFromRecord(await seedBranch(f.storage, record));
  await f.queue.whenPersisted(asset);
  f.transport.save.mockClear();
  return f.queue.exportDraft(asset)!;
}

describe('C07 retained-only UI eligibility', () => {
  it.each([false, true])('replays the exact owned noheld original despite stale diagnosis without fresh permission (unknown=%s)', async (unknown) => {
    const f = fixture();
    const original = await retainedRejected(f, false, unknown);
    const retained = f.queue.toRecord(asset)!;
    const prepare = vi.fn(() => false);
    const newOperation = vi.fn(() => 'forbidden-new-operation');
    f.queue = new SaveQueue({ storage: f.storage, transport: f.transport, newOperationId: newOperation,
      owner: { token: {}, actor_id: 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: prepare, getLease: () => null } });
    await f.queue.forkFromRecord(await seedBranch(f.storage, retained));
    await f.queue.whenPersisted(asset);
    prepare.mockClear();
    const onResumeLocal = vi.fn();
    f.transport.save.mockResolvedValueOnce({ operation_id: original.pending!.operation_id, revision: revision(), idempotent_replay: true });
    render(panel(f, { canWrite: () => false, canReconcileInScope: () => true, onResumeLocal }));
    expect(screen.getByTestId('save-retry')).toBeEnabled();
    fireEvent.click(screen.getByTestId('save-retry'));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save.mock.calls).toEqual([[original.pending!.request, asset]]);
    expect(f.queue.toRecord(asset)).toMatchObject({ pending: null, base_revision_id: 'server-r9', synced_generation: 8 });
    expect(newOperation).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(onResumeLocal).not.toHaveBeenCalled();
  });

  it.each(['storage failure', 'held storage'] as const)('ordinary automatic ACK with %s permits only original-scope local commit retry', async (mode) => {
    const storage = new InMemoryDraftStorage();
    let block = false;
    let fail = mode === 'storage failure';
    const gate = deferred<void>();
    const response = deferred<SaveResponse>();
    const puts = vi.fn(async (envelope: DraftBranchEnvelope, guard?: () => boolean) => {
      const value = envelope.record as DraftRecord;
      if (block && value.pending === null) {
        if (fail) throw new StorageError({ code: 'STORAGE_FAILED', message: 'disk denied' });
        await gate.promise;
      }
      if (guard && !guard()) return false;
      return storage.put(envelope, guard);
    });
    const f = fixture({ list: storage.list.bind(storage), get: storage.get.bind(storage), delete: storage.delete.bind(storage), put: puts });
    f.transport.save.mockImplementationOnce(() => response.promise);
    const onResumeLocal = vi.fn();
    render(panel(f, { canWrite: () => false, canReconcileInScope: () => true, onResumeLocal }));
    act(() => f.enqueue());
    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS); await drain(); });
    await f.queue.whenPersisted(asset);
    const original = f.queue.toRecord(asset)!;
    const physical = ((await storage.get(asset, f.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))?.record as DraftRecord | null);
    expect(original.writes_paused).toBe(false);
    expect(f.transport.save.mock.calls).toEqual([[original.pending!.request, asset]]);
    block = true;
    await act(async () => {
      response.resolve({ operation_id: original.pending!.operation_id, revision: revision(), idempotent_replay: false });
      await drain();
    });
    const acknowledged = f.queue.getStatus(asset).last_ack;
    const retained = f.queue.exportDraft(asset)!;
    expect(f.queue.toRecord(asset)?.pending).toBeNull();
    expect(acknowledged?.revision_id).toBe('server-r9');
    expect(f.queue.getStatus(asset)).toMatchObject({ writes_paused: true, local_commit: null });
    if (mode === 'storage failure') expect(f.queue.getStatus(asset)).toMatchObject({ phase: 'storage_error', last_error: { code: 'STORAGE_FAILED' } });
    expect(((await storage.get(asset, f.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(physical);
    expect(screen.getByTestId('save-retry')).toBeEnabled();
    expect(within(screen.getByTestId('save-certificate')).queryByText('local_commit.generation', { selector: 'dt' })).not.toBeInTheDocument();
    expect(onResumeLocal).not.toHaveBeenCalled();
    const putCount = puts.mock.calls.length;
    fail = false;
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(screen.getByTestId('save-retry')).toBeDisabled();
    expect(f.queue.getStatus(asset).local_commit).toBeNull();
    expect(onResumeLocal).not.toHaveBeenCalled();
    expect(f.queue.getStatus(asset).last_ack).toBe(acknowledged);
    expect(f.queue.exportDraft(asset)?.document).toEqual(retained.document);
    expect(f.queue.exportDraft(asset)?.intent_journal).toEqual(retained.intent_journal);
    expect(f.queue.toRecord(asset)?.used_operation_ids).toEqual(original.used_operation_ids);
    expect(((await storage.get(asset, f.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))?.record as DraftRecord | null)).toEqual(physical);
    await act(async () => { gate.resolve(); await drain(); });
    await act(async () => { await f.queue.whenPersisted(asset); await drain(); });
    expect(puts.mock.calls.slice(putCount).map(([value]) => (value.record as DraftRecord).pending)).toEqual([null]);
    expect(f.transport.save.mock.calls).toEqual([[original.pending!.request, asset]]);
    expect(f.queue.toRecord(asset)).toMatchObject({ pending: null, base_revision_id: 'server-r9', generation: 8, synced_generation: 8 });
    expect(f.queue.getStatus(asset).local_commit).toMatchObject({ generation: 8 });
    expect(f.queue.getStatus(asset).last_ack).toBe(acknowledged);
    expect(f.queue.exportDraft(asset)?.document).toEqual(retained.document);
    expect(f.queue.exportDraft(asset)?.intent_journal).toEqual(retained.intent_journal);
    expect(f.queue.toRecord(asset)?.used_operation_ids).toEqual(original.used_operation_ids);
    expect(((await storage.get(asset, f.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))?.record as DraftRecord | null)).toMatchObject({ pending: null, document: retained.document, intent_journal: retained.intent_journal, base_revision_id: 'server-r9' });
    expect(onResumeLocal).not.toHaveBeenCalled();
  });

  it('does not treat a restored paused pendingless future as an actual ACK local barrier', async () => {
    const f = fixture();
    await retainedRejected(f, true);
    const retained = f.queue.toRecord(asset)!;
    retained.pending = null;
    retained.pending_owner = null;
    retained.pending_outcome = 'prepared';
    f.queue = new SaveQueue({ storage: f.storage, transport: f.transport, newOperationId: () => 'forbidden-new-operation',
      owner: { token: {}, actor_id: 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => false, getLease: () => null } });
    await f.queue.forkFromRecord(await seedBranch(f.storage, retained));
    await f.queue.whenPersisted(asset);
    const before = f.queue.exportDraft(asset)!;
    render(panel(f, { canWrite: () => false, canReconcileInScope: () => true }));
    expect(screen.getByTestId('save-retry')).toBeDisabled();
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save).not.toHaveBeenCalled();
    expect(f.queue.exportDraft(asset)?.document).toEqual(before.document);
    expect(f.queue.exportDraft(asset)?.pending).toBeNull();
  });

  it.each(['lost role', 'old scope'] as const)('%s cannot start retained-only replay', async (mode) => {
    const f = fixture();
    const original = await retainedRejected(f);
    render(panel(f, { canWrite: () => false, canReconcileInScope: () => mode !== 'lost role', isCurrentScope: () => mode !== 'old scope' }));
    expect(screen.getByTestId('save-retry')).toBeDisabled();
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save).not.toHaveBeenCalled();
    expect(f.queue.exportDraft(asset)?.pending).toEqual(original.pending);
  });
});
describe('C07 exact retained rejected replay', () => {
  it('sends original null-lease body once, holds edit barrier until ACK and preserves future work', async () => {
    const f = fixture();
    const original = await retainedRejected(f, true);
    f.setLease({ task_id: 'new-task', fencing_token: 99 });
    const reply = deferred<SaveResponse>();
    f.transport.save.mockImplementationOnce(() => reply.promise);
    const onResumeLocal = vi.fn();
    render(panel(f, { onResumeLocal }));
    fireEvent.click(screen.getByTestId('save-retry'));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save.mock.calls).toEqual([[original.pending!.request, asset]]);
    expect(f.queue.getStatus(asset)).toMatchObject({ writes_paused: true, last_error: { code: 'PENDING_OWNER_MISMATCH' } });
    expect(onResumeLocal).not.toHaveBeenCalled();
    await act(async () => { reply.resolve({ operation_id: original.pending!.operation_id, revision: revision(), idempotent_replay: true }); await drain(); });
    expect(f.transport.save).toHaveBeenCalledTimes(1);
    expect(f.queue.toRecord(asset)).toMatchObject({ generation: 9, synced_generation: 8, synced_intent_seq: 1, document: document('confirmed_negative'), pending: null });
    expect(f.queue.exportDraft(asset)?.intent_journal).toEqual(original.intent_journal);
    expect(f.queue.getStatus(asset).local_commit).toMatchObject({ generation: 9 });
    expect(onResumeLocal).toHaveBeenCalledTimes(1);
  });

  it.each(['403', '422', '409', '502', 'invalid ACK', 'invalid document', 'missing revision', 'network'] as const)('%s keeps paused request and cannot fall through to new lease operation', async (mode) => {
    const f = fixture();
    const original = await retainedRejected(f);
    if (mode === 'invalid ACK') f.transport.save.mockResolvedValueOnce({ operation_id: 'foreign-operation', revision: revision(), idempotent_replay: false });
    else if (mode === 'invalid document' || mode === 'missing revision') f.transport.save.mockResolvedValueOnce({ operation_id: original.pending!.operation_id, revision: { ...revision(), ...(mode === 'invalid document' ? { document: document('confirmed_negative') } : { annotation_revision_id: '' }) }, idempotent_replay: false });
    else f.transport.save.mockRejectedValueOnce(mode === 'network' ? network() : failure(Number(mode), mode === '409' ? 'LEASE_REQUIRED' : 'DENIED'));
    const onResumeLocal = vi.fn();
    render(panel(f, { onResumeLocal }));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save.mock.calls).toEqual([[original.pending!.request, asset]]);
    expect(f.queue.getStatus(asset)).toMatchObject({ writes_paused: true, dirty: true });
    expect(f.queue.exportDraft(asset)?.pending).toEqual(original.pending);
    expect(onResumeLocal).not.toHaveBeenCalled();
    if (mode === 'network' || mode === '502' || mode === 'invalid ACK' || mode === 'invalid document' || mode === 'missing revision') {
      expect(f.queue.toRecord(asset)?.pending_outcome).toBe('unknown');
      f.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_REQUIRED'));
      await act(async () => { fireEvent.click(screen.getByTestId('save-retry')); await drain(); });
      expect(f.queue.toRecord(asset)?.pending_outcome).toBe('unknown');
      expect(await f.queue.retryRejectedLease(asset)).toBe(false);
      expect(f.transport.save.mock.calls[1]).toEqual([original.pending!.request, asset]);
    }
  });
  it.each([false, true])('historical unknown retains partial ACK next generation behavior unless new scope permission expires (%s)', async (expire) => {
    const f = fixture();
    await retainedRejected(f, true, true);
    const restored = f.queue.toRecord(asset)!;
    const original = restored.pending!;
    let allowed = true;
    const unsubscribe = f.queue.subscribe(asset, () => { if (expire && f.queue.getStatus(asset).last_ack) allowed = false; });
    f.transport.save.mockResolvedValueOnce({ operation_id: original.operation_id, revision: revision(), idempotent_replay: true });
    f.transport.save.mockRejectedValueOnce(network());
    await f.queue.retry(asset, () => allowed);
    await f.queue.whenPersisted(asset);
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    unsubscribe();
    expect(f.transport.save.mock.calls[0]).toEqual([original.request, asset]);
    expect(f.queue.getStatus(asset).synced_generation).toBe(8);
    if (expire) {
      expect(f.transport.save).toHaveBeenCalledTimes(1);
      expect(f.queue.toRecord(asset)?.pending).toBeNull();
    } else {
      expect(f.transport.save).toHaveBeenCalledTimes(2);
      expect(f.transport.save.mock.calls[1][0]).toMatchObject({ base_revision_id: 'server-r9', document: document('confirmed_negative'), suggestion_decisions: [{ ...intent, decision: 'revert' }] });
      expect(f.transport.save.mock.calls[1][0].operation_id).not.toBe(original.operation_id);
    }
  });
});
describe('C07 actual ACK durable resume', () => {
  it.each(['commit', 'storage failure', 'scope expiry', 'owner replacement', 'role revoked'] as const)('%s resumes only after latest certificate with still current scope', async (mode) => {
    const storage = new InMemoryDraftStorage();
    const gate = deferred<void>();
    let hold = false;
    const boundary: DraftStorage = {
      list: storage.list.bind(storage), get: storage.get.bind(storage), delete: storage.delete.bind(storage),
      put: async (envelope, guard) => { const value = envelope.record as DraftRecord;
        if (hold && value.pending === null) {
          await gate.promise;
          if (mode === 'storage failure') throw new StorageError({ code: 'STORAGE_FAILED', message: 'disk denied' });
        }
        if (guard && !guard()) return false;
        return storage.put(envelope, guard);
      },
    };
    const f = fixture(boundary);
    const original = await retainedRejected(f);
    hold = true;
    let current = true;
    const onResumeLocal = vi.fn();
    f.transport.save.mockResolvedValueOnce({ operation_id: original.pending!.operation_id, revision: revision(), idempotent_replay: true });
    render(panel(f, { onResumeLocal, isCurrentScope: () => current }));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save).toHaveBeenCalledTimes(1);
    expect(onResumeLocal).not.toHaveBeenCalled();
    expect(f.queue.getStatus(asset).local_commit).toBeNull();
    if (mode === 'scope expiry') current = false;
    if (mode === 'owner replacement' || mode === 'role revoked') f.queue.setWriteOwner({ token: {}, actor_id: 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => mode !== 'role revoked', canPrepareOperation: () => true, getLease: () => null });
    await act(async () => { gate.resolve(); await drain(); });
    if (mode === 'commit') expect(onResumeLocal).toHaveBeenCalledTimes(1);
    else expect(onResumeLocal).not.toHaveBeenCalled();
    if (mode === 'storage failure') {
      expect(f.queue.getStatus(asset)).toMatchObject({ phase: 'storage_error', local_commit: null, last_error: { code: 'STORAGE_FAILED' } });
      expect(f.queue.exportDraft(asset)?.document).toEqual(original.document);
    }
    if (mode !== 'commit') expect(f.queue.getStatus(asset).local_commit).toBeNull();
  });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('C07 lease refusal is not a CAS resolver', () => {
  it('keeps the exact refused operation and rescue while readonly server view cannot adopt or rebase it', async () => {
    const f = fixture();
    f.enqueue();
    f.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_REQUIRED'));
    await f.queue.flush(asset);
    const before = f.queue.exportDraft(asset)!;
    render(panel(f));
    expect(screen.queryByTestId('conflict-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-status')).toHaveAttribute('data-phase', 'paused');
    expect(screen.getByTestId('export-local-draft')).toBeEnabled();
    fireEvent.click(screen.getByTestId('save-view-server'));
    await act(drain);
    const after = f.queue.exportDraft(asset)!;
    expect(after.pending).toEqual(before.pending);
    expect(after.pending_owner).toEqual(before.pending_owner);
    expect(after.draft_owner).toEqual(before.draft_owner);
    expect(after.intent_journal).toEqual(before.intent_journal);
    expect(f.queue.getStatus(asset)).toMatchObject({ dirty: true, writes_paused: true });
  });
});

describe('C07 restored source cannot be recertified by another scope', () => {
  it.each(['different actor', 'write role revoked'] as const)('%s cannot overwrite the stored original rejection or mint current local commit', async (mode) => {
    const storage = new InMemoryDraftStorage();
    const source = fixture(storage);
    source.enqueue();
    source.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_REQUIRED'));
    await source.queue.flush(asset);
    await source.queue.whenPersisted(asset);
    const original = ((await storage.get(asset, source.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))!.record as DraftRecord);
    const restored = fixture(storage);
    restored.queue.setWriteOwner({ token: {}, actor_id: mode === 'different actor' ? 'actor-b' : 'test-actor', project_id: 'test-project', isCurrent: () => true, isWritable: () => mode !== 'write role revoked', canPrepareOperation: () => true, getLease: () => null });
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, original));
    await restored.queue.whenPersisted(asset);
    render(panel(restored, { canWrite: () => false }));
    expect(screen.getByTestId('save-retry')).toBeDisabled();
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(restored.transport.save).not.toHaveBeenCalled();
    expect((await storage.get(asset, source.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id))?.record).toEqual(original);
    expect(restored.queue.getStatus(asset).local_commit).toBeNull();
    expect(within(screen.getByTestId('save-certificate')).queryByText('local_commit.generation', { selector: 'dt' })).not.toBeInTheDocument();
    expect(restored.queue.exportDraft(asset)?.pending).toEqual(original.pending);
    expect(restored.queue.exportDraft(asset)?.intent_journal).toEqual(original.intent_journal);
  });
});

describe('C07 current local commit evidence', () => {
  it('does not confirm a new generation using the previous completed storage write', async () => {
    const storage = new InMemoryDraftStorage();
    const f = fixture(storage);
    f.enqueue();
    await drain();
    expect(f.queue.getStatus(asset).phase).toBe('saved_local');
    const next = deferred<void>();
    vi.spyOn(storage, 'put').mockImplementationOnce(async (envelope, guard) => { await next.promise; return InMemoryDraftStorage.prototype.put.call(storage, envelope, guard); });
    render(panel(f));
    act(() => f.enqueue(9, 'confirmed_negative'));
    expect(f.queue.getStatus(asset).phase).toBe('unsaved');
    expect(screen.getByTestId('save-status')).toHaveAttribute('data-phase', 'unsaved');
    next.resolve();
    await act(drain);
    expect(f.queue.getStatus(asset).phase).toBe('saved_local');
  });

  it('same-generation journal edit must wait for its own storage commit', async () => {
    const storage = new InMemoryDraftStorage();
    const f = fixture(storage);
    f.enqueue();
    await drain();
    const next = deferred<void>();
    vi.spyOn(storage, 'put').mockImplementationOnce(async (envelope, guard) => { await next.promise; return InMemoryDraftStorage.prototype.put.call(storage, envelope, guard); });
    f.enqueue(8);
    expect(f.queue.getStatus(asset).phase).toBe('unsaved');
    next.resolve();
    await drain();
    expect(f.queue.toRecord(asset)?.intent_journal.map((entry) => entry.intent)).toEqual([intent, intent]);
    expect(f.queue.getStatus(asset).phase).toBe('saved_local');
  });

  it('old commit completion cannot confirm a newer pending record', async () => {
    const old = deferred<void>();
    const latest = deferred<void>();
    const storage = new InMemoryDraftStorage();
    vi.spyOn(storage, 'put').mockImplementationOnce(async (envelope, guard) => { await old.promise; return InMemoryDraftStorage.prototype.put.call(storage, envelope, guard); }).mockImplementationOnce(async (envelope, guard) => { await latest.promise; return InMemoryDraftStorage.prototype.put.call(storage, envelope, guard); });
    const f = fixture(storage);
    f.enqueue(8);
    f.enqueue(9, 'confirmed_negative');
    old.resolve();
    await drain();
    expect(f.queue.getStatus(asset).phase).toBe('unsaved');
    latest.resolve();
    await drain();
    expect(f.queue.getStatus(asset).phase).toBe('saved_local');
  });
});

describe('C07 historical unknown operation preservation', () => {
  it.each([409, 403])('unknown send then lease rejection %s cannot mint a fresh operation', async (status) => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset); // The first send may have committed; reply was lost.
    const original = f.queue.toRecord(asset)?.pending;
    f.transport.save.mockRejectedValueOnce(failure(status, 'LEASE_NOT_HELD'));
    await f.queue.retry(asset);
    expect(f.transport.save.mock.calls[1][0]).toEqual(original?.request);
    f.setLease({ task_id: 'task-a', fencing_token: 42 });
    const handled = await f.queue.retryRejectedLease(asset);
    expect(handled).toBe(false);
    expect(f.transport.save.mock.calls).toHaveLength(2);
    expect(f.queue.toRecord(asset)?.pending).toEqual(original);
    expect(f.queue.toRecord(asset)?.synced_generation).toBe(0);
    render(panel(f));
    expect(screen.getAllByRole('alert').some(node => node.getAttribute('data-save-outcome') === 'unknown')).toBe(true);
    expect(screen.getAllByRole('alert').every(node => node.getAttribute('data-save-outcome') !== 'rejected')).toBe(true);
    const diagnostic = openDiagnostic('LEASE_NOT_HELD');
    expect(diagnostic.getByText('LEASE_NOT_HELD', { selector: 'dd' })).toBeVisible();
    expect(f.queue.toRecord(asset)?.pending_outcome).toBe('unknown');
  });

  it('restart preserves historical uncertainty rather than treating the next 409 as definitive', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    const stored = JSON.parse(JSON.stringify(f.queue.toRecord(asset))) as DraftRecord;
    const restored = fixture();
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, stored));
    restored.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_EXPIRED'));
    await restored.queue.retry(asset);
    restored.setLease({ task_id: 'task-a', fencing_token: 43 });
    expect(await restored.queue.retryRejectedLease(asset)).toBe(false);
    expect(restored.transport.save.mock.calls).toHaveLength(1);
    expect(restored.queue.toRecord(asset)?.pending).toEqual(stored.pending);
  });

  it('matching head and body is not an immutable operation acknowledgement', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    const before = recordContent(f.queue.toRecord(asset));
    f.transport.fetchHead.mockResolvedValue(revision('r7'));
    await resolve(f.queue, 'view_server');
    expect(recordContent(f.queue.toRecord(asset))).toEqual(before);
    expect(f.queue.getStatus(asset).synced_generation).toBe(0);
  });

  it('keep-local rescue cannot discard unknown pending and restart automatic writes', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    await f.queue.forkFromRecord(await seedBranch(f.storage, f.queue.toRecord(asset)!), { pauseForUserChoice: true, expectedCurrent: f.queue.getStatus(f.queue.toRecord(asset)!.asset_revision_id).local_commit });
    const before = recordContent(f.queue.toRecord(asset));
    await resolve(f.queue, 'keep_local_export');
    expect(recordContent(f.queue.toRecord(asset))).toEqual(before);
    expect(f.queue.getStatus(asset).writes_paused).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.transport.save.mock.calls).toHaveLength(1);
  });

  it('storage failure rescue serializes the entire prepared payload and ordered journal', async () => {
    const storage = new InMemoryDraftStorage();
    const f = fixture(storage);
    f.enqueue();
    await f.queue.flush(asset);
    const source = await seedBranch(f.storage, f.queue.toRecord(asset)!);
    storage.failNextPut(new StorageError({ code: 'QUOTA_EXCEEDED', message: 'disk quota exceeded' }));
    await f.queue.forkFromRecord(source, { pauseForUserChoice: true, expectedCurrent: f.queue.getStatus(asset).local_commit });
    await drain();
    const before = f.queue.toRecord(asset)!;
    const rescue = JSON.parse(serializeNativeDraft(f.queue.exportDraft(asset)!));
    // Assert recoverable content, not the spelling of a newly added export field.
    expect(nestedObjects(rescue)).toContainEqual(before.pending);
    expect(rescue.document).toEqual(before.document);
    expect(rescue.intent_journal).toEqual(before.intent_journal);
    expect(rescue.unsynced).toBe(true);
  });
});

describe('C07 read failures and captured mutation guards', () => {
  it.each(['network', 'http', 'schema'])('head %s failure remains an error and retains pending', async (kind) => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    await f.queue.forkFromRecord(await seedBranch(f.storage, f.queue.toRecord(asset)!), { pauseForUserChoice: true, expectedCurrent: f.queue.getStatus(f.queue.toRecord(asset)!.asset_revision_id).local_commit });
    const before = recordContent(f.queue.toRecord(asset));
    const error = kind === 'network' ? network() : failure(kind === 'http' ? 500 : 502, kind === 'http' ? 'DATABASE_FAILED' : 'INVALID_ANNOTATION');
    f.transport.fetchHead.mockRejectedValue(error);
    await expect(resolve(f.queue, 'view_server')).rejects.toMatchObject({ kind: error.kind, code: error.code, message: error.message });
    expect(recordContent(f.queue.toRecord(asset))).toEqual(before);
    expect(f.queue.exportDraft(asset)?.document).toEqual(before.document);
  });

  it.each(['scope', 'write-role', 'new-edit'])('late head cannot resume after %s changes', async (change) => {
    const f = fixture();
    f.enqueue();
    f.transport.save.mockRejectedValueOnce(failure(409, 'REVISION_CONFLICT'));
    await f.queue.flush(asset);
    const head = deferred<AnnotationRevision | null>();
    f.transport.fetchHead.mockReturnValueOnce(head.promise);
    let current = true;
    let writable = true;
    const resolving = resolve(f.queue, 'keep_local_export', () => current && writable).catch(() => null);
    if (change === 'scope') current = false;
    if (change === 'write-role') writable = false;
    if (change === 'new-edit') f.enqueue(9, 'confirmed_negative');
    const before = recordContent(f.queue.toRecord(asset));
    head.resolve(revision());
    await resolving;
    expect(recordContent(f.queue.toRecord(asset))).toEqual(before);
    expect(f.queue.getStatus(asset).writes_paused).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.transport.save.mock.calls).toHaveLength(1);
  });

  it('readonly server view preserves local unknown and never auto writes', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    await f.queue.forkFromRecord(await seedBranch(f.storage, f.queue.toRecord(asset)!), { pauseForUserChoice: true, expectedCurrent: f.queue.getStatus(f.queue.toRecord(asset)!.asset_revision_id).local_commit });
    const before = recordContent(f.queue.toRecord(asset));
    const viewed = vi.fn();
    render(panel(f, { canWrite: () => false, onViewServer: viewed }));
    fireEvent.click(screen.getByTestId('save-view-server'));
    await act(drain);
    expect(viewed).toHaveBeenCalledWith(revision());
    expect(recordContent(f.queue.toRecord(asset))).toEqual(before);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.transport.save.mock.calls).toHaveLength(1);
  });

  it('stale UI completion cannot install a server preview in a new scope', async () => {
    const f = fixture();
    f.enqueue();
    f.transport.save.mockRejectedValueOnce(failure(409, 'REVISION_CONFLICT'));
    await f.queue.flush(asset);
    const head = deferred<AnnotationRevision | null>();
    f.transport.fetchHead.mockReturnValueOnce(head.promise);
    let currentScope = scope;
    const viewed = vi.fn();
    render(panel(f, { isCurrentScope: (key: string) => key === currentScope, onViewServer: viewed }));
    fireEvent.click(screen.getByTestId('conflict-view-server'));
    currentScope = 'project-b/asset-b/user-b/host-b';
    head.resolve(revision());
    await act(drain);
    expect(viewed).not.toHaveBeenCalled();
  });

  it('retains request identity with recovery and exposes actual service error details', async () => {
    const f = fixture();
    f.enqueue();
    f.transport.save.mockRejectedValueOnce(failure(500, 'DATABASE_FAILED'));
    await f.queue.flush(asset);
    await drain();
    render(panel(f));
    const diagnostic = openDiagnostic('DATABASE_FAILED');
    expect(diagnostic.getByText('DATABASE_FAILED', { selector: 'dd' })).toBeVisible();
    expect(diagnostic.getByText('request-save-17', { selector: 'dd' })).toBeVisible();
    expect(diagnostic.getByText('server denied this request', { selector: 'dd' })).toBeVisible();
    f.transport.fetchHead.mockRejectedValue(failure(500, 'DATABASE_FAILED'));
    const report = await runRecovery({ storage: f.storage, transport: f.transport }, asset, f.queue.getDraftBranchSnapshot(asset)!.envelope.draft_id);
    expect(report).toMatchObject({ kind: 'unreachable', error: { kind: 'http', code: 'DATABASE_FAILED', message: 'server denied this request', request_id: 'request-save-17' } });
  });
});

describe('C07 immutable acknowledgement and restart identity', () => {
  it('only the actual operation ACK confirms its captured generation', async () => {
    const f = fixture();
    const ack = deferred<SaveResponse>();
    f.transport.save.mockReturnValueOnce(ack.promise);
    f.enqueue(8);
    const sending = f.queue.flush(asset);
    await f.queue.whenPersisted(asset);
    await drain();
    const sent = f.transport.save.mock.calls[0][0];
    f.enqueue(9, 'confirmed_negative');
    ack.resolve({ operation_id: sent.operation_id, revision: { ...revision('r8'), document: sent.document }, idempotent_replay: false });
    await sending;
    expect(f.queue.getStatus(asset)).toMatchObject({ dirty: true, local_generation: 9, synced_generation: 8, base_revision_id: 'r8' });
    expect(f.queue.toRecord(asset)?.document.completion).toBe('confirmed_negative');
  });

  it('foreign ACK cannot confirm or delete the prepared operation', async () => {
    const f = fixture();
    f.transport.save.mockResolvedValueOnce({ operation_id: 'foreign-op', revision: revision(), idempotent_replay: false });
    f.enqueue();
    await f.queue.flush(asset);
    expect(f.queue.getStatus(asset)).toMatchObject({ dirty: true, synced_generation: 0, base_revision_id: 'r7' });
    expect(f.queue.toRecord(asset)?.pending?.request).toEqual(f.transport.save.mock.calls[0][0]);
  });

  it('restored used operation history prevents reuse of an earlier acknowledged ID', async () => {
    const f = fixture();
    for (const generation of [8, 9]) {
      const ack = deferred<SaveResponse>();
      f.transport.save.mockReturnValueOnce(ack.promise);
      f.enqueue(generation);
      const sending = f.queue.flush(asset);
      await f.queue.whenPersisted(asset);
      await drain();
      const sent = f.transport.save.mock.calls[generation - 8][0];
      ack.resolve({ operation_id: sent.operation_id, revision: { ...revision('r' + generation), document: sent.document }, idempotent_replay: false });
      await sending;
    }
    const stored = JSON.parse(JSON.stringify(f.queue.toRecord(asset))) as DraftRecord;
    const restored = fixture();
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, stored));
    restored.enqueue(10, 'confirmed_negative');
    await restored.queue.flush(asset);
    const usedIds = f.transport.save.mock.calls.map(([request]) => request.operation_id);
    expect(usedIds).not.toContain(restored.transport.save.mock.calls[0][0].operation_id);
  });

  it('head and storage read failures do not block the in-memory rescue download', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    vi.spyOn(f.storage, 'get').mockRejectedValue(new StorageError({ code: 'STORAGE_FAILED', message: 'read unavailable' }));
    f.transport.fetchHead.mockRejectedValue(failure(500, 'DATABASE_FAILED'));
    const downloaded = vi.fn();
    render(panel(f, { onExportDraft: downloaded }));
    fireEvent.click(screen.getByTestId('export-local-draft'));
    expect(downloaded).toHaveBeenCalledWith(expect.objectContaining({ document: document(), intent_journal: f.queue.toRecord(asset)?.intent_journal, unsynced: true }));
  });
});

describe('C07 unknown operation versus newer local edit', () => {
  it('replays the unknown payload first instead of replacing it with the newer document', async () => {
    const f = fixture();
    f.enqueue(8);
    await f.queue.flush(asset);
    const original = f.queue.toRecord(asset)!.pending!;
    f.enqueue(9, 'confirmed_negative');
    await f.queue.retry(asset);
    expect(f.transport.save.mock.calls[1][0]).toEqual(original.request);
    expect(f.queue.toRecord(asset)?.pending).toEqual(original);
    expect(f.queue.toRecord(asset)?.document.completion).toBe('confirmed_negative');
    expect(f.queue.toRecord(asset)?.intent_journal.map((entry) => entry.intent)).toEqual([intent, intent]);
    expect(f.queue.getStatus(asset).synced_generation).toBe(0);
  });
});

describe('C07 persisted operation boundaries', () => {
  it('known-owner schema-1 pending with legacy outcome conservatively survives a later lease rejection', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    const legacy = JSON.parse(JSON.stringify(f.queue.toRecord(asset))) as DraftRecord;
    delete legacy.pending_outcome;
    delete legacy.used_operation_ids;
    delete legacy.edit_seq;
    const restored = fixture();
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, legacy));
    restored.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_REQUIRED'));
    await restored.queue.retry(asset);
    restored.setLease({ task_id: 'task-a', fencing_token: 50 });
    expect(await restored.queue.retryRejectedLease(asset)).toBe(false);
    expect(restored.queue.toRecord(asset)?.pending).toEqual(legacy.pending);
  });

  it('fresh definite lease rejection allows explicit new operation with the acquired lease', async () => {
    const f = fixture();
    f.enqueue();
    f.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_REQUIRED'));
    await f.queue.flush(asset);
    const original = f.transport.save.mock.calls[0][0];
    f.setLease({ task_id: 'task-a', fencing_token: 51 });
    expect(await f.queue.retryRejectedLease(asset)).toBe(true);
    const retried = f.transport.save.mock.calls[1][0];
    expect(retried.operation_id).not.toBe(original.operation_id);
    expect(retried.document).toEqual(original.document);
    expect(retried.lease).toEqual({ task_id: 'task-a', fencing_token: 51 });
  });

  it('acknowledges the replay before sending the newer document and only its unacknowledged journal', async () => {
    const f = fixture();
    f.enqueue(8);
    await f.queue.flush(asset);
    const original = f.queue.toRecord(asset)!.pending!;
    f.enqueue(9, 'confirmed_negative');
    await vi.advanceTimersByTimeAsync(400);
    const ack = deferred<SaveResponse>();
    f.transport.save.mockReturnValueOnce(ack.promise);
    const replay = f.queue.retry(asset);
    expect(f.transport.save.mock.calls[1][0]).toEqual(original.request);
    ack.resolve({ operation_id: original.operation_id, revision: { ...revision('replay-r8'), document: original.request.document }, idempotent_replay: true });
    await replay;
    await f.queue.whenPersisted(asset);
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    const latest = f.transport.save.mock.calls[2][0];
    expect(latest.operation_id).not.toBe(original.operation_id);
    expect(latest.base_revision_id).toBe('replay-r8');
    expect(latest.document.completion).toBe('confirmed_negative');
    expect(latest.suggestion_decisions).toEqual([intent]);
    expect(f.queue.getStatus(asset).synced_generation).toBe(8);
  });

  it('wire schema failure is not an absent annotation head', async () => {
    const transport = new FetchSaveTransport({ fetchImpl: vi.fn(async () => new Response(JSON.stringify({ document: null }), { status: 200 })) as typeof fetch });
    await expect(transport.fetchHead(asset, 'ontology_v1')).rejects.toMatchObject({ kind: 'http', code: 'INVALID_ANNOTATION_RESPONSE', status: 502 });
  });
  it('two retry clicks share one immutable send', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.flush(asset);
    const pending = f.queue.toRecord(asset)!.pending!;
    const ack = deferred<SaveResponse>();
    f.transport.save.mockReturnValueOnce(ack.promise);
    render(panel(f));
    fireEvent.click(screen.getByTestId('save-retry'));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect(f.transport.save.mock.calls).toHaveLength(2);
    expect(f.transport.save.mock.calls[1][0]).toEqual(pending.request);
    ack.resolve({ operation_id: pending.operation_id, revision: { ...revision('retry-r8'), document: pending.request.document }, idempotent_replay: true });
    await act(drain);
    expect(f.queue.getStatus(asset)).toMatchObject({ synced_generation: 8, dirty: false });
  });
});


describe('C07 legacy author rescue consumer', () => {
  it('shows missing-author failure and never replays legacy unknown through retry controls', async () => {
    const source = fixture();
    source.enqueue();
    await source.queue.flush(asset);
    const legacy = JSON.parse(JSON.stringify(source.queue.toRecord(asset))) as DraftRecord;
    delete legacy.pending_owner;
    const restored = fixture();
    await restored.queue.forkFromRecord(await seedBranch(restored.storage, legacy));
    render(panel(restored));
    const diagnostic = openDiagnostic('PENDING_OWNER_UNKNOWN');
    expect(diagnostic.getByText('PENDING_OWNER_UNKNOWN', { selector: 'dd' })).toBeVisible();
    const before = restored.queue.exportDraft(asset);
    await restored.queue.retry(asset);
    expect(restored.transport.save).not.toHaveBeenCalled();
    expect(restored.queue.exportDraft(asset)?.pending).toEqual(before?.pending);
    expect(restored.queue.exportDraft(asset)?.intent_journal).toEqual(before?.intent_journal);
  });
});

describe('P1 rejected operation author at SaveStatus consumers', () => {
  it.each(['known actor A', 'legacy missing author'] as const)('%s LEASE_EXPIRED cannot become actor B operation via retry click', async (source) => {
    const original = fixture();
    original.setLease({ task_id: 'task-a', fencing_token: 41 });
    original.enqueue();
    original.transport.save.mockRejectedValueOnce(failure(409, 'LEASE_EXPIRED'));
    await original.queue.flush(asset);
    expect(original.queue.toRecord(asset)?.pending_outcome).toBe('rejected');
    let f = original;
    if (source === 'legacy missing author') {
      const legacy = JSON.parse(JSON.stringify(original.queue.toRecord(asset))) as DraftRecord & Record<string, unknown>;
      delete legacy.pending_owner;
      delete legacy.draft_owner;
      f = fixture();
      await f.queue.forkFromRecord(await seedBranch(f.storage, legacy));
    }
    const before = f.queue.toRecord(asset)!;
    const sends = f.transport.save.mock.calls.length;
    f.queue.setWriteOwner({ token: {}, actor_id: 'actor-b', project_id: 'test-project',
      isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true,
      getLease: () => ({ task_id: 'task-b', fencing_token: 99 }) });
    const onExportDraft = vi.fn();
    render(panel(f, { onExportDraft }));
    fireEvent.click(screen.getByTestId('save-retry'));
    await act(drain);
    expect.soft(f.transport.save.mock.calls).toHaveLength(sends);
    expect.soft(f.queue.toRecord(asset)).toMatchObject({
      pending: before.pending, pending_owner: before.pending_owner ?? null,
      pending_outcome: 'rejected', document: before.document, intent_journal: before.intent_journal,
      base_revision_id: before.base_revision_id, synced_generation: before.synced_generation,
    });
    fireEvent.click(screen.getByTestId('export-local-draft'));
    expect.soft(onExportDraft).toHaveBeenCalledWith(expect.objectContaining({
      pending: before.pending, document: before.document, intent_journal: before.intent_journal,
      pending_owner: before.pending_owner ?? null, unsynced: true,
    }));
  });

  it.each(['known actor A', 'legacy missing author'] as const)('%s rejected conflict keep_local_export cannot clear original operation or resume as B', async (source) => {
    const original = fixture();
    original.enqueue();
    original.transport.save.mockRejectedValueOnce(failure(409, 'REVISION_CONFLICT'));
    await original.queue.flush(asset);
    expect(original.queue.toRecord(asset)?.pending_outcome).toBe('rejected');
    let f = original;
    if (source === 'legacy missing author') {
      const legacy = JSON.parse(JSON.stringify(original.queue.toRecord(asset))) as DraftRecord & Record<string, unknown>;
      delete legacy.pending_owner;
      delete legacy.draft_owner;
      f = fixture();
      await f.queue.forkFromRecord(await seedBranch(f.storage, legacy));
    }
    const before = f.queue.toRecord(asset)!;
    const sends = f.transport.save.mock.calls.length;
    f.queue.setWriteOwner({ token: {}, actor_id: 'actor-b', project_id: 'test-project',
      isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null });
    const onExportDraft = vi.fn();
    const onResumeLocal = vi.fn();
    render(panel(f, { onExportDraft, onResumeLocal }));
    if (source === 'known actor A') fireEvent.click(screen.getByTestId('conflict-keep-local'));
    else {
      // Missing-author recovery deliberately has no conflict-resume button.
      fireEvent.click(screen.getByTestId('export-local-draft'));
      await act(async () => { await resolve(f.queue, 'keep_local_export'); });
    }
    await act(drain);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect.soft(onExportDraft).toHaveBeenCalledWith(expect.objectContaining({
      pending: before.pending, pending_owner: before.pending_owner ?? null,
      document: before.document, intent_journal: before.intent_journal, unsynced: true,
    }));
    expect.soft(onResumeLocal).not.toHaveBeenCalled();
    expect.soft(f.transport.save.mock.calls).toHaveLength(sends);
    expect.soft(f.queue.toRecord(asset)).toMatchObject({
      pending: before.pending, pending_owner: before.pending_owner ?? null, pending_outcome: 'rejected',
      base_revision_id: before.base_revision_id, document: before.document,
      intent_journal: before.intent_journal, synced_generation: before.synced_generation,
    });
    expect.soft(f.queue.getStatus(asset).writes_paused).toBe(true);
  });
});

describe('P2 owner handoff local certificate presentation', () => {
  it('withdraws the prior owner local committed claim while retaining downloadable content', async () => {
    const f = fixture();
    f.enqueue();
    await f.queue.whenPersisted(asset);
    const before = f.queue.toRecord(asset)!;
    const onExportDraft = vi.fn();
    render(panel(f, { onExportDraft }));
    expect(f.queue.getStatus(asset).local_commit).not.toBeNull();
    expect(within(screen.getByTestId('save-certificate')).getByText('local_commit.generation', { selector: 'dt' })).toBeInTheDocument();
    act(() => f.queue.setWriteOwner({ token: {}, actor_id: 'actor-b', project_id: 'test-project',
      isCurrent: () => true, isWritable: () => true, canPrepareOperation: () => true, getLease: () => null }));
    expect.soft(within(screen.getByTestId('save-certificate')).queryByText('local_commit.generation', { selector: 'dt' })).not.toBeInTheDocument();
    expect.soft(f.queue.getStatus(asset).local_commit).toBeNull();
    fireEvent.click(screen.getByTestId('export-local-draft'));
    expect.soft(onExportDraft).toHaveBeenCalledWith(expect.objectContaining({
      document: before.document, intent_journal: before.intent_journal, pending: before.pending,
      pending_owner: before.pending_owner ?? null, draft_owner: before.draft_owner ?? null,
      base_revision_id: before.base_revision_id, ontology_version_id: before.ontology_version_id, unsynced: true,
    }));
    expect.soft(f.transport.save).not.toHaveBeenCalled();
  });
});

