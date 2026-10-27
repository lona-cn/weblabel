// Browser-bundled synthetic identity/media fixture; geometry, views and persistence
// use the shipped native implementations. This is not a product entrypoint.
import type { SessionController } from '../../apps/web/src/app/session';
import type { EditorAssetRequest, EditorHostOptions } from '../../apps/web/src/lib/editor/types';
import type { SaveQueueOptions } from '../../apps/web/src/lib/persistence/types';
import { SaveQueue } from '../../apps/web/src/lib/persistence/save-queue';
import { createWorkspaceState } from '../../apps/web/src/features/workbench/workspace-data';
import { createEditorPort } from '../../apps/web/src/features/workbench/editor-port';
import { mountCanvasView } from '../../apps/web/src/features/workbench/canvas-view';
import { ToolState } from '../../apps/web/src/features/workbench/tool-state';
import type { WorkspaceState } from '../../apps/web/src/features/workbench/workspace-state';
import type { EditorPort } from '../../apps/web/src/features/workbench/editor-port';

export interface NativeEditorFixture {
  state: WorkspaceState;
  port: EditorPort;
  signal: AbortSignal;
  element: HTMLElement;
  load(request: EditorAssetRequest, revisionId?: string): void;
  dispose(): void;
}

export function createNativeEditorFixture(projectId: string, persistence: Pick<SaveQueueOptions, 'transport' | 'storage' | 'debounceMs'>, hostOptions?: Partial<EditorHostOptions>): NativeEditorFixture {
  const lifecycle = new AbortController();
  const entry = { kind: 'authenticated' as const, createdUsername: null, session: { user_id: 'fixture', username: 'fixture', platform_admin: false, project_roles: [{ project_id: projectId, role: 'admin' }] } };
  // The fixture supplies only the read boundary consumed by WorkspaceState;
  // login/logout and network authentication are exercised by the routed specs.
  const session = { getSnapshot: () => entry } as SessionController;
  const state = createWorkspaceState(session, { projectId, assetId: '', ontologyId: '', taskId: null }, lifecycle.signal);
  state.queue.revokeWriteOwner(state.owner.token);
  state.queue = new SaveQueue({ ...persistence, owner: state.owner });
  state.project = { project_id: projectId, name: 'Synthetic native editor fixture', description: '', allow_self_review: false, role: 'admin' };
  state.assignedAssets = new Set(); state.catalogReady = true; state.phase = 'ready';
  const port = createEditorPort(state);
  state.tools = new ToolState(port);
  const unsubscribeTools = state.tools.subscribe(() => state.notify());
  const canvas = mountCanvasView(state, port, lifecycle.signal, hostOptions);
  let disposed = false;
  return { state, port, signal: lifecycle.signal, element: canvas.element,
    load(request: EditorAssetRequest, revisionId = 'revision-' + request.media.asset_revision_id) {
      if (disposed) throw new Error('Native fixture is disposed');
      state.host?.cancelGesture(); state.scope = {}; state.assetId = request.media.asset_revision_id; state.ontologyId = request.ontology.ontology_version_id;
      state.assets = [request.media]; state.ontologies = [request.ontology];
      state.document = request.document; state.objects = request.document.objects; state.flags = {}; state.previewSelection = [];
      state.canUndo = false; state.canRedo = false; state.activeLabel = request.ontology.labels[0]?.label_id ?? '';
      state.loaded = { ...request, readOnlyPreview: false, revision: { annotation_revision_id: revisionId, parent_revision_id: null, revision_no: 1, document: request.document, created_by: 'fixture', created_at: '2026-10-26T00:00:00Z', content_hash: 'synthetic-fixture' } };
      state.queue.initializeFromServerRevision({ asset_revision_id: state.assetId, ontology_version_id: state.ontologyId, annotation_revision_id: revisionId, generation: request.initial_generation ?? 0, document: request.document });
      state.notify();
    },
    dispose() {
      if (disposed) return; disposed = true;
      state.host?.cancelGesture(); state.queue.revokeWriteOwner(state.owner.token); state.alive = false;
      state.readonlyRequests.abort(); state.activity.setEnabled(false); unsubscribeTools(); lifecycle.abort(); canvas.dispose(); canvas.element.remove();
    },
  };
}

export function unexpectedSaveTransport(): SaveQueueOptions['transport'] {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence transport in lifecycle-only fixture'); };
  return { save: unexpected, fetchHead: unexpected, fetchRevision: unexpected };
}
