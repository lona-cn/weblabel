import { InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import { SaveQueue } from '../../lib/persistence/save-queue';
import type { SaveQueueOwner } from '../../lib/persistence/types';
import { createRunController, type RunController, type RunApi, type RunControllerOptions } from '../ai/run-controller';

const fixtureOwners = new Set<object>();
const controllers = new Set<RunController>();
afterEach(() => { for (const controller of controllers) controller.dispose(); controllers.clear(); fixtureOwners.clear(); vi.useRealTimers(); });

it('ends model waiting on a validated terminal event while preserving strict-after candidate delivery retries', async () => {
  vi.useFakeTimers();
  const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 't34-wait-asset', ontology_version_id: 't34-wait-ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [] };
  const context: RunContext = { project_id: 't34-wait-project', asset_revision_id: document.asset_revision_id, annotation_revision_id: 't34-wait-revision', ontology_version_id: document.ontology_version_id, draft_generation: 0, canonical_sha256: 't34-wait-sha', selected_object_ids: [], object_hashes: {}, input_fingerprint: 't34-wait-input' };
  const profile: ModelProfile = { profile_id: 't34-unit-only-profile', provider_id: 'openai_api', model_id: 'unit-only-no-model-call', auth_kind: 'api_key', capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true }, availability: 'needs_configuration', verification: 'not_run', runtime_version: null, verified_at: null };
  const token = {};
  fixtureOwners.add(token);
  const owner: SaveQueueOwner = { token, actor_id: 't34-wait-actor', project_id: context.project_id, isCurrent: () => fixtureOwners.has(token), isWritable: () => fixtureOwners.has(token), canPrepareOperation: () => true, getLease: () => null };
  const queue = new SaveQueue({
    owner,
    storage: new InMemoryDraftStorage(),
    transport: { save: async () => { throw new Error('Unexpected annotation write'); }, fetchHead: async () => null, fetchRevision: async () => { throw new Error('Unexpected conflict read'); } },
  });
  queue.initializeFromServerRevision({ asset_revision_id: document.asset_revision_id, ontology_version_id: document.ontology_version_id, annotation_revision_id: context.annotation_revision_id, generation: 0, document });
  let terminal = false;
  const cursors: number[] = [];
  const suggestions = vi.fn<RunApi['suggestions']>().mockRejectedValueOnce(new Error('candidate delivery unavailable')).mockResolvedValue([]);
  const start = vi.fn<RunApi['start']>(async () => ({ run_id: 't34-wait-run' }));
  const api: RunApi = {
    preview: async (request, grants) => ({ preview_id: 't34-wait-preview', request, input_fingerprint: context.input_fingerprint, execution_configuration_hash: 't34-unit-only-configuration', profile, grants, expires_at: new Date(Date.now() + 600_000).toISOString() }),
    start,
    events: async (_run, after) => {
      cursors.push(after);
      const events: RunEvent[] = [{ run_id: 't34-wait-run', seq: 1, type: 'queued', message: 'Queued', data: null }];
      if (terminal) events.push({ run_id: 't34-wait-run', seq: 2, type: 'succeeded', message: 'Completed', data: null });
      return events.filter((event) => event.seq > after);
    },
    suggestions,
    cancel: async () => {},
  };
  const options: RunControllerOptions = { ontology: { ontology_version_id: document.ontology_version_id, project_id: context.project_id, version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }, asset_revision_id: document.asset_revision_id, profile, context, intent: 'audit_attributes', prompt: 'Unit-only waiting boundary', grants: { allow_image: true, allow_object_context: true, preview_crop: null }, obtainConsent: async () => 't34-unit-consent', dispatch: () => null, getDocument: () => document, getGeneration: () => 0, refreshContext: () => context, saveQueue: queue, api };
  const controller = createRunController(options);
  controllers.add(controller);
  const initialSnapshot = controller.getSnapshot();
  controller.update(options);
  expect(controller.getSnapshot()).toBe(initialSnapshot);
  const preview = await controller.preparePreview();
  expect(preview).not.toBeNull();
  await controller.run(preview!);
  expect(controller.getSnapshot().modelWaiting).toBe(true);
  terminal = true;
  await vi.advanceTimersByTimeAsync(500);
  expect(controller.getSnapshot().events.at(-1)?.type).toBe('succeeded');
  expect(controller.getSnapshot().error).toBe('candidate delivery unavailable');
  expect(controller.getSnapshot().modelWaiting).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(suggestions).toHaveBeenCalledTimes(2);
  expect(cursors).toEqual([0, 1, 1]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().modelWaiting).toBe(false);
  fixtureOwners.delete(token);
});
