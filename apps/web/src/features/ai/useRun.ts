import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateContract } from '@weblabel/contracts/validate-browser';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunEvent } from '../../../../../packages/contracts/generated/RunEvent';
import type { StartRunRequest } from '../../../../../packages/contracts/generated/StartRunRequest';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import { freezeAfterFlush } from './runCoordinator';
import type { AiApprovedGrants } from '../../../../../packages/contracts/generated/AiApprovedGrants';
import type { AiPreviewRequest } from '../../../../../packages/contracts/generated/AiPreviewRequest';
import type { AiPreviewResponse } from '../../../../../packages/contracts/generated/AiPreviewResponse';

export interface ConsentPreview extends AiPreviewResponse {
  context: RunContext;
  intent: StartRunRequest['intent'];
  prompt: string;
}

export interface RunApi {
  preview(request: StartRunRequest, grants: AiApprovedGrants, signal: AbortSignal): Promise<AiPreviewResponse>;
  start(request: StartRunRequest, signal: AbortSignal): Promise<{ run_id: string }>;
  events(runId: string, after: number, signal: AbortSignal): Promise<unknown[]>;
  suggestions(runId: string, signal: AbortSignal): Promise<unknown[]>;
  cancel(runId: string, signal: AbortSignal): Promise<void>;
}

export interface RunControllerOptions {
  asset_revision_id: string;
  profile: ModelProfile | null;
  context: RunContext;
  intent: StartRunRequest['intent'];
  prompt: string;
  grants: AiApprovedGrants;
  obtainConsent?: (preview: ConsentPreview) => Promise<string>;
  dispatch: (command: EditorCommand) => EditorDelta | null;
  getDocument: () => AnnotationDocument | null;
  getGeneration: () => number | null;
  refreshContext: (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) => RunContext | Promise<RunContext>;
  saveQueue?: SaveQueue;
  csrfToken?: string | null;
  api?: RunApi;
}

export interface CandidateEntry {
  readonly key: string;
  readonly asset_revision_id: string;
  readonly run_id: string;
  readonly run_context: RunContext;
  readonly candidate: SuggestionSet;
  readonly schema_error: string | null;
  readonly objects: ReadonlyMap<string, AnnotationObject>;
}

const runCache = new Map<string, CandidateEntry[]>();

export function candidateCacheKey(runId: string, assetId: string): string {
  return JSON.stringify([runId, assetId]);
}

export function canAcceptSuggestion(input: {
  active_asset: string;
  candidate_asset: string;
  active_context: RunContext;
  candidate: SuggestionSet;
  run_context?: RunContext;
  active_generation?: number;
  busy: boolean;
  schema_error?: string | null;
}): boolean {
  if (input.busy || input.schema_error || input.active_asset !== input.candidate_asset) return false;
  if (input.run_context && !contextMatches(input.run_context, input.candidate.context)) return false;
  if (input.active_generation !== undefined && input.candidate.context.draft_generation !== input.active_generation) return false;
  if (!['pending', 'partially_accepted'].includes(input.candidate.state) || !input.candidate.changes.length) return false;
  return contextMatches(input.active_context, input.candidate.context, false);
}

