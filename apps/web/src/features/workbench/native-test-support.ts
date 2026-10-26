import { vi } from 'vitest';
import type { AuthEntry, SessionController } from '../../app/session';
import type { AnnotationDocument, EditorDelta } from '../../lib/editor/types';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { EditorHost } from '../../lib/editor/EditorHost';
import { InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import { SaveQueue } from '../../lib/persistence/save-queue';
import type { SaveTransport } from '../../lib/persistence/types';
import { createWorkspaceState } from './workspace-data';
import { createEditorPort } from './editor-port';
import { ToolState } from './tool-state';

export function nativeFixture() {
  const project = 'r07-unit-' + crypto.randomUUID();
  let entry: AuthEntry = { kind: 'authenticated', createdUsername: null, session: { user_id: 'actor', username: 'unit', platform_admin: false, project_roles: [{ project_id: project, role: 'admin' }] } };
  const session: SessionController = { getSnapshot: () => entry, subscribe: vi.fn(() => vi.fn()), login: vi.fn(), bootstrap: vi.fn(), recover: vi.fn(), logout: vi.fn(), refresh: vi.fn(), dispose: vi.fn() };
  const state = createWorkspaceState(session, { projectId: project, assetId: 'asset', ontologyId: 'ontology', taskId: null });
  const ontology: OntologyVersion = { project_id: project, ontology_version_id: 'ontology', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false,
    labels: [{ label_id: 'label', name: '<script>类别</script>', color: '#69d9bb', shortcut: '1', allowed_geometry_types: ['bbox_xyxy'], attributes: [{ key: 'text', kind: 'text', required: false, enum_values: [], default_value: null, min: null, max: null }, { key: 'number', kind: 'number', required: false, enum_values: [], default_value: 0, min: 0, max: 10 }] }] };
  const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 100, height: 100 }, completion: 'in_progress', objects: [{ object_id: 'object', label_id: 'label', attributes: { text: 'old', number: 2 }, geometry: { type: 'bbox_xyxy', x_min: 2, y_min: 3, x_max: 20, y_max: 30 }, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
  const revision: AnnotationRevision = { annotation_revision_id: 'revision', parent_revision_id: null, revision_no: 1, document, created_by: 'actor', created_at: '2026-10-25T00:00:00Z', content_hash: 'hash' };
  const media = { asset_id: 'media', asset_revision_id: 'asset', project_id: project, original_name: '<img src=x>.png', original_sha256: 'hash', canonical_sha256: 'hash', canonical_width: 100, canonical_height: 100, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' };
  const storage = new InMemoryDraftStorage();
  const transport = { save: vi.fn<SaveTransport['save']>(), fetchHead: vi.fn<SaveTransport['fetchHead']>().mockResolvedValue(revision), fetchRevision: vi.fn<SaveTransport['fetchRevision']>().mockResolvedValue(revision) };
  state.queue = new SaveQueue({ owner: state.owner, storage, transport });
  state.project = { project_id: project, name: 'unit', description: '', allow_self_review: false, role: 'admin' }; state.catalogReady = true; state.assets = [media]; state.ontologies = [ontology];
  state.loaded = { media, ontology, document, revision, frame: { width: 100, height: 100, rgba: new Uint8Array(40_000) }, initial_generation: 0, readOnlyPreview: false };
  state.document = document; state.objects = document.objects; state.phase = 'ready'; state.assignedAssets = new Set();
  const host = { status: 'ready', getGeneration: vi.fn(() => 0), dispatch: vi.fn(), setTool: vi.fn(() => true), setActiveLabel: vi.fn(), cancelGesture: vi.fn(), select: vi.fn(), setLocalFlags: vi.fn(), getLocalFlags: vi.fn(() => state.flags), getCommittedSnapshot: vi.fn(() => document), getObjectHashes: vi.fn(() => ({ object: 'object-hash' })), getViewport: vi.fn(() => ({ scale: 1, tx: 0, ty: 0, css_width: 100, css_height: 100, dpr: 1 })), getHitStackState: vi.fn(() => ({ index: null, count: 0 })), subscribeRendered: vi.fn(() => vi.fn()), focusRegion: vi.fn(() => true), fitImage: vi.fn(), focusSelection: vi.fn(), zoomAt: vi.fn(), dispose: vi.fn() };
  state.host = host as unknown as EditorHost; state.hostStatus = 'ready'; state.nativeDocuments.set(state.host, document);
  state.queue.initializeFromServerRevision({ asset_revision_id: 'asset', ontology_version_id: 'ontology', annotation_revision_id: 'revision', generation: 0, document });
  const delta: EditorDelta = { generation: 0, changed_objects: [], removed_object_ids: [], selected_object_ids: ['object'], can_undo: false, can_redo: false, document_changed: false, repaint: false, suggestion_decisions: [], error: null };
  state.selection.publish(delta); state.previewSelection = ['object'];
  const port = createEditorPort(state); state.tools = new ToolState(port);
  return { state, port, host, document, ontology, revision, media, storage, transport, delta,
    revoke() { entry = { kind: 'login', usernameHint: '' }; },
    dispose() { state.readonlyRequests.abort(); state.catalogRead?.abort(); state.assetRead?.abort(); state.queue.revokeWriteOwner(state.owner.token); state.alive = false; state.activity.setEnabled(false); },
  };
}
