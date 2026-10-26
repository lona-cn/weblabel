import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import { useSession } from '../../app/providers';
import { api, ApiFailure, csrfToken, saveAuthorizationEpoch, subscribeSaveAuthorization, type ApiMedia, type Project } from '../../lib/t15/api';
import { locateOntology } from './fixed-ontology';
import { decodeCanonicalFrame } from '../../lib/editor/loader';
import { EditorHost } from '../../lib/editor/EditorHost';
import type { LocalObjectFlagMap } from '../../lib/editor/types';
import { FetchSaveTransport, SaveQueue, isLeaseRejection } from '../../lib/persistence/save-queue';
import { IndexedDbDraftStorage, admitRawDraft } from '../../lib/persistence/draft-store';
import type { DraftBranchEnvelope, DraftRecord, LocalCommitEvidence, SaveQueueOwner } from '../../lib/persistence/types';
import { classifyDraftBranches, classifyReadonlySnapshot, compareWithServer, type RecoveryReport } from '../../lib/persistence/recovery';
import { DraftRecoveryChoice, SaveStatus } from './SaveStatus';
import { AttributePanel } from './AttributePanel';
import { SessionComfort } from './SessionComfort';
import { ProjectSaveSummary } from './ProjectSaveSummary';
import { ObjectList } from './ObjectList';
import { Toolbar, type Tool } from './Toolbar';
import { CanvasView } from './CanvasView';
import { ResizeControls } from './ResizeControls';
import { ReviewPanel } from '../review/ReviewPanel';
import { wireSaveLease, type LocalTaskLease, type TaskOpenPreparation, type TaskContinueInput, type TaskContinuationProof } from '../review/task-session-port';
import { reviewApi, type ReviewTask, type TaskCreateTarget, type TaskCreatePreparation } from '../review/api';
import type { TaskQueue } from '../review/workflow';
import { nextAssignedTask } from '../review/continue-task';
import { ViewportControls, type ViewportControlsHost } from './ViewportControls';
import { MemberManager } from '../projects/MemberManager';
import { ModelProfileSettings } from '../ai/ModelProfileSettings';
import { setReviewEditorLocked, submitCurrentReviewRevision } from '../review/submission';
import { WorkbenchAi, type WorkbenchAiEditorPort } from '../ai/WorkbenchAi';
import { ExternalProcessingPolicy } from '../projects/ExternalProcessingPolicy';
import { ActivityCollector } from './activity';
import { ActivityPanel } from './ActivityPanel';
import type { RunScope } from '../ai/run-controller';
import { Keyboard } from './Keyboard';
import { SelectionStore } from './selection-store';
import { ToolState } from './tool-state';
import { NumericGeometry } from './NumericGeometry';
import { LabelControls } from './LabelControls';
import { categoryShortcuts } from './category-shortcuts';
import { MediaImportPanel } from '../import-export/MediaImportPanel';
import { AnnotationImportPanel } from '../import-export/AnnotationImportPanel';
import type { AnnotationImportContext } from '../import-export/import-context';
import { RevisionExportPanel } from '../import-export/RevisionExportPanel';
import { getOutboxSnapshot, hasUnconfirmedImportForTarget, subscribeOutbox } from '../import-export/outbox';

type FixedTaskContext = Pick<ReviewTask, 'task_id' | 'project_id' | 'asset_revision_id' | 'ontology_version_id'>;
type Props = { projectId?: string; onProjects?: () => void; onDatasets?: () => void; initialReviewQueue?: TaskQueue };
type LoadedAsset = { media: ApiMedia; ontology: OntologyVersion; document: AnnotationDocument; revisionId: string; initial_generation: number; readOnlyPreview: boolean; frame: { width: number; height: number; rgba: Uint8Array } };
// Full Workbench remounts are new authorization sessions, unlike a panel-only remount.
let nextWorkbenchSession = 0;
// Preserve unresolved memory rescue across mounts; a new owner never inherits write authority.
const projectSaveQueues = new Map<string, { queue: SaveQueue; storage: IndexedDbDraftStorage }>();
// Native JSON maps need not preserve property insertion order. Arrays retain order.
function sameDocumentValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameDocumentValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function reportError(reason: unknown): string {
  if (reason instanceof ApiFailure) return [reason.code, reason.message, reason.request_id ? 'request_id: ' + reason.request_id : null].filter(Boolean).join(' · ');
  return reason instanceof Error ? reason.message : String(reason);
}

function rawDraftJson(record: unknown): string {
  const active = new WeakSet<object>();
  const invalid = () => { throw new Error('原始草稿无法无损表示为 JSON；保留原库，不宣称已救援。'); };
  function visit(value: unknown): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) invalid(); return; }
    if (typeof value !== 'object') return invalid();
    if (active.has(value)) return invalid();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) invalid();
    active.add(value);
    if (array) for (let i = 0; i < value.length; i += 1) { if (!(i in value)) invalid(); visit(value[i]); }
    else for (const key of Object.keys(value)) visit((value as Record<string, unknown>)[key]);
    active.delete(value);
  }
  visit(record);
  const text = JSON.stringify(record); if (text === undefined) return invalid(); return text;
}
function downloadRawDraft(record: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([rawDraftJson(record)], { type: 'application/json' }));
  try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); }
  finally { URL.revokeObjectURL(url); }
}
function RescueDraft({ record }: { record: unknown }) {
  const [error, setError] = useState<string | null>(null);
  return <section className="save-status-panel" data-testid="recovery-banner"><p role="status">本地记录已保留；这里只读查看或导出，不解除暂停、不丢弃 pending/journal。</p><button type="button" data-testid="export-local-draft" onClick={() => {
    try { downloadRawDraft(record, 'weblabel-native-draft.json'); setError(null); } catch (reason) { setError(reportError(reason)); }
  }}>下载本地草稿</button>{error ? <p role="alert">{error}</p> : null}</section>;
}