function defaultApi(csrfToken: string | null): RunApi {
  const request = async <T,>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') {
      if (!csrfToken) throw new Error('CSRF_TOKEN_UNAVAILABLE: unsafe AI request was not sent.');
      headers.set('x-csrf-token', csrfToken);
    }
    const response = await fetch(url, { ...init, credentials: 'same-origin', signal, headers });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const code = typeof body === 'object' && body !== null && 'code' in body ? String((body as { code: unknown }).code) : `HTTP_${response.status}`;
      throw new Error(`${code}: AI request failed`);
    }
    return body as T;
  };
  return {
    preview: (body, grants, signal) => request<AiPreviewResponse>('/api/ai/previews', { method: 'POST', body: JSON.stringify({ request: body, grants } satisfies AiPreviewRequest) }, signal),
    start: (body, signal) => request('/api/ai/runs', { method: 'POST', body: JSON.stringify(body) }, signal),
    events: async (runId, after, signal) => {
      const body = await request<{ items: unknown[] }>(`/api/ai/runs/${encodeURIComponent(runId)}/events?after=${after}`, { method: 'GET' }, signal);
      return body.items;
    },
    suggestions: async (runId, signal) => {
      const items: unknown[] = [];
      const cursors = new Set<string>();
      let after: string | null = null;
      while (true) {
        const query = new URLSearchParams({ limit: '500' });
        if (after !== null) query.set('after', after);
        const page = await request<{ items: unknown[]; next_cursor: string | null }>(`/api/ai/runs/${encodeURIComponent(runId)}/suggestions?${query}`, { method: 'GET' }, signal);
        if (!Array.isArray(page.items) || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) throw new Error('SUGGESTION_RESPONSE_INVALID: invalid page shape');
        items.push(...page.items);
        if (page.next_cursor === null) return items;
        if (page.items.length === 0 || cursors.has(page.next_cursor)) throw new Error('SUGGESTION_RESPONSE_INVALID: invalid pagination cursor');
        cursors.add(page.next_cursor);
        after = page.next_cursor;
      }
    },
    cancel: async (runId, signal) => { await request(`/api/ai/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' }, signal); },
  };
}

function contextMatches(a: RunContext, b: RunContext, includeRunInput = true): boolean {
  const hashesA = Object.entries(a.object_hashes).sort(([left], [right]) => left.localeCompare(right));
  const hashesB = Object.entries(b.object_hashes).sort(([left], [right]) => left.localeCompare(right));
  return a.project_id === b.project_id && a.asset_revision_id === b.asset_revision_id &&
    a.annotation_revision_id === b.annotation_revision_id && a.ontology_version_id === b.ontology_version_id &&
    a.draft_generation === b.draft_generation && a.canonical_sha256 === b.canonical_sha256 &&
    (!includeRunInput || a.input_fingerprint === b.input_fingerprint) &&
    JSON.stringify([...a.selected_object_ids].sort()) === JSON.stringify([...b.selected_object_ids].sort()) &&
    JSON.stringify(hashesA) === JSON.stringify(hashesB);
}

export function useRun(options: RunControllerOptions) {
  const api = useMemo(() => options.api ?? defaultApi(options.csrfToken ?? null), [options.api, options.csrfToken]);
  const [runId, setRunId] = useState<string | null>(null);
  const [runIds, setRunIds] = useState<string[]>([]);
  const [eventsByRun, setEventsByRun] = useState<Map<string, RunEvent[]>>(() => new Map());
  const [background, setBackground] = useState(() => document.visibilityState === 'hidden');
  const events = runId ? eventsByRun.get(runId) ?? [] : [];
  const [candidateEntries, setCandidateEntries] = useState<CandidateEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState<{ assetId: string; generation: number; message: string } | null>(null);
  const savedMessage = savedNotice?.assetId === options.asset_revision_id
    ? (savedNotice.generation === options.getGeneration() ? savedNotice.message : 'A later edit or undo changed this acceptance; check the current save status.')
    : null;
  const runContexts = useRef(new Map<string, RunContext>());
  const runObjects = useRef(new Map<string, ReadonlyMap<string, AnnotationObject>>());
  const lastSequences = useRef(new Map<string, number>());
  const finishedRuns = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => { setSavedNotice(null); }, [options.asset_revision_id]);
  const prepareSnapshot = useCallback(async () => {
    const initial = optionsRef.current;
    try {
      if (!initial.saveQueue) throw new Error('Persistence is unavailable; AI runs require an acknowledged save queue.');
      const frozen = await freezeAfterFlush({
        asset_revision_id: initial.asset_revision_id,
        ontology_version_id: initial.context.ontology_version_id,
        saveQueue: initial.saveQueue,
        getDocument: initial.getDocument,
        getGeneration: initial.getGeneration,
        refreshContext: initial.refreshContext,
      });
      const current = optionsRef.current;
      if (current.asset_revision_id !== initial.asset_revision_id ||
        frozen.context.project_id !== current.context.project_id) {
        throw new Error('Active project or asset changed while preparing AI scope; no run was started.');
      }
      return frozen;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh the saved AI context.');
      return null;
    }
  }, []);
  const preparedObjects = useRef(new Map<string, ReadonlyMap<string, AnnotationObject>>());
  const inFlight = useRef(false);
  const scopeIdentity = (value: RunControllerOptions) => JSON.stringify([value.asset_revision_id, value.context.project_id, value.context.ontology_version_id, value.context.selected_object_ids, value.context.object_hashes, value.getGeneration(), value.profile, value.intent, value.prompt, value.grants]);
  const preparePreview = useCallback(async (): Promise<ConsentPreview | null> => {
    const initial = optionsRef.current;
    const identity = scopeIdentity(initial);
    if (!initial.profile || !initial.prompt.trim()) return null;
    setError(null);
    try {
      const frozen = await prepareSnapshot();
      if (!mounted.current || !frozen || identity !== scopeIdentity(optionsRef.current)) return null;
      const request: StartRunRequest = {
        operation_id: globalThis.crypto.randomUUID(), profile_id: initial.profile.profile_id,
        context: frozen.context, intent: initial.intent, prompt: initial.prompt, consent_id: null,
      };
      const fixed = await api.preview(request, initial.grants, new AbortController().signal);
      if (!mounted.current || identity !== scopeIdentity(optionsRef.current)) return null;
      if (!fixed.preview_id || !contextMatches(fixed.request.context, frozen.context, false)) throw new Error('PREVIEW_RESPONSE_INVALID: preview does not match the acknowledged scope');
      preparedObjects.current.clear();
      preparedObjects.current.set(fixed.preview_id, new Map(frozen.document.objects.map(object => [object.object_id, structuredClone(object)])));
      return { ...fixed, context: fixed.request.context, intent: fixed.request.intent, prompt: fixed.request.prompt };
    } catch (cause) {
      if (identity === scopeIdentity(optionsRef.current)) setError(cause instanceof Error ? cause.message : 'Could not prepare AI scope.');
      return null;
    }
  }, [api, prepareSnapshot]);


  useEffect(() => {
    const update = () => setBackground(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const run = useCallback(async (preview: ConsentPreview) => {
    if (inFlight.current) return;
    setError(null);
    setSavedNotice(null);
    const initial = optionsRef.current;
    const identity = scopeIdentity(initial);
    if (!initial.obtainConsent || !initial.profile) { setError('Consent service is unavailable; no run was started.'); return; }
    if (!initial.api && !initial.csrfToken) { setError('CSRF token is unavailable; no AI request was sent.'); return; }
    inFlight.current = true;
    setBusy(true);
    const controller = new AbortController();
    try {
      const prepared = await prepareSnapshot();
      if (!prepared) return;
      if (!mounted.current || identity !== scopeIdentity(optionsRef.current) || !contextMatches(preview.context, prepared.context, false) ||
          initial.profile.profile_id !== preview.profile.profile_id || initial.prompt !== preview.prompt || initial.intent !== preview.intent ||
          JSON.stringify(initial.grants) !== JSON.stringify(preview.grants) || Date.parse(preview.expires_at) <= Date.now()) {
        throw new Error('The saved scope changed after review. Prepare a new server preview and confirm consent again.');
      }
      const objectSnapshot = preparedObjects.current.get(preview.preview_id);
      if (!objectSnapshot) throw new Error('The reviewed editor snapshot is unavailable.');
      const consent_id = await initial.obtainConsent(preview);
      if (!mounted.current || identity !== scopeIdentity(optionsRef.current)) throw new Error('Active editor changed during consent; no run was started.');
      const result = await api.start({ ...preview.request, consent_id }, controller.signal);
      if (!result.run_id) throw new Error('RUN_RESPONSE_INVALID: server returned no run id');
      runContexts.current.set(result.run_id, preview.context);
      runObjects.current.set(result.run_id, objectSnapshot);
      preparedObjects.current.delete(preview.preview_id);
      setRunId(result.run_id);
      setRunIds(currentRuns => currentRuns.includes(result.run_id) ? currentRuns : [...currentRuns, result.run_id]);
      setCandidateEntries(currentEntries => {
        const cached = runCache.get(candidateCacheKey(result.run_id, initial.asset_revision_id)) ?? [];
        return [...currentEntries.filter(entry => entry.run_id !== result.run_id || entry.asset_revision_id !== initial.asset_revision_id), ...cached];
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not start AI run.');
    } finally {
      preparedObjects.current.delete(preview.preview_id);
      inFlight.current = false;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }, [api, prepareSnapshot]);

  useEffect(() => {
    const active: Array<{ controller: AbortController; timer: ReturnType<typeof setTimeout> | undefined }> = [];
    const pollRun = (runId: string) => {
      if (finishedRuns.current.has(runId)) return;
      const poller = { controller: new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
      active.push(poller);
      const poll = async () => {
        try {
          const rawEvents = await api.events(runId, lastSequences.current.get(runId) ?? 0, poller.controller.signal);
          if (poller.controller.signal.aborted) return;
          const invalidEvents = rawEvents.map((event) => validateContract('run_event', event)).filter((result) => !result.valid);
          if (invalidEvents.length) {
            setError(`Run event schema validation failed: ${invalidEvents.flatMap((result) => result.errors.map((item) => `${item.instancePath || '/'} ${item.message}`)).join('; ')}`);
            return;
          }
          const incoming = rawEvents as RunEvent[];
          if (incoming.length) setEventsByRun((prior) => new Map(prior).set(
            runId,
            [...(prior.get(runId) ?? []), ...incoming].filter((event, index, all) => all.findIndex((item) => item.seq === event.seq) === index).sort((a, b) => a.seq - b.seq),
          ));
          if (incoming.some((event) => event.type === 'candidate' || event.type === 'succeeded')) {
            const raw = await api.suggestions(runId, poller.controller.signal);
            if (poller.controller.signal.aborted) return;
            const pinnedContext = runContexts.current.get(runId);
            const pinnedObjects = runObjects.current.get(runId);
            if (!pinnedContext || !pinnedObjects) {
              setError('Run context or editor snapshot is unavailable; returned suggestions were not attached.');
              return;
            }
            const assetId = pinnedContext.asset_revision_id;
            const key = candidateCacheKey(runId, assetId);
            const checked = raw.map((unknownCandidate, index): CandidateEntry => {
              const validation = validateContract('suggestion_set', unknownCandidate);
              const schema_error = validation.valid
                ? ((unknownCandidate as SuggestionSet).model_run_id !== runId || !contextMatches((unknownCandidate as SuggestionSet).context, pinnedContext)
                  ? `Candidate ${index + 1} does not match its frozen run context.` : null)
                : `Candidate ${index + 1} failed schema validation: ${validation.errors.map((item) => `${item.instancePath || '/'} ${item.message}`).join('; ')}`;
              const candidate: SuggestionSet = validation.valid ? unknownCandidate as SuggestionSet : {
                suggestion_set_id: `invalid-${runId}-${index}`,
                model_run_id: runId,
                prediction_id: 'unavailable',
                context: pinnedContext,
                changes: [],
                issues: [],
                score: null,
                state: 'stale',
              };
              return { key: `${key}:${index}`, asset_revision_id: assetId, run_id: runId, run_context: pinnedContext, candidate, schema_error, objects: pinnedObjects };
            });
            runCache.set(key, checked);
            setCandidateEntries((current) => [...current.filter((entry) => entry.run_id !== runId), ...checked]);
          }
          // Commit the cursor only after dependent suggestions have been attached.
          // Failed or aborted reads must leave their trigger replayable via strict after.
          for (const event of incoming) lastSequences.current.set(runId, Math.max(lastSequences.current.get(runId) ?? 0, event.seq));
          const latest = incoming[incoming.length - 1];
          if (latest && ['succeeded', 'failed', 'cancelled'].includes(latest.type)) {
            finishedRuns.current.add(runId);
            return;
          }
        } catch (cause) {
          if (!poller.controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not update AI run.');
        }
        if (!poller.controller.signal.aborted) poller.timer = setTimeout(poll, background ? 2000 : 500);
      };
      void poll();
    };
    for (const activeRunId of runIds) pollRun(activeRunId);
    return () => {
      for (const poller of active) {
        poller.controller.abort();
        if (poller.timer !== undefined) clearTimeout(poller.timer);
      }
    };
  }, [api, background, runIds]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    const controller = new AbortController();
    try { await api.cancel(runId, controller.signal); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel AI run.'); }
  }, [api, runId]);

  const acceptSelected = useCallback(async (candidate: SuggestionSet, assetId: string, changeIds: string[], schemaError: string | null) => {
    setError(null);
    setSavedNotice(null);
    const captured = runContexts.current.get(candidate.model_run_id) ?? null;
    const currentGeneration = options.getGeneration();
    if (!captured || !contextMatches(captured, candidate.context) || !canAcceptSuggestion({ active_asset: options.asset_revision_id, candidate_asset: assetId, active_context: options.context, active_generation: currentGeneration ?? -1, candidate, busy, schema_error: schemaError })) {
      setError(candidate.state === 'stale' ? 'This candidate is stale and can only be compared.' : 'Candidate context or schema is not valid for acceptance.');
      return;
    }
    if (!changeIds.length) { setError('Select at least one change to accept.'); return; }
    const saveQueue = options.saveQueue;
    if (!saveQueue) { setError('Persistence is unavailable; candidate changes were not applied.'); return; }
    const delta = options.dispatch({ kind: 'apply_suggestions', set: candidate, change_ids: changeIds, expected_generation: currentGeneration ?? -1 });
    if (!delta || delta.error) { setError(delta?.error?.message ?? 'Editor rejected the selected changes.'); return; }
    const documentNow = options.getDocument();
    const generation = options.getGeneration();
    if (!documentNow || generation === null) {
      options.dispatch({ kind: 'undo' });
      setError('Editor snapshot is unavailable after acceptance; the operation was undone.');
      return;
    }
    const acceptedIntent = delta.suggestion_decisions.find((intent) =>
      intent.suggestion_set_id === candidate.suggestion_set_id &&
      intent.decision === 'accept' &&
      JSON.stringify(intent.change_ids) === JSON.stringify(changeIds),
    );
    if (!acceptedIntent) {
      options.dispatch({ kind: 'undo' });
      setError('Editor did not produce the selected acceptance journal; the operation was undone.');
      return;
    }
    const showSavedMessage = (message: string) => setSavedNotice({ assetId, generation: delta.generation, message });
    const acceptanceChanged = () => optionsRef.current.getGeneration() !== delta.generation;
    try {
      await saveQueue.flush(assetId);
      if (optionsRef.current.asset_revision_id !== assetId) return;
      if (acceptanceChanged()) {
        showSavedMessage('A later edit or undo changed this acceptance; check the current save status.');
        return;
      }
      const saved = saveQueue.getStatus(assetId);
      if (saved.synced_generation >= delta.generation && !saved.dirty) showSavedMessage('Accepted changes are saved on the server.');
      else showSavedMessage('Accepted changes are pending server acknowledgement.');
    } catch {
      if (optionsRef.current.asset_revision_id !== assetId) return;
      showSavedMessage(acceptanceChanged()
        ? 'A later edit or undo changed this acceptance; check the current save status.'
        : 'Accepted changes remain in the local save journal; server acknowledgement is pending.');
    }
  }, [busy, options]);

  const modelWaiting = runIds.some((id) => runContexts.current.get(id)?.project_id === options.context.project_id && !(eventsByRun.get(id) ?? []).some((event) => event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled'));
  return { run, preparePreview, cancel, runId, events, candidates: candidateEntries, error, busy, modelWaiting, savedMessage, acceptSelected };
}
