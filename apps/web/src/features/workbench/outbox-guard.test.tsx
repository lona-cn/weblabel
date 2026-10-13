import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { ComponentProps } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorHost } from '../../lib/editor/EditorHost';
import { api } from '../../lib/t15/api';
import { IndexedDbDraftStorage, InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import { Workbench } from './Workbench';
import { reviewApi } from '../review/api';
import type { AnnotationImportPanel } from '../import-export/AnnotationImportPanel';
type AnnotationImportPanelProps = ComponentProps<typeof AnnotationImportPanel>;

const boundary = vi.hoisted(() => ({ unknown: false, panel: null as AnnotationImportPanelProps | null }));
vi.mock('../import-export/outbox', () => ({ hasUnconfirmedImportForTarget: () => boundary.unknown, subscribeOutbox: () => () => {} }));
vi.mock('../../app/providers', () => ({ useSession: () => ({ entry: { kind: 'authenticated', session: { user_id: 'user', username: 'tester', platform_admin: false, project_roles: [{ project_id: 'p', role: 'admin' }] } }, logout: vi.fn() }) }));
vi.mock('../ai/WorkbenchAi', () => ({ WorkbenchAi: () => null }));
vi.mock('../review/ReviewPanel', () => ({ ReviewPanel: () => null }));
vi.mock('./ActivityPanel', () => ({ ActivityPanel: () => null }));
vi.mock('../import-export/MediaImportPanel', () => ({ MediaImportPanel: () => null }));
vi.mock('../import-export/RevisionExportPanel', () => ({ RevisionExportPanel: () => null }));
vi.mock('../import-export/AnnotationImportPanel', () => ({ AnnotationImportPanel: (props: AnnotationImportPanelProps) => { boundary.panel = props; return null; } }));
vi.mock('../../lib/editor/loader', () => ({ decodeCanonicalFrame: async () => ({ width: 20, height: 20, rgba: new Uint8Array(1600) }) }));
vi.mock('./CanvasView', () => {
  return { CanvasView: ({ request, onHostSettled }: { request: { document: AnnotationDocument }; onHostSettled: (host: EditorHost) => void }) => {
    useEffect(() => {
      const delta: EditorDelta = { generation: 0, selected_object_ids: [], changed_objects: [], removed_object_ids: [], document_changed: false, repaint: true, can_undo: false, can_redo: false, suggestion_decisions: [], error: null };
      const viewport: Pick<EditorHost, 'subscribeRendered' | 'getViewport' | 'getHitStackState' | 'zoomAt' | 'fitImage' | 'focusSelection'> = {
        subscribeRendered: () => () => {}, getViewport: () => null, getHitStackState: () => ({ index: null, count: 0 }),
        zoomAt: () => {}, fitImage: () => {}, focusSelection: () => {},
      };
      const host = { ...viewport, status: 'ready', subscribeStatus: () => () => {}, getSnapshot: () => request.document, getGeneration: () => 0, getObjectHashes: () => ({}), getLocalFlags: () => ({}), cancelGesture: () => {}, setActiveLabel: () => true, setTool: () => true, dispatch: () => delta } as unknown as EditorHost;
      onHostSettled(host);
    }, []);
    return null;
  } };
});

const document: AnnotationDocument = { schema_version: 1, asset_revision_id: 'asset', ontology_version_id: 'ontology', coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: 'in_progress', objects: [] };
const baseline: AnnotationRevision = { annotation_revision_id: 'base', parent_revision_id: null, revision_no: 1, document, content_hash: 'a'.repeat(64), created_at: '2026-10-10T00:00:00Z', created_by: 'user' };
beforeEach(() => {
  boundary.unknown = false; boundary.panel = null;
  history.replaceState(null, '', '?asset_revision_id=asset&ontology_version_id=ontology');
  const storage = new InMemoryDraftStorage();
  vi.spyOn(IndexedDbDraftStorage.prototype, 'get').mockImplementation(storage.get.bind(storage));
  vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(storage.list.bind(storage));
  vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(storage.put.bind(storage));
  vi.spyOn(api, 'projects').mockResolvedValue({ items: [{ project_id: 'p', name: 'Project', description: '', allow_self_review: false, role: 'admin' }], next_cursor: null });
  vi.spyOn(api, 'ontologies').mockResolvedValue({ items: [{ ontology_version_id: 'ontology', project_id: 'p', version_no: 1, guidelines_markdown: '', allow_out_of_bounds: false, labels: [{ label_id: 'class', name: '类别', color: '#ffff00', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }] }], next_cursor: null });
  vi.spyOn(api, 'assets').mockResolvedValue([{ asset_id: 'asset-id', asset_revision_id: 'asset', project_id: 'p', original_name: 'synthetic.png', original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: 'group' }]);
  vi.spyOn(api, 'annotationHeads').mockResolvedValue({ items: [{ ontology_version_id: 'ontology', annotation_revision_id: 'base', revision_no: 1, content_hash: 'a'.repeat(64), completion: 'in_progress', object_count: 0, approved_review_id: null }], next_cursor: null });
  vi.spyOn(api, 'annotation').mockResolvedValue(baseline);
  vi.spyOn(api, 'image').mockResolvedValue(new Blob());
  vi.spyOn(api, 'externalProcessingPolicy').mockResolvedValue({ allow_external_processing: false });
  vi.spyOn(reviewApi, 'tasks').mockResolvedValue({ items: [], next_cursor: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });
async function ready() {
  const view = render(<Workbench projectId="p" />);
  await waitFor(() => expect((screen.getByTestId('completion-state') as HTMLSelectElement).disabled).toBe(false));
  return view;
}
it('retains the chosen drawing label across images in the same project and fixed ontology without retaining selection', async () => {
  const definition = (await api.ontologies('p')).items[0];
  vi.mocked(api.ontologies).mockResolvedValue({ items: [{ ...definition, labels: [...definition.labels, { ...definition.labels[0], label_id: 'second', name: '第二类别' }] }], next_cursor: null });
  const media = (await api.assets('p'))[0]; vi.mocked(api.assets).mockResolvedValue([media, { ...media, asset_revision_id: 'next', asset_id: 'next-id', original_name: 'next.png' }]);
  vi.mocked(api.annotation).mockImplementation(async (assetId) => ({ ...baseline, document: { ...document, asset_revision_id: assetId } }));
  await ready(); fireEvent.change(screen.getByTestId('drawing-label'), { target: { value: 'second' } });
  fireEvent.click(screen.getByTestId('asset-item-next'));
  await waitFor(() => expect((screen.getByTestId('drawing-label') as HTMLSelectElement).disabled).toBe(false));
  expect((screen.getByTestId('drawing-label') as HTMLSelectElement).value).toBe('second');
  expect((screen.getByTestId('batch-label-apply') as HTMLButtonElement).disabled).toBe(true);
});
it('suspends current editing through the same host fence and resumes without bypassing an unknown import', async () => {
  await ready(); fireEvent.click(screen.getByRole('button', { name: '暂停编辑' }));
  const control = screen.getByTestId('completion-state') as HTMLSelectElement; expect(control.disabled).toBe(true);
  fireEvent.change(control, { target: { value: 'complete' } }); expect(control.value).toBe('in_progress');
  boundary.unknown = true; fireEvent.click(screen.getByRole('button', { name: '返回编辑' }));
  expect(control.disabled).toBe(true);
});

it('blocks a native completion write at event time when another unknown import appears without a render', async () => {
  await ready();
  const control = screen.getByTestId('completion-state') as HTMLSelectElement;
  boundary.unknown = true;
  fireEvent.change(control, { target: { value: 'complete' } });
  expect(control.value).toBe('in_progress');
});

it('does not adopt an old import acknowledgement into a freshly prepared same-target Workbench session', async () => {
  const first = await ready();
  let originalScope = '';
  await act(async () => { const panel = boundary.panel!; originalScope = panel.scopeKey; await panel.prepareImport(); });
  first.unmount();
  await ready();
  await act(async () => { await boundary.panel!.prepareImport(); });
  const receipt: AnnotationRevision = { ...baseline, annotation_revision_id: 'imported', parent_revision_id: 'base', revision_no: 2, document: { ...document, completion: 'complete' } };
  await act(async () => { await expect(boundary.panel!.onCommit(receipt, originalScope)).rejects.toThrow('范围'); });
  expect((screen.getByTestId('completion-state') as HTMLSelectElement).value).toBe('in_progress');
});
it('keeps ordinary editing read-only and terminates qualification on a repeated task cursor', async () => {
  vi.mocked(reviewApi.tasks).mockResolvedValue({ items: [], next_cursor: 'repeat' });
  render(<Workbench projectId="p" />);
  await screen.findByRole('alert');
  expect(screen.getByTestId('completion-state')).toHaveProperty('disabled', true);
  expect(vi.mocked(reviewApi.tasks).mock.calls.map(call => call[1] ?? null)).toEqual([null, 'repeat']);
});
