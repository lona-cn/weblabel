// Loaded only by the test build of the real routed workbench. This observes the
// existing controller/host; it never creates an editor or owns editable geometry.
import type { EditorHost } from '../../lib/editor/EditorHost';
import type { AnnotationDocument, EditorDelta } from '../../lib/editor/types';
import type { WorkbenchController } from './controller';
import { selectedIds } from './workspace-state';

export type WorkbenchObservationAction = 'observe' | 'document' | 'nativeDelete' | 'consumerInvalidSelect';
export interface WorkbenchTestObserver {
  readonly surface: 'routed-native-workbench';
  inspect(action?: WorkbenchObservationAction, objectId?: string): {
    surface: 'routed-native-workbench';
    document: AnnotationDocument | null;
    delta: EditorDelta | null;
    error: EditorHost['error'];
    consumerError: string | null;
    objects: WorkbenchController['state']['objects'];
    selectedIds: readonly string[];
    consumerFlags: WorkbenchController['state']['flags'];
    nativeFlags: WorkbenchController['state']['flags'];
    generation: number | null;
    counters: { snapshots: number; committedChecks: number; committedDocuments: number };
    serializedObjects: number;
    validationObjects: number;
    adapter: string;
  };
}

declare global { interface Window { __wl_workbench_test?: WorkbenchTestObserver } }

export function observeRoutedWorkbench(controller: WorkbenchController) {
  const { state, editorPort: port, signal } = controller;
  if (import.meta.env.MODE !== 'test') throw new Error('Workbench observation is test-build-only');
  if (signal.aborted) return;
  const counters = { snapshots: 0, committedChecks: 0, committedDocuments: 0 };
  let host: EditorHost | null = null, restore: (() => void) | null = null;
  function update() {
    if (host === state.host) return;
    restore?.(); host = state.host; restore = null;
    if (!host) return;
    const mounted = host, snapshot = mounted.getSnapshot, committed = mounted.getCommittedSnapshot;
    const countedSnapshot: EditorHost['getSnapshot'] = function () { counters.snapshots++; return snapshot.call(mounted); };
    const countedCommitted: EditorHost['getCommittedSnapshot'] = function (delta) {
      counters.committedChecks++;
      const document = committed.call(mounted, delta);
      if (document) counters.committedDocuments++;
      return document;
    };
    mounted.getSnapshot = countedSnapshot; mounted.getCommittedSnapshot = countedCommitted;
    restore = () => {
      if (mounted.getSnapshot === countedSnapshot) mounted.getSnapshot = snapshot;
      if (mounted.getCommittedSnapshot === countedCommitted) mounted.getCommittedSnapshot = committed;
    };
  }
  const observer: WorkbenchTestObserver = { surface: 'routed-native-workbench',
    inspect(action = 'observe', objectId = '') {
      update();
      const mounted = port.getReadHost();
      if (signal.aborted || !state.alive || !mounted || mounted !== host || mounted.status !== 'ready') throw new Error('Actual routed native host is not ready');
      // The native error path is deliberately separate from the fenced consumer.
      const delta = action === 'nativeDelete' ? mounted.dispatch({ kind: 'delete', object_ids: [objectId] }) : null;
      if (action === 'consumerInvalidSelect') port.select(objectId);
      return { surface: 'routed-native-workbench', document: action === 'document' ? mounted.getSnapshot() : null, delta, error: mounted.error,
        consumerError: state.error, objects: state.objects, selectedIds: selectedIds(state), consumerFlags: state.flags, nativeFlags: mounted.getLocalFlags(),
        generation: mounted.getGeneration(), counters: { ...counters }, serializedObjects: mounted.getSerializedInputObjects(), validationObjects: mounted.getValidationInputObjects(), adapter: mounted.getAdapterDiagnostics() };
    },
  };
  const unsubscribe = state.subscribe(update); update(); window.__wl_workbench_test = observer;
  signal.addEventListener('abort', () => { unsubscribe(); restore?.(); restore = null; host = null; if (window.__wl_workbench_test === observer) delete window.__wl_workbench_test; }, { once: true });
}
