// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';
import { CandidateList } from './CandidateList';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import { Panel } from './Panel';
import { ProviderPicker } from './ProviderPicker';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { candidateCacheKey, canAcceptSuggestion, type CandidateEntry, type RunApi } from './useRun';

let visibilityDescriptor: PropertyDescriptor | undefined;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
  visibilityDescriptor = undefined;
});

const context: RunContext = {
  project_id: 'project-1', asset_revision_id: 'asset-A', annotation_revision_id: 'revision-1', ontology_version_id: 'ontology-1',
  draft_generation: 4, canonical_sha256: 'sha256-A', selected_object_ids: ['object-1'], object_hashes: { 'object-1': 'hash-1' }, input_fingerprint: 'fingerprint-A',
};
const profile: ModelProfile = {
  profile_id: 'profile-1', provider_id: 'openai_api', model_id: 'full-model-2026-09', auth_kind: 'api_key',
  capabilities: { image_input: true, tools: false, structured_output: true, bbox_output: false, attributes: true },
  availability: 'needs_configuration', verification: 'not_run', runtime_version: null, verified_at: null,
};
const person: AnnotationObject = {
  object_id: 'object-1', label_id: 'label-person', geometry: { type: 'bbox_xyxy', x_min: 2, y_min: 3, x_max: 12, y_max: 23 },
  attributes: { helmet_state: 'unknown' }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null },
};
const change = { change_id: 'change-1', kind: 'set_attributes' as const, object_id: 'object-1', values: { helmet_state: 'wearing' }, before_hash: 'hash-1', reason: 'The helmet is visible.' };
const candidate: SuggestionSet = {
  suggestion_set_id: 'set-1', model_run_id: 'run-1', prediction_id: 'prediction-1', context,
  changes: [change], issues: [], score: null, state: 'pending',
};
const grants = { image: true, selected_objects: true, crop: null } as const;
const validEntry: CandidateEntry = { key: `${candidateCacheKey('run-1', 'asset-A')}:0`, asset_revision_id: 'asset-A', run_id: 'run-1', candidate, schema_error: null, objects: new Map([[person.object_id, person]]) };

function contextWith(overrides: Partial<RunContext>): RunContext {
  return { ...context, ...overrides };
}
function refreshScopeContext(snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }): RunContext {
  return contextWith({
    asset_revision_id: snapshot.document.asset_revision_id,
    annotation_revision_id: snapshot.annotation_revision_id,
    ontology_version_id: snapshot.document.ontology_version_id,
    draft_generation: snapshot.generation,
  });
}
function cleanSaveQueue(revision = context.annotation_revision_id): SaveQueue {
  return {
    flush: vi.fn(async () => undefined),
    getStatus: vi.fn(() => ({
      phase: 'synced' as const, dirty: false, saving: false, writes_paused: false, local_generation: 4,
      synced_generation: 4, base_revision_id: revision, draft_exportable: true, last_error: null,
    })),
  } as unknown as SaveQueue;
}


async function openConsentPreview() {
  fireEvent.click(screen.getByTestId('ai-run'));
  await screen.findByLabelText('I reviewed this exact scope and authorize this run.');
}

