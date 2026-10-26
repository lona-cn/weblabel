// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFixture } from './native-test-support';
import { createDraftRecovery } from './draft-recovery';
import { createTaskSession } from './task-session';
import { api } from '../../lib/t15/api';
import { TransportError } from '../../lib/persistence/types';
import type { ReviewTask } from '../review/api';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
function setup() { const f = nativeFixture(); cleanups.push(f.dispose); const recovery = createDraftRecovery(f.state, f.port, vi.fn(async () => {})), taskSession = createTaskSession(f.state, f.port, recovery); const task: ReviewTask = { task_id: 'task', project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology', assignee_id: 'actor', state: 'open', created_at: 'now', review_id: null, revision_ids: null, review_decision: null, review_reason: null }; return { ...f, recovery, taskSession, task }; }

it('prepares only after a real current local certificate and invalidates the preparation on identity exit', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  const prepared = await f.taskSession.onPrepareTaskCreate({ project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology', assignee_id: 'actor' });
  expect(prepared.isCurrent()).toBe(true); expect(await prepared.validateCurrent()).toBe(true); expect(f.port.getHost()).toBeNull();
  f.revoke(); expect(prepared.isCurrent()).toBe(false); expect(await prepared.validateCurrent()).toBe(false); prepared.release(); expect(f.state.preparation).toBeNull();
});
it('detects a changed foreign branch before allowing a prepared claim', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  const prepared = await f.taskSession.onPrepareTaskOpen(f.task);
  await f.storage.put({ asset_revision_id: 'asset', draft_id: 'late-branch', write_token: 'late-token', sources: [], record: { ...f.state.queue.toRecord('asset')!, generation: 1, draft_owner: { actor_id: 'other', project_id: f.state.projectId } } });
  await expect(prepared.validateCurrent()).rejects.toThrow();
  prepared.release(); expect(f.state.lease).toBeNull();
});
it('never treats a claim callback as permission to rewrap or retry an unknown save', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset'); f.transport.save.mockRejectedValue(new TransportError({ kind: 'network', message: 'unknown' }));
  f.state.queue.enqueue({ asset_revision_id: 'asset', ontology_version_id: 'ontology', generation: 1, document: f.document }); await f.state.queue.flush('asset'); const original = f.state.queue.toRecord('asset')!.pending;
  f.taskSession.onLeaseChange({ task_id: 'task', asset_revision_id: 'asset', ontology_version_id: 'ontology', fencing_token: 9 });
  expect(f.transport.save).toHaveBeenCalledTimes(1); expect(f.state.queue.toRecord('asset')!.pending).toEqual(original);
  await expect(f.taskSession.onPrepareTaskOpen(f.task)).rejects.toThrow(); expect(f.state.queue.toRecord('asset')!.pending).toEqual(original);
});
it('checks fixed task and exact current revision again after an asynchronous submission read', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset'); f.state.fixedTask = f.task;
  f.taskSession.onLeaseChange({ task_id: 'task', asset_revision_id: 'asset', ontology_version_id: 'ontology', fencing_token: 1 });
  let finish!: (revision: typeof f.revision) => void;
  vi.spyOn(api, 'annotation').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const submit = vi.fn(async () => {}), operation = f.taskSession.onSubmitTask(f.task, submit);
  for (let index = 0; index < 30 && !finish; index++) await Promise.resolve();
  expect(f.state.submission).toBe(true); f.revoke(); finish(f.revision);
  await expect(operation).rejects.toThrow(); expect(submit).not.toHaveBeenCalled(); expect(f.state.submission).toBe(false);
});
it('recertifies an unchanged clean server baseline after replacing the page writer before task creation', async () => {
  const f = setup(); await f.state.queue.whenPersisted('asset');
  const original = f.state.queue.getDraftBranchSnapshot('asset')!;
  f.state.queue.revokeWriteOwner(f.state.owner.token);
  f.state.owner = { ...f.state.owner, token: {} }; f.state.queue.setWriteOwner(f.state.owner);
  f.state.queue.initializeFromServerRevision({ asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: f.revision.annotation_revision_id, generation: 0, document: f.document });
  await f.state.queue.whenPersisted('asset');
  const prepared = await f.taskSession.onPrepareTaskCreate({ project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology', assignee_id: 'actor' });
  expect(prepared.isCurrent()).toBe(true); expect(await prepared.validateCurrent()).toBe(true); prepared.release();
  const current = f.state.queue.getDraftBranchSnapshot('asset')!;
  expect(current.envelope.draft_id).toBe(original.envelope.draft_id); expect(current.envelope.sources).toEqual(original.envelope.sources);
  expect(current.local_commit?.write_token).not.toBe(original.local_commit!.write_token);
  expect((await f.storage.get('asset', current.envelope.draft_id))?.write_token).toBe(current.local_commit?.write_token);
  expect(current.envelope.record).toMatchObject({ document: f.document, generation: 0, synced_generation: 0, pending: null, used_operation_ids: [] });
  expect(f.transport.save).not.toHaveBeenCalled();
});