export function Workbench({ projectId = '', onProjects = () => {}, onDatasets = () => {}, initialReviewQueue }: Props) {
  const [workbenchSession] = useState(() => ++nextWorkbenchSession);
  const { entry, logout } = useSession();
  const session = entry.kind === 'authenticated' ? entry.session : null;
  const activitySurfaceRef = useRef<HTMLElement>(null);
  const reviewPanelRef = useRef<HTMLDetailsElement>(null);
  const managementRef = useRef<HTMLDetailsElement>(null);
  const [reviewQueue, setReviewQueue] = useState<TaskQueue>(initialReviewQueue ?? 'all');
  const [reviewOpen, setReviewOpen] = useState(Boolean(initialReviewQueue));
  const [managementOpen, setManagementOpen] = useState(false);
  const [profilesRevision, setProfilesRevision] = useState(0);
  useEffect(() => { if (initialReviewQueue) { setReviewQueue(initialReviewQueue); setReviewOpen(true); } }, [initialReviewQueue]);
  function openReviewQueue(queue: TaskQueue) {
    setReviewQueue(queue); setReviewOpen(true);
    const url = new URL(location.href); url.searchParams.set('review_queue', queue); history.replaceState(null, '', url);
    requestAnimationFrame(() => { reviewPanelRef.current?.scrollIntoView({ block: 'start' }); reviewPanelRef.current?.querySelector<HTMLElement>(':scope > summary')?.focus(); });
  }
  const activity = useMemo(() => new ActivityCollector(projectId, session?.user_id ?? '', undefined, () => window.localStorage), [projectId, session?.user_id]);
  const recordActivity = useCallback((kind: Parameters<ActivityCollector['interact']>[0]) => activity.interact(kind), [activity]);
  const modelWaitingChanged = useCallback((waiting: boolean) => activity.setKind(waiting ? 'model_wait' : 'task'), [activity]);
  const [activityRun, setActivityRun] = useState<{ actorId: string; scope: RunScope } | null>(null);
  const activityRunChanged = useCallback((scope: RunScope | null) => {
    if (!session || currentSessionRef.current.actorId !== session.user_id || currentSessionRef.current.projectId !== projectId) return;
    setActivityRun(scope && scope.projectId === projectId ? { actorId: session.user_id, scope } : null);
  }, [projectId, session?.user_id]);
  const workspaceHeadingRef = useRef<HTMLDivElement>(null);
  useEffect(() => { workspaceHeadingRef.current?.focus(); }, []);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia?.('(max-width: 1099px)').matches ?? false);
  const [compactPanel, setCompactPanel] = useState<'assets' | 'attributes' | 'ai' | null>(null);
  const [assetsCollapsed, setAssetsCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorView, setInspectorView] = useState<'attributes' | 'ai'>('attributes');
  const panelLaunchers = useRef<Record<'assets' | 'attributes' | 'ai', HTMLButtonElement | null>>({ assets: null, attributes: null, ai: null });
  const assetsPanelRef = useRef<HTMLElement>(null);
  const inspectorPanelRef = useRef<HTMLElement>(null);
  // CSS can blur a hidden drawer before matchMedia delivers the breakpoint event.
  const focusedPanelRef = useRef<'assets' | 'inspector' | null>(null);
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 1099px)');
    if (!query) return;
    const update = () => {
      if (focusedPanelRef.current === 'assets') panelLaunchers.current.assets?.focus();
      else if (focusedPanelRef.current === 'inspector') panelLaunchers.current[inspectorView]?.focus();
      setCompactLayout(query.matches);
      setCompactPanel(null);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [inspectorView]);
  useEffect(() => {
    if (!compactPanel) return;
    const panel = compactPanel === 'assets' ? assetsPanelRef.current : inspectorPanelRef.current;
    panel?.querySelector<HTMLButtonElement>('[data-close-panel]')?.focus();
  }, [compactPanel]);
  function closeCompactPanel() {
    const previous = compactPanel;
    setCompactPanel(null);
    if (previous) panelLaunchers.current[previous]?.focus();
  }
  function togglePanel(panel: 'assets' | 'attributes' | 'ai') {
    if (panel !== 'assets') setInspectorView(panel);
    if (compactLayout) setCompactPanel((current) => current === panel ? null : panel);
    else if (panel === 'assets') setAssetsCollapsed((current) => !current);
    else if (!inspectorCollapsed && inspectorView === panel) setInspectorCollapsed(true);
    else setInspectorCollapsed(false);
  }
  const showAssets = compactLayout ? compactPanel === 'assets' : !assetsCollapsed;
  const showInspector = compactLayout ? compactPanel === 'attributes' || compactPanel === 'ai' : !inspectorCollapsed;
  const [project, setProject] = useState<Project | null>(null);
  const [ontologies, setOntologies] = useState<OntologyVersion[]>([]);
  const [assets, setAssets] = useState<ApiMedia[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(() => new URLSearchParams(location.search).get('asset_revision_id'));
  const [taskContext, setTaskContext] = useState<FixedTaskContext | null>(() => {
    const params = new URLSearchParams(location.search);
    const task_id = params.get('task_id'), asset_revision_id = params.get('asset_revision_id'), ontology_version_id = params.get('ontology_version_id');
    return task_id && asset_revision_id && ontology_version_id ? { task_id, project_id: projectId, asset_revision_id, ontology_version_id } : null;
  });
  const taskContextRef = useRef(taskContext); taskContextRef.current = taskContext;
  const taskOntologyId = taskContext?.ontology_version_id ?? null;
  const [explicitOntologyId, setExplicitOntologyId] = useState<string | null>(() => new URLSearchParams(location.search).get('ontology_version_id'));
  const [headIds, setHeadIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<LoadedAsset | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [activeLabelId, setActiveLabelId] = useState('');
  const drawingLabelMemory = useRef<{ project: string; ontology: string; label: string } | null>(null);
  const [previewSelectedIds, setPreviewSelectedIds] = useState<string[]>([]);
  const [pausedScope, setPausedScope] = useState<string | null>(null);
  const pausedScopeRef = useRef<string | null>(null);
  const [host, setHost] = useState<EditorHost | null>(null);
  const [settledHost, setSettledHost] = useState<{ host: EditorHost; loaded: LoadedAsset } | null>(null);
  const subscribeHostStatus = useCallback((notify: () => void) => host?.subscribeStatus(notify) ?? (() => {}), [host]);
  const hostStatus = useSyncExternalStore(subscribeHostStatus, () => host?.status ?? 'idle', () => 'idle');
  const [objects, setObjects] = useState<AnnotationObject[]>([]);
  const committedNativeDocuments = useRef(new WeakMap<EditorHost, AnnotationDocument>());
  const trustedLoadedBases = useRef(new WeakMap<LoadedAsset, AnnotationRevision>());
  const [localFlags, setLocalFlags] = useState<LocalObjectFlagMap>({});
  const [completionChoice, setCompletionChoice] = useState<'unprocessed' | 'in_progress' | 'complete' | 'confirmed_negative'>('unprocessed');
  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [branches, setBranches] = useState<readonly DraftBranchEnvelope[]>([]);
  const [legacyRows, setLegacyRows] = useState<readonly { key: IDBValidKey; record: unknown }[]>([]);
  async function readLegacyRescue(reason: unknown) {
    if (!(reason instanceof Error) || !('code' in reason) || (reason.code !== 'STORAGE_UPGRADE_FAILED' && reason.code !== 'STORAGE_BLOCKED')) return;
    const epoch = saveAuthorizationEpoch();
    const isCurrent = () => lifecycle.current && currentSessionRef.current.projectId === projectId && currentSessionRef.current.actorId === actorId && saveAuthorizationEpoch() === epoch;
    if (!isCurrent()) return;
    try { const rows = await storage.readLegacyForRescue(); if (isCurrent()) setLegacyRows(rows); }
    catch (reason) { if (isCurrent()) setError(previous => (previous ?? '') + ' 旧库只读救援：' + reportError(reason)); }
  }
  const [branchChoice, setBranchChoice] = useState<{ asset: string; draft: string; token: string; action: 'recover' | 'use_server'; expected: LocalCommitEvidence | null } | null>(null);
  const appliedBranchChoice = useRef<{ choice: NonNullable<typeof branchChoice>; draftId: string } | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  async function chooseBranch(draft: string, action: 'recover' | 'use_server') {
    if (!selectedAssetId || branchBusy || taskPreparationRef.current || importLockRef.current || submissionLockRef.current) return;
    const captured = currentSessionRef.current, owner = saveOwnerRef.current?.owner, epoch = saveAuthorizationEpoch();
    const isCurrent = () => lifecycle.current && currentSessionRef.current.selectedAssetId === selectedAssetId
      && currentSessionRef.current.scopeKey === captured.scopeKey && currentSessionRef.current.actorId === captured.actorId
      && currentSessionRef.current.projectId === captured.projectId && currentSessionRef.current.host === captured.host
      && currentSessionRef.current.loaded === captured.loaded && saveOwnerRef.current?.owner === owner && saveAuthorizationEpoch() === epoch
      && !taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current;
    setBranchBusy(true);
    try {
      host?.cancelGesture();
      await queue.whenPersisted(selectedAssetId);
      if (!isCurrent()) return;
      const source = await queue.readDraftBranch(selectedAssetId, draft);
      if (!isCurrent()) return;
      if (!source) throw new Error('所选分支已变化，请重新选择。');
      const memory = queue.getDraftBranchSnapshot(selectedAssetId);
      if (memory && (!memory.local_commit || memory.ack_local_barrier || queue.getStatus(selectedAssetId).saving || queue.getStatus(selectedAssetId).last_error?.kind === 'storage')) throw new Error('当前分支尚未完成真实本地提交，请先下载救援。');
      currentSessionRef.current = { ...currentSessionRef.current, host: null, loaded: null };
      setHost(null); setLoaded(null);
      setBranchChoice({ asset: selectedAssetId, draft, token: source.write_token, action, expected: memory?.local_commit ?? null });
    } catch (reason) { setError(reportError(reason)); }
    finally { setBranchBusy(false); }
  }
  async function rescueBranch(draft: string) {
    if (!selectedAssetId) return;
    const asset = selectedAssetId, captured = currentSessionRef.current, epoch = saveAuthorizationEpoch();
    const cached = branches.find(row => row.asset_revision_id === asset && row.draft_id === draft);
    const isCurrent = () => lifecycle.current && currentSessionRef.current.selectedAssetId === asset && currentSessionRef.current.projectId === captured.projectId && currentSessionRef.current.actorId === captured.actorId && saveAuthorizationEpoch() === epoch;
    try {
      let source: DraftBranchEnvelope;
      try {
        const fresh = await queue.readDraftBranch(asset, draft);
        if (!fresh) throw new Error('所选分支不存在。');
        source = fresh;
      } catch (reason) {
        if (!isCurrent()) return;
        if (!cached) throw reason;
        downloadRawDraft(cached.record, 'weblabel-draft-' + draft + '.json');
        setError('已导出先前完整读取的缓存快照；这不是最新读取确认或本地保存凭证。读取失败：' + reportError(reason));
        return;
      }
      if (isCurrent()) downloadRawDraft(source.record, 'weblabel-draft-' + draft + '.json');
    } catch (reason) { if (isCurrent()) setError(reportError(reason)); }
  }
  const [importLocked, setImportLocked] = useState(false);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const importLockRef = useRef<{ scope: string; context: AnnotationImportContext | null } | null>(null);
  const taskLeaseRef = useRef<LocalTaskLease | null>(null);
  const taskLeaseActorRef = useRef<string | null>(null);
  const [, renderLease] = useState(0);
  const taskPreparationRef = useRef<symbol | null>(null);
  const ownedFutureProof = useRef<{ scope: string; host: EditorHost; loaded: LoadedAsset; taskId: string; draftId: string; writeToken: string; generation: number; editSeq: number; persistSeq: number; base: string; syncedGeneration: number; syncedIntentSeq: number; journalLength: number } | null>(null);
  const [taskPreparing, setTaskPreparing] = useState(false);
  const ordinaryNativeScopeRef = useRef<{ host: EditorHost; loaded: LoadedAsset; ontologies: OntologyVersion[]; project: Project | null; sessionEpoch: number; authorizationEpoch: number; canWriteRole: boolean } | null>(null);
  const editorSurfaceRef = useRef<HTMLDivElement>(null);
  const importSurfaceRef = useRef<HTMLElement>(null);
  const submissionLockRef = useRef(false);
  const persistence = useMemo(() => {
    const existing = projectSaveQueues.get(projectId);
    if (existing) return existing;
    const storage = new IndexedDbDraftStorage();
    const created = new SaveQueue({
      transport: new FetchSaveTransport({ csrfToken }), storage,
      owner: { token: {}, actor_id: session?.user_id ?? '', project_id: projectId, isCurrent: () => false, isWritable: () => false, canPrepareOperation: () => false, getLease: () => null },
    });
    const persistence = { queue: created, storage }; projectSaveQueues.set(projectId, persistence);
    return persistence;
  }, [projectId]);
  const { queue, storage } = persistence;
  const updateTaskLease = useCallback((lease: LocalTaskLease | null) => {
    if (currentSessionRef.current.actorId !== session?.user_id) return;
    taskLeaseRef.current = lease;
    taskLeaseActorRef.current = lease ? session?.user_id ?? null : null;
    renderLease(version => version + 1);
    // Renewing/claiming never authorizes a rejected or historically unknown save.
    // A user retries the immutable operation through the scoped SaveStatus action.
  }, [session?.user_id]);
  const activeLoaded = loaded?.media.asset_revision_id === selectedAssetId ? loaded : null;
  const subscribeCurrentSave = useCallback((listener: () => void) => activeLoaded ? queue.subscribe(activeLoaded.media.asset_revision_id, listener) : () => {}, [queue, activeLoaded?.media.asset_revision_id]);
  const currentSaveStatus = useSyncExternalStore(subscribeCurrentSave,
    () => activeLoaded ? queue.getStatus(activeLoaded.media.asset_revision_id) : null,
    () => activeLoaded ? queue.getStatus(activeLoaded.media.asset_revision_id) : null);
  const currentSaveRecord = activeLoaded ? queue.toRecord(activeLoaded.media.asset_revision_id) : null;
  // Server base advances independently of the immutable Native load request.
  const currentRevisionId = activeLoaded && !activeLoaded.readOnlyPreview
    && currentSaveRecord?.ontology_version_id === activeLoaded.ontology.ontology_version_id
    && currentSaveRecord.document.asset_revision_id === activeLoaded.media.asset_revision_id
    && currentSaveRecord.document.ontology_version_id === activeLoaded.ontology.ontology_version_id
    && currentSaveStatus?.last_ack?.revision_id === currentSaveRecord.base_revision_id
    ? currentSaveRecord.base_revision_id : activeLoaded?.revisionId ?? null;
  const actorId = session?.user_id ?? '';
  const sessionRole = session?.project_roles.find(item => item.project_id === projectId)?.role;
  const liveAuthorizationEpoch = useSyncExternalStore(subscribeSaveAuthorization, saveAuthorizationEpoch, saveAuthorizationEpoch);
  // Only a newly verified Session object binds the new epoch; unrelated renders cannot reauthorize an old identity.
  const authorizationScope = useRef({ session, epoch: liveAuthorizationEpoch });
  if (authorizationScope.current.session !== session) authorizationScope.current = { session, epoch: liveAuthorizationEpoch };
  const authorizationEpoch = authorizationScope.current.epoch;
  const canWriteRole = liveAuthorizationEpoch === authorizationEpoch && !!actorId && project?.project_id === projectId && project.role === sessionRole && ['admin', 'annotator'].includes(sessionRole ?? '');
  const scopeOwner = useRef({ projectId, actorId, sessionRole, selectedAssetId, loaded, host, sessionEpoch, epoch: 0 });
  const previousScope = scopeOwner.current;
  if (previousScope.projectId !== projectId || previousScope.actorId !== actorId || previousScope.sessionRole !== sessionRole || previousScope.selectedAssetId !== selectedAssetId || previousScope.loaded !== loaded || previousScope.host !== host || previousScope.sessionEpoch !== sessionEpoch) {
    scopeOwner.current = { projectId, actorId, sessionRole, selectedAssetId, loaded, host, sessionEpoch, epoch: previousScope.epoch + 1 };
  }
  const scopeKey = JSON.stringify([projectId, selectedAssetId, activeLoaded?.ontology.ontology_version_id ?? null, workbenchSession, scopeOwner.current.epoch, liveAuthorizationEpoch, branchChoice?.asset === selectedAssetId ? [branchChoice.draft, branchChoice.token, branchChoice.action] : null]);
  const unknownImport = useSyncExternalStore(subscribeOutbox, () => activeLoaded ? hasUnconfirmedImportForTarget(projectId, activeLoaded.media.asset_revision_id, activeLoaded.ontology.ontology_version_id) : false, () => false);
  const currentSessionRef = useRef({ host, loaded, selectedAssetId, projectId, actorId, canWriteRole, scopeKey });
  currentSessionRef.current = { host, loaded, selectedAssetId, projectId, actorId, canWriteRole, scopeKey };
  const creationAuthorityRef = useRef({ project, assets, ontologies, sessionRole, catalogReady });
  creationAuthorityRef.current = { project, assets, ontologies, sessionRole, catalogReady };
  // Server task eligibility is asset-wide, across all states, norms and assignees.
  const ordinaryEligibilityKey = JSON.stringify([projectId, actorId, sessionRole, selectedAssetId, explicitOntologyId, taskOntologyId, sessionEpoch, liveAuthorizationEpoch]);
  const ordinaryEligibilityRef = useRef<{ key: string; ontologies: OntologyVersion[]; assignedAssets: Set<string> | null }>({ key: ordinaryEligibilityKey, ontologies, assignedAssets: null });
  if (ordinaryEligibilityRef.current.key !== ordinaryEligibilityKey || ordinaryEligibilityRef.current.ontologies !== ontologies) {
    ordinaryEligibilityRef.current = { key: ordinaryEligibilityKey, ontologies, assignedAssets: null };
  }
  const matchesFixedTask = (assetId: string, ontologyId: string) => {
    const fixed = taskContextRef.current, lease = taskLeaseRef.current;
    if (!fixed) return ordinaryEligibilityRef.current.assignedAssets !== null && !ordinaryEligibilityRef.current.assignedAssets.has(assetId);
    return !!lease && fixed.project_id === currentSessionRef.current.projectId && fixed.asset_revision_id === assetId
      && fixed.ontology_version_id === ontologyId && lease.task_id === fixed.task_id && lease.asset_revision_id === assetId
      && lease.ontology_version_id === ontologyId && taskLeaseActorRef.current === currentSessionRef.current.actorId;
  };
  const lifecycle = useRef(true);
  const ownerKey = JSON.stringify([workbenchSession, projectId, actorId, sessionRole ?? null, authorizationEpoch]);
  const saveOwnerRef = useRef<{ key: string; owner: SaveQueueOwner } | null>(null);
  if (saveOwnerRef.current?.key !== ownerKey) {
    const owner: SaveQueueOwner = {
      token: {}, actor_id: actorId, project_id: projectId,
      isCurrent: () => lifecycle.current && saveOwnerRef.current?.owner === owner && saveAuthorizationEpoch() === authorizationEpoch
        && currentSessionRef.current.actorId === actorId && currentSessionRef.current.projectId === projectId,
      // Original immutable success receipts do not need a currently held lease.
      isWritable: () => currentSessionRef.current.canWriteRole,
      // Fresh-operation lease authority is independent of receipt reconciliation.
      // Caller preparation/import barriers must not prevent the C06 flush.
      canPrepareOperation: (assetId, ontologyId) => matchesFixedTask(assetId, ontologyId),
      getLease: assetId => {
        const lease = taskLeaseRef.current, fixed = taskContextRef.current, record = queue.toRecord(assetId);
        return lease && fixed && lease.asset_revision_id === assetId && lease.task_id === fixed.task_id
          && lease.ontology_version_id === fixed.ontology_version_id && record?.ontology_version_id === fixed.ontology_version_id
          && taskLeaseActorRef.current === currentSessionRef.current.actorId ? wireSaveLease(lease) : null;
      },
    };
    // Synchronous invalidation: queued work cannot borrow a replacement owner.
    saveOwnerRef.current = { key: ownerKey, owner };
  }
  const saveOwner = saveOwnerRef.current.owner;
  useLayoutEffect(() => {
    lifecycle.current = true;
    if (liveAuthorizationEpoch === authorizationEpoch) queue.setWriteOwner(saveOwner);
    else queue.revokeWriteOwner(saveOwner.token);
    return () => {
      queue.revokeWriteOwner(saveOwner.token);
      if (saveOwnerRef.current?.owner === saveOwner) lifecycle.current = false;
    };
  }, [queue, saveOwner, liveAuthorizationEpoch, authorizationEpoch]);
  const editorPort = useMemo(() => {
    const getReadHost = () => {
      const current = currentSessionRef.current;
      return lifecycle.current && saveAuthorizationEpoch() === authorizationEpoch && host && current.host === host && current.loaded === loaded && current.scopeKey === scopeKey
        && loaded?.media.asset_revision_id === current.selectedAssetId && loaded.media.project_id === current.projectId ? host : null;
    };
    const getHost = () => {
      const current = getReadHost();
      return current && pausedScopeRef.current !== scopeKey && currentSessionRef.current.canWriteRole && !loaded?.readOnlyPreview && current.status === 'ready'
        && !taskPreparationRef.current && matchesFixedTask(loaded!.media.asset_revision_id, loaded!.ontology.ontology_version_id)
        && !submissionLockRef.current && !importLockRef.current && !hasUnconfirmedImportForTarget(loaded!.media.project_id, loaded!.media.asset_revision_id, loaded!.ontology.ontology_version_id)
        && queue.canAcceptEdits(loaded!.media.asset_revision_id, loaded!.ontology.ontology_version_id) ? current : null;
    };
    return { getReadHost, getHost,
      getSnapshot: () => getReadHost()?.getSnapshot() ?? (lifecycle.current && currentSessionRef.current.scopeKey === scopeKey ? loaded?.document ?? null : null),
      setTool: (next: Tool) => getHost()?.setTool(next) ?? false,
      dispatch: (command: Parameters<EditorHost['dispatch']>[0]) => getHost()?.dispatch(command) ?? null,
      cancelGesture: () => { getReadHost()?.cancelGesture(); },
    };
  }, [host, loaded, scopeKey, queue, authorizationEpoch]);
  const viewportHost = useMemo<ViewportControlsHost | null>(() => {
    const captured = editorPort.getReadHost();
    if (!captured) return null;
    const current = () => editorPort.getReadHost();
    return {
      get status() { return current()?.status ?? 'disposed'; },
      getViewport: () => current()?.getViewport() ?? null,
      getHitStackState: () => current()?.getHitStackState() ?? null,
      zoomAt: (x, y, factor) => { current()?.zoomAt(x, y, factor); },
      fitImage: () => { current()?.fitImage(); },
      focusSelection: () => { current()?.focusSelection(); },
      subscribeRendered: listener => captured.subscribeRendered(listener),
      subscribeStatus: listener => captured.subscribeStatus(listener),
    };
  }, [editorPort]);
  const activeHost = activeLoaded ? host : null;
  const subscribeActiveSave = useCallback((notify: () => void) => queue.subscribe(selectedAssetId ?? '', notify), [queue, selectedAssetId]);
  const activeSaveSnapshot = useSyncExternalStore(subscribeActiveSave, () => queue.getStatus(selectedAssetId ?? ''), () => queue.getStatus(selectedAssetId ?? ''));
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (selectedAssetId) void queue.readDraftBranches(selectedAssetId).then(rows => { if (alive) setBranches(rows); }).catch(reason => { if (alive) setError(reportError(reason)); }); };
    if (activeSaveSnapshot.local_commit) refresh();
    window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, [queue, selectedAssetId, activeSaveSnapshot.local_commit?.write_token]);
  const branchDispositions = useMemo(() => classifyDraftBranches(branches, selectedAssetId ? queue.getDraftBranchSnapshot(selectedAssetId) : null), [branches, queue, selectedAssetId, activeSaveSnapshot]);
  // Display only: ownerless clean snapshots remain in the project history, never become recovery grants.
  const recoveryBranches = useMemo(() => branches.filter(row => classifyReadonlySnapshot(row.record, row.asset_revision_id) !== 'clean_snapshot'), [branches]);
  const editableHost = activeLoaded && activeHost ? editorPort.getHost() : null;
  const sessionPaused = pausedScope === scopeKey;
  const aiEditor: WorkbenchAiEditorPort = useMemo(() => ({
    getDocument: editorPort.getSnapshot,
    getGeneration: () => editorPort.getReadHost()?.getGeneration() ?? null,
    getObjectHashes: () => editorPort.getReadHost()?.getObjectHashes() ?? null,
    focusRegion: bounds => editorPort.getReadHost()?.focusRegion(bounds) ?? false,
    dispatch: editorPort.dispatch,
  }), [editorPort]);
  const selectionStore = useMemo(() => new SelectionStore(), [editorPort]);
  const subscribeSelection = useCallback((notify: () => void) => selectionStore.subscribeSelection(notify), [selectionStore]);
  const selectedIds = useSyncExternalStore(subscribeSelection, () => selectionStore.getSelection(), () => selectionStore.getSelection());
  const tools = useMemo(() => new ToolState(editorPort), [editorPort]);
  const subscribeTools = useCallback((notify: () => void) => tools.subscribe(notify), [tools]);
  const tool = useSyncExternalStore(subscribeTools, () => tools.current(), () => tools.current());
  useEffect(() => { if (hostStatus === 'ready') tools.reconcileSpaceRelease(); }, [hostStatus, tools]);
  const acceptsKeyboardTarget = useCallback((target: EventTarget | null) =>
    target instanceof Node && !!editorSurfaceRef.current?.contains(target), []);
  const submitReviewTask = useCallback((task: ReviewTask, submit: (revisionId: string) => Promise<void>) => {
    if (!editorPort.getHost() || taskPreparationRef.current || taskContextRef.current?.task_id !== task.task_id
      || task.asset_revision_id !== activeLoaded?.media.asset_revision_id || task.ontology_version_id !== activeLoaded?.ontology.ontology_version_id
      || importLockRef.current || hasUnconfirmedImportForTarget(projectId, task.asset_revision_id, task.ontology_version_id)) return Promise.reject(new Error('当前固定任务、权限、保存或导入状态不允许提交。'));
    return submitCurrentReviewRevision({
      task,
      queue,
      readHead: () => api.annotation(task.asset_revision_id, task.ontology_version_id),
      submit,
      lockEditor: (locked) => {
        setReviewEditorLocked({
          locked, state: submissionLockRef, host, surfaces: [editorSurfaceRef.current, importSurfaceRef.current],
        });
        if (!locked) tools.reconcileSpaceRelease();
      },
    }); }, [host, queue, tools, projectId, editorPort, activeLoaded]);
  const continueTask = useCallback(async (input: TaskContinueInput) => {
    const { task, submission } = input;
    const currentScope = scopeKey;
    const fixedRecord = queue.toRecord(task.asset_revision_id);
    const local = queue.getStatus(task.asset_revision_id).local_commit;
    const certified = local ? { ...local } : null;
    const fixedHost = editorPort.getReadHost(), fixedEpoch = saveAuthorizationEpoch();
    let preparationOwner: symbol | null = null;
    const proof: TaskContinuationProof = { isCurrent: (preparationToken) => {
      if (preparationToken !== null) {
        if (taskPreparationRef.current !== preparationToken || preparationOwner !== null && preparationOwner !== preparationToken) return false;
        preparationOwner = preparationToken;
      } else if (preparationOwner !== null) return false;
      const current = currentSessionRef.current;
      const readHost = editorPort.getReadHost();
      const saved = queue.getStatus(task.asset_revision_id);
      return lifecycle.current && saveOwner.isCurrent() && current.scopeKey === currentScope
        && saveAuthorizationEpoch() === fixedEpoch && current.host === fixedHost && readHost === fixedHost
        && current.actorId === actorId && current.projectId === projectId && current.canWriteRole
        && current.loaded === activeLoaded && current.loaded?.media.asset_revision_id === task.asset_revision_id
        && current.loaded.ontology.ontology_version_id === task.ontology_version_id
        && taskContextRef.current?.task_id === task.task_id && (!taskLeaseRef.current || preparationToken !== null && taskPreparationRef.current === preparationToken)
        && taskPreparationRef.current === preparationToken && !importLockRef.current && !submissionLockRef.current
        && !hasUnconfirmedImportForTarget(projectId, task.asset_revision_id, task.ontology_version_id)
        && readHost?.status === 'ready' && saved.phase === 'synced' && !saved.dirty && !saved.saving && !saved.writes_paused
        && saved.base_revision_id === submission.revision_ids[0] && !!saved.local_commit
        && !!certified && saved.local_commit.draft_id === certified.draft_id
        && saved.local_commit.write_token === certified.write_token && saved.local_commit.persist_seq === certified.persist_seq
        && saved.local_commit.edit_seq === certified.edit_seq && saved.local_commit.generation === certified.generation
        && saved.local_commit.generation === saved.local_generation && readHost.getGeneration() === saved.local_generation
        && !!fixedRecord && sameDocumentValue(readHost.getSnapshot(), fixedRecord.document);
    } };
    const next = await nextAssignedTask({ task, submission, actorId, projectId, isCurrent: () => input.isCurrent() && proof.isCurrent(null), read: {
      session: api.session, submission: reviewApi.submission, tasks: reviewApi.tasks,
    } });
    return next ? { task: next, proof } : null;
  }, [scopeKey, editorPort, queue, saveOwner, actorId, projectId, activeLoaded]);
  function canReconcileInScope(key: string): boolean {
    const current = currentSessionRef.current, document = current.loaded;
    const fixed = taskContextRef.current;
    const record = document ? queue.toRecord(document.media.asset_revision_id) : null;
    return lifecycle.current && saveAuthorizationEpoch() === authorizationEpoch
      && saveOwnerRef.current?.owner === saveOwner && saveOwner.isCurrent()
      && current.scopeKey === key && current.actorId === actorId && current.projectId === projectId && current.canWriteRole
      && !!document && document === loaded && current.host === host && current.host?.status === 'ready'
      && current.selectedAssetId === document.media.asset_revision_id && document.media.project_id === projectId
      && document.ontology.labels.length > 0 && record?.asset_revision_id === document.media.asset_revision_id
      && record.ontology_version_id === document.ontology.ontology_version_id
      && record.document.asset_revision_id === document.media.asset_revision_id
      && record.document.ontology_version_id === document.ontology.ontology_version_id
      && (!taskContext ? !fixed : !!fixed && fixed.task_id === taskContext.task_id
        && fixed.project_id === projectId && fixed.asset_revision_id === document.media.asset_revision_id
        && fixed.ontology_version_id === document.ontology.ontology_version_id)
      && !taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current
      && !hasUnconfirmedImportForTarget(projectId, document.media.asset_revision_id, document.ontology.ontology_version_id);
  }
  function canSaveInScope(key: string): boolean {
    const current = currentSessionRef.current, document = current.loaded;
    const record = document ? queue.toRecord(document.media.asset_revision_id) : null;
    const owned = record?.draft_owner?.actor_id === current.actorId && record.draft_owner.project_id === current.projectId;
    const pendingOwned = record?.pending_owner?.actor_id === current.actorId && record.pending_owner.project_id === current.projectId;
    const outstanding = !!record && (record.generation > record.synced_generation || record.intent_journal.length > record.synced_intent_seq || !!record.pending);
    if (outstanding && (!owned || (!!record?.pending && !pendingOwned))) return false;
    return lifecycle.current && saveAuthorizationEpoch() === authorizationEpoch && current.scopeKey === key && current.canWriteRole && !!document && current.selectedAssetId === document.media.asset_revision_id
      && current.host?.status === 'ready' && document.ontology.labels.length > 0
      && record?.ontology_version_id === document.ontology.ontology_version_id
      && matchesFixedTask(document.media.asset_revision_id, document.ontology.ontology_version_id)
      && !taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current
      && !hasUnconfirmedImportForTarget(current.projectId, document.media.asset_revision_id, document.ontology.ontology_version_id);
  }
  function hasOwnedFuture(current: typeof currentSessionRef.current): boolean {
    const document = current.loaded, native = current.host, fixed = taskContextRef.current;
    if (!document || !native || native.status !== 'ready' || !fixed || fixed.project_id !== current.projectId
      || fixed.asset_revision_id !== current.selectedAssetId || fixed.asset_revision_id !== document.media.asset_revision_id
      || fixed.ontology_version_id !== document.ontology.ontology_version_id || document.media.project_id !== current.projectId) return false;
    const record = queue.toRecord(fixed.asset_revision_id), status = queue.getStatus(fixed.asset_revision_id);
    if (!record || record.pending || record.pending_owner || (record.pending_outcome != null && record.pending_outcome !== 'prepared') || record.save_error || status.last_error || status.saving
      || record.draft_owner?.actor_id !== current.actorId || record.draft_owner.project_id !== current.projectId
      || record.asset_revision_id !== fixed.asset_revision_id || record.ontology_version_id !== fixed.ontology_version_id
      || record.document.asset_revision_id !== fixed.asset_revision_id || record.document.ontology_version_id !== fixed.ontology_version_id
      || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.synced_generation) || record.synced_generation < 0
      || record.generation < record.synced_generation || !Number.isSafeInteger(record.edit_seq ?? 0) || (record.edit_seq ?? 0) < 0
      || !Number.isSafeInteger(record.synced_intent_seq) || record.synced_intent_seq < 0
      || record.synced_intent_seq > record.intent_journal.length
      || !(record.generation > record.synced_generation || record.intent_journal.length > record.synced_intent_seq)
      || native.getGeneration() !== record.generation || !record.base_revision_id
      || hasUnconfirmedImportForTarget(current.projectId, fixed.asset_revision_id, fixed.ontology_version_id)) return false;
    const ack = status.last_ack, base = trustedLoadedBases.current.get(document);
    return (!!ack && ack.revision_id === record.base_revision_id && ack.generation === record.synced_generation)
      || (!!base && base.annotation_revision_id === record.base_revision_id && base.document.asset_revision_id === record.asset_revision_id
        && base.document.ontology_version_id === record.ontology_version_id);
  }
  function canRetryOwnedFuture(key: string): boolean {
    const current = currentSessionRef.current, proof = ownedFutureProof.current;
    if (!canReconcileInScope(key) || !hasOwnedFuture(current) || !proof || proof.scope !== key || proof.host !== current.host
      || proof.loaded !== current.loaded || proof.taskId !== taskContextRef.current?.task_id
      || !matchesFixedTask(current.selectedAssetId!, current.loaded!.ontology.ontology_version_id)) return false;
    const record = queue.toRecord(current.selectedAssetId!)!, certificate = queue.getStatus(current.selectedAssetId!).local_commit;
    const lease = taskLeaseRef.current;
    return !!lease && Number.isSafeInteger(lease.fencing_token) && lease.fencing_token > 0
      && record.generation === proof.generation && (record.edit_seq ?? 0) === proof.editSeq && record.base_revision_id === proof.base
      && record.synced_generation === proof.syncedGeneration && record.synced_intent_seq === proof.syncedIntentSeq
      && record.intent_journal.length === proof.journalLength && !!certificate && certificate.generation === proof.generation
      && certificate.draft_id === proof.draftId && certificate.write_token === proof.writeToken && certificate.edit_seq === proof.editSeq && certificate.persist_seq === proof.persistSeq;
  }
  async function branchHold(asset: string, allowCurrent: boolean, excludeCurrent = false, reclaimTask: ReviewTask | null = null): Promise<string> {
    const rows = await queue.readDraftBranches(asset), memory = queue.getDraftBranchSnapshot(asset);
    const dispositions = classifyDraftBranches(rows, memory);
    const recoverySources = new Set<string>();
    const lineageSnapshots = new Map<string, string>();
    if (reclaimTask && memory?.local_commit && !memory.ack_local_barrier && hasOwnedFuture(currentSessionRef.current)) {
      const fixed = taskContextRef.current, certificate = memory.local_commit;
      admitRawDraft(memory.envelope.record, asset);
      const current = memory.envelope.record;
      if (reclaimTask.state === 'open' && reclaimTask.assignee_id === actorId && fixed?.task_id === reclaimTask.task_id
        && fixed.project_id === projectId && fixed.asset_revision_id === asset && fixed.ontology_version_id === reclaimTask.ontology_version_id
        && reclaimTask.asset_revision_id === asset && reclaimTask.project_id === projectId
        && certificate.draft_id === memory.envelope.draft_id && certificate.write_token === memory.envelope.write_token
        && certificate.generation === current.generation && certificate.edit_seq === (current.edit_seq ?? 0) && certificate.persist_seq > 0
        && rows.some(row => row.draft_id === certificate.draft_id && row.write_token === certificate.write_token)) {
        for (const ref of memory.envelope.sources) {
          if (ref.action !== 'recover') continue;
          const source = rows.find(row => row.draft_id === ref.draft_id && row.write_token === ref.write_token);
          if (!source) throw new Error('当前恢复来源已移除或 token 已改写，不能续领原任务。');
          admitRawDraft(source.record, asset);
          lineageSnapshots.set(source.draft_id, rawDraftJson(source.record));
          if (dispositions.get(source.draft_id) !== 'unresolved') continue;
          const record = source.record;
          if (record.draft_owner?.actor_id !== actorId || record.draft_owner.project_id !== projectId
            || record.pending !== null || record.pending_owner || record.pending_outcome != null && record.pending_outcome !== 'prepared' || record.save_error
            || record.ontology_version_id !== reclaimTask.ontology_version_id || record.base_revision_id !== current.base_revision_id) continue;
          rawDraftJson(record); // The required full source snapshot must not lose unknown data.
          recoverySources.add(source.draft_id);
        }
      }
    }
    for (const [draft, disposition] of dispositions) {
      if ((disposition === 'unresolved' || disposition === 'rescue_only') && !(allowCurrent && draft === memory?.envelope.draft_id) && !recoverySources.has(draft)) throw new Error('存在未处理草稿分支；请逐项明确恢复或留档，不能准备任务。');
    }
    return JSON.stringify({ branches: rows.filter(row => !excludeCurrent || row.draft_id !== memory?.envelope.draft_id).map(row => ({ draft_id: row.draft_id, write_token: row.write_token, sources: row.sources, ...(lineageSnapshots.has(row.draft_id) ? { record_snapshot: lineageSnapshots.get(row.draft_id) } : {}) })).sort((a, b) => a.draft_id.localeCompare(b.draft_id)), memory: !excludeCurrent && memory ? { draft_id: memory.envelope.draft_id, write_token: memory.envelope.write_token, sources: memory.envelope.sources, local_commit: memory.local_commit, ack_local_barrier: memory.ack_local_barrier } : null });
  }
  async function prepareTaskCreate(target: TaskCreateTarget): Promise<TaskCreatePreparation> {
    const captured = currentSessionRef.current;
    const verifiedSession = session;
    const directEpoch = saveAuthorizationEpoch();
    const validAdmin = () => lifecycle.current && session === verifiedSession && !!verifiedSession
      && authorizationScope.current.session === verifiedSession && directEpoch === authorizationEpoch && saveAuthorizationEpoch() === directEpoch
      && currentSessionRef.current === captured && captured.canWriteRole && project?.role === 'admin' && sessionRole === 'admin'
      && target.project_id === captured.projectId && assets.some(item => item.project_id === target.project_id && item.asset_revision_id === target.asset_revision_id)
      && ontologies.some(item => item.project_id === target.project_id && item.ontology_version_id === target.ontology_version_id);
    if (!validAdmin() || taskPreparationRef.current || importLockRef.current || submissionLockRef.current || loadState === 'loading') throw new Error('当前已核实管理员权限或工作区状态不允许创建任务。');
    const token = Symbol('task-create-preparation');
    taskPreparationRef.current = token; setTaskPreparing(true);
    captured.host?.cancelGesture();
    // Render creates a new ref value; identity is scope/host/loaded, not the wrapper object.
    const isCurrent = () => lifecycle.current && authorizationScope.current.session === verifiedSession && saveAuthorizationEpoch() === directEpoch
      && creationAuthorityRef.current.project === project && creationAuthorityRef.current.project?.role === 'admin'
      && creationAuthorityRef.current.sessionRole === 'admin' && creationAuthorityRef.current.catalogReady
      && creationAuthorityRef.current.assets === assets && creationAuthorityRef.current.ontologies === ontologies
      && taskPreparationRef.current === token && currentSessionRef.current.scopeKey === captured.scopeKey
      && currentSessionRef.current.host === captured.host && currentSessionRef.current.loaded === captured.loaded
      && currentSessionRef.current.actorId === captured.actorId && currentSessionRef.current.projectId === captured.projectId && currentSessionRef.current.canWriteRole;
    const release = () => { if (taskPreparationRef.current === token) { taskPreparationRef.current = null; setTaskPreparing(false); applyDeferredCatalog(); } };
    const check = () => { if (!isCurrent()) throw new Error('创建准备期间身份、权限或工作区已变化。'); };
    const ids = [...new Set([target.asset_revision_id, ...(captured.selectedAssetId ? [captured.selectedAssetId] : [])])];
    const settledRecords = new Map<string, string>();
    const beforeOthers = new Map<string, string>();
    const importPending = (assetId: string) => getOutboxSnapshot().imports.some(item => item.target.projectId === captured.projectId && item.target.assetRevisionId === assetId && !item.receipt);
    const recordKey = (record: NonNullable<ReturnType<SaveQueue['toRecord']>>) => JSON.stringify({ ...record, updated_at: '' });
    const inspect = (assetId: string, source = queue.toRecord(assetId)) => {
      const record = source, status = queue.getStatus(assetId);
      if (importPending(assetId)) throw new Error('目标图片存在未确认导入；不能创建任务。');
      if (!record) return null;
      admitRawDraft(record, assetId);
      const outstanding = status.dirty || !!record.pending || record.generation !== record.synced_generation || record.intent_journal.length !== record.synced_intent_seq;
      if (record.asset_revision_id !== assetId || record.document.asset_revision_id !== assetId || record.document.ontology_version_id !== record.ontology_version_id
        || !assets.some(item => item.asset_revision_id === assetId && item.project_id === captured.projectId)
        || !ontologies.some(norm => norm.ontology_version_id === record.ontology_version_id && norm.project_id === captured.projectId)
        || !record.base_revision_id || status.writes_paused || status.last_error || record.writes_paused || record.save_error
        || record.pending && record.pending_outcome !== 'prepared' && !(record.pending_outcome === 'unknown' && status.saving)
        || outstanding && (record.draft_owner?.actor_id !== captured.actorId || record.draft_owner.project_id !== captured.projectId)
        || record.pending && (record.pending_owner?.actor_id !== captured.actorId || record.pending_owner.project_id !== captured.projectId
          || record.pending.request.document.asset_revision_id !== assetId || record.pending.request.document.ontology_version_id !== record.ontology_version_id
          || record.pending.request.base_revision_id !== record.base_revision_id)
        || outstanding && assetId === captured.loaded?.media.asset_revision_id && (captured.loaded.readOnlyPreview || captured.host?.status !== 'ready'
          || captured.loaded.ontology.ontology_version_id !== record.ontology_version_id)) throw new Error('原图片草稿存在未知结果、作者、规范、冲突或存储故障；请先救援并核实，不能创建任务。');
      return record;
    };
    try {
      for (const assetId of ids) {
        beforeOthers.set(assetId, await branchHold(assetId, true, true)); check();
        const record = inspect(assetId);
        if (!record) continue;
        await queue.flush(assetId); check(); inspect(assetId);
        await queue.whenPersisted(assetId); check();
        const latest = inspect(assetId)!, status = queue.getStatus(assetId), commit = status.local_commit;
        if (status.dirty || status.saving || latest.pending || latest.generation !== latest.synced_generation
          || latest.intent_journal.length !== latest.synced_intent_seq || !commit || commit.edit_seq !== latest.edit_seq || commit.generation !== latest.generation
          || assetId === captured.loaded?.media.asset_revision_id && captured.host?.getGeneration() !== latest.generation) throw new Error('原草稿的服务端回执与最新本地提交尚未全部确认；不能创建任务。');
        settledRecords.set(assetId, recordKey(latest));
      }
      const holds = new Map<string, string>();
      for (const id of ids) { if (await branchHold(id, false, true) !== beforeOthers.get(id)) throw new Error('任务准备期间其他草稿分支已变化，请重新核实。'); holds.set(id, await branchHold(id, false)); }
      check();
      return { token, release, validateCurrent: async () => { if (!isCurrent()) return false; for (const id of ids) if (await branchHold(id, false) !== holds.get(id)) return false; return isCurrent(); }, isCurrent: () => isCurrent() && ids.every(id => {
        const status = queue.getStatus(id), record = queue.toRecord(id);
        return !status.dirty && !status.saving && !status.writes_paused && !status.last_error
          && (!record || !!status.local_commit && recordKey(record) === settledRecords.get(id))
          && (!record || id !== captured.loaded?.media.asset_revision_id || captured.host?.getGeneration() === record.generation) && !importPending(id);
      }) };
    } catch (error) { release(); throw error; }
  }
  async function prepareTaskOpen(task: ReviewTask, proof?: TaskContinuationProof): Promise<TaskOpenPreparation> {
    const captured = currentSessionRef.current;
    const verifiedSession = session, directEpoch = saveAuthorizationEpoch();
    if (!lifecycle.current || !captured.canWriteRole || task.project_id !== captured.projectId || task.state !== 'open'
      || !assets.some(item => item.asset_revision_id === task.asset_revision_id)
      || !ontologies.some(item => item.ontology_version_id === task.ontology_version_id)
      || taskPreparationRef.current || proof && !proof.isCurrent(null) || importLockRef.current || submissionLockRef.current || loadState === 'loading') {
      throw new Error('当前权限、固定任务或工作区状态不允许领取；未释放原任务。');
    }
    const token = Symbol('fixed-task-preparation');
    taskPreparationRef.current = token; setTaskPreparing(true); captured.host?.cancelGesture();
    let ordinaryRecord: string | null = null;
    let futureRecord: string | null = null;
    const retainedKey = () => { const record = captured.selectedAssetId ? queue.toRecord(captured.selectedAssetId) : null; return JSON.stringify(record ? { ...record, updated_at: '' } : null); };
    const isCurrent = () => lifecycle.current && authorizationScope.current.session === verifiedSession && directEpoch === authorizationEpoch && saveAuthorizationEpoch() === directEpoch
      && currentSessionRef.current.host === captured.host && currentSessionRef.current.loaded === captured.loaded
      && (!proof || proof.isCurrent(token))
      && (futureRecord === null || retainedKey() === futureRecord && hasOwnedFuture(captured)
        && queue.getStatus(captured.selectedAssetId!).local_commit?.persist_seq === ownedFutureProof.current?.persistSeq)
      && taskPreparationRef.current === token && currentSessionRef.current.scopeKey === captured.scopeKey
      && currentSessionRef.current.actorId === captured.actorId && currentSessionRef.current.canWriteRole && (ordinaryRecord === null || retainedKey() === ordinaryRecord
        && queue.getStatus(captured.selectedAssetId!).last_error?.kind === 'conflict' && queue.getStatus(captured.selectedAssetId!).last_error?.code === 'LEASE_REQUIRED'
        && captured.host?.getGeneration() === queue.toRecord(captured.selectedAssetId!)?.generation
        && !hasUnconfirmedImportForTarget(captured.projectId, task.asset_revision_id, task.ontology_version_id));
    const release = () => { if (taskPreparationRef.current === token) { taskPreparationRef.current = null; setTaskPreparing(false); applyDeferredCatalog(); } };
    let reclaimLease = false;
    let ordinaryRecovery = false;
    const holdIds = [...new Set([task.asset_revision_id, ...(captured.selectedAssetId ? [captured.selectedAssetId] : [])])];
    const holds = new Map<string, string>();
    const beforeOthers = new Map<string, string>();
    try {
      for (const id of holdIds) beforeOthers.set(id, await branchHold(id, true, true, id === captured.selectedAssetId ? task : null));
      if (captured.selectedAssetId) {
        await branchHold(captured.selectedAssetId, true, false, task);
        if (!isCurrent()) throw new Error('准备期间身份或范围已变化；未授权打开任务。');
        const status = queue.getStatus(captured.selectedAssetId);
        const norm = captured.loaded?.ontology.ontology_version_id ?? queue.toRecord(captured.selectedAssetId)?.ontology_version_id;
        const retained = queue.toRecord(captured.selectedAssetId);
        const fixed = taskContextRef.current;
        reclaimLease = !taskLeaseRef.current && fixed?.task_id === task.task_id && fixed.asset_revision_id === captured.selectedAssetId
          && task.asset_revision_id === captured.selectedAssetId && task.ontology_version_id === norm
          && retained?.draft_owner?.actor_id === captured.actorId && retained.draft_owner.project_id === captured.projectId
          && retained.pending_owner?.actor_id === captured.actorId && retained.pending_owner.project_id === captured.projectId
          && retained.pending_outcome === 'rejected' && !!retained.pending && !!status.last_error && isLeaseRejection(status.last_error.code);
        const sameFixedFuture = !taskLeaseRef.current && fixed?.task_id === task.task_id && fixed.project_id === task.project_id
          && fixed.asset_revision_id === task.asset_revision_id && fixed.ontology_version_id === task.ontology_version_id
          && (task.assignee_id === captured.actorId || verifiedSession?.platform_admin === true) && hasOwnedFuture(captured);
        if (sameFixedFuture) {
          const preparedFutureRecord = retainedKey();
          const nativeSnapshot = captured.host!.getSnapshot();
          if (!nativeSnapshot || !sameDocumentValue(nativeSnapshot, retained!.document)) throw new Error('Native 与原草稿不匹配；未授权续领。');
          committedNativeDocuments.current.set(captured.host!, nativeSnapshot);
          await queue.whenPersisted(captured.selectedAssetId);
          if (!isCurrent() || !hasOwnedFuture(captured) || retainedKey() !== preparedFutureRecord) throw new Error('本地保存或准备范围已变化；未授权续领。');
          const latest = queue.toRecord(captured.selectedAssetId)!, certificate = queue.getStatus(captured.selectedAssetId).local_commit;
          if (!certificate || !Number.isSafeInteger(certificate.persist_seq) || certificate.persist_seq < 1 || certificate.generation !== latest.generation || certificate.edit_seq !== (latest.edit_seq ?? 0)
            || !sameDocumentValue(captured.host!.getSnapshot(), latest.document)) throw new Error('缺少当前真实本地提交凭证；未授权续领。');
          ownedFutureProof.current = { scope: captured.scopeKey, host: captured.host!, loaded: captured.loaded!, taskId: task.task_id,
            draftId: certificate.draft_id, writeToken: certificate.write_token, generation: latest.generation, editSeq: latest.edit_seq ?? 0, persistSeq: certificate.persist_seq, base: latest.base_revision_id!,
            syncedGeneration: latest.synced_generation, syncedIntentSeq: latest.synced_intent_seq, journalLength: latest.intent_journal.length };
          futureRecord = retainedKey();
          reclaimLease = true;
        }
        const pending = retained?.pending;
        ordinaryRecovery = !taskLeaseRef.current && fixed === null && !!captured.loaded && captured.host?.status === 'ready' && !captured.loaded.readOnlyPreview
          && captured.loaded.media.asset_revision_id === task.asset_revision_id && captured.selectedAssetId === task.asset_revision_id
          && captured.loaded.ontology.ontology_version_id === task.ontology_version_id && (task.assignee_id === captured.actorId || session?.platform_admin === true)
          && retained?.draft_owner?.actor_id === captured.actorId && retained.draft_owner.project_id === captured.projectId
          && retained.pending_owner?.actor_id === captured.actorId && retained.pending_owner.project_id === captured.projectId
          && retained.pending_outcome === 'rejected' && !!pending && pending.request.lease == null
          && retained.save_error?.kind === 'conflict' && retained.save_error.status === 409 && retained.save_error.code === 'LEASE_REQUIRED'
          && status.last_error?.kind === 'conflict' && status.last_error.code === 'LEASE_REQUIRED' && !status.saving
          && retained.asset_revision_id === task.asset_revision_id && retained.ontology_version_id === task.ontology_version_id
          && pending.request.document.asset_revision_id === retained.asset_revision_id && pending.request.document.ontology_version_id === retained.ontology_version_id
          && pending.request.base_revision_id === retained.base_revision_id && retained.document.asset_revision_id === retained.asset_revision_id
          && retained.document.ontology_version_id === retained.ontology_version_id && captured.host.getGeneration() === retained.generation
          && queue.getStatus(retained.asset_revision_id).base_revision_id === retained.base_revision_id;
        if (ordinaryRecovery) ordinaryRecord = retainedKey();
        reclaimLease = reclaimLease || ordinaryRecovery;
        if ((!reclaimLease && status.writes_paused && (status.dirty || status.last_error || retained?.pending || recovery?.kind === 'conflict')) || (norm && hasUnconfirmedImportForTarget(captured.projectId, captured.selectedAssetId, norm))) throw new Error('原范围存在冲突或未确认操作；请保留请求并先救援，不能释放原任务。');
        // Crucially: the old lease is still installed throughout this flush.
        if (!reclaimLease && (status.dirty || status.saving)) {
          if (!captured.loaded || captured.loaded.readOnlyPreview || captured.host?.status !== 'ready'
            || !matchesFixedTask(captured.selectedAssetId, captured.loaded.ontology.ontology_version_id)) throw new Error('原草稿当前不能安全同步；未释放原任务。');
          await queue.flush(captured.selectedAssetId);
        }
        const settled = queue.getStatus(captured.selectedAssetId);
        if (!isCurrent() || (!reclaimLease && (settled.dirty || settled.saving || settled.last_error || queue.toRecord(captured.selectedAssetId)?.pending))) throw new Error('原草稿或范围尚未确认同步；未释放原任务。');
      }
      for (const id of holdIds) { const reclaim = reclaimLease && id === captured.selectedAssetId; if (await branchHold(id, reclaim, true, reclaim ? task : null) !== beforeOthers.get(id)) throw new Error('领取准备期间其他草稿分支已变化，请重新核实。'); holds.set(id, await branchHold(id, reclaim, false, reclaim ? task : null)); }
      if (!isCurrent()) throw new Error('准备期间身份或范围已变化；未授权打开任务。');
      return { token, isCurrent, validateCurrent: async () => { if (!isCurrent()) return false; for (const id of holdIds) { const reclaim = reclaimLease && id === captured.selectedAssetId; if (await branchHold(id, reclaim, false, reclaim ? task : null) !== holds.get(id)) return false; } return isCurrent(); }, release, onTaskOpen: (opened, lease) => {
        if (!isCurrent() || opened.state !== 'open' || (opened.assignee_id !== captured.actorId && verifiedSession?.platform_admin !== true) || opened.task_id !== task.task_id || opened.project_id !== captured.projectId
          || opened.asset_revision_id !== task.asset_revision_id || opened.ontology_version_id !== task.ontology_version_id
          || lease.task_id !== opened.task_id || lease.asset_revision_id !== opened.asset_revision_id
          || lease.ontology_version_id !== opened.ontology_version_id || !Number.isSafeInteger(lease.fencing_token) || lease.fencing_token < 1
          || taskLeaseActorRef.current !== captured.actorId || taskLeaseRef.current?.fencing_token !== lease.fencing_token) throw new Error('领取回执与准备的固定任务不匹配；不采纳新上下文。');
        // Same-task explicit lease recovery preserves the existing Native document and undo state.
        if (reclaimLease && !ordinaryRecovery) return;
        const fixed: FixedTaskContext = { task_id: opened.task_id, project_id: opened.project_id, asset_revision_id: opened.asset_revision_id, ontology_version_id: opened.ontology_version_id };
        taskContextRef.current = fixed; setTaskContext(fixed);
        if (ordinaryRecovery) {
          ordinaryNativeScopeRef.current = { host: captured.host!, loaded: captured.loaded!, ontologies, project, sessionEpoch, authorizationEpoch, canWriteRole };
          return; // Claim does not retry or replace the rejected operation.
        }
        currentSessionRef.current = { ...currentSessionRef.current, host: null, loaded: null, selectedAssetId: opened.asset_revision_id, scopeKey: 'opening:' + captured.scopeKey };
        setHost(null); setLoaded(null); setSelectedAssetId(opened.asset_revision_id); setExplicitOntologyId(opened.ontology_version_id);
        setSessionEpoch(epoch => epoch + 1);
        const url = new URL(location.href);
        for (const [name, value] of Object.entries(fixed)) url.searchParams.set(name, value);
        history.replaceState(null, '', url);
      } };
    } catch (error) { release(); throw error; }
  }
  const activeObjects = activeLoaded ? objects : [];
  const activeSelectedIds = activeLoaded ? activeLoaded.readOnlyPreview || !canWriteRole || hostStatus !== 'ready' ? previewSelectedIds : selectedIds : [];
  const selectedObjects = useMemo(() => { const ids = new Set(activeSelectedIds); return activeObjects.filter(object => ids.has(object.object_id)); }, [activeObjects, activeSelectedIds]);
  const selectionIncomplete = selectedObjects.length !== activeSelectedIds.length;
  const labelNames = useMemo(() => Object.fromEntries((activeLoaded?.ontology.labels ?? []).map((label) => [label.label_id, label.name])), [activeLoaded?.ontology]);
  const objectNames = useMemo(() => Object.fromEntries(activeObjects.map((object, index) => [object.object_id, (labelNames[object.label_id] ?? object.label_id) + ' #' + (index + 1)])), [activeObjects, labelNames]);
  const renderGeneration = selectionStore.getGeneration();
  const shortcuts = useMemo(() => categoryShortcuts(activeLoaded?.ontology ?? null), [activeLoaded?.ontology]);

  // Apply completed reads only in their original scope, after preparation releases.
  // Retain the real result: releasing this barrier never repeats a GET or upload.
  const deferredCatalog = useRef<Array<{ apply: () => void; finish: () => void }>>([]);
  function applyDeferredCatalog() {
    if (taskPreparationRef.current) return;
    const pending = deferredCatalog.current; deferredCatalog.current = [];
    for (const result of pending) { result.apply(); result.finish(); }
  }
  useEffect(() => () => {
    const pending = deferredCatalog.current; deferredCatalog.current = [];
    for (const result of pending) result.finish();
  }, []);
  const refreshAssets = useCallback(async () => {
    const isCurrent = () => lifecycle.current && authorizationScope.current.session === session
      && saveAuthorizationEpoch() === authorizationEpoch
      && currentSessionRef.current.actorId === actorId && currentSessionRef.current.projectId === projectId
      && currentSessionRef.current.scopeKey === scopeKey;
    if (!isCurrent()) return;
    const result = await api.assets(projectId);
    const apply = () => {
      if (!isCurrent()) return;
      setAssets(result);
      if (!result.length) setLoadState('empty');
    };
    if (!isCurrent()) return;
    if (taskPreparationRef.current) {
      await new Promise<void>(finish => { deferredCatalog.current.push({ apply, finish }); });
    } else apply();
  }, [projectId, actorId, session, authorizationEpoch, scopeKey]);
  useEffect(() => {
    let alive = true;
    setError(null); setCatalogReady(false); setProject(null);
    Promise.all([api.projects(), api.ontologies(projectId), api.assets(projectId)]).then(([projectsResult, ontologyResult, assetsResult]) => {
      if (!alive) return;
      const selectedProject = projectsResult.items.find((item) => item.project_id === projectId) ?? null;
      setProject(selectedProject);
      setOntologies(ontologyResult.items);
      setAssets(assetsResult); setCatalogReady(true);
      if (!assetsResult.length) setLoadState('empty');
      setSelectedAssetId((current) => {
        if (current) return current;
        return assetsResult[0]?.asset_revision_id ?? null;
      });
    }).catch(async (reason: unknown) => {
      if (!alive) return; setError(reportError(reason)); setLoadState('error');
      const assetId = new URLSearchParams(location.search).get('asset_revision_id');
      if (!assetId) return;
      try { const rows = await queue.readDraftBranches(assetId);
        if (!alive) return; setBranches(rows); setSelectedAssetId(assetId);
      } catch (storageError) { if (alive) { setError(`${reportError(reason)}；本地记录读取也失败：${reportError(storageError)}`); await readLegacyRescue(storageError); } }
    });
    return () => { alive = false; };
  }, [projectId, actorId, sessionRole, queue]);


  const selectedCatalogKey = assets.some(item => item.project_id === projectId && item.asset_revision_id === selectedAssetId) ? selectedAssetId : null;
  useEffect(() => {
    const preserved = ordinaryNativeScopeRef.current;
    if (catalogReady && preserved && host === preserved.host && loaded === preserved.loaded && selectedAssetId === preserved.loaded.media.asset_revision_id
      && taskOntologyId === preserved.loaded.ontology.ontology_version_id && selectedCatalogKey === preserved.loaded.media.asset_revision_id && ontologies === preserved.ontologies
      && project === preserved.project && sessionEpoch === preserved.sessionEpoch && authorizationEpoch === preserved.authorizationEpoch
      && liveAuthorizationEpoch === authorizationEpoch && canWriteRole === preserved.canWriteRole) return;
    ordinaryNativeScopeRef.current = null;
    if (!selectedAssetId) { setLoaded(null); setObjects([]); setHost(null); return; }
    if (!catalogReady) { setLoaded(null); setObjects([]); setHost(null); return; }
    const media = assets.find(item => item.project_id === projectId && item.asset_revision_id === selectedCatalogKey);
    if (!media) {
      let alive = true;
      setLoaded(null); setObjects([]); setHost(null); setRecovery(null); setHeadIds([]); setPreviewSelectedIds([]);
      setHistoryState({ canUndo: false, canRedo: false }); setLocalFlags({});
      const message = '指定媒体不在可读取列表中，可能已删除或权限已变化；未切换到其他媒体。本地草稿仅可救援下载。';
      setError(message); setLoadState('error');
      void (async () => {
        const rows = await queue.readDraftBranches(selectedAssetId);
        if (!alive) return;
        setBranches(rows);
        const record = queue.toRecord(selectedAssetId);
        if (record) setRecovery({ kind: 'unreachable', record, error: { kind: 'location', code: 'REQUESTED_ASSET_MISSING', message, request_id: null } });
      })().catch(async reason => { if (alive) { setError(message + ' 本地记录读取失败：' + reportError(reason)); await readLegacyRescue(reason); } });
      return () => { alive = false; };
    }
    let alive = true;
    setLoadState('loading'); setError(null); setHost(null); setLoaded(null); setRecovery(null); setHeadIds([]); setPreviewSelectedIds([]);
    setHistoryState({ canUndo: false, canRedo: false }); setLocalFlags({});
    const load = async () => {
      let ordinaryTaskMessage: string | null = null;
      if (!taskContextRef.current) {
        const eligibility = ordinaryEligibilityRef.current;
        eligibility.assignedAssets = null;
        try {
          const assignedAssets = new Set<string>();
          const matchingStates: string[] = [];
          let cursor: string | null = null;
          const seenCursors = new Set<string>();
          do {
            if (cursor !== null) {
              if (seenCursors.has(cursor)) throw new Error('任务分页游标循环，无法确认编辑资格。');
              seenCursors.add(cursor);
            }
            const page = await reviewApi.tasks(projectId, cursor);
            if (!alive || ordinaryEligibilityRef.current !== eligibility) return;
            for (const task of page.items) {
              if (task.project_id !== projectId) throw new Error('任务列表项目范围不匹配。');
              assignedAssets.add(task.asset_revision_id);
              if (task.asset_revision_id === media.asset_revision_id) matchingStates.push(task.state);
            }
            cursor = page.next_cursor;
          } while (cursor !== null);
          eligibility.assignedAssets = assignedAssets;
          if (matchingStates.length) ordinaryTaskMessage = matchingStates.every(state => state === 'closed')
            ? '此图片已关联关闭任务，普通入口只读。请由项目管理员新建明确任务，再显式领取；已有暂停草稿须先在 GUI 留档，不会自动创建、领取或重放。'
            : matchingStates.some(state => state === 'open')
              ? '此图片已关联任务，普通入口只读。开放待办须在任务区明确领取并取得匹配 lease 后编辑；不会自动领取或重放。'
              : '此图片已关联任务，普通入口只读。当前任务状态不能授权编辑，请在任务区核实；不会猜测状态或自动重放。';
        } catch (reason) {
          if (!alive || ordinaryEligibilityRef.current !== eligibility) return;
          ordinaryTaskMessage = '图片任务编辑资格尚未确认，保持只读；任务列表读取失败：' + reportError(reason);
        }
      }
      const diskBranches = await queue.readDraftBranches(media.asset_revision_id);
      if (!alive) return;
      setBranches(diskBranches);
      const choice = branchChoice?.asset === media.asset_revision_id ? branchChoice : null;
      const source = choice ? diskBranches.find(row => row.draft_id === choice.draft && row.write_token === choice.token) : null;
      if (choice && !source) throw new Error('所选分支 token 已变化，请重新选择。');
      const memory = queue.getDraftBranchSnapshot(media.asset_revision_id);
      const choiceApplied = !!choice && appliedBranchChoice.current?.choice === choice && appliedBranchChoice.current.draftId === memory?.envelope.draft_id;
      let draft: DraftRecord | null = queue.toRecord(media.asset_revision_id);
      if (source && choice?.action === 'recover' && !choiceApplied && source.draft_id !== memory?.envelope.draft_id) { admitRawDraft(source.record, media.asset_revision_id); draft = source.record; }
      if (choice?.action === 'use_server' && !choiceApplied) draft = null;
      if (draft) setRecovery({ kind: 'unreachable', record: draft, error: { kind: 'location', code: 'LOCATION_PENDING', message: '正在只读核验固定规范与 base', request_id: null } });
      let locationValidated = false;
      try {
      const location = locateOntology(media.asset_revision_id, taskOntologyId, explicitOntologyId, draft);
      locationValidated = true;
      let ontologyId = location.ontologyId;
      const summaries = [];
      let cursor: string | null = null;
      do {
        const page = await api.annotationHeads(media.asset_revision_id, cursor);
        if (!alive) return;
        summaries.push(...page.items); cursor = page.next_cursor;
      } while (cursor !== null);
      setHeadIds(summaries.map(h => h.ontology_version_id));
      if (!ontologyId) { setLoadState('ready'); setError(summaries.length ? '请选择已有标注 head 的固定规范；不会默认使用最新版本。' : '此媒体没有标注 head；不会自动迁移或创建标注。'); return; }
      const ontology = ontologies.find(o => o.ontology_version_id === ontologyId);
      if (!ontology) throw new Error('固定规范不存在或无法读取，不能使用最新规范替代。');
      if (!summaries.some(h => h.ontology_version_id === ontologyId)) throw new ApiFailure(404, 'ANNOTATION_HEAD_NOT_FOUND', '所选固定规范没有对应标注 head；不会使用其他版本替代。');
      const revision = await api.annotation(media.asset_revision_id, ontologyId);
      if (!alive) return;
      if (revision.document.asset_revision_id !== media.asset_revision_id || revision.document.ontology_version_id !== ontologyId) throw new Error('标注文档与固定规范不匹配');
      const report: RecoveryReport = draft ? location.conflict ? { kind: 'conflict', record: draft, server_head: revision, options: ['keep_local_export', 'view_server'] } : compareWithServer(draft, revision) : { kind: 'no_local_record' };
      setRecovery(report);
      const importUnknown = hasUnconfirmedImportForTarget(projectId, media.asset_revision_id, ontologyId);
      const priorStatus = queue.getStatus(media.asset_revision_id);
      const priorPauseApplies = !choice || choiceApplied || (choice.action === 'recover' && source?.draft_id === memory?.envelope.draft_id);
      const conflictBlocked = location.conflict || report.kind === 'conflict' || (priorPauseApplies && priorStatus.writes_paused && (priorStatus.dirty || !!priorStatus.last_error || !!draft?.pending));
      const outstanding = !!draft && (draft.generation > draft.synced_generation || draft.intent_journal.length > draft.synced_intent_seq || !!draft.pending);
      const provenanceBlocked = outstanding && (draft?.draft_owner?.actor_id !== actorId || draft.draft_owner.project_id !== projectId
        || (!!draft.pending && (draft.pending_owner?.actor_id !== actorId || draft.pending_owner.project_id !== projectId)));
      const awaitingChoice = !memory && !choice && [...classifyDraftBranches(diskBranches, null).values()].some(value => value === 'unresolved' || value === 'rescue_only');
      const blocked = conflictBlocked || provenanceBlocked || !canWriteRole || importUnknown || !matchesFixedTask(media.asset_revision_id, ontologyId) || awaitingChoice;
      if (source && choice && !choiceApplied) {
        const installed = choice.action === 'recover'
          ? await queue.forkFromRecord(source, { pauseForUserChoice: blocked, expectedCurrent: choice.expected })
          : await queue.forkFromServerRevision({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontologyId, annotation_revision_id: revision.annotation_revision_id, generation: 0, document: revision.document }, [{ draft_id: source.draft_id, write_token: source.write_token, action: 'use_server' }], { expectedCurrent: choice.expected });
        if (!alive) return;
        if (!installed) throw new Error('分支切换未获得当前真实提交凭证；保留原分支和新内存救援，不安装过期 Native。');
        appliedBranchChoice.current = { choice, draftId: queue.getDraftBranchSnapshot(media.asset_revision_id)!.envelope.draft_id };
        draft = queue.toRecord(media.asset_revision_id);
        setBranches(await queue.readDraftBranches(media.asset_revision_id));
      } else if (!memory && !awaitingChoice) {
        queue.initializeFromServerRevision({ asset_revision_id: media.asset_revision_id, ontology_version_id: ontologyId, annotation_revision_id: revision.annotation_revision_id, generation: 0, document: revision.document });
        await queue.whenPersisted(media.asset_revision_id);
      }
      const image = await api.image(media.asset_revision_id);
      const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height });
      if (!alive) return;
      if (source && choice) {
        const latestSource = await queue.readDraftBranch(media.asset_revision_id, source.draft_id);
        if (!alive) return;
        if (!latestSource || latestSource.write_token !== source.write_token) throw new Error('源分支已变化，未安装 Native；请重新选择。');
      }
      // A matching real server read proves the restored base, not an invented ACK.
      // Keep the owned future in Native while the queue remains paused for claim/retry.
      const ownedFutureLoad = !!draft && !draft.pending && !draft.pending_owner && (draft.pending_outcome == null || draft.pending_outcome === 'prepared') && !draft.save_error
        && !priorStatus.last_error && !priorStatus.saving && !location.conflict && report.kind !== 'conflict'
        && !provenanceBlocked && canWriteRole && !importUnknown && ontology.labels.length > 0
        && draft.base_revision_id === revision.annotation_revision_id && draft.asset_revision_id === revision.document.asset_revision_id
        && draft.ontology_version_id === revision.document.ontology_version_id
        && Number.isSafeInteger(draft.synced_generation) && draft.synced_generation >= 0 && draft.generation >= draft.synced_generation
        && Number.isSafeInteger(draft.synced_intent_seq) && draft.synced_intent_seq >= 0 && draft.synced_intent_seq <= draft.intent_journal.length
        && (draft.generation > draft.synced_generation || draft.intent_journal.length > draft.synced_intent_seq)
        && taskContextRef.current?.project_id === projectId && taskContextRef.current.asset_revision_id === media.asset_revision_id
        && taskContextRef.current.ontology_version_id === ontologyId;
      const chosenRecoveryLoad = choice?.action === 'recover' && !location.conflict && !provenanceBlocked && canWriteRole && !importUnknown
        && !!queue.getDraftBranchSnapshot(media.asset_revision_id)?.local_commit;
      const record = !blocked || ownedFutureLoad || chosenRecoveryLoad ? queue.toRecord(media.asset_revision_id) : null;
      const document = record?.document ?? revision.document;
      const readOnlyPreview = (blocked && !ownedFutureLoad) || ontology.labels.length === 0 || !project || !['admin', 'annotator'].includes(project.role ?? '');
      const nextLoaded = { media, ontology, document, revisionId: record?.base_revision_id ?? revision.annotation_revision_id, initial_generation: record?.generation ?? 0, readOnlyPreview, frame };
      trustedLoadedBases.current.set(nextLoaded, revision);
      setLoaded(nextLoaded);
      const remembered = drawingLabelMemory.current;
      const drawingLabel = remembered?.project === projectId && remembered.ontology === ontology.ontology_version_id && ontology.labels.some(label => label.label_id === remembered.label) ? remembered.label : ontology.labels[0]?.label_id ?? '';
      setActiveLabelId(drawingLabel);
      drawingLabelMemory.current = { project: projectId, ontology: ontology.ontology_version_id, label: drawingLabel };
      setObjects(document.objects); setCompletionChoice(document.completion); setNegativeConfirmed(false); setLoadState('ready');
      if (importUnknown) setError('此媒体与固定规范仍有未确认导入；保留原操作与请求，仅可查看和救援，不能授权旧会话写入。');
      else if (conflictBlocked) setError('固定规范或 base 与本地草稿冲突：只读查看，保留 pending/journal 与暂停队列；请先导出救援。');
      else if (provenanceBlocked) setError('未同步草稿的原作者缺失或不属于当前身份；只能查看和下载完整救援，不会猜测作者、接管或覆盖。');
      else if (!matchesFixedTask(media.asset_revision_id, ontologyId)) setError(ordinaryTaskMessage ?? '当前固定任务没有匹配的已确认 lease/fence；这里只读查看，请在任务区显式领取。');
      else if (!canWriteRole) setError('当前角色仅可查看和选择；本地未确认保存记录保持暂停，不会自动保存。');
      else if (!ontology.labels.length) setError('历史空规范可读，但没有可绘制类别；请由管理员显式发布新版本，不会迁移本图。');
      if (activity.getKind() === 'switch') activity.setKind('task');
      queue.switchAsset(media.asset_revision_id);
      } catch (reason) {
        if (alive) {
          const retained = locationValidated ? queue.toRecord(media.asset_revision_id) ?? draft : draft;
          if (retained) {
            setRecovery({ kind: 'unreachable', record: retained, error: { kind: 'load', code: reason instanceof ApiFailure ? reason.code : 'WORKSPACE_LOAD_FAILED', message: reportError(reason), request_id: reason instanceof ApiFailure ? reason.request_id : null } });
          }
        }
        throw reason;
      }
    };
    void load().catch(async reason => { if (alive) { setError('工作区载入失败；未开启离线编辑。' + reportError(reason)); setLoadState('error'); await readLegacyRescue(reason); } });
    return () => { alive = false; };
  }, [selectedAssetId, selectedCatalogKey, catalogReady, ontologies, queue, activity, taskOntologyId, explicitOntologyId, project, canWriteRole, projectId, sessionEpoch, authorizationEpoch, liveAuthorizationEpoch, branchChoice, ordinaryEligibilityKey]);


  const selectAsset = (asset: ApiMedia) => {
    if (taskPreparationRef.current || importLockRef.current || submissionLockRef.current) { setError('请先处理当前任务准备、导入预览、未知提交或审核提交，再切换图片。'); return; }
    if (taskContextRef.current && taskLeaseRef.current) { setError('当前任务已固定图片和规范；请先显式释放任务，再浏览非任务图片。'); return; }
    if (taskContextRef.current) { taskContextRef.current = null; setTaskContext(null); }
    host?.cancelGesture();
    currentSessionRef.current = { ...currentSessionRef.current, selectedAssetId: asset.asset_revision_id };
    if (asset.asset_revision_id !== selectedAssetId) recordActivity('switch');
    setSelectedAssetId(asset.asset_revision_id);
    const url = new URL(location.href);
    url.searchParams.set('project_id', projectId);
    url.searchParams.set('asset_revision_id', asset.asset_revision_id);
    url.searchParams.delete('task_id');
    history.replaceState(null, '', url);
  };

  const applyDelta = useCallback((currentHost: EditorHost, delta: EditorDelta) => {
    if (!loaded || currentHost !== editorPort.getReadHost()) return;
    if ((delta.document_changed || delta.suggestion_decisions.length > 0) && currentHost !== editorPort.getHost()) return;
    if (delta.error) { setError(`${delta.error.code}: ${delta.error.message}`); return; }
    selectionStore.publish(delta);
    setHistoryState(current => current.canUndo === delta.can_undo && current.canRedo === delta.can_redo ? current : { canUndo: delta.can_undo, canRedo: delta.can_redo });
    setLocalFlags(currentHost.getLocalFlags());
    const snapshot = currentHost.getCommittedSnapshot(delta);
    if (!snapshot) return;
    committedNativeDocuments.current.set(currentHost, snapshot);
    setObjects(snapshot.objects);
    setCompletionChoice(snapshot.completion);
    if (delta.document_changed || delta.suggestion_decisions.length > 0) {
      queue.enqueue({ asset_revision_id: loaded.media.asset_revision_id, ontology_version_id: loaded.ontology.ontology_version_id,
        base_revision_id: queue.getStatus(loaded.media.asset_revision_id).base_revision_id ?? loaded.revisionId,
        generation: delta.generation, document: snapshot, suggestion_decisions: delta.suggestion_decisions });
      recordActivity(snapshot.objects.length > objects.length ? 'annotation' : 'correction');
    }
  }, [loaded, queue, editorPort, selectionStore, objects.length, recordActivity]);

  function selectObject(objectId: string, additive = false) {
    if (!activeObjects.some(object => object.object_id === objectId)) return;
    if (!editorPort.getHost()) {
      setPreviewSelectedIds(current => additive ? current.includes(objectId) ? current.filter(id => id !== objectId) : [...current, objectId] : [objectId]);
      const current = editorPort.getReadHost();
      if (current?.status === 'ready' && !importLockRef.current && !submissionLockRef.current) current.select(additive ? activeSelectedIds.includes(objectId) ? activeSelectedIds.filter(id => id !== objectId) : [...activeSelectedIds, objectId] : [objectId]);
      return;
    }
    editorPort.getHost()?.select(additive ? activeSelectedIds.includes(objectId) ? activeSelectedIds.filter(id => id !== objectId) : [...activeSelectedIds, objectId] : [objectId]);
  }

  function changeLocalFlags(ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }) {
    const currentHost = editorPort.getHost();
    if (!currentHost) return;
    const delta = currentHost.setLocalFlags(ids, flags);
    if (!delta) setError('显示或锁定状态未更新，请重试。');
    else if (delta.error) setError(`${delta.error.code}: ${delta.error.message}`);
  }

  function changeAttribute(key: string, value: Scalar) {
    if (!editorPort.getHost()) { setError('编辑器尚未就绪，暂时无法修改属性。'); return; }
    if (editorPort.getHost()?.getGeneration() !== renderGeneration || JSON.stringify(selectionStore.getSelection()) !== JSON.stringify(activeSelectedIds)) return;
    if (!activeSelectedIds.length) { setError('先选一个对象，再修改属性。'); return; }
    if (selectionIncomplete || activeSelectedIds.some(id => localFlags[id]?.locked)) return;
    const delta = editorPort.dispatch({ kind: 'set_attributes', object_ids: [...activeSelectedIds], values: { [key]: value } });
    if (!delta) setError('属性未更新，请重试。');
    else if (delta.error) setError(`${delta.error.code}: ${delta.error.message}`);
  }

  function setCompletion(value: 'unprocessed' | 'in_progress' | 'complete' | 'confirmed_negative') {
    if (!editorPort.getHost()) return;
    if (value !== 'confirmed_negative') {
      const delta = editorPort.dispatch({ kind: 'set_completion', completion: value });
      if (!delta || delta.error) return;
    }
    setCompletionChoice(value);
    setNegativeConfirmed(false);
  }

  function confirmNegative() {
    if (!editorPort.getHost() || activeObjects.length !== 0 || !negativeConfirmed) return;
    editorPort.dispatch({ kind: 'set_completion', completion: 'confirmed_negative' });
  }

  function selectDrawingLabel(id: string) {
    const current = editorPort.getHost();
    if (!current || !activeLoaded?.ontology.labels.some(label => label.label_id === id)) return;
    current.cancelGesture(); current.setActiveLabel(id); setActiveLabelId(id);
    drawingLabelMemory.current = { project: projectId, ontology: activeLoaded.ontology.ontology_version_id, label: id };
  }
  function setSelectedLabel(id: string) {
    const current = editorPort.getHost();
    if (!current || !activeSelectedIds.length || JSON.stringify(selectionStore.getSelection()) !== JSON.stringify(activeSelectedIds)) return;
    const delta = editorPort.dispatch({ kind: 'set_label', object_ids: [...activeSelectedIds], label_id: id });
    if (!delta || delta.error) setError(delta?.error ? delta.error.code + ': ' + delta.error.message : '当前无法改类。');
  }
  async function prepareImport(): Promise<AnnotationImportContext> {
    const current = activeLoaded;
    const ready = editorPort.getHost();
    if (!current || !ready || currentSessionRef.current.scopeKey !== scopeKey) throw new Error('当前范围不能导入：请确认权限及编辑器就绪。');
    const token = { scope: scopeKey, context: null as AnnotationImportContext | null };
    importLockRef.current = token; setImportLocked(true); ready.cancelGesture();
    try {
      await queue.flush(current.media.asset_revision_id);
      if (!currentSessionRef.current.canWriteRole || ready.status !== 'ready' || taskPreparationRef.current || submissionLockRef.current || !matchesFixedTask(current.media.asset_revision_id, current.ontology.ontology_version_id)) throw new Error('权限、任务 lease 或编辑器就绪状态已变化。');
      if (hasUnconfirmedImportForTarget(projectId, current.media.asset_revision_id, current.ontology.ontology_version_id)) throw new Error('同一媒体与固定规范存在未确认导入，请保留原操作并先查看救援记录。');
      if (importLockRef.current !== token || currentSessionRef.current.scopeKey !== scopeKey) throw new Error('导入范围已变化。');
      const status = queue.getStatus(current.media.asset_revision_id);
      if (status.dirty || status.saving || status.writes_paused || !status.base_revision_id || !['idle', 'synced'].includes(status.phase)) throw new Error('草稿尚未同步；保留原保存请求，请先处理保存状态。');
      const lease = taskLeaseRef.current;
      token.context = { asset_revision_id: current.media.asset_revision_id, ontology_version_id: current.ontology.ontology_version_id, base_revision_id: status.base_revision_id,
        lease: lease?.asset_revision_id === current.media.asset_revision_id && lease.ontology_version_id === current.ontology.ontology_version_id ? wireSaveLease(lease) : null };
      return token.context;
    } catch (reason) {
      if (importLockRef.current === token) { setError(reportError(reason)); importLockRef.current = null; currentSessionRef.current = { ...currentSessionRef.current, scopeKey: 'released:' + scopeKey }; setImportLocked(false); setSessionEpoch(epoch => epoch + 1); }
      throw reason;
    }
  }
  function releaseImport(releasedScope: string) {
    if (importLockRef.current?.scope !== releasedScope || currentSessionRef.current.scopeKey !== releasedScope) return;
    importLockRef.current = null; currentSessionRef.current = { ...currentSessionRef.current, scopeKey: 'released:' + releasedScope }; setImportLocked(false); setSessionEpoch(epoch => epoch + 1);
  }
  async function commitImport(revision: AnnotationRevision, committedScope: string): Promise<void> {
    const token = importLockRef.current;
    const context = token?.context;
    const current = activeLoaded;
    if (!lifecycle.current || !token || !context || !current || token.scope !== committedScope || currentSessionRef.current.scopeKey !== committedScope
      || currentSessionRef.current.loaded !== current || !currentSessionRef.current.canWriteRole
      || revision.document.asset_revision_id !== context.asset_revision_id || revision.document.ontology_version_id !== context.ontology_version_id
      || revision.parent_revision_id !== context.base_revision_id) throw new Error('导入回执与当前范围或固定 base 不匹配；不采纳、不丢弃原请求。');
    if (!queue.adoptImportReceipt(revision, context.base_revision_id)) throw new Error('保存队列不再干净，导入回执尚未采纳；原队列已保留。');
    editorPort.cancelGesture();
    currentSessionRef.current = { ...currentSessionRef.current, host: null };
    setHost(null); setPreviewSelectedIds([]); setLocalFlags({}); setHistoryState({ canUndo: false, canRedo: false });
    setLoaded({ ...current, document: revision.document, revisionId: revision.annotation_revision_id, initial_generation: 0 });
    setObjects(revision.document.objects); setCompletionChoice(revision.document.completion); setNegativeConfirmed(false); setRecovery(null);
    importLockRef.current = null; setImportLocked(false);
    await queue.whenPersisted(context.asset_revision_id);
  }
  async function prepareExport(): Promise<AnnotationRevision> {
    const current = activeLoaded;
    if (!current || currentSessionRef.current.scopeKey !== scopeKey || taskPreparationRef.current || importLockRef.current || submissionLockRef.current) throw new Error('当前范围无法导出。');
    if (currentSessionRef.current.canWriteRole && !hasUnconfirmedImportForTarget(projectId, current.media.asset_revision_id, current.ontology.ontology_version_id)) {
      await queue.flush(current.media.asset_revision_id);
      const status = queue.getStatus(current.media.asset_revision_id);
      if (currentSessionRef.current.scopeKey !== scopeKey || status.dirty || status.saving || status.writes_paused) throw new Error('当前范围已变化或草稿未同步；不能导出旧版本。');
    }
    const revision = await api.annotation(current.media.asset_revision_id, current.ontology.ontology_version_id);
    if (currentSessionRef.current.scopeKey !== scopeKey || revision.document.asset_revision_id !== current.media.asset_revision_id || revision.document.ontology_version_id !== current.ontology.ontology_version_id) throw new Error('导出读取范围已变化。');
    return revision;
  }

  function viewServerRevision(revision: AnnotationRevision | null) {
    if (!lifecycle.current || currentSessionRef.current.scopeKey !== scopeKey) return;
    if (!revision) {
      setError('无法读取服务端标注版本。');
      return;
    }
    if (!activeLoaded || revision.document.ontology_version_id !== activeLoaded.ontology.ontology_version_id || revision.document.asset_revision_id !== activeLoaded.media.asset_revision_id) { setError('服务端版本与当前固定规范不匹配；本地记录已保留。'); return; }
    setLoaded((current) => current?.media.asset_revision_id === activeLoaded.media.asset_revision_id
      ? { ...current, document: revision.document, revisionId: revision.annotation_revision_id, readOnlyPreview: true }
      : current);
    setObjects(revision.document.objects);
    setCompletionChoice(revision.document.completion);
  }

  function resumeLocalDraft() {
    const current = currentSessionRef.current;
    if (!activeLoaded || current.loaded !== activeLoaded || current.host !== host || current.actorId !== actorId
      || current.projectId !== projectId || current.selectedAssetId !== activeLoaded.media.asset_revision_id
      || activeLoaded.media.project_id !== projectId || saveOwnerRef.current?.owner !== saveOwner
      || !saveOwner.isCurrent() || !canSaveInScope(scopeKey)
      || !matchesFixedTask(activeLoaded.media.asset_revision_id, activeLoaded.ontology.ontology_version_id)) return;
    const record = queue.toRecord(activeLoaded.media.asset_revision_id), status = queue.getStatus(activeLoaded.media.asset_revision_id);
    const owned = (owner: { actor_id: string; project_id: string } | null | undefined) => !owner || owner.actor_id === actorId && owner.project_id === projectId;
    if (!record?.base_revision_id || record.asset_revision_id !== activeLoaded.media.asset_revision_id
      || record.document.asset_revision_id !== record.asset_revision_id || record.document.ontology_version_id !== record.ontology_version_id
      || record.ontology_version_id !== activeLoaded.ontology.ontology_version_id || !owned(record.draft_owner) || !owned(record.pending_owner)
      || status.writes_paused || record.writes_paused || status.last_error || record.save_error
      || !status.local_commit || status.local_commit.generation !== record.generation
      || status.local_commit.edit_seq !== (record.edit_seq ?? 0) || (!activeLoaded.readOnlyPreview && current.host?.getGeneration() !== record.generation)
      || !activeLoaded.ontology.labels.length) return;
    // Compare current Native content, not the older document carried by an ACK.
    // Matching current generations include edits made while replay was in flight.
    const nativeDocument = current.host ? committedNativeDocuments.current.get(current.host) ?? activeLoaded.document : null;
    if (current.host?.status !== 'ready' || !canSaveInScope(scopeKey)
      || !matchesFixedTask(activeLoaded.media.asset_revision_id, activeLoaded.ontology.ontology_version_id)) return;
    if (!activeLoaded.readOnlyPreview && sameDocumentValue(nativeDocument, record.document)) {
      setRecovery(null);
      return;
    }
    currentSessionRef.current = { ...current, host: null };
    setHost(null);
    setPreviewSelectedIds([]); setLocalFlags({});
    setHistoryState({ canUndo: false, canRedo: false });
    setLoaded({ ...activeLoaded, document: record.document, revisionId: record.base_revision_id, initial_generation: record.generation, readOnlyPreview: false });
    setObjects(record.document.objects);
    setCompletionChoice(record.document.completion);
    setRecovery(null);
  }

  if (!session) return null;
  const assetIndex = assets.findIndex((asset) => asset.asset_revision_id === selectedAssetId);
  const activityContext = activeLoaded && activeLoaded.media.asset_revision_id === selectedAssetId && activeLoaded.media.project_id === projectId ? {
    assetRevisionId: activeLoaded.media.asset_revision_id, ontologyVersionId: activeLoaded.ontology.ontology_version_id,
    taskId: taskContext?.project_id === projectId && taskContext.asset_revision_id === selectedAssetId && taskContext.ontology_version_id === activeLoaded.ontology.ontology_version_id ? taskContext.task_id : null,
  } : undefined;
  const currentActivityRun = activityRun?.actorId === session.user_id && activityContext && activityRun.scope.projectId === projectId
    && activityRun.scope.assetRevisionId === activityContext.assetRevisionId && activityRun.scope.ontologyVersionId === activityContext.ontologyVersionId ? activityRun.scope : null;
  return <main ref={activitySurfaceRef} className="app-shell workbench-page" data-intensity="restrained"
    onClickCapture={event => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link) return;
      const target = new URL(link.href, location.href), value = target.searchParams.get('review_queue');
      if (target.origin === location.origin && target.pathname === location.pathname && target.searchParams.get('project_id') === projectId
        && value && ['all', 'mine', 'pending', 'returned', 'closed'].includes(value)) { event.preventDefault(); openReviewQueue(value as TaskQueue); }
    }}
    onFocusCapture={(event) => { focusedPanelRef.current = assetsPanelRef.current?.contains(event.target as Node) ? 'assets' : inspectorPanelRef.current?.contains(event.target as Node) ? 'inspector' : null; }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      const fold = event.target instanceof Element ? event.target.closest<HTMLDetailsElement>('details[open]') : null;
      if (fold) { event.preventDefault(); event.stopPropagation(); fold.querySelector<HTMLElement>(':scope > summary')?.focus(); fold.open = false; }
      else if (compactPanel) { event.preventDefault(); closeCompactPanel(); }
    }}>
    <a className="skip-link" href="#annotation-workspace">跳到标注区</a>
    <header className="topbar"><a className="brand" href="/" aria-disabled={taskPreparing} onClick={event => { if (taskPreparationRef.current) event.preventDefault(); }} aria-label="WebLabel 项目"><span className="brand-mark" aria-hidden="true">WL</span><span className="brand-name">WebLabel</span></a>
      <nav aria-label="主导航" className="main-nav"><button type="button" disabled={taskPreparing} onClick={() => { if (!taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current) onProjects(); else setError('请先处理当前准备、导入或提交结果。'); }}>项目</button><button type="button" aria-current="page">工作台</button><button type="button" disabled={taskPreparing} onClick={() => { if (!taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current) onDatasets(); else setError('请先处理当前准备、导入或提交结果。'); }}>交付</button>
        {canWriteRole ? <button type="button" onClick={() => openReviewQueue('mine')}>我的任务</button> : null}
        {['admin', 'reviewer'].includes(sessionRole ?? '') ? <button type="button" onClick={() => openReviewQueue('pending')}>待审核</button> : null}
        {session.platform_admin || sessionRole === 'admin' ? <button type="button" onClick={() => { setManagementOpen(true); requestAnimationFrame(() => { managementRef.current?.scrollIntoView({ block: 'start' }); managementRef.current?.querySelector<HTMLElement>(':scope > summary')?.focus(); }); }}>管理</button> : null}
      </nav>
      <div ref={workspaceHeadingRef} tabIndex={-1} className="workspace-heading">
        <h1 aria-label={project?.name ?? '工作台'}><input className="project-name-field" data-testid="project-name" aria-label="项目名称" title={project?.name} value={project?.name ?? ''} readOnly /></h1>
      </div>
      <span className="session-user">{session.username}</span><button type="button" disabled={taskPreparing} className="logout-button" onClick={() => { if (!taskPreparationRef.current && !importLockRef.current && !submissionLockRef.current) void logout(); else setError('请先处理当前准备、导入或提交结果。'); }}>退出</button>
    </header>
    <div className="workspace-controls" aria-label="工作区面板">
      <button ref={(node) => { panelLaunchers.current.assets = node; }} type="button" data-testid="toggle-assets" aria-controls="workbench-sidebar" aria-expanded={showAssets} onClick={() => togglePanel('assets')}>图片与对象</button>
      <button ref={(node) => { panelLaunchers.current.attributes = node; }} type="button" data-testid="toggle-attributes" aria-controls="workbench-inspector" aria-expanded={showInspector && inspectorView === 'attributes'} onClick={() => togglePanel('attributes')}>属性</button>
      <button ref={(node) => { panelLaunchers.current.ai = node; }} type="button" data-testid="toggle-ai" aria-controls="workbench-inspector" aria-expanded={showInspector && inspectorView === 'ai'} onClick={() => togglePanel('ai')}>AI 审校</button>
      <span className="local-state">{activeLoaded?.readOnlyPreview ? '只读版本' : editableHost ? '可以开始标注' : loadState === 'empty' ? '先导入几张图片' : loadState === 'error' ? '图片未能载入' : '正在准备编辑器'}</span>
    </div>
    {error ? <p className="api-error" role="alert">{error}</p> : null}
    <label>固定标注规范<select data-testid="ontology-selector" value={taskOntologyId ?? explicitOntologyId ?? activeLoaded?.ontology.ontology_version_id ?? ''} disabled={!!taskContext || taskPreparing || loadState === 'loading' || importLocked} onChange={event => { if (taskPreparationRef.current || taskContextRef.current || importLockRef.current || submissionLockRef.current) return; editorPort.cancelGesture(); currentSessionRef.current = { ...currentSessionRef.current, host: null }; setExplicitOntologyId(event.target.value || null); const url = new URL(location.href); if (event.target.value) url.searchParams.set('ontology_version_id', event.target.value); else url.searchParams.delete('ontology_version_id'); history.replaceState(null, '', url); }}><option value="">明确选择已有 head</option>{headIds.map(id => <option key={id} value={id}>{ontologies.find(o => o.ontology_version_id === id)?.version_no ?? '未知'} · {id}</option>)}</select></label>
    {!activeLoaded && selectedAssetId && recovery && recovery.kind !== 'no_local_record' ? <RescueDraft record={recovery.record} /> : null}
    {legacyRows.length ? <section aria-label="升级失败旧库只读救援"><p role="status">升级未完成；旧库保持原样。逐项下载原始记录，不代表已经保存或可删除旧库。</p>{legacyRows.map((row, index) => <button type="button" key={index} onClick={() => { try { downloadRawDraft(row.record, 'weblabel-legacy-' + index + '.json'); } catch (reason) { setError(reportError(reason)); } }}>下载旧库记录 {String(row.key)}</button>)}</section> : null}
    <div className="workbench-shell">
      {compactLayout && compactPanel ? <button type="button" className="panel-backdrop" tabIndex={-1} aria-label="关闭当前侧栏" onClick={closeCompactPanel} /> : null}
    <div id="annotation-workspace" ref={editorSurfaceRef} className="workbench-grid" tabIndex={-1}>
      <Keyboard host={editorPort} tools={tools} store={selectionStore} acceptsTarget={acceptsKeyboardTarget} categoryKeys={shortcuts.bindings} onCategory={selectDrawingLabel} />
      <aside ref={assetsPanelRef} id="workbench-sidebar" className="sidebar-resize workspace-rail" aria-label="项目图片与对象" hidden={!showAssets}>
        <div className="panel-close-row"><strong>图片与对象</strong><button type="button" data-close-panel data-testid="close-assets" aria-label="关闭图片与对象" onClick={closeCompactPanel}>关闭</button></div>
        <section ref={importSurfaceRef} className="asset-import-bar" aria-label="项目媒体导入"><MediaImportPanel key={projectId} projectId={projectId} catalogLocked={taskPreparing} canImport={canWriteRole && !importLocked && !submissionLockRef.current} onImported={refreshAssets} /></section>
        <ProjectSaveSummary key={'summary:' + projectId + ':' + actorId} assets={assets} projectId={projectId} actorId={actorId} queue={queue} onSelect={selectAsset} />
        <SessionComfort key={'comfort:' + projectId + ':' + actorId} surface={activitySurfaceRef} paused={sessionPaused} onPause={value => { if (value) editorPort.getReadHost()?.cancelGesture(); pausedScopeRef.current = value ? scopeKey : null; setPausedScope(value ? scopeKey : null); }} context={(activeLoaded?.media.original_name ?? '未选图片') + ' · 规范 ' + (activeLoaded?.ontology.version_no ?? '—') + ' · 类别 ' + activeLabelId + (taskContext ? ' · 固定任务 ' + taskContext.task_id : ' · 普通标注')} />
        <section id="media-strip" className="media-strip" data-testid="asset-grid" aria-label="项目图片">
          <div className="media-strip-heading"><h2>图片</h2><span>{assets.length} 张</span></div>
          {assets.map((asset) => <button key={asset.asset_revision_id} type="button" className={'media-thumb' + (selectedAssetId === asset.asset_revision_id ? ' active' : '')} data-testid={'asset-item-' + asset.asset_revision_id} aria-pressed={selectedAssetId === asset.asset_revision_id} aria-label={'选择图片 ' + asset.original_name} onClick={() => selectAsset(asset)}><span title={asset.original_name}>{asset.original_name}</span><small>{asset.canonical_width} × {asset.canonical_height}</small></button>)}
          {!assets.length ? <p role="status">{loadState === 'loading' ? '正在加载图片…' : '还没有图片，先导入一张吧。'}</p> : null}
        </section>
        <ObjectList objects={activeObjects} labelNames={labelNames} selectedIds={activeSelectedIds} localFlags={localFlags}
          onSelect={selectObject} onSetLocalFlags={changeLocalFlags}
          flagsEditable={!!editableHost && !activeLoaded?.readOnlyPreview && !submissionLockRef.current}
          status={loadState === 'error' ? 'error' : !activeLoaded || loadState === 'loading' ? 'loading' : activeObjects.length ? 'ready' : 'empty'} />
        <details className="layout-options"><summary>调整布局</summary><div><span>图片列表高度</span><ResizeControls targetId="media-strip" axis="height" decreaseName="减小图片列表高度" increaseName="增大图片列表高度" minimum={94} maximum={260} step={16} /></div><div hidden={compactLayout}><span>侧栏宽度</span><ResizeControls targetId="workbench-sidebar" axis="width" decreaseName="缩窄对象与属性侧栏" increaseName="加宽对象与属性侧栏" minimum={220} maximum={360} step={20} /></div><div><span>工具栏高度</span><ResizeControls targetId="canvas-toolbar-row" axis="height" decreaseName="减小画布工具栏高度" increaseName="增大画布工具栏高度" minimum={44} maximum={160} step={8} /></div></details>
      </aside>
      <section className="canvas-column" aria-label="标注工作区" inert={compactLayout && compactPanel !== null}>
        <div className="canvas-context"><strong title={activeLoaded?.media.original_name}>{activeLoaded?.media.original_name ?? '还没有选择图片'}</strong><div className="canvas-actions"><button type="button" data-testid="image-prev" aria-label="上一张图片" disabled={assetIndex <= 0} onClick={() => { const previous = assets[assetIndex - 1]; if (previous) selectAsset(previous); }}>←</button><span>{assetIndex < 0 ? '—' : assetIndex + 1} / {assets.length}</span><button type="button" data-testid="image-next" aria-label="下一张图片" disabled={assetIndex < 0 || assetIndex >= assets.length - 1} onClick={() => { const following = assets[assetIndex + 1]; if (following) selectAsset(following); }}>→</button></div></div>
        <div id="canvas-toolbar-row" className="canvas-toolbar-row"><Toolbar active={tool} disabled={!activeLoaded || !editableHost} onChange={(next) => tools.set(next)} /><div className="canvas-actions">
          <button type="button" data-testid="undo" disabled={!editableHost || !historyState.canUndo} onClick={() => editorPort.dispatch({ kind: 'undo' })}>撤销</button>
          <button type="button" data-testid="redo" disabled={!editableHost || !historyState.canRedo} onClick={() => editorPort.dispatch({ kind: 'redo' })}>重做</button>
        </div></div>
        <ViewportControls host={viewportHost} />
        {activeLoaded ? <LabelControls key={scopeKey} ontology={activeLoaded.ontology} activeLabel={activeLabelId} onActiveLabel={selectDrawingLabel} selectedCount={activeSelectedIds.length} onSetLabel={setSelectedLabel} disabled={!editableHost} /> : null}
        <div className="canvas-stage" data-testid="canvas-container">
          {activeLoaded ? <CanvasView key={activeLoaded.media.asset_revision_id + ':' + activeLoaded.revisionId + ':' + activeLoaded.readOnlyPreview} request={activeLoaded} readOnly={activeLoaded.readOnlyPreview || !canWriteRole || importLocked} activeTool={tool} objectNames={objectNames} canInteract={current => current === editorPort.getHost()} onDelta={applyDelta} onHostSettled={(readyHost) => { if (currentSessionRef.current.loaded !== activeLoaded || currentSessionRef.current.selectedAssetId !== activeLoaded.media.asset_revision_id) return; setLocalFlags(readyHost.getLocalFlags()); setHost(readyHost); setSettledHost({ host: readyHost, loaded: activeLoaded }); if (readyHost.status === 'ready' && activeLabelId && canWriteRole && !activeLoaded.readOnlyPreview && !importLockRef.current && !submissionLockRef.current) readyHost.setActiveLabel(activeLabelId); }} /> : <div className="canvas-empty" role="status">{loadState === 'loading' ? '正在载入图片…' : '请选择图片'}</div>}
        </div>
        <footer className="canvas-footer"><span>{activeLoaded ? activeLoaded.media.canonical_width + ' × ' + activeLoaded.media.canonical_height + ' 像素' : '尚未载入图片'}</span><span>{activeObjects.length} 个对象</span></footer>
        <div className="workspace-feedback" aria-label="保存与恢复">
        {recoveryBranches.length ? <DraftRecoveryChoice key={selectedAssetId} branches={recoveryBranches.map(envelope => ({ envelope, disposition: branchDispositions.get(envelope.draft_id) ?? 'unresolved' }))} selected={branchChoice?.asset === selectedAssetId ? branchChoice.draft : null} busy={branchBusy || loadState === 'loading'} onChoose={draft => { void chooseBranch(draft, 'recover'); }} onUseServer={draft => { void chooseBranch(draft, 'use_server'); }} onRescue={draft => { void rescueBranch(draft); }} serverDocument={activeLoaded ? trustedLoadedBases.current.get(activeLoaded)?.document : undefined} canReadBranch={envelope => { const record = envelope.record as Partial<DraftRecord> | null; return lifecycle.current && saveAuthorizationEpoch() === authorizationEpoch && currentSessionRef.current.projectId === projectId && currentSessionRef.current.actorId === actorId && !!project && assets.some(asset => asset.project_id === projectId && asset.asset_revision_id === envelope.asset_revision_id) && !!actorId && record?.draft_owner?.actor_id === actorId && record.draft_owner.project_id === projectId; }} /> : null}
        {activeLoaded ? <SaveStatus queue={queue} asset_revision_id={activeLoaded.media.asset_revision_id} scopeKey={scopeKey} isCurrentScope={key => lifecycle.current && saveAuthorizationEpoch() === authorizationEpoch && currentSessionRef.current.scopeKey === key} canWrite={canSaveInScope} canReconcileInScope={canReconcileInScope} canRetryOwnedFuture={canRetryOwnedFuture} recovery={recovery} onViewServer={viewServerRevision} onResumeLocal={resumeLocalDraft} /> : null}
        </div>
        <details className="utility-panel delivery-fold"><summary className="utility-title">完成状态与交付</summary><div className="fold-body delivery-controls">
        <section className="completion-panel" aria-label="标注完成状态"><label htmlFor="completion-state">标注状态</label><select id="completion-state" data-testid="completion-state" value={completionChoice} disabled={!editableHost} onChange={(event) => setCompletion(event.target.value as typeof completionChoice)}>
          <option value="unprocessed">未处理</option><option value="in_progress">标注中</option><option value="complete">已完成</option><option value="confirmed_negative">已确认无目标</option>
        </select>
        {completionChoice === 'confirmed_negative' ? <div data-testid="negative-confirmation" className="negative-confirmation" role="group" aria-label="确认负样本">
          <p>请检查图片后再确认。没有画框，不代表没有目标。</p>
          {activeObjects.length ? <p role="alert">请先移除全部对象后再确认。</p> : null}
          <label><input data-testid="negative-confirm-checkbox" type="checkbox" checked={negativeConfirmed} disabled={activeObjects.length > 0 || !editableHost} onChange={(event) => { if (editorPort.getHost()) setNegativeConfirmed(event.target.checked); }} />我已检查图片，确认没有目标对象</label>
          <button data-testid="negative-confirm-submit" type="button" disabled={!negativeConfirmed || activeObjects.length > 0 || !editableHost} onClick={confirmNegative}>确认无目标并保存</button>
        </div> : null}</section>
        <details className="utility-panel" data-testid="export-options"><summary className="utility-title">导出当前图片</summary>
        <RevisionExportPanel scopeKey={scopeKey} media={activeLoaded?.media ?? null} canStart={!!activeLoaded && settledHost?.loaded === activeLoaded && settledHost.host === host && ['ready', 'error', 'lost'].includes(hostStatus)} prepareExport={prepareExport} />
        </details>
        <details className="utility-panel"><summary className="utility-title">导入已有标注</summary><AnnotationImportPanel scopeKey={scopeKey} media={activeLoaded?.media ?? null} ontology={activeLoaded?.ontology ?? null} canWrite={!!activeLoaded && canWriteRole && !activeLoaded.readOnlyPreview && hostStatus === 'ready' && !submissionLockRef.current && (!!editableHost || (importLocked && importLockRef.current?.scope === scopeKey)) && (!unknownImport || importLockRef.current?.scope === scopeKey)} prepareImport={prepareImport} onCommit={commitImport} releaseImport={releaseImport} /></details>
        </div></details>
      </section>
    </div>
      <aside ref={inspectorPanelRef} id="workbench-inspector" className="inspector-rail" aria-label="属性与 AI 审校" hidden={!showInspector}>
        <div className="panel-close-row"><strong>{inspectorView === 'ai' ? 'AI 审校' : '属性'}</strong><button type="button" data-close-panel data-testid="close-inspector" aria-label="关闭属性与 AI 审校" onClick={closeCompactPanel}>关闭</button></div>
        <div className="inspector-content" hidden={inspectorView !== 'attributes'}>
          {activeLoaded ? <>{selectionIncomplete ? <p role="alert">选择已过期：共 {activeSelectedIds.length} 个选中 ID，其中 {activeSelectedIds.length - selectedObjects.length} 个对象不可用。请重新选择；不会缩小批量范围。</p> : <AttributePanel key={scopeKey + ':' + JSON.stringify(activeSelectedIds)} objects={selectedObjects} ontology={activeLoaded.ontology} onChange={changeAttribute} disabled={!editableHost || selectionIncomplete} locked={activeSelectedIds.some(id => localFlags[id]?.locked)} editContext={JSON.stringify([scopeKey, activeSelectedIds, renderGeneration])} /> }<NumericGeometry key={scopeKey} store={selectionStore} host={editorPort} selectedIds={activeLoaded.readOnlyPreview || !canWriteRole || hostStatus !== 'ready' ? activeSelectedIds : undefined} disabled={!editableHost || activeSelectedIds.some(id => localFlags[id]?.locked)} /></> : <p className="state-message">选择图片后查看属性。</p>}
        </div>
        <div className="inspector-content" hidden={inspectorView !== 'ai'}>
          <WorkbenchAi key={projectId + ':' + session.user_id} assetId={selectedAssetId ?? ''} media={activeLoaded?.media ?? null}
            ontology={activeLoaded?.ontology ?? null} editor={activeLoaded ? aiEditor : null} queue={queue}
            revisionId={currentRevisionId} selectedIds={activeSelectedIds} profilesRevision={profilesRevision} onModelWaitingChange={modelWaitingChanged} onRunScopeChange={activityRunChanged} />
        </div>
      </aside>
    </div>
    <section className="workspace-utilities" aria-label="项目辅助操作">
      <details className="utility-panel" data-testid="policy-options"><summary className="utility-title">外部处理设置</summary>{projectId ? <ExternalProcessingPolicy key={projectId} projectId={projectId} canManage={project?.project_id === projectId && project.role === 'admin'} /> : null}</details>
      <details className="utility-panel" data-testid="activity-options"><summary className="utility-title">工时记录</summary>{projectId ? <ActivityPanel key={projectId + session.user_id} projectId={projectId} actorId={session.user_id} collector={activity} surfaceRef={activitySurfaceRef} context={activityContext} currentRun={currentActivityRun} verifiedAuthorizationEpoch={authorizationEpoch} /> : null}</details>
      <details ref={reviewPanelRef} open={reviewOpen} onToggle={event => setReviewOpen(event.currentTarget.open)} className="utility-panel" data-testid="review-options"><summary className="utility-title">任务与审核</summary>{projectId && session ? <div onPointerDownCapture={() => recordActivity('review')} onInputCapture={() => recordActivity('review')}><ReviewPanel projectId={projectId} session={session} initialQueue={reviewQueue} onContinueTask={continueTask} onPrepareTaskCreate={prepareTaskCreate} onPrepareTaskOpen={prepareTaskOpen} onLeaseChange={updateTaskLease} onSubmitTask={submitReviewTask} /></div> : null}</details>
      {session.platform_admin || sessionRole === 'admin' ? <details ref={managementRef} open={managementOpen} onToggle={event => setManagementOpen(event.currentTarget.open)} className="utility-panel" data-testid="management-options"><summary className="utility-title">账号、成员与模型配置</summary><MemberManager key={projectId + ':' + session.user_id} project={project} />{session.platform_admin ? <ModelProfileSettings key={session.user_id} platformAdmin={session.platform_admin} onProfilesChanged={() => setProfilesRevision(value => value + 1)} /> : <p>模型配置仅平台管理员可管理；人工标注不依赖模型。</p>}</details> : null}
    </section>
  </main>;
}
