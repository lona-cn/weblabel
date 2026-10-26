import type { PageContext } from '../../ui/page-context';
import type { TaskSessionPort } from '../review/task-session-port';
import { subscribeSaveAuthorization } from '../../lib/t15/api';
import { subscribeOutbox } from '../import-export/outbox';
import { createWorkspaceState, refreshWorkspaceCatalog, refreshWorkspaceAssets, installServerPreview, readWorkspaceRescue, type WorkspaceInitialScope } from './workspace-data';
import { createEditorPort, type EditorPort } from './editor-port';
import { createDraftRecovery, type DraftRecovery } from './draft-recovery';
import { createTaskSession } from './task-session';
import { ToolState } from './tool-state';
import { reportError, sessionCurrent, type WorkspaceState } from './workspace-state';

export interface WorkbenchController {
  readonly state: WorkspaceState;
  readonly editorPort: EditorPort;
  readonly taskSession: TaskSessionPort;
  readonly recovery: DraftRecovery;
  readonly signal: AbortSignal;
  start(): Promise<void>;
  refreshAssets(): Promise<void>;
  selectAsset(assetId: string): Promise<void>;
  selectOntology(ontologyId: string): Promise<void>;
  dispose(): void;
}
/** Lifecycle composition only; business fences, task transactions and recovery live in their owning modules. */
export function createWorkbenchController(context: PageContext, initial: WorkspaceInitialScope): WorkbenchController {
  const lifecycle = new AbortController(), state = createWorkspaceState(context.session, initial, lifecycle.signal), editorPort = createEditorPort(state);
  const recovery = createDraftRecovery(state, editorPort, revision => installServerPreview(state, revision));
  const taskSession = createTaskSession(state, editorPort, recovery);
  state.tools = new ToolState(editorPort);
  const unsubscribeTools = state.tools.subscribe(() => state.notify());
  let disposed = false, started = false;
  const authorizationChanged = () => {
    if (sessionCurrent(state)) return;
    state.readonlyRequests.abort(); state.catalogRead?.abort(); state.assetRead?.abort();
    state.host?.cancelGesture(); state.queue.revokeWriteOwner(state.owner.token); state.lease = null; state.leaseActor = null;
    state.activity.setEnabled(false); state.scope = {}; state.loadToken = {}; state.error = '登录身份或权限已变化；旧工作区已停止写入，原请求和草稿保留。请以核实后的身份重新进入。'; state.notify();
  };
  const unsubscribeSession = context.session.subscribe(authorizationChanged), unsubscribeAuthorization = subscribeSaveAuthorization(authorizationChanged);
  const unsubscribeOutbox = subscribeOutbox(() => { state.host?.cancelGesture(); state.notify(); });
  const focus = () => { if (sessionCurrent(state)) void recovery.refresh().catch(reason => { state.error = reportError(reason); state.notify(); }); };
  window.addEventListener('focus', focus, { signal: lifecycle.signal });
  async function refreshAssets() { if (!disposed) await refreshWorkspaceAssets(state); }
  function dispose() {
    if (disposed) return; disposed = true;
    state.host?.cancelGesture(); state.queue.revokeWriteOwner(state.owner.token); state.activity.setEnabled(false); state.alive = false;
    state.readonlyRequests.abort(); state.catalogRead?.abort(); state.assetRead?.abort();
    state.scope = {}; state.loadToken = {}; unsubscribeTools(); unsubscribeSession(); unsubscribeAuthorization(); unsubscribeOutbox();
    lifecycle.abort(); context.signal.removeEventListener('abort', dispose);
  }
  if (context.signal.aborted) dispose(); else context.signal.addEventListener('abort', dispose, { once: true });
  return { state, editorPort, taskSession, recovery, signal: lifecycle.signal, dispose, refreshAssets,
    async start() { if (started || disposed) return; started = true; try { await refreshWorkspaceCatalog(state); } catch (reason) { if (!disposed) await readWorkspaceRescue(state, reason); } },
    selectAsset: editorPort.selectAsset,
    selectOntology: editorPort.selectOntology,
  };
}
