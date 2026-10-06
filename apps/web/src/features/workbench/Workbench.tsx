import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import { useSession } from '../../app/providers';
import { api, csrfToken, type ApiMedia, type Project } from '../../lib/t15/api';
import { decodeCanonicalFrame } from '../../lib/editor/loader';
import { EditorHost } from '../../lib/editor/EditorHost';
import type { LocalObjectFlagMap } from '../../lib/editor/types';
import { FetchSaveTransport, SaveQueue } from '../../lib/persistence/save-queue';
import { IndexedDbDraftStorage } from '../../lib/persistence/draft-store';
import { runRecovery, type RecoveryReport } from '../../lib/persistence/recovery';
import { SaveStatus } from './SaveStatus';
import { AttributePanel } from './AttributePanel';
import { ObjectList } from './ObjectList';
import { Toolbar, type Tool } from './Toolbar';
import { CanvasView } from './CanvasView';
import { ResizeControls } from './ResizeControls';
import { ReviewPanel } from '../review/ReviewPanel';
import type { ReviewTask } from '../review/api';
import { setReviewEditorLocked, submitCurrentReviewRevision } from '../review/submission';
import { WorkbenchAi } from '../ai/WorkbenchAi';
import { ExternalProcessingPolicy } from '../projects/ExternalProcessingPolicy';
import { ActivityCollector } from './activity';
import { ActivityPanel } from './ActivityPanel';
import { Keyboard } from './Keyboard';
import { SelectionStore } from './SelectionLink';
import { ToolState } from './ToolSettings';

type TaskLease = { asset_revision_id: string; task_id: string; fencing_token: number };
type Props = { projectId?: string; onProjects?: () => void; onDatasets?: () => void };
type LoadedAsset = { media: ApiMedia; ontology: OntologyVersion; document: AnnotationDocument; revisionId: string; initial_generation: number; readOnlyPreview: boolean; frame: { width: number; height: number; rgba: Uint8Array } };

