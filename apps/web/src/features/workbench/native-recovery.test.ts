// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { createDraftRecovery, rawDraftJson } from './draft-recovery';
import { TransportError } from '../../lib/persistence/types';
import { mountSaveView } from './save-view';
import { SaveQueue } from '../../lib/persistence/save-queue';
import { InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import { api } from '../../lib/t15/api';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() { const f = nativeFixture(), owner = new AbortController(); cleanups.push(f.dispose, () => owner.abort()); const install = vi.fn(async () => {}); return { ...f, owner, install, recovery: createDraftRecovery(f.state, f.port, install) }; }

it('retains raw fields and refuses a lossy rescue rather than silently changing the original', () => {
  const raw = { future_field: { flag: false, nullable: null, empty: '' }, pending: { operation_id: 'original' } };
  expect(JSON.parse(rawDraftJson(raw))).toEqual(raw);
  expect(() => rawDraftJson({ value: -0 })).toThrow(); expect(() => rawDraftJson({ value: Number.NaN })).toThrow();
  const circular: { child?: unknown } = {}; circular.child = circular; expect(() => rawDraftJson(circular)).toThrow();
});
it('reads every branch without automatically selecting the newest or modifying its lineage', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  const source = { asset_revision_id: 'asset', draft_id: 'newest', write_token: 'source-token', sources: [], record: { ...f.state.queue.toRecord('asset')!, generation: 1, draft_owner: { actor_id: 'other', project_id: f.state.projectId }, extra_future: { retained: true } } };
  await f.storage.put(source); const before = f.state.queue.getDraftBranchSnapshot('asset');
  await f.recovery.refresh();
  const after = f.state.queue.getDraftBranchSnapshot('asset');
  expect(f.state.branches.some(row => row.draft_id === 'newest')).toBe(true);
  expect(after).toMatchObject({ envelope: { draft_id: before!.envelope.draft_id, write_token: before!.envelope.write_token, sources: before!.envelope.sources, record: { document: f.document, generation: 0 } }, local_commit: before!.local_commit });
  expect((await f.storage.get('asset', 'newest'))?.record).toEqual(source.record);
});
it('retains explicit foreign recovery as uncommitted rescue without granting current-author edit authority', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  const source = { asset_revision_id: 'asset', draft_id: 'foreign', write_token: 'foreign-token', sources: [], record: { ...f.state.queue.toRecord('asset')!, generation: 1, draft_owner: { actor_id: 'other', project_id: f.state.projectId }, extra_future: 'retain' } };
  await f.storage.put(source); f.state.reload = vi.fn(async () => {});
  vi.spyOn(api, 'annotation').mockResolvedValue(f.revision);
  await expect(f.recovery.choose(source.draft_id, 'recover')).rejects.toThrow();
  expect(f.state.queue.toRecord('asset')).toMatchObject({ draft_owner: { actor_id: 'other' }, extra_future: 'retain', writes_paused: true });
  expect(f.state.queue.getDraftBranchSnapshot('asset')?.envelope.sources).toContainEqual({ draft_id: source.draft_id, write_token: source.write_token, action: 'recover' });
  expect(f.state.queue.getStatus('asset').local_commit).toBeNull();
  expect((await f.storage.get('asset', source.draft_id))?.record).toEqual(source.record); expect(f.port.getHost()).toBeNull();
});
it('replays only the original unknown operation and payload after a new task lease is installed', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  f.transport.save.mockRejectedValue(new TransportError({ kind: 'network', message: 'ACK lost' }));
  f.state.queue.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', generation: 1, document: f.document });
  await f.state.queue.flush('asset'); const original = f.state.queue.toRecord('asset')!.pending!;
  expect(f.state.queue.toRecord('asset')!.pending_outcome).toBe('unknown');
  f.state.fixedTask = { task_id: 'task', project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology' };
  f.state.lease = { task_id: 'task', asset_revision_id: 'asset', ontology_version_id: 'ontology', fencing_token: 17 }; f.state.leaseActor = 'actor';
  await f.recovery.retry();
  expect(f.transport.save).toHaveBeenCalledTimes(2); expect(f.transport.save.mock.calls[1][0]).toEqual(original.request); expect(f.transport.save.mock.calls[1][0].lease).toBeNull();
  expect(f.state.queue.toRecord('asset')!.pending!.operation_id).toBe(original.operation_id);
});
it('requires explicit negative confirmation and exposes separate actual local/remote receipts', async () => {
  const f = setup(), root = document.createElement('section'); document.body.append(root); await f.state.queue.whenPersisted('asset');
  f.state.document = { ...f.document, objects: [] }; f.state.objects = [];
  mountSaveView(root, f.state, f.port, f.recovery, f.owner.signal);
  const completion = root.querySelector<HTMLSelectElement>('[data-testid=completion-state]')!, confirm = root.querySelector<HTMLInputElement>('[data-testid=negative-confirmation]')!, complete = root.querySelector<HTMLButtonElement>('[data-testid=complete-annotation]')!;
  completion.value = 'confirmed_negative'; completion.dispatchEvent(new Event('change', { bubbles: true })); expect(f.host.dispatch).not.toHaveBeenCalled(); expect(complete.disabled).toBe(true);
  confirm.checked = true; confirm.dispatchEvent(new Event('change', { bubbles: true })); expect(complete.disabled).toBe(false);
  complete.click(); expect(f.host.dispatch).toHaveBeenCalledWith({ kind: 'set_completion', completion: 'confirmed_negative' });
  expect(root.querySelector('[data-testid=save-status]')?.textContent).toContain('0'); expect(root.textContent).toContain('revision');
});
it('prepares a never-annotated target with nullable base and adopts only its real first import receipt', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset'); f.state.queue.revokeWriteOwner(f.state.owner.token);
  f.state.queue = new SaveQueue({ owner: f.state.owner, storage: new InMemoryDraftStorage(), transport: f.transport });
  f.state.loaded = null; f.state.host = null; f.state.document = null; f.state.objects = []; f.state.heads = []; f.state.branches = [];
  f.state.reload = vi.fn(async () => {});
  const prepared = await f.port.prepareImport();
  expect(prepared).toEqual({ asset_revision_id: 'asset', ontology_version_id: 'ontology', base_revision_id: null, lease: null });
  expect(f.port.canImport()).toBe(true); expect(f.port.getHost()).toBeNull(); expect(f.state.queue.toRecord('asset')).toBeNull(); expect(f.transport.save).not.toHaveBeenCalled();
  const receipt = { ...f.revision, annotation_revision_id: 'imported-revision', parent_revision_id: null };
  await f.port.commitImport(receipt);
  expect(f.state.queue.toRecord('asset')).toMatchObject({ base_revision_id: 'imported-revision', document: receipt.document, pending: null });
  expect(f.state.reload).toHaveBeenCalledTimes(1); expect(f.transport.save).not.toHaveBeenCalled();
});
it('holds the import fence until the receipt persistence hands off to the replacement Native scope', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset'); f.state.reload = vi.fn(async () => {});
  await f.port.prepareImport();
  const persisted = f.state.queue.whenPersisted.bind(f.state.queue);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.state.queue, 'whenPersisted').mockImplementationOnce(async asset => { await gate; return persisted(asset); });
  const committing = f.port.commitImport({ ...f.revision, annotation_revision_id: 'imported-existing', parent_revision_id: f.revision.annotation_revision_id });
  expect(f.state.importing).not.toBeNull(); expect(f.port.getHost()).toBeNull(); expect(f.state.reload).not.toHaveBeenCalled();
  release(); await committing;
  expect(f.state.importing).toBeNull(); expect(f.state.reload).toHaveBeenCalledTimes(1);
});
it.each(['existing', 'fresh'] as const)('keeps the %s import receipt fenced after local commit failure and retries only that receipt locally', async target => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  let storage = f.storage;
  if (target === 'fresh') {
    f.state.queue.revokeWriteOwner(f.state.owner.token);
    storage = new InMemoryDraftStorage();
    f.state.queue = new SaveQueue({ owner: f.state.owner, storage, transport: f.transport });
    f.state.loaded = null; f.state.host = null; f.state.document = null; f.state.objects = []; f.state.heads = []; f.state.branches = [];
  }
  f.state.reload = vi.fn(async () => {});
  const context = await f.port.prepareImport(), scope = f.state.scope;
  const receipt = { ...f.revision, annotation_revision_id: 'durable-import', parent_revision_id: context.base_revision_id };
  storage.failNextPut(new Error('synthetic local quota abort'));
  await expect(f.port.commitImport(receipt)).rejects.toThrow();
  const fence = f.state.importing;
  expect(fence).not.toBeNull(); expect(f.state.scope).toBe(scope); expect(f.port.getHost()).toBeNull();
  expect(f.state.queue.toRecord('asset')).toMatchObject({ base_revision_id: receipt.annotation_revision_id, document: receipt.document, pending: null });
  expect(f.state.queue.getStatus('asset').local_commit).toBeNull(); expect(f.state.reload).not.toHaveBeenCalled();
  f.port.releaseImport(); expect(f.state.importing).toBe(fence); expect(f.port.canImport()).toBe(true);
  await expect(f.port.commitImport({ ...receipt, document: { ...receipt.document, completion: 'complete' } })).rejects.toThrow();
  expect(f.state.queue.toRecord('asset')?.document).toEqual(receipt.document);
  await f.port.commitImport(receipt);
  const proof = f.state.queue.getStatus('asset').local_commit;
  expect(proof).toMatchObject({ generation: 0, edit_seq: f.state.queue.toRecord('asset')?.edit_seq });
  expect((await storage.get('asset', proof!.draft_id))?.record).toMatchObject({ base_revision_id: receipt.annotation_revision_id, document: receipt.document });
  expect(f.state.importing).toBeNull(); expect(f.state.reload).toHaveBeenCalledTimes(1); expect(f.transport.save).not.toHaveBeenCalled();
});
