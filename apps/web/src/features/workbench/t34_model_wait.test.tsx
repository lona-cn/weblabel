import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import { SaveQueue } from '../../lib/persistence/save-queue';
import { useRun } from '../ai/useRun';
import type { ConsentPreview, RunApi, RunControllerOptions } from '../ai/useRun';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('ends model waiting on a validated terminal event while preserving strict-after candidate delivery retries', async () => {
  vi.useFakeTimers();
  const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 't34-wait-asset', ontology_version_id: 't34-wait-ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [] };
  const context: RunContext = { project_id: 't34-wait-project', asset_revision_id: document.asset_revision_id, annotation_revision_id: 't34-wait-revision', ontology_version_id: document.ontology_version_id, draft_generation: 0, canonical_sha256: 't34-wait-sha', selected_object_ids: [], object_hashes: {}, input_fingerprint: 't34-wait-input' };
  const profile: ModelProfile = { profile_id: 't34-unit-only-profile', provider_id: 'openai_api', model_id: 'unit-only-no-model-call', auth_kind: 'api_key', capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true }, availability: 'needs_configuration', verification: 'not_run', runtime_version: null, verified_at: null };
  const queue = new SaveQueue({
    storage: { get: async () => null, put: async () => {}, delete: async () => {} },
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
  const options: RunControllerOptions = { asset_revision_id: document.asset_revision_id, profile, context, intent: 'audit_attributes', prompt: 'Unit-only waiting boundary', grants: { allow_image: true, allow_object_context: true, preview_crop: null }, obtainConsent: async () => 't34-unit-consent', dispatch: () => null, getDocument: () => document, getGeneration: () => 0, refreshContext: () => context, saveQueue: queue, api };
  const view = renderHook(() => useRun(options));
  let preview: ConsentPreview | null = null;
  await act(async () => { preview = await view.result.current.preparePreview(); });
  expect(preview).not.toBeNull();
  await act(async () => { await view.result.current.run(preview!); });
  expect(view.result.current.modelWaiting).toBe(true);
  terminal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(view.result.current.events.at(-1)?.type).toBe('succeeded');
  expect(view.result.current.error).toBe('candidate delivery unavailable');
  expect(view.result.current.modelWaiting).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(suggestions).toHaveBeenCalledTimes(2);
  expect(cursors).toEqual([0, 1, 1]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(view.result.current.modelWaiting).toBe(false);
  view.unmount();
});
