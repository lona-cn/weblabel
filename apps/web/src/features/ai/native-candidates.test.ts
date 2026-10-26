// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { CandidateEntry, RunController, RunSnapshot } from './run-controller';
import { mountCandidatesView } from './candidates-view';
import { rejectionApi } from './rejections';
import { nativeFixture } from '../workbench/native-test-support';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture() {
  const f = nativeFixture(), owner = new AbortController(), root = document.createElement('section'); document.body.append(root); cleanups.push(f.dispose, () => owner.abort());
  const context = { project_id: f.state.projectId, asset_revision_id: 'asset', annotation_revision_id: 'revision', ontology_version_id: 'ontology', canonical_sha256: 'hash', draft_generation: 1, input_fingerprint: 'input', selected_object_ids: [], object_hashes: {} };
  const entry: CandidateEntry = { key: 'key', asset_revision_id: 'asset', run_id: 'run', run_context: context,
    candidate: { suggestion_set_id: 'set', model_run_id: 'run', prediction_id: 'prediction', context, changes: [{ kind: 'create', change_id: 'change', object: { ...f.document.objects[0], object_id: 'candidate', origin: { type: 'prediction', prediction_id: 'prediction', model_run_id: 'run', import_batch_id: null } }, reason: '<img src=x onerror=alert(1)>', before_hash: null }], state: 'pending', issues: [], score: null },
    schema_error: null, objects: new Map(), fixedDocument: f.document, fixedOntology: f.ontology };
  const snapshot: RunSnapshot = { runId: 'run', runScope: null, events: [], candidates: [entry], error: null, busy: false, modelWaiting: false, savedMessage: null };
  const accept = vi.fn(async () => {}), controller: RunController = { getSnapshot: () => snapshot, subscribe: vi.fn(() => vi.fn()), update: vi.fn(), dispose: vi.fn(), run: vi.fn(), preparePreview: vi.fn(), getPreviewSnapshot: vi.fn(), cancel: vi.fn(), acceptSelected: accept };
  let asset = 'asset', generation = 1, writable = true;
  const view = mountCandidatesView(root, { signal: owner.signal, controller, getScope: () => ({ assetId: asset, context, generation, writable, current: true }), focusRegion: vi.fn(() => true), onDecisionRecorded: vi.fn() });
  return { ...f, root, entry, accept, view, setAsset(value: string) { asset = value; }, setGeneration(value: number) { generation = value; }, fence() { writable = false; } };
}
const readState = (set = 'set', rejected: string[] = []) => ({ suggestion_set_id: set, rejected_change_ids: rejected, operations: [], next_cursor: null });

it('clears the empty-state announcement when a candidate arrives', () => {
  vi.spyOn(rejectionApi, 'read').mockResolvedValue(readState());
  const f = fixture(); f.view.update([]);
  const announcement = f.root.querySelector<HTMLElement>('[role=status]')!;
  f.view.update([f.entry]);
  expect(f.root.querySelector('[data-testid=candidate-change]')).not.toBeNull();
  expect(announcement.textContent).toBe('');
});

