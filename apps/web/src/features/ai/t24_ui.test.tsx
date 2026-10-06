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
import { SaveQueue } from '../../lib/persistence/save-queue';
import { candidateCacheKey, canAcceptSuggestion, type CandidateEntry, type RunApi } from './useRun';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { DraftRecord, SaveRequest, SaveResponse } from '../../lib/persistence/types';

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
const grants = { allow_image: true, allow_object_context: true, preview_crop: null } as const;
const serverPreview: RunApi['preview'] = async (request, approved) => ({
  preview_id: 'preview-1', request: { ...request, context: { ...request.context, input_fingerprint: 'server-authoritative-fingerprint' } },
  input_fingerprint: 'server-authoritative-fingerprint', profile, grants: approved, expires_at: new Date(Date.now() + 600_000).toISOString(),
});
const ontology: OntologyVersion = { ontology_version_id: 'ontology-1', project_id: 'project-1', version_no: 1, guidelines_markdown: 'Review <script>alert(1)</script> helmets.', allow_out_of_bounds: false, labels: [{ label_id: 'label-person', name: 'person', color: '#3366ff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'helmet_state', kind: 'enum', required: true, default_value: 'unknown', enum_values: ['unknown', 'wearing'], min: null, max: null }] }] };
const validEntry: CandidateEntry = { key: `${candidateCacheKey('run-1', 'asset-A')}:0`, asset_revision_id: 'asset-A', run_id: 'run-1', run_context: context, candidate, schema_error: null, objects: new Map([[person.object_id, person]]) };

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

  it('discards a delayed server preview after the editor asset changes', async () => {
    let release!: (value: Awaited<ReturnType<RunApi['preview']>>) => void;
    const pending = new Promise<Awaited<ReturnType<RunApi['preview']>>>(resolve => { release = resolve; });
    const preview = vi.fn<RunApi['preview']>(async () => pending);
    const start = vi.fn<RunApi['start']>(async () => ({ run_id: 'must-not-start' }));
    const obtainConsent = vi.fn(async () => 'must-not-consent');
    const documentA:AnnotationDocument={schema_version:1,asset_revision_id:'asset-A',ontology_version_id:'ontology-1',coordinate_space:{type:'canonical_image_pixels',width:100,height:100},completion:'in_progress',objects:[person]};
    const props={asset_revision_id:'asset-A',profiles:[profile],context,getDocument:()=>documentA,getGeneration:()=>4,ontology,generation:4,dispatch:()=>null,grants,api:{preview,start,events:async()=>[],suggestions:async()=>[],cancel:async()=>undefined},obtainConsent,refreshContext:refreshScopeContext,saveQueue:cleanSaveQueue()};
    const view=render(<Panel {...props}/>);
    fireEvent.change(screen.getByTestId('ai-prompt'),{target:{value:'Review asset A'}});
    fireEvent.click(screen.getByTestId('ai-run'));
    await waitFor(()=>expect(preview).toHaveBeenCalledTimes(1));
    view.rerender(<Panel {...props} asset_revision_id="asset-B" context={contextWith({asset_revision_id:'asset-B'})} getDocument={()=>({...documentA,asset_revision_id:'asset-B'})}/>);
    await act(async()=>release(await serverPreview(...preview.mock.calls[0]!)));
    expect(screen.queryByTestId('ai-consent')).toBeNull();
    expect(obtainConsent).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();
  });

  it('does not start a billable request when its consent finishes after unmount', async () => {
    let release!:(value:string)=>void;const pending=new Promise<string>(resolve=>{release=resolve;});
    const obtainConsent=vi.fn(async()=>pending);const start=vi.fn<RunApi['start']>(async()=>({run_id:'must-not-start'}));
    const api:RunApi={preview:serverPreview,start,events:async()=>[],suggestions:async()=>[],cancel:async()=>undefined};
    const view=render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={()=>({schema_version:1,asset_revision_id:'asset-A',ontology_version_id:'ontology-1',coordinate_space:{type:'canonical_image_pixels',width:100,height:100},completion:'in_progress',objects:[person]})} getGeneration={()=>4} ontology={ontology} generation={4} dispatch={()=>null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()}/>);
    fireEvent.change(screen.getByTestId('ai-prompt'),{target:{value:'Review saved asset'}});await openConsentPreview();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button',{name:'Authorize and run now'}));
    await waitFor(()=>expect(obtainConsent).toHaveBeenCalledTimes(1));view.unmount();await act(async()=>release('consent-finished'));
    expect(start).not.toHaveBeenCalled();
  });

  it('does not submit prompt before preview authorization and starts only after consent', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'run-1' }));
    const events = vi.fn(async (): Promise<RunEvent[]> => [{ run_id: 'run-1', seq: 1, type: 'succeeded', message: 'Completed', data: null }]);
    const api: RunApi = { preview: serverPreview, start, events, suggestions: async () => [], cancel: async () => undefined };
    const obtainConsent = vi.fn(async () => 'consent-1');
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
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
    const api: RunApi = { preview: serverPreview, start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} />);
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
    const api: RunApi = { preview: serverPreview, start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    const saveQueue = {
      flush: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({
        phase: 'idle', dirty: false, saving: false, writes_paused: false, local_generation: 0,
        synced_generation: 0, base_revision_id: null, draft_exportable: false, last_error: null,
      })),
    } as unknown as SaveQueue;
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={saveQueue} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check persisted content only.' } });
    fireEvent.click(screen.getByTestId('ai-run'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('acknowledged by the save queue'));
    expect(screen.queryByTestId('ai-consent')).toBeNull();
    expect(obtainConsent).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });


  it('pins consent and the run to the revision acknowledged by the save queue', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'saved-run' }));
    const api: RunApi = { preview: serverPreview, start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
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
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshContext} saveQueue={saveQueue} />);
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
    const api: RunApi = { preview: serverPreview, start, events: async () => [], suggestions: async () => [], cancel: async () => undefined };
    const status = (revision: string) => ({
      phase: 'synced' as const, dirty: false, saving: false, writes_paused: false, local_generation: 4,
      synced_generation: 4, base_revision_id: revision, draft_exportable: true, last_error: null,
    });
    const saveQueue = {
      flush: vi.fn(async () => undefined),
      getStatus: vi.fn().mockReturnValueOnce(status('revision-reviewed')).mockReturnValue(status('revision-changed')),
    } as unknown as SaveQueue;
    const obtainConsent = vi.fn(async () => 'must-not-obtain');
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={obtainConsent} refreshContext={refreshScopeContext} saveQueue={saveQueue} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check only the reviewed revision.' } });
    await openConsentPreview();
    expect(screen.getByTestId('ai-consent').textContent).toContain('revision-reviewed');
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    expect(obtainConsent).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('shows generated-schema validation failures from the run API', async () => {
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'run-invalid' }));
    const api: RunApi = {
      preview: serverPreview,
      start,
      events: async () => [{ run_id: 'run-invalid', seq: 1, type: 'candidate', message: 'Candidate received', data: null }],
      suggestions: async () => [{ score: 200 }],
      cancel: async () => undefined,
    };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={async () => 'consent-1'} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
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
      preview: serverPreview,
      start,
      events,
      suggestions: async () => [{ ...candidate, model_run_id: 'late-run', context: start.mock.calls[0]![0].context }],
      cancel: async () => undefined,
    };
    const assetADocument = { schema_version: 1 as const, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels' as const, width: 100, height: 100 }, completion: 'in_progress' as const, objects: [person] };
    const props = { asset_revision_id: 'asset-A', profiles: [profile], context, getDocument: () => assetADocument, getGeneration: () => 4, ontology, generation: 4, dispatch: vi.fn(() => null), grants, api, obtainConsent: async () => 'consent-1', refreshContext: refreshScopeContext, saveQueue: cleanSaveQueue() };
    const view = render(<Panel {...props} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Check attributes.' } });
    await openConsentPreview();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(events).toHaveBeenCalled());
    const contextB = contextWith({ asset_revision_id: 'asset-B', annotation_revision_id: 'revision-B', canonical_sha256: 'sha256-B', input_fingerprint: 'fingerprint-B' });
    const documentB = { ...assetADocument, asset_revision_id: 'asset-B', objects: [{ ...person, attributes: { helmet_state: 'not_wearing' } }] };
    view.rerender(<Panel {...props} asset_revision_id="asset-B" context={contextB} getDocument={() => documentB} />);
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
    const api: RunApi = { preview: serverPreview, start, events, suggestions: async () => [], cancel };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={async () => 'consent-1'} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
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
  it.each(['failure', 'abort'] as const)('retries strict-after suggestion delivery after %s without restarting the run', async (scenario) => {
    vi.useFakeTimers();
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const start = vi.fn(async (_request: StartRunRequest) => ({ run_id: 'retry-' + scenario }));
    const delivered: RunEvent[] = [
      { run_id: 'retry-' + scenario, seq: 1, type: 'candidate', message: 'Candidate ready', data: null },
      { run_id: 'retry-' + scenario, seq: 2, type: 'succeeded', message: 'Done', data: null },
    ];
    const events = vi.fn(async (_run: string, after: number) => delivered.filter((event) => event.seq > after));
    let firstSignal: AbortSignal | undefined;
    const suggestions = vi.fn(async (_run: string, signal: AbortSignal): Promise<unknown[]> => {
      if (!firstSignal) {
        firstSignal = signal;
        if (scenario === 'failure') throw new Error('suggestions unavailable');
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      }
      return [{ ...candidate, model_run_id: 'retry-' + scenario, context: start.mock.calls[0]![0].context }];
    });
    const cancel = vi.fn(async () => undefined);
    const api: RunApi = { preview: serverPreview, start, events, suggestions, cancel };
    render(<Panel asset_revision_id="asset-A" profiles={[profile]} context={context} getDocument={() => ({ schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] })} getGeneration={() => 4} ontology={ontology} generation={4} dispatch={() => null} grants={grants} api={api} obtainConsent={async () => 'consent'} refreshContext={refreshScopeContext} saveQueue={cleanSaveQueue()} />);
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Inspect helmets' } });
    await act(async () => { fireEvent.click(screen.getByTestId('ai-run')); await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' })); await vi.advanceTimersByTimeAsync(0); });
    expect(suggestions).toHaveBeenCalledTimes(1);
    if (scenario === 'failure') {
      expect(screen.getByRole('alert').textContent).toContain('suggestions unavailable');
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    } else {
      visibility = 'hidden';
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
      expect(firstSignal?.aborted).toBe(true);
    }
    expect(screen.getByRole('checkbox', { name: 'Select change change-1' })).toHaveProperty('disabled', false);
    expect(suggestions).toHaveBeenCalledTimes(2);
    expect(events.mock.calls.map((call) => call[1])).toEqual([0, 0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(suggestions).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
  it.each(['undo-after-ack', 'undo-before-ack', 'undo-before-failure', 'undo-before-flush-rejection'] as const)('binds acceptance feedback to the live generation: %s', async (scenario) => {
    let documentNow: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [person] };
    let generationNow = 4;
    let runContext = context;
    let releaseAck!: () => void;
    const pendingAck = new Promise<void>((resolve) => { releaseAck = resolve; });
    const saves: SaveRequest[] = [];
    const records = new Map<string, DraftRecord>();
    const queue = new SaveQueue({
      storage: { get: async (id) => records.get(id) ?? null, put: async (record) => { records.set(record.asset_revision_id, structuredClone(record)); }, delete: async (id) => { records.delete(id); } },
      transport: {
        save: async (request): Promise<SaveResponse> => {
          saves.push(request);
          await pendingAck;
          if (scenario === 'undo-before-failure' || scenario === 'undo-before-flush-rejection') throw new Error('save unavailable');
          return { operation_id: request.operation_id, idempotent_replay: false, revision: { annotation_revision_id: 'revision-2', parent_revision_id: request.base_revision_id, revision_no: 2, document: request.document, created_at: new Date().toISOString(), created_by: 'test', content_hash: 'test' } };
        },
        fetchHead: async () => null, fetchRevision: async () => { throw new Error('unexpected conflict'); },
      },
    });
    if (scenario === 'undo-before-flush-rejection') {
      const flush = queue.flush.bind(queue);
      vi.spyOn(queue, 'flush').mockImplementation(async (assetId) => {
        await flush(assetId);
        if (queue.getStatus(assetId).dirty) throw new Error('flush rejected');
      });
    }
    queue.initializeFromServerRevision({ asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', annotation_revision_id: 'revision-1', generation: 4, document: documentNow });
    const dispatch = vi.fn((command: import('../../../../../packages/contracts/generated/EditorCommand').EditorCommand) => {
      if (command.kind !== 'apply_suggestions') return null;
      documentNow = { ...documentNow, objects: [{ ...person, attributes: { helmet_state: 'wearing' } }] };
      generationNow = 5;
      const intents = [{ suggestion_set_id: candidate.suggestion_set_id, decision: 'accept' as const, change_ids: command.change_ids }];
      queue.enqueue({ asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', generation: generationNow, document: documentNow, suggestion_decisions: intents });
      return { generation: generationNow, changed_objects: documentNow.objects, removed_object_ids: [], selected_object_ids: [], can_undo: true, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: intents, error: null };
    });
    const api: RunApi = { preview: serverPreview, start: async (request) => { runContext = request.context; return { run_id: 'live-ack-run' }; }, events: async () => [{ run_id: 'live-ack-run', seq: 1, type: 'succeeded', message: 'Done', data: null }], suggestions: async () => [{ ...candidate, model_run_id: 'live-ack-run', context: runContext }], cancel: async () => undefined };
    const panel = () => <Panel asset_revision_id="asset-A" profiles={[profile]} context={context} ontology={ontology} getDocument={() => documentNow} getGeneration={() => generationNow} generation={generationNow} dispatch={dispatch} grants={grants} api={api} saveQueue={queue} refreshContext={refreshScopeContext} obtainConsent={async () => 'consent'} />;
    const view = render(panel());
    const undo = () => {
      documentNow = { ...documentNow, objects: [person] };
      generationNow = 6;
      queue.enqueue({ asset_revision_id: 'asset-A', ontology_version_id: 'ontology-1', generation: generationNow, document: documentNow, suggestion_decisions: [{ suggestion_set_id: 'set-1', decision: 'revert', change_ids: ['change-1'] }] });
      view.rerender(panel());
    };
    expect(screen.getByText(ontology.guidelines_markdown)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Pinned ontology rules' }).querySelector('script')).toBeNull();
    fireEvent.change(screen.getByTestId('ai-prompt'), { target: { value: 'Inspect helmets' } });
    await openConsentPreview();
    fireEvent.click(screen.getByLabelText('I reviewed this exact scope and authorize this run.'));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and run now' }));
    const select = await screen.findByRole('checkbox', { name: 'Select change change-1' });
    expect(select).toHaveProperty('disabled', false);
    expect(runContext.input_fingerprint).not.toBe(context.input_fingerprint);
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('button', { name: 'Accept selected changes' }));
    await waitFor(() => expect(queue.getStatus('asset-A').phase).toBe('saving'));
    expect(saves).toEqual([expect.objectContaining({ document: documentNow, suggestion_decisions: [{ suggestion_set_id: 'set-1', decision: 'accept', change_ids: ['change-1'] }] })]);
    expect(queue.getStatus('asset-A').synced_generation).toBe(4);
    expect(screen.queryByText('Accepted changes are saved on the server.')).toBeNull();
    if (scenario !== 'undo-after-ack') undo();
    await act(async () => { releaseAck(); });
    if (scenario === 'undo-after-ack') {
      await screen.findByText('Accepted changes are saved on the server.');
      expect(queue.getStatus('asset-A').synced_generation).toBe(5);
      undo();
    }
    expect(screen.queryByText('Accepted changes are saved on the server.')).toBeNull();
    expect(screen.queryByText('Accepted changes remain in the local save journal; server acknowledgement is pending.')).toBeNull();
    expect(screen.queryByText('Accepted changes are pending server acknowledgement.')).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await queue.whenPersisted('asset-A');
    expect(records.get('asset-A')?.intent_journal.map((entry) => entry.intent.decision)).toEqual(['accept', 'revert']);
  });
  it('allows a run fingerprint distinct from UI input but blocks a candidate rebound to another run input or changed object', () => {
    const pinned = contextWith({ input_fingerprint: 'run-specific' });
    const entry = { ...validEntry, run_context: pinned, candidate: { ...candidate, context: pinned } };
    const view = render(<CandidateList entries={[entry]} activeAsset="asset-A" activeContext={context} activeGeneration={4} busy={false} onAccept={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Select change change-1' })).toHaveProperty('disabled', false);
    view.rerender(<CandidateList entries={[{ ...entry, candidate }]} activeAsset="asset-A" activeContext={context} activeGeneration={4} busy={false} onAccept={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Select change change-1' })).toHaveProperty('disabled', true);
    view.rerender(<CandidateList entries={[entry]} activeAsset="asset-A" activeContext={contextWith({ object_hashes: { 'object-1': 'changed' } })} activeGeneration={4} busy={false} onAccept={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Select change change-1' })).toHaveProperty('disabled', true);
  });
});
