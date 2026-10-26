// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { useRun } from './useRun';
import type { RunApi, CandidateEntry } from './run-controller';
import { CandidateList } from './CandidateList';
import { freezeAfterFlush } from './runCoordinator';

afterEach(cleanup);
const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [{ object_id: 'object', label_id: 'old', geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 2, x_max: 10, y_max: 20 }, attributes: { obsolete: 'old value' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
const ontology: OntologyVersion = { ontology_version_id: 'ontology', project_id: 'project', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false, labels: ['old', 'new'].map(label_id => ({ label_id, name: label_id, color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: label_id === 'old' ? [{ key: 'obsolete', kind: 'text', required: false, default_value: null, enum_values: [], min: null, max: null }] : [] })) };
const context: RunContext = { project_id: 'project', asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'revision', draft_generation: 1, canonical_sha256: 'image-hash', selected_object_ids: ['object'], object_hashes: { object: 'hash' }, input_fingerprint: 'fingerprint' };
const profile: ModelProfile = { profile_id: 'profile', provider_id: 'openai_api', model_id: 'model', auth_kind: 'api_key', capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true }, availability: 'needs_configuration', verification: 'not_run', runtime_version: null, verified_at: null };
const candidate: SuggestionSet = { suggestion_set_id: 'set', model_run_id: 'run', prediction_id: 'prediction', context, changes: [{ kind: 'set_label', change_id: 'change', object_id: 'object', before_hash: 'hash', label_id: 'new', reason: 'relabel' }], issues: [], score: null, state: 'pending' };

it('retains the complete prepare-time document and ontology after live inputs mutate and the asset switches', async () => {
  const liveDocument = structuredClone(document);
  const liveOntology = structuredClone(ontology);
  let release!: (value: unknown[]) => void;
  const suggestions = new Promise<unknown[]>(resolve => { release = resolve; });
  const api: RunApi = { preview: async (request, grants) => ({ preview_id: 'preview', request, profile, grants, input_fingerprint: 'fingerprint', execution_configuration_hash: 'configuration', expires_at: new Date(Date.now() + 60_000).toISOString() }), start: async () => ({ run_id: 'run' }), events: async () => [{ run_id: 'run', seq: 1, type: 'succeeded', message: 'Finished', data: null }], suggestions: async () => suggestions, cancel: async () => undefined };
  const queue = { flush: async () => undefined, getStatus: () => ({ dirty: false, writes_paused: false, phase: 'synced', synced_generation: 1, base_revision_id: 'revision' }) } as unknown as SaveQueue;
  const options = { asset_revision_id: 'asset', ontology: liveOntology, profile, context, intent: 'audit_attributes' as const, prompt: 'review', grants: { allow_image: true, allow_object_context: true, preview_crop: null }, obtainConsent: async () => 'consent', dispatch: vi.fn(() => null), getDocument: () => liveDocument, getGeneration: () => 1, refreshContext: async () => context, saveQueue: queue, api };
  const hook = renderHook(value => useRun(value), { initialProps: options });
  let previewVisual: ReturnType<typeof hook.result.current.getPreviewSnapshot> = null;
  await act(async () => { const preview = await hook.result.current.preparePreview(); expect(preview).not.toBeNull(); previewVisual = hook.result.current.getPreviewSnapshot(preview!.preview_id); await hook.result.current.run(preview!); });
  liveDocument.coordinate_space.width = 999;
  liveDocument.objects[0]!.attributes.obsolete = 'mutated';
  liveOntology.labels[1]!.name = 'mutated';
  hook.rerender({ ...options, asset_revision_id: 'other', context: { ...context, asset_revision_id: 'other' } });
  await act(async () => release([candidate]));
  await waitFor(() => expect(hook.result.current.candidates[0]?.fixedDocument).toEqual(document));
  expect(hook.result.current.candidates[0]?.fixedOntology).toEqual(ontology);
  expect(previewVisual).toEqual({ document, ontology });
  expect(hook.result.current.getPreviewSnapshot('preview')).toBeNull();
  expect(options.dispatch).not.toHaveBeenCalled();
});

it('does not fabricate after attributes or allow acceptance when fixed relabel context is missing', async () => {
  const entry: CandidateEntry = { key: 'entry', asset_revision_id: 'asset', run_id: 'run', run_context: context, candidate, schema_error: null, objects: new Map(document.objects.map(object => [object.object_id, object])), fixedDocument: null, fixedOntology: null };
  const accept = vi.fn();
  render(<CandidateList entries={[entry]} activeAsset="asset" activeContext={context} busy={false} onAccept={accept} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('投影'));
  expect(screen.queryByText('类别： new; obsolete: old value')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '采纳所选建议' }));
  expect(accept).not.toHaveBeenCalled();
});

it('pins the document before awaiting asynchronous context refresh', async () => {
  const live = structuredClone(document);
  let release!: (value: RunContext) => void;
  const pending = new Promise<RunContext>(resolve => { release = resolve; });
  let entered!: () => void;
  const refreshing = new Promise<void>(resolve => { entered = resolve; });
  const queue = { flush: async () => undefined, getStatus: () => ({ dirty: false, writes_paused: false, phase: 'synced', synced_generation: 1, base_revision_id: 'revision' }) } as unknown as SaveQueue;
  const frozen = freezeAfterFlush({ asset_revision_id: 'asset', ontology_version_id: 'ontology', saveQueue: queue, getDocument: () => live, getGeneration: () => 1, refreshContext: () => { entered(); return pending; } });
  await refreshing;
  live.objects[0]!.attributes.obsolete = 'changed during refresh';
  release(context);
  expect((await frozen).document).toEqual(document);
});

it('rejects a generation change while asynchronous scope refresh is pending', async () => {
  let generation = 1;
  let release!: (value: RunContext) => void;
  const pending = new Promise<RunContext>(resolve => { release = resolve; });
  let entered!: () => void;
  const refreshing = new Promise<void>(resolve => { entered = resolve; });
  const queue = { flush: async () => undefined, getStatus: () => ({ dirty: false, writes_paused: false, phase: 'synced', synced_generation: 1, base_revision_id: 'revision' }) } as unknown as SaveQueue;
  const frozen = freezeAfterFlush({ asset_revision_id: 'asset', ontology_version_id: 'ontology', saveQueue: queue, getDocument: () => document, getGeneration: () => generation, refreshContext: () => { entered(); return pending; } });
  await refreshing;
  generation = 2;
  release(context);
  await expect(frozen).rejects.toThrow();
});