it('does not offer previously rejected changes for acceptance', async () => {
  vi.spyOn(rejectionApi, 'read').mockResolvedValue(readState('set', ['change']));
  const f = fixture(); f.view.update([f.entry]);
  await vi.waitFor(() => expect(rejectionApi.read).toHaveBeenCalledTimes(1));
  const checkbox = f.root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.disabled).toBe(true); expect(f.root.querySelector('script,img')).toBeNull(); expect(f.accept).not.toHaveBeenCalled();
});
it('retains an unknown rejection operation and selection across panel updates and reconciles only with GET', async () => {
  let operation: string | undefined;
  vi.spyOn(rejectionApi, 'read').mockImplementation(async (set, op) => op ? { ...readState(set, ['change']), operations: [{ operation_id: op, change_ids: ['change'], created_at: 'now' }] } : readState(set));
  const reject = vi.spyOn(rejectionApi, 'reject').mockImplementation(async (_set, payload) => { operation = payload.operation_id; throw new TypeError('ACK lost'); });
  const f = fixture(); f.view.update([f.entry]);
  const checkbox = f.root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await vi.waitFor(() => expect(checkbox.disabled).toBe(false)); checkbox.click();
  f.root.querySelector<HTMLButtonElement>('[data-testid=reject-selected]')!.click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('拒绝结果未知'));
  f.view.update([f.entry]); expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
  f.root.querySelector<HTMLButtonElement>('[data-testid=accept-selected]')!.click(); expect(f.accept).not.toHaveBeenCalled();
  f.root.querySelector<HTMLButtonElement>('[data-testid=check-rejection-set]')!.click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('已只读核实拒绝成功'));
  expect(reject).toHaveBeenCalledTimes(1); expect(rejectionApi.read).toHaveBeenLastCalledWith('set', operation, expect.any(AbortSignal)); expect(checkbox.checked).toBe(false);
});
it('disables stale acceptance and removes cross-image SVG projection without removing its run record', async () => {
  vi.spyOn(rejectionApi, 'read').mockResolvedValue(readState()); const f = fixture(); f.view.update([f.entry]);
  const checkbox = f.root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await vi.waitFor(() => expect(checkbox.disabled).toBe(false)); checkbox.click();
  f.setGeneration(2); f.view.update([f.entry]); expect(f.root.querySelector<HTMLButtonElement>('[data-testid=accept-selected]')!.disabled).toBe(true);
  f.setAsset('other'); f.view.update([f.entry]); expect(f.root.querySelector('svg')).toBeNull(); expect(f.root.textContent).toContain('另一张图片');
  expect(f.root.querySelector('[data-testid=candidate-change]')).not.toBeNull(); expect(f.accept).not.toHaveBeenCalled();
});
it('re-reads current edit authority instead of trusting the rendered accept button', async () => {
  vi.spyOn(rejectionApi, 'read').mockResolvedValue(readState()); const f = fixture(); f.view.update([f.entry]);
  const checkbox = f.root.querySelector<HTMLInputElement>('input[type=checkbox]')!; await vi.waitFor(() => expect(checkbox.disabled).toBe(false)); checkbox.click();
  const accept = f.root.querySelector<HTMLButtonElement>('[data-testid=accept-selected]')!; expect(accept.disabled).toBe(false);
  f.fence(); accept.click(); expect(f.accept).not.toHaveBeenCalled();
});
it('reports independent cross-set rejection success and unknown outcomes without repeating writes', async () => {
  vi.spyOn(rejectionApi, 'read').mockImplementation(async set => readState(set));
  const reject = vi.spyOn(rejectionApi, 'reject').mockImplementation(async (set, payload) => { if (set === 'second') throw new TypeError('unknown'); return { ...payload, suggestion_set_id: set, created_at: 'now' }; });
  const f = fixture(), second = { ...f.entry, key: 'second', candidate: { ...f.entry.candidate, suggestion_set_id: 'second' } }; f.view.update([f.entry, second]);
  await vi.waitFor(() => expect([...f.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.disabled)).toBe(true));
  for (const input of f.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) input.click();
  f.root.querySelector<HTMLButtonElement>('[data-testid=reject-cross-groups]')!.click();
  await vi.waitFor(() => expect(f.root.textContent).toContain('1 组成功，0 组明确失败，1 组结果未知'));
  expect(reject).toHaveBeenCalledTimes(2); expect(f.root.querySelector('[data-testid=check-rejection-second]')).not.toBeNull();
  const announcement = f.root.querySelector<HTMLElement>(':scope > [role=status]')!;
  const outcome = announcement.textContent;
  f.view.update([f.entry, second]);
  expect(announcement.textContent).toBe(outcome);
});
