import { useEffect, useState } from 'react';
import type { ModelProfile } from '../../../../../packages/contracts/generated/ModelProfile';
import type { RunContext } from '../../../../../packages/contracts/generated/RunContext';
import type { RunIntent } from '../../../../../packages/contracts/generated/RunIntent';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { SaveQueue } from '../../lib/persistence/save-queue';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { CandidateList } from './CandidateList';
import { Consent } from './Consent';
import { ProviderPicker } from './ProviderPicker';
import { RunProgress } from './RunProgress';
import { useRun, type ConsentPreview, type RunApi } from './useRun';

export function Panel({ asset_revision_id, profiles, context, ontology, getDocument, getGeneration, generation, dispatch, saveQueue, obtainConsent, refreshContext, grants, api, csrfToken, intent: initialIntent = 'audit_attributes' }: {
  asset_revision_id: string;
  profiles: readonly ModelProfile[];
  context: RunContext;
  ontology: OntologyVersion;
  getDocument: () => AnnotationDocument | null;
  getGeneration: () => number | null;
  generation: number;
  dispatch: (command: EditorCommand) => EditorDelta | null;
  saveQueue?: SaveQueue;
  obtainConsent?: (preview: ConsentPreview) => Promise<string>;
  refreshContext: (snapshot: { document: AnnotationDocument; generation: number; annotation_revision_id: string }) => RunContext | Promise<RunContext>;
  grants: ConsentPreview['grants'];
  csrfToken?: string | null;
  api?: RunApi;
  intent?: RunIntent;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(profiles[0]?.profile_id ?? null);
  const [intent, setIntent] = useState<RunIntent>(initialIntent);
  const profile = profiles.find((item) => item.profile_id === selectedProfileId) ?? null;
  useEffect(() => {
    if (!profiles.some((item) => item.profile_id === selectedProfileId)) setSelectedProfileId(profiles[0]?.profile_id ?? null);
  }, [profiles, selectedProfileId]);
  const [prompt, setPrompt] = useState('');
  const [confirmedPreviewKey, setConfirmedPreviewKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const contextKey = JSON.stringify(context);
  const [reviewContext, setReviewContext] = useState(context);
  const [preparingScope, setPreparingScope] = useState(false);
  useEffect(() => {
    setReviewContext(context);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
  }, [contextKey]);
  const controller = useRun({
    asset_revision_id, profile, context, intent, prompt, grants, obtainConsent, dispatch,
    getDocument,
    getGeneration,
    refreshContext,
    saveQueue,
    csrfToken,
    api,
  });
  const preview: ConsentPreview | null = profile ? { profile, context: reviewContext, intent, prompt, grants } : null;
  const previewKey = preview === null ? null : JSON.stringify(preview);
  const consentChecked = previewKey !== null && confirmedPreviewKey === previewKey;

  const startRun = async () => {
    setPreparingScope(true);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
    try {
      const refreshed = await controller.prepareContext();
      if (refreshed) {
        setReviewContext(refreshed);
        setPreviewOpen(true);
      }
    } finally {
      setPreparingScope(false);
    }
  };
  const authorizeAndRun = async () => {
    if (!consentChecked || !previewKey) return;
    await controller.run(reviewContext);
    setPreviewOpen(false);
    setConfirmedPreviewKey(null);
  };


  return (
    <aside aria-label="AI review panel" data-testid="ai-panel">
      <h2>AI review</h2>
      <section aria-label="Pinned ontology rules">
        <h3>Ontology {ontology.ontology_version_id} · version {ontology.version_no}</h3>
        <pre>{ontology.guidelines_markdown}</pre>
        {ontology.labels.map((label) => <div key={label.label_id}>
          <h4>{label.name}</h4>
          <p>Allowed geometry: {label.allowed_geometry_types.join(', ')}</p>
          {label.attributes.map((attribute) => <p key={attribute.key}>{attribute.key}: {attribute.kind}; {attribute.required ? 'required' : 'optional'}; default {JSON.stringify(attribute.default_value)}; values {attribute.enum_values?.join(', ') ?? 'none'}; min {attribute.min ?? 'none'}; max {attribute.max ?? 'none'}</p>)}
        </div>)}
      </section>
      <ProviderPicker profiles={profiles} selected={profile?.profile_id ?? null} disabled={controller.busy || preparingScope} onSelect={(next) => { setSelectedProfileId(next.profile_id); setConfirmedPreviewKey(null); setPreviewOpen(false); }} />
      <label htmlFor="ai-intent">Review intent</label>
      <select id="ai-intent" value={intent} disabled={controller.busy || preparingScope} onChange={(event) => { setIntent(event.currentTarget.value as RunIntent); setConfirmedPreviewKey(null); setPreviewOpen(false); }} aria-label="Run intent">
        <option value="audit_attributes">Audit attributes</option><option value="find_issues">Find issues</option><option value="detect">Detect objects</option>
      </select>
      <label htmlFor="ai-prompt">Instruction</label>
      <textarea id="ai-prompt" data-testid="ai-prompt" value={prompt} onChange={(event) => { setPrompt(event.currentTarget.value); setConfirmedPreviewKey(null); }} disabled={controller.busy || preparingScope} rows={4} />
      <p>Scope: project {context.project_id}; asset revision {context.asset_revision_id}; ontology {context.ontology_version_id}; {context.selected_object_ids.length ? `${context.selected_object_ids.length} selected objects` : 'all document objects'}.</p>
      <button type="button" data-testid="ai-run" disabled={controller.busy || preparingScope || !profile || prompt.trim().length === 0 || context.asset_revision_id !== asset_revision_id} onClick={() => void startRun()}>{preparingScope ? 'Saving and refreshing scope…' : 'Review scope and run'}</button>
      {previewOpen && preview ? <>
        <Consent preview={preview} confirmed={consentChecked} onChange={(checked) => setConfirmedPreviewKey(checked ? previewKey : null)} />
        <button type="button" disabled={!consentChecked || controller.busy || preparingScope || !obtainConsent} onClick={() => void authorizeAndRun()}>Authorize and run now</button>
      </> : null}
      {controller.error ? <p role="alert">{controller.error}</p> : null}
      {controller.savedMessage ? <p role="status">{controller.savedMessage}</p> : null}
      <RunProgress runId={controller.runId} events={controller.events} busy={controller.busy} onCancel={() => void controller.cancel()} />
      <CandidateList entries={controller.candidates} activeAsset={asset_revision_id} activeContext={context} activeGeneration={generation} busy={controller.busy} onAccept={(entry, changeIds) => void controller.acceptSelected(entry.candidate, entry.asset_revision_id, changeIds, entry.schema_error)} />
    </aside>
  );
}