describe('T24 AI review behavior', () => {
  it('shows provider, full model, authentication, availability, and verification independently', () => {
    render(<ProviderPicker profiles={[profile]} selected={profile.profile_id} onSelect={() => undefined} />);
    expect(screen.getByText('OpenAI API · full-model-2026-09')).toBeTruthy();
    expect(screen.getByText('API key')).toBeTruthy();
    expect(screen.getByText('Needs configuration')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
  });
  it('keys cached candidates by both run and asset and rejects foreign, stale, or newer-generation candidates', () => {
    expect(candidateCacheKey('r1', 'asset-A')).not.toBe(candidateCacheKey('r1', 'asset-B'));
    expect(candidateCacheKey('r1', 'asset-A')).not.toBe(candidateCacheKey('r2', 'asset-A'));
    const accepts = (active_asset: string, active_context: RunContext, value = candidate, active_generation?: number) => canAcceptSuggestion({ active_asset, candidate_asset: 'asset-A', active_context, active_generation, candidate: value, busy: false });
    expect(accepts('asset-B', context)).toBe(false);
    expect(accepts('asset-A', contextWith({ draft_generation: 5 }))).toBe(false);
    expect(accepts('asset-A', context, { ...candidate, state: 'stale' })).toBe(false);
    expect(accepts('asset-A', context, { ...candidate, state: 'partially_accepted' })).toBe(true);
    expect(accepts('asset-A', context, candidate, 5)).toBe(false);
    expect(accepts('asset-A', context)).toBe(true);
  });

  it('keeps attributes diff geometry-projection-only and exposes missing confidence', () => {
    render(<CandidateList entries={[validEntry]} activeAsset="asset-A" activeContext={context} busy={false} onAccept={() => undefined} />);
    expect(screen.getByText('Unchanged')).toBeTruthy();
    expect(screen.getByText('Not provided')).toBeTruthy();
    expect(screen.getByText('The helmet is visible.')).toBeTruthy();
    expect(screen.getByText(/prediction-1/)).toBeTruthy();
  });

  it('requires explicit selection and submits only the selected subset once', () => {
    const twoChanges: SuggestionSet = { ...candidate, changes: [change, { ...change, change_id: 'change-2', object_id: 'object-2', before_hash: 'hash-2' }] };
    const entry = { ...validEntry, candidate: twoChanges };
    const onAccept = vi.fn();
    render(<CandidateList entries={[entry]} activeAsset="asset-A" activeContext={context} busy={false} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select change change-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept selected changes' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]?.[1]).toEqual(['change-1']);
  });

  it('displays schema-invalid candidates as errors and makes them unacceptable', () => {
    const invalid: CandidateEntry = { ...validEntry, schema_error: 'Candidate 1 failed schema validation: /score must be number or null' };
    render(<CandidateList entries={[invalid]} activeAsset="asset-A" activeContext={context} busy={false} onAccept={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('failed schema validation');
    expect(screen.getByRole('button', { name: 'Accept selected changes' })).toHaveProperty('disabled', true);
  });

  it('retains another asset result for comparison but never enables acceptance on this canvas', () => {
    const foreign = { ...validEntry, asset_revision_id: 'asset-A' };
    const onAccept = vi.fn();
    render(<CandidateList entries={[foreign]} activeAsset="asset-B" activeContext={contextWith({ asset_revision_id: 'asset-B' })} busy={false} onAccept={onAccept} />);
    expect(screen.getByText(/belongs to asset asset-A/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept selected changes' })).toHaveProperty('disabled', true);
  });

  it('does not submit prompt before preview authorization and starts only after consent', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'run-1' }));
    const events = vi.fn(async (): Promise<RunEvent[]> => [{ run_id: 'run-1', seq: 1, type: 'succeeded', message: 'Completed', data: null }]);
    const api: RunApi = { start, events, suggestions: async () => [], cancel: async () => undefined };
    const obtainConsent = vi.fn(async () => 'consent-1');
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Only inspect helmet_state.' } });
    await openConsentPreview();
    expect(start).not.toHaveBeenCalled();
    expect(obtainConsent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(obtainConsent).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      prompt: 'Only inspect helmet_state.',
      consent_id: 'consent-1',
      context: { ...context, input_fingerprint: expect.any(String) },
    });
    expect(request?.context.input_fingerprint).not.toBe(context.input_fingerprint);
  });
  it('refuses consent and run creation without an acknowledged save queue', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'must-not-start' }));
    const obtainConsent = vi.fn(async () => 'must-not-consent');
    const api: RunApi = { start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check saved attributes.' } });
    fireEvent.click(screen.getByTestId('ai-run'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('acknowledged save queue'));
    expect(screen.queryByTestId('ai-consent')).toBeNull();
    expect(obtainConsent).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it('rejects an idle queue with no server revision baseline', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'must-not-start' }));
    const obtainConsent = vi.fn(async () => 'must-not-consent');
    const api: RunApi = { start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    const saveQueue = {
      flush: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        phase: 'idle', dirty: false, saving: false, writes_paused: false, local_generation: 0,
        synced_generation: 0, base_revision_id: null, draft_exportable: false, last_error: null,
      })),
    } as unknown as SaveQueue;
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={saveQueue} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check persisted content only.' } });
    fireEvent.click(screen.getByTestId('ai-run'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('acknowledged by the save queue'));
    expect(screen.queryByTestId('ai-consent')).toBeNull();
    expect(obtainConsent).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });


  it('pins consent and the run to the revision acknowledged by the save queue', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'saved-run' }));
    const api: RunApi = { start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    const acknowledgedRevision = 'revision-after-save';
    const saveQueue = {
      flush: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        phase: 'synced', dirty: false, saving: false, writes_paused: false, local_generation: 4,
        synced_generation: 4, base_revision_id: acknowledgedRevision, draft_exportable: true, last_error: null,
      })),
    } as unknown as SaveQueue;
    const refreshContext = vi.fn((snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) =>
      contextWith({ annotation_revision_id: snapshot.annotation_revision_id, draft_generation: snapshot.generation }));
    const obtainConsent = vi.fn(async () => 'fresh-consent');
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshContext} saveQueue={saveQueue} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check saved attributes.' } });
    await openConsentPreview();
    expect(screen.getByTestId('ai-consent').textContent).toContain(acknowledgedRevision);
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(saveQueue.flush).toHaveBeenCalledTimes(2);
    expect(obtainConsent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ annotation_revision_id: acknowledgedRevision }) }));
    expect(start.mock.calls[0]?.[0].context.annotation_revision_id).toBe(acknowledgedRevision);
  });
  it('requires scope review again when the acknowledged revision changes after consent preview', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'must-not-start' }));
    const api: RunApi = { start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    const status = (revision: string) => ({
      phase: 'synced' as const, dirty: false, saving: false, writes_paused: false, local_generation: 4,
      synced_generation: 4, base_revision_id: revision, draft_exportable: true, last_error: null,
    });
    const saveQueue = {
      flush: vi.fn(async () => undefined),
      getStatus: vi.fn().mockReturnValueOnce(status('revision-reviewed')).mockReturnValue(status('revision-changed')),
    } as unknown as SaveQueue;
    const obtainConsent = vi.fn(async () => 'must-not-obtain');
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={saveQueue} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check only the reviewed revision.' } });
    await openConsentPreview();
    expect(screen.getByTestId('ai-consent').textContent).toContain('revision-reviewed');
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('changed after scope review'));
    expect(obtainConsent).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('shows generated-schema validation failures from the run API', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'run-invalid' }));
    const api: RunApi = {
      start,
      events: async () => [{ run_id: 'run-invalid', seq: 1, type: 'candidate', message: 'Candidate received', data: null }],
      suggestions: async () => [{ score: 200 }],
      cancel: async () => undefined,
    };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={async () => 'consent-1'} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check attributes.' } });
    await openConsentPreview();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('schema validation'));
    expect(screen.getByRole('button', { name: 'Accept selected changes' })).toHaveProperty('disabled', true);
  });
  it('keeps a late switched-asset result attached to its originating asset', async () => {
    let releaseEvents: (events: unknown[]) => void = () => undefined;
    const pendingEvents = new Promise<unknown[]>((resolve) => { releaseEvents = resolve; });
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'late-run' }));
    const events = vi.fn(async () => pendingEvents);
    const api: RunApi = {
      start,
      events,
      suggestions: async () => [{ ...candidate, model_run_id: 'late-run' }],
      cancel: async () => undefined,
    };
    const assetADocument = { schema_version: 1 as const, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels' as const, width: 100, height: 100 }, completion: 'in_progress' as const, objects: [person] };
    const props = { asset_revision_id: 'asset-A', profiles: [profile], context, document: assetADocument, generation: 4, dispatch: vi.fn(() => null), grants, api, obtainConsent: async () => 'consent-1', refreshContext: refreshScopeContext, saveQueue: cleanSaveQueue() };
    const view = render(<Panel {...props} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check attributes.' } });
    await openConsentPreview();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(events).toHaveBeenCalled());
    const contextB = contextWith({ asset_revision_id: 'asset-B', annotation_revision_id: 'revision-B', canonical_sha256: 'sha256-B', input_fingerprint: 'fingerprint-B' });
    const documentB = { ...assetADocument, asset_revision_id: 'asset-B', objects: [{ ...person, attributes: { helmet_state: 'not_wearing' } }] };
    view.rerender(<Panel {...props} asset_revision_id="asset-B" context={contextB} document={documentB} />);
    releaseEvents([{ run_id: 'late-run', seq: 1, type: 'candidate', message: 'Candidate received', data: null }]);
    await waitFor(() => expect(screen.getByText(/belongs to asset asset-A/)).toBeTruthy());
    expect(screen.getByText(/helmet_state: unknown/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept selected changes' })).toHaveProperty('disabled', true);
    expect(props.dispatch).not.toHaveBeenCalled();
  });
  it('polls every 500ms in foreground and 2s in background, then cleans up without cancelling the run', async () => {
    vi.useFakeTimers();
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'poll-run' }));
    const events = vi.fn(async () => []);
    const cancel = vi.fn(async () => undefined);
    const api: RunApi = { start, events, suggestions: async () => [], cancel };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} document={{ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] }} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={async () => 'consent-1'} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check attributes.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-run'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText('I reviewed this exact scope and authorize this run.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(events).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(events).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(events).toHaveBeenCalledTimes(2);
    visibility = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(events).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(events).toHaveBeenCalledTimes(4);
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(events).toHaveBeenCalledTimes(4);
    expect(cancel).not.toHaveBeenCalled();
  });
});