function reportError(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

export function Workbench({ projectId = '', onProjects = () => {}, onDatasets = () => {} }: Props) {
  const { session, logout } = useSession();
  const activitySurfaceRef = useRef<HTMLElement>(null);
  const activity = useMemo(() => new ActivityCollector(projectId, session?.user_id ?? '', undefined, () => window.localStorage), [projectId, session?.user_id]);
  const recordActivity = useCallback((kind: Parameters<ActivityCollector['interact']>[0]) => activity.interact(kind), [activity]);
  const modelWaitingChanged = useCallback((waiting: boolean) => activity.setKind(waiting ? 'model_wait' : 'task'), [activity]);
  const workspaceHeadingRef = useRef<HTMLElement>(null);
  useEffect(() => { workspaceHeadingRef.current?.focus(); }, []);
  const [project, setProject] = useState<Project | null>(null);
  const [ontologies, setOntologies] = useState<OntologyVersion[]>([]);
  const [assets, setAssets] = useState<ApiMedia[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(() => new URLSearchParams(location.search).get('asset_revision_id'));
  const [loaded, setLoaded] = useState<LoadedAsset | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [host, setHost] = useState<EditorHost | null>(null);
  const subscribeHostStatus = useCallback((notify: () => void) => host?.subscribeStatus(notify) ?? (() => {}), [host]);
  const hostStatus = useSyncExternalStore(subscribeHostStatus, () => host?.status ?? 'idle', () => 'idle');
  const [objects, setObjects] = useState<AnnotationObject[]>([]);
  const [localFlags, setLocalFlags] = useState<LocalObjectFlagMap>({});
  const [completionChoice, setCompletionChoice] = useState<'unprocessed' | 'in_progress' | 'complete' | 'confirmed_negative'>('unprocessed');
  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [exportFormat, setExportFormat] = useState<'coco' | 'yolo' | 'native'>('coco');
  const [exporting, setExporting] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const taskLeaseRef = useRef<TaskLease | null>(null);
  const editorSurfaceRef = useRef<HTMLDivElement>(null);
  const importSurfaceRef = useRef<HTMLElement>(null);
  const submissionLockRef = useRef(false);
  const queue = useMemo(() => new SaveQueue({
    transport: new FetchSaveTransport({ csrfToken }),
    storage: new IndexedDbDraftStorage(),
    getLease: (assetRevisionId) => {
      const lease = taskLeaseRef.current;
      return lease?.asset_revision_id === assetRevisionId
        ? { task_id: lease.task_id, fencing_token: lease.fencing_token }
        : null;
    },
  }), []);
  const updateTaskLease = useCallback((lease: TaskLease | null) => {
    taskLeaseRef.current = lease;
    if (lease) {
      void queue.retryRejectedLease(lease.asset_revision_id)
        .catch((reason: unknown) => setError(reportError(reason)));
    }
  }, [queue]);
  const activeLoaded = loaded?.media.asset_revision_id === selectedAssetId ? loaded : null;
  const activeHost = activeLoaded && !activeLoaded.readOnlyPreview ? host : null;
  const editableHost = activeHost && hostStatus === 'ready' ? activeHost : null;
  // Ports retain their actual editor session. Read all fences again at event
  // time: inert and a render-time ready projection cannot authorize mutation.
  const currentSessionRef = useRef({ host, loaded, selectedAssetId });
  currentSessionRef.current = { host, loaded, selectedAssetId };
  const editorPort = useMemo(() => {
    const getHost = () => {
      const current = currentSessionRef.current;
      return host && current.host === host && current.loaded === loaded
        && loaded?.media.asset_revision_id === current.selectedAssetId
        && !loaded.readOnlyPreview && host.status === 'ready'
        && !submissionLockRef.current ? host : null;
    };
    return {
      getHost,
      setTool: (next: Tool) => getHost()?.setTool(next) ?? false,
      dispatch: (command: Parameters<EditorHost['dispatch']>[0]) => getHost()?.dispatch(command) ?? null,
      cancelGesture: () => { getHost()?.cancelGesture(); },
    };
  }, [host, loaded, selectedAssetId]);
  const selectionStore = useMemo(() => new SelectionStore(), [editorPort]);
  const subscribeSelection = useCallback((notify: () => void) => selectionStore.subscribeSelection(notify), [selectionStore]);
  const selectedIds = useSyncExternalStore(subscribeSelection, () => selectionStore.getSelection(), () => selectionStore.getSelection());
  const tools = useMemo(() => new ToolState(editorPort), [editorPort]);
  const subscribeTools = useCallback((notify: () => void) => tools.subscribe(notify), [tools]);
  const tool = useSyncExternalStore(subscribeTools, () => tools.current(), () => tools.current());
  useEffect(() => { if (hostStatus === 'ready') tools.reconcileSpaceRelease(); }, [hostStatus, tools]);
  const acceptsKeyboardTarget = useCallback((target: EventTarget | null) =>
    target instanceof Node && !!editorSurfaceRef.current?.contains(target), []);
  const submitReviewTask = useCallback((task: ReviewTask, submit: (revisionId: string) => Promise<void>) =>
    submitCurrentReviewRevision({
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
    }), [host, queue, tools]);
  const activeObjects = activeLoaded ? objects : [];
  const activeSelectedIds = activeLoaded ? selectedIds : [];

  const refreshAssets = useCallback(async () => {
    const result = await api.assets(projectId);
    setAssets(result);
    if (!result.length) setLoadState('empty');
    return result;
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([api.projects(), api.ontologies(projectId), api.assets(projectId)]).then(([projectsResult, ontologyResult, assetsResult]) => {
      if (!alive) return;
      const selectedProject = projectsResult.items.find((item) => item.project_id === projectId) ?? null;
      setProject(selectedProject);
      setOntologies(ontologyResult.items);
      setAssets(assetsResult);
      if (!assetsResult.length) setLoadState('empty');
      setSelectedAssetId((current) => {
        if (current && assetsResult.some((asset) => asset.asset_revision_id === current)) return current;
        return assetsResult[0]?.asset_revision_id ?? null;
      });
    }).catch((reason: unknown) => { if (alive) setError(reportError(reason)); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    if (!job) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.job(job);
        if (!alive) return;
        if (status.state === 'succeeded' || status.state === 'failed' || status.state === 'interrupted') {
          setJob(null);
          await refreshAssets();
        } else timer = setTimeout(() => void poll(), 600);
      } catch (reason) {
        if (alive) { setError(reportError(reason)); timer = setTimeout(() => void poll(), 1200); }
      }
    };
    timer = setTimeout(() => void poll(), 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [job, refreshAssets]);

  useEffect(() => {
    if (!selectedAssetId) {
      setLoaded(null);
      setObjects([]);
      setHost(null);
      if (assets.length) setLoadState('ready');
      return;
    }
    const media = assets.find((item) => item.asset_revision_id === selectedAssetId);
    const ontology = ontologies[0];
    if (!media || !ontology) return;
    if (loaded?.media.asset_revision_id === media.asset_revision_id
      && loaded.ontology.ontology_version_id === ontology.ontology_version_id) {
      setLoadState('ready');
      return;
    }
    let alive = true;
    setLoadState('loading');
    setError(null);
    setHost(null);
    setHistoryState({ canUndo: false, canRedo: false });
    setLocalFlags({});
    const transport = new FetchSaveTransport({ csrfToken });
    Promise.all([api.annotation(media.asset_revision_id, ontology.ontology_version_id), api.image(media.asset_revision_id)]).then(async ([revision, image]) => {
      const frame = await decodeCanonicalFrame(image, { width: media.canonical_width, height: media.canonical_height });
      const recoveryReport = await runRecovery({ storage: new IndexedDbDraftStorage(), transport }, media.asset_revision_id);
      if (!alive) return;
      setRecovery(recoveryReport);
      if (recoveryReport.kind === 'restored' || recoveryReport.kind === 'conflict' || recoveryReport.kind === 'unreachable') {
        queue.restoreFromRecord(recoveryReport.record, recoveryReport.kind !== 'restored');
      } else if (recoveryReport.kind === 'clean' || recoveryReport.kind === 'no_local_record') {
        queue.initializeFromServerRevision({
          asset_revision_id: media.asset_revision_id,
          ontology_version_id: ontology.ontology_version_id,
          annotation_revision_id: revision.annotation_revision_id,
          generation: 0,
          document: revision.document,
        });
      }
      const queueRecord = queue.toRecord(media.asset_revision_id);
      // Document, base and generation are one queue snapshot, including a save
      // ACK that arrived after the earlier annotation GET or recovered draft.
      const document = queueRecord?.document ?? revision.document;
      setLoaded({ media, ontology, document, revisionId: queueRecord?.base_revision_id ?? revision.annotation_revision_id, initial_generation: queueRecord?.generation ?? 0, readOnlyPreview: false, frame });
      setObjects(document.objects);
      setCompletionChoice(document.completion);
      setNegativeConfirmed(false);
      setLoadState('ready');
      if (activity.getKind() === 'switch') activity.setKind('task');
      queue.switchAsset(media.asset_revision_id);
    }).catch((reason: unknown) => { if (alive) { setError(reportError(reason)); setLoadState('error'); } });
    return () => { alive = false; };
  }, [selectedAssetId, assets, ontologies, loaded, queue, activity]);

  async function importFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const result = await api.importAssets(projectId, Array.from(files));
      setJob(result.import_job_id);
    } catch (reason) { setError(reportError(reason)); }
    if (importRef.current) importRef.current.value = '';
  }

  const selectAsset = (asset: ApiMedia) => {
    if (asset.asset_revision_id !== selectedAssetId) recordActivity('switch');
    setSelectedAssetId(asset.asset_revision_id);
    const url = new URL(location.href);
    url.searchParams.set('project_id', projectId);
    url.searchParams.set('asset_revision_id', asset.asset_revision_id);
    history.replaceState(null, '', url);
  };

  const applyDelta = useCallback((currentHost: EditorHost, delta: EditorDelta) => {
    if (!loaded || currentHost !== editorPort.getHost()) return;
    if (delta.error) { setError(`${delta.error.code}: ${delta.error.message}`); return; }
    selectionStore.publish(delta);
    setHistoryState(current => current.canUndo === delta.can_undo && current.canRedo === delta.can_redo ? current : { canUndo: delta.can_undo, canRedo: delta.can_redo });
    setLocalFlags(currentHost.getLocalFlags());
    const snapshot = currentHost.getCommittedSnapshot(delta);
    if (!snapshot) return;
    setObjects(snapshot.objects);
    setCompletionChoice(snapshot.completion);
    if (delta.document_changed || delta.suggestion_decisions.length > 0) {
      queue.enqueue({ asset_revision_id: loaded.media.asset_revision_id, ontology_version_id: loaded.ontology.ontology_version_id,
        base_revision_id: queue.getStatus(loaded.media.asset_revision_id).base_revision_id ?? loaded.revisionId,
        generation: delta.generation, document: snapshot, suggestion_decisions: delta.suggestion_decisions });
      recordActivity(snapshot.objects.length > objects.length ? 'annotation' : 'correction');
    }
  }, [loaded, queue, editorPort, selectionStore, objects.length, recordActivity]);

  function selectObject(objectId: string) {
    editorPort.getHost()?.select([objectId]);
  }

  function changeLocalFlags(ids: readonly string[], flags: { hidden?: boolean; locked?: boolean }) {
    const currentHost = editorPort.getHost();
    if (!currentHost) return;
    const delta = currentHost.setLocalFlags(ids, flags);
    if (!delta) setError('Editor did not accept the transient flag update.');
    else if (delta.error) setError(`${delta.error.code}: ${delta.error.message}`);
  }

  function changeAttribute(key: string, value: Scalar) {
    if (!editorPort.getHost()) { setError('The editor is not ready for attribute editing.'); return; }
    if (!activeSelectedIds.length) { setError('Select an object before editing attributes.'); return; }
    const delta = editorPort.dispatch({ kind: 'set_attributes', object_ids: [...activeSelectedIds], values: { [key]: value } });
    if (!delta) setError('Editor did not return the attribute update.');
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

  async function exportCurrent() {
    const current = activeLoaded;
    if (!current) return;
    setExporting(true);
    setExportMessage(null);
    try {
      await queue.flush(current.media.asset_revision_id);
      if (queue.getStatus(current.media.asset_revision_id).dirty) throw new Error('保存未同步，无法导出旧版本；请处理保存状态后重试。');
      const revision = await api.annotation(current.media.asset_revision_id, current.ontology.ontology_version_id);
      const result = await api.exportRevision(revision.annotation_revision_id, exportFormat);
      const file = await api.download(result.download_url);
      const objectUrl = URL.createObjectURL(file.bytes);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${current.media.original_name.replace(/\.[^.]*$/, '')}.${exportFormat === 'coco' ? 'json' : 'zip'}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setExportMessage(file.loss ? `导出完成。损失报告：${file.loss}` : '导出完成，已下载服务端固定版本的文件。');
    } catch (reason) { setExportMessage(reportError(reason)); }
    finally { setExporting(false); }
  }

  function viewServerRevision(revision: AnnotationRevision | null) {
    if (!revision) {
      setError('无法读取服务端标注版本。');
      return;
    }
    if (!activeLoaded) return;
    setLoaded((current) => current?.media.asset_revision_id === activeLoaded.media.asset_revision_id
      ? { ...current, document: revision.document, revisionId: revision.annotation_revision_id, readOnlyPreview: true }
      : current);
    setObjects(revision.document.objects);
    setCompletionChoice(revision.document.completion);
  }

  function resumeLocalDraft() {
    if (!activeLoaded) return;
    const record = queue.toRecord(activeLoaded.media.asset_revision_id);
    if (!record?.base_revision_id) return;
    setHost(null);
    setHistoryState({ canUndo: false, canRedo: false });
    setLoaded({ ...activeLoaded, document: record.document, revisionId: record.base_revision_id, initial_generation: record.generation, readOnlyPreview: false });
    setObjects(record.document.objects);
    setCompletionChoice(record.document.completion);
    setRecovery(null);
  }

  if (!session) return null;
  return <main ref={activitySurfaceRef} className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="WebLabel 项目"><span className="brand-mark" aria-hidden="true">W</span><span>WebLabel</span></a>
      <nav aria-label="主导航" className="main-nav"><button type="button" onClick={onProjects}>项目</button><button type="button" aria-current="page">工作台</button><button type="button" onClick={onDatasets}>数据集与导出</button></nav>
      <span className="session-user">{session.username}</span><button type="button" className="logout-button" onClick={() => void logout()}>退出</button>
    </header>
    <header ref={workspaceHeadingRef} tabIndex={-1} className="workspace-heading"><div><p className="eyebrow">{project?.name ?? '项目'} / {activeLoaded?.media.original_name ?? '选择媒体'}</p><input className="project-name-field" data-testid="project-name" aria-label="项目名称" value={project?.name ?? ''} readOnly /></div><span className="local-state">服务端版本 · canonical 像素坐标</span></header>
    {projectId ? <ExternalProcessingPolicy key={projectId} projectId={projectId} canManage={project?.project_id === projectId && project.role === 'admin'} /> : null}
    {projectId ? <ActivityPanel key={projectId + session.user_id} projectId={projectId} actorId={session.user_id} collector={activity} surfaceRef={activitySurfaceRef} /> : null}
    {error ? <p className="api-error" role="alert">{error}</p> : null}
    <section ref={importSurfaceRef} className="asset-import-bar" aria-label="项目媒体导入"><label htmlFor="media-import">导入图片</label><input ref={importRef} id="media-import" data-testid="media-import" type="file" accept="image/png,image/jpeg" multiple onChange={(event) => void importFiles(event.currentTarget.files)} />{job ? <span role="status">导入处理中…</span> : null}</section>
    <div ref={editorSurfaceRef} className="workbench-grid" tabIndex={-1}>
      <Keyboard host={editorPort} tools={tools} store={selectionStore} acceptsTarget={acceptsKeyboardTarget} />
      <aside id="workbench-sidebar" className="sidebar-resize" aria-label="项目媒体、对象与属性侧栏，可调整宽度">
        <section id="media-strip" className="media-strip" data-testid="asset-grid" aria-label="项目媒体">
          <div className="media-strip-heading"><span className="eyebrow">媒体</span><span>{assets.length} 张</span>
            <ResizeControls targetId="media-strip" axis="height" decreaseName="减小媒体底片条高度" increaseName="增大媒体底片条高度" minimum={94} maximum={260} step={16} />
            <ResizeControls targetId="workbench-sidebar" axis="width" decreaseName="缩窄对象与属性侧栏" increaseName="加宽对象与属性侧栏" minimum={220} maximum={420} step={20} />
          </div>
          {assets.map((asset) => <button key={asset.asset_revision_id} type="button" className={`media-thumb${selectedAssetId === asset.asset_revision_id ? ' active' : ''}`} data-testid={`asset-item-${asset.asset_revision_id}`} aria-pressed={selectedAssetId === asset.asset_revision_id} aria-label={`选择媒体 ${asset.original_name}`} onClick={() => selectAsset(asset)}><span>{asset.original_name}</span><small>{asset.canonical_width} × {asset.canonical_height}</small></button>)}
          {!assets.length ? <p role="status">{loadState === 'loading' ? '加载媒体…' : '暂无媒体，请导入图片。'}</p> : null}
        </section>
        <ObjectList objects={activeObjects} selectedIds={activeSelectedIds} localFlags={localFlags}
          onSelect={selectObject} onSetLocalFlags={changeLocalFlags}
          flagsEditable={!!editableHost && !activeLoaded?.readOnlyPreview && !submissionLockRef.current}
          status={loadState === 'error' ? 'error' : !activeLoaded || loadState === 'loading' ? 'loading' : 'ready'} />
        {activeLoaded ? <AttributePanel object={activeObjects.find((item) => activeSelectedIds.includes(item.object_id)) ?? null} ontology={activeLoaded.ontology} onChange={changeAttribute} disabled={!editableHost} /> : null}
      </aside>
      <section className="canvas-column" aria-label="标注工作区">
        <div id="canvas-toolbar-row" className="canvas-toolbar-row"><Toolbar active={tool} disabled={!activeLoaded || !editableHost} onChange={(next) => tools.set(next)} /><div className="canvas-actions"><button type="button" aria-label="适配画布" disabled={!editableHost} onClick={() => editorPort.getHost()?.fitImage()}>适配画布</button>
          <ResizeControls targetId="canvas-toolbar-row" axis="height" decreaseName="减小画布工具栏高度" increaseName="增大画布工具栏高度" minimum={46} maximum={180} step={16} />
          <button type="button" data-testid="undo" disabled={!editableHost || !historyState.canUndo} onClick={() => editorPort.dispatch({ kind: 'undo' })}>撤销</button>
          <button type="button" data-testid="redo" disabled={!editableHost || !historyState.canRedo} onClick={() => editorPort.dispatch({ kind: 'redo' })}>重做</button>
        </div></div>
        <div className="canvas-stage" data-testid="canvas-container">
          {activeLoaded ? <CanvasView key={`${activeLoaded.media.asset_revision_id}:${activeLoaded.revisionId}:${activeLoaded.readOnlyPreview}`} request={activeLoaded} readOnly={activeLoaded.readOnlyPreview} activeTool={tool} onDelta={applyDelta} onHostReady={(readyHost) => { if (selectedAssetId !== activeLoaded.media.asset_revision_id) return; setLocalFlags(readyHost.getLocalFlags()); setHost(readyHost); readyHost.setActiveLabel(activeLoaded.ontology.labels[0]?.label_id ?? ''); }} /> : <div className={`canvas-state${loadState === 'error' ? ' error' : ''}`} role={loadState === 'error' ? 'alert' : 'status'}>{loadState === 'error' ? '媒体加载失败。' : selectedAssetId || loadState === 'loading' ? '正在加载服务端媒体与标注…' : '选择或导入媒体以开始标注。'}</div>}
        </div>
        <footer className="canvas-footer"><span>工具：{tool}</span><span>{activeLoaded ? `${activeLoaded.media.canonical_width} × ${activeLoaded.media.canonical_height} canonical` : '—'}</span><span>对象 {activeObjects.length}</span></footer>
        {activeLoaded ? <SaveStatus queue={queue} asset_revision_id={activeLoaded.media.asset_revision_id} recovery={recovery} onViewServer={viewServerRevision} onResumeLocal={resumeLocalDraft} /> : null}
        <section className="completion-panel" aria-label="标注完成状态"><label htmlFor="completion-state">完成状态</label><select id="completion-state" data-testid="completion-state" value={completionChoice} disabled={!editableHost} onChange={(event) => setCompletion(event.target.value as typeof completionChoice)}>
          <option value="unprocessed">未处理</option><option value="in_progress">处理中</option><option value="complete">已完成</option><option value="confirmed_negative">已确认无目标</option>
        </select>
        {completionChoice === 'confirmed_negative' ? <div data-testid="negative-confirmation" className="negative-confirmation" role="group" aria-label="确认负样本">
          <p>确认该图像确实没有目标对象。空白文档不会自动成为负样本。</p>
          {activeObjects.length ? <p role="alert">请先移除全部对象后再确认。</p> : null}
          <label><input data-testid="negative-confirm-checkbox" type="checkbox" checked={negativeConfirmed} disabled={activeObjects.length > 0 || !editableHost} onChange={(event) => setNegativeConfirmed(event.target.checked)} />我已检查图像并确认没有目标对象</label>
          <button data-testid="negative-confirm-submit" type="button" disabled={!negativeConfirmed || activeObjects.length > 0 || !editableHost} onClick={confirmNegative}>确认负样本并保存</button>
        </div> : null}</section>
        <section className="export-panel" aria-label="固定版本导出"><label htmlFor="export-format">导出格式</label><select id="export-format" data-testid="export-format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as typeof exportFormat)}><option value="coco">COCO</option><option value="yolo">YOLO</option><option value="native">WebLabel 原生包</option></select>
          <p>COCO/YOLO 不包含全部对象属性；点击确认导出即确认接受该格式的信息损失，产物绑定保存后的不可变标注版本。</p><button data-testid="export-start" type="button" disabled={!activeLoaded || exporting} onClick={() => void exportCurrent()}>{exporting ? '保存并导出中…' : '确认信息损失并导出'}</button>{exportMessage ? <p role="status">{exportMessage}</p> : null}</section>
      </section>
    </div>
    <WorkbenchAi key={projectId} assetId={selectedAssetId ?? ''} media={activeLoaded?.media ?? null}
      ontology={activeLoaded?.ontology ?? null} host={activeHost} queue={queue}
      revisionId={activeLoaded?.revisionId ?? null} selectedIds={activeSelectedIds} onModelWaitingChange={modelWaitingChanged} />
    {projectId && session ? <div onPointerDownCapture={() => recordActivity('review')} onInputCapture={() => recordActivity('review')}><ReviewPanel projectId={projectId} session={session} onLeaseChange={updateTaskLease} onSubmitTask={submitReviewTask} /></div> : null}
  </main>;
}
