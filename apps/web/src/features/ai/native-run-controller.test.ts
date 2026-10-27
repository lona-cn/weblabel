// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';
import type { AiPreviewResponse } from '../../../../../packages/contracts/generated/AiPreviewResponse';
import { nativeFixture } from '../workbench/native-test-support';
import { createRunController, canAcceptSuggestion, candidateCacheKey, type RunApi, type RunControllerOptions } from './run-controller';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const f = nativeFixture(); cleanups.push(f.dispose);
  let document = structuredClone(f.document), generation = 0;
  const ontology = structuredClone(f.ontology), runId = 'synthetic-run-' + crypto.randomUUID();
  const context: RunContext = { project_id: f.state.projectId, asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'revision', draft_generation: 0, canonical_sha256: 'a'.repeat(64), selected_object_ids: ['object'], object_hashes: { object: 'hash' }, input_fingerprint: 'synthetic-input' };
  const profile: ModelProfile = { profile_id: 'synthetic-profile', provider_id: 'openai_api', model_id: 'synthetic-no-network', auth_kind: 'api_key', capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true }, availability: 'ready', verification: 'not_run', verified_at: null, runtime_version: null };
  const candidate: SuggestionSet = { suggestion_set_id: 'set', model_run_id: runId, prediction_id: 'prediction', context, changes: [{ kind: 'set_attributes', change_id: 'change', object_id: 'object', before_hash: 'hash', values: { text: 'synthetic correction' }, reason: 'synthetic' }], issues: [], score: null, state: 'pending' };
  const terminal: RunEvent = { run_id: runId, seq: 1, type: 'succeeded', message: 'Synthetic terminal', data: null };
  const api: RunApi = {
    preview: vi.fn(async (request, grants) => ({ preview_id: 'synthetic-preview', request, input_fingerprint: request.context.input_fingerprint, execution_configuration_hash: 'synthetic-configuration', profile, grants, expires_at: new Date(Date.now() + 60_000).toISOString() })),
    start: vi.fn(async () => ({ run_id: runId })), events: vi.fn(async () => [terminal]), suggestions: vi.fn(async () => [candidate]), cancel: vi.fn(async () => {}),
  };
  const options: RunControllerOptions = { asset_revision_id: 'asset', profile, context, ontology, intent: 'audit_attributes', prompt: 'Synthetic review', grants: { allow_image: true, allow_object_context: true, preview_crop: null }, obtainConsent: vi.fn(async () => 'synthetic-consent'), dispatch: f.port.dispatch, getDocument: () => document, getGeneration: () => generation, refreshContext: snapshot => ({ ...context, annotation_revision_id: snapshot.annotation_revision_id, draft_generation: snapshot.generation }), saveQueue: f.state.queue, api };
  const controller = createRunController(options); cleanups.push(() => controller.dispose());
  return { ...f, controller, options, api, context, ontology, profile, candidate, terminal, runId, get document() { return document; }, replaceDocument(next: typeof document) { document = next; }, advanceGeneration() { generation++; } };
}
it('prepares only a saved fixed document and never authorizes or starts before explicit consent', async () => {
  const f = fixture(), before = JSON.stringify(f.document);
  const preview = await f.controller.preparePreview(); expect(preview).not.toBeNull();
  expect(preview!.context.annotation_revision_id).toBe(f.revision.annotation_revision_id); expect(preview!.request.consent_id).toBeNull();
  expect(f.options.obtainConsent).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled();
  await f.controller.run(preview!);
  expect(f.api.start).toHaveBeenCalledTimes(1); expect(vi.mocked(f.api.start).mock.calls[0][0]).toMatchObject({ consent_id: 'synthetic-consent', context: { annotation_revision_id: 'revision' } });
  expect(JSON.stringify(f.document)).toBe(before);
});
it('retains the complete prepare-time document and ontology after live inputs mutate and the asset switches', async () => {
  const f = fixture(), oldDocument = structuredClone(f.document), oldOntology = structuredClone(f.ontology);
  const delivery = Promise.withResolvers<unknown[]>(); vi.mocked(f.api.suggestions).mockReturnValue(delivery.promise);
  const preview = await f.controller.preparePreview(); expect(preview).not.toBeNull();
  await f.controller.run(preview!);
  f.document.objects[0].attributes.text = 'later live input'; f.ontology.labels[0].name = 'later live category';
  f.controller.update({ ...f.options, asset_revision_id: 'next', context: { ...f.context, asset_revision_id: 'next' } });
  delivery.resolve([f.candidate]);
  await vi.waitFor(() => expect(f.controller.getSnapshot().candidates).toHaveLength(1));
  const candidate = f.controller.getSnapshot().candidates[0];
  expect(candidate.asset_revision_id).toBe('asset'); expect(candidate.fixedDocument).toEqual(oldDocument); expect(candidate.fixedOntology).toEqual(oldOntology);
  expect(candidate.objects.get('object')?.attributes.text).toBe('old'); expect(f.controller.getSnapshot().runScope?.assetRevisionId).toBe('asset');
});
it.each(['generation', 'live-content'] as const)('pins the full document before asynchronous context refresh while fencing %s changes', async changed => {
  const f = fixture(), pending = Promise.withResolvers<RunContext>(), original = structuredClone(f.document);
  const refresh = vi.fn(() => pending.promise); f.options.refreshContext = refresh; f.controller.update(f.options);
  const preparing = f.controller.preparePreview();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  if (changed === 'generation') f.advanceGeneration(); else f.document.objects[0].attributes.text = 'later live edit';
  pending.resolve(f.context);
  const preview = await preparing;
  if (changed === 'generation') { expect(preview).toBeNull(); expect(f.api.preview).not.toHaveBeenCalled(); }
  else { expect(preview).not.toBeNull(); expect(f.controller.getPreviewSnapshot(preview!.preview_id)?.document).toEqual(original); }
  expect(f.api.start).not.toHaveBeenCalled();
});
it('discards a delayed preview after the owning asset changes', async () => {
  const f = fixture(), pending = Promise.withResolvers<AiPreviewResponse>();
  vi.mocked(f.api.preview).mockReturnValue(pending.promise);
  const preparing = f.controller.preparePreview(); await vi.waitFor(() => expect(f.api.preview).toHaveBeenCalledTimes(1));
  f.controller.update({ ...f.options, asset_revision_id: 'next', context: { ...f.context, asset_revision_id: 'next' } });
  const [request, grants] = vi.mocked(f.api.preview).mock.calls[0];
  pending.resolve({ preview_id: 'late', request, grants, profile: f.profile, input_fingerprint: request.context.input_fingerprint, execution_configuration_hash: 'hash', expires_at: new Date(Date.now() + 60_000).toISOString() });
  expect(await preparing).toBeNull(); expect(f.controller.getPreviewSnapshot('late')).toBeNull(); expect(f.api.start).not.toHaveBeenCalled();
});
it('does not start a potentially billable request if consent completes after disposal', async () => {
  const f = fixture(), consent = Promise.withResolvers<string>();
  f.options.obtainConsent = vi.fn(() => consent.promise); f.controller.update(f.options);
  const preview = await f.controller.preparePreview(), running = f.controller.run(preview!);
  await vi.waitFor(() => expect(f.options.obtainConsent).toHaveBeenCalledTimes(1));
  f.controller.dispose(); consent.resolve('late-consent'); await running;
  expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.cancel).not.toHaveBeenCalled();
});
it('requires a new preview when the acknowledged revision changes before authorization', async () => {
  const f = fixture(), preview = await f.controller.preparePreview();
  expect(f.state.queue.adoptImportReceipt({ ...f.revision, parent_revision_id: f.revision.annotation_revision_id, annotation_revision_id: 'new-revision', revision_no: 2, document: f.document }, f.revision.annotation_revision_id)).toBe(true);
  await f.controller.run(preview!);
  expect(f.options.obtainConsent).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().error).not.toBeNull();
});
it('does not authorize an old full-image preview after the requested image scope is narrowed', async () => {
  const f = fixture(), preview = await f.controller.preparePreview(), before = structuredClone(f.document);
  f.controller.update({ ...f.options, grants: { ...f.options.grants, preview_crop: { type: 'bbox_xyxy', x_min: 10, y_min: 20, x_max: 30, y_max: 40 } } });
  await f.controller.run(preview!);
  expect(f.options.obtainConsent).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().busy).toBe(false); expect(f.controller.getSnapshot().error).not.toBeNull(); expect(f.document).toEqual(before);
});
it('refuses preparation without a save service and without a real server baseline', async () => {
  const f = fixture(); f.controller.update({ ...f.options, saveQueue: undefined });
  expect(await f.controller.preparePreview()).toBeNull(); expect(f.api.preview).not.toHaveBeenCalled();
  f.controller.update({ ...f.options, asset_revision_id: 'never-saved', context: { ...f.context, asset_revision_id: 'never-saved' } });
  expect(await f.controller.preparePreview()).toBeNull(); expect(f.api.start).not.toHaveBeenCalled();
});
it('shows malformed suggestions as non-acceptable fixed records instead of fabricated after attributes', async () => {
  const f = fixture(); vi.mocked(f.api.suggestions).mockResolvedValue([{ ...f.candidate, score: 'not-a-number' }]);
  const preview = await f.controller.preparePreview(); await f.controller.run(preview!);
  await vi.waitFor(() => expect(f.controller.getSnapshot().candidates).toHaveLength(1));
  const entry = f.controller.getSnapshot().candidates[0]; expect(entry.schema_error).not.toBeNull(); expect(entry.candidate.changes).toEqual([]);
  await f.controller.acceptSelected(entry.candidate, 'asset', ['change'], entry.schema_error, []); expect(f.host.dispatch).not.toHaveBeenCalled();
});
it('retains strict-after event delivery and aborts owned polling without cancelling the server run', async () => {
  vi.useFakeTimers(); const f = fixture(); let signal: AbortSignal | undefined;
  vi.mocked(f.api.events).mockImplementation(async (_id, _after, owned) => { signal = owned; return [{ ...f.terminal, type: 'queued' }]; });
  const preview = await f.controller.preparePreview(); await f.controller.run(preview!);
  await vi.advanceTimersByTimeAsync(500);
  expect(vi.mocked(f.api.events).mock.calls.map(call => call[1])).toEqual([0, 1]);
  f.controller.dispose(); expect(signal?.aborted).toBe(true); await vi.advanceTimersByTimeAsync(5000);
  expect(f.api.events).toHaveBeenCalledTimes(2); expect(f.api.cancel).not.toHaveBeenCalled();
});
it('checks run/asset/generation/object hashes and explicit rejection evidence before acceptance', async () => {
  const f = fixture();
  expect(candidateCacheKey(f.runId, 'asset')).not.toBe(candidateCacheKey(f.runId, 'next'));
  for (const changed of [{ active_asset: 'next' }, { active_generation: 1 }, { active_context: { ...f.context, object_hashes: { object: 'changed' } } }, { busy: true }, { schema_error: 'invalid' }]) {
    expect(canAcceptSuggestion({ active_asset: 'asset', candidate_asset: 'asset', active_context: f.context, active_generation: 0, candidate: f.candidate, busy: false, ...changed })).toBe(false);
  }
  const preview = await f.controller.preparePreview(); await f.controller.run(preview!);
  await f.controller.acceptSelected(f.candidate, 'asset', ['change'], null, null);
  await f.controller.acceptSelected(f.candidate, 'asset', ['change'], null, ['change']);
  expect(f.host.dispatch).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().error).toContain('拒绝');
});
