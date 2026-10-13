// @vitest-environment jsdom
import { useCallback, useEffect, useRef, useState } from 'react';
import * as ReactRuntime from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '../../lib/t15/api';
import type { ReviewTask, TaskCreateTarget, TaskCreatePreparation } from './api';
import { ReviewPanel, type LocalTaskLease, type TaskOpenPreparation } from './ReviewPanel';
import { api, setCsrfToken } from '../../lib/t15/api';
import { putImportIntent, removeImportIntent, type ImportIntent } from '../import-export/outbox';
import { SaveQueue } from '../../lib/persistence/save-queue';
import { IndexedDbDraftStorage, InMemoryDraftStorage } from '../../lib/persistence/draft-store';
import type { DraftRecord, SaveQueueOwner, DraftBranchEnvelope } from '../../lib/persistence/types';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorHost } from '../../lib/editor/EditorHost';
import { Workbench } from '../workbench/Workbench';
const workbenchBoundary = vi.hoisted(() => ({ session: null as Session | null, generation: 0, host: null as EditorHost | null }));
const controlledCanvas = vi.hoisted(() => ({
  committedDocument: null as AnnotationDocument | null,
  commit: null as ((document: AnnotationDocument, delta: EditorDelta) => void) | null,
}));
vi.mock('../../app/providers', () => ({ useSession: () => ({ entry: { kind: 'authenticated', session: workbenchBoundary.session }, logout: () => {} }) }));
vi.mock('../ai/WorkbenchAi', () => ({ WorkbenchAi: () => null }));
vi.mock('../workbench/ActivityPanel', () => ({ ActivityPanel: () => null }));
vi.mock('../projects/ExternalProcessingPolicy', () => ({ ExternalProcessingPolicy: () => null }));
vi.mock('../import-export/AnnotationImportPanel', () => ({ AnnotationImportPanel: () => null }));
vi.mock('../import-export/RevisionExportPanel', () => ({ RevisionExportPanel: () => null }));
vi.mock('../../lib/editor/loader', () => ({ decodeCanonicalFrame: async () => ({ width: 32, height: 24, rgba: new Uint8Array(3072) }) }));
// Canvas/EditorHost is a controlled boundary: host identity here is not Native undo evidence.
// Main owns the real Native and undo browser proof. MediaImportPanel below is the real UI consumer.
vi.mock('../workbench/CanvasView', () => ({ CanvasView: ({ request, onHostSettled, onDelta }: { request: { document: AnnotationDocument; initial_generation?: number }; onHostSettled: (host: EditorHost) => void; onDelta: (host: EditorHost, delta: EditorDelta) => void }) => {
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;
  useEffect(() => {
    let currentDocument = request.document;
    workbenchBoundary.generation = request.initial_generation ?? workbenchBoundary.generation;
    const committedDocuments = new WeakMap<EditorDelta, AnnotationDocument>();
    const viewport: Pick<EditorHost, 'subscribeRendered' | 'getViewport' | 'getHitStackState' | 'zoomAt' | 'fitImage' | 'focusSelection'> = {
      subscribeRendered: () => () => {}, getViewport: () => null, getHitStackState: () => ({ index: null, count: 0 }),
      zoomAt: () => {}, fitImage: () => {}, focusSelection: () => {},
    };
    const host = { ...viewport, status: 'ready', subscribeStatus: () => () => {}, getSnapshot: () => currentDocument, getGeneration: () => workbenchBoundary.generation,
      getCommittedSnapshot: (delta: EditorDelta) => committedDocuments.get(delta) ?? null,
      getObjectHashes: () => ({}), getLocalFlags: () => ({}), cancelGesture: () => {}, dispatch: () => null, setActiveLabel: () => true, setTool: () => true } as unknown as EditorHost;
    const commit = (document: AnnotationDocument, delta: EditorDelta) => {
      currentDocument = document;
      controlledCanvas.committedDocument = document;
      workbenchBoundary.generation = delta.generation;
      committedDocuments.set(delta, document);
      onDeltaRef.current(host, delta);
    };
    controlledCanvas.commit = commit;
    workbenchBoundary.host = host; onHostSettled(host);
    return () => {
      if (controlledCanvas.commit === commit) {
        controlledCanvas.commit = null;
        controlledCanvas.committedDocument = null;
      }
    };
  }, []);
  return null;
} }));

// Real ReviewPanel + reviewApi + public api client; only HTTP is controlled.
// These are UI consumer regressions, not evidence of real server authorization.
type LocalLease = LocalTaskLease;
type Preparation = TaskOpenPreparation;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const actor: Session = { user_id: 'admin-1', username: 'project-admin', platform_admin: false, project_roles: [{ project_id: 'project-1', role: 'admin' }] };
const task: ReviewTask = { task_id: 'task-1', project_id: 'project-1', asset_revision_id: 'asset-1', ontology_version_id: 'ontology-old', assignee_id: actor.user_id, state: 'open', created_at: '2026-10-10T00:00:00Z', review_id: null, revision_ids: null, review_decision: null, review_reason: null };
const second: ReviewTask = { ...task, task_id: 'task-2', asset_revision_id: 'asset-2', ontology_version_id: 'ontology-second' };
const members = [
  { user_id: actor.user_id, username: actor.username, role: 'admin' },
  { user_id: 'annotator-1', username: 'qualified-one', role: 'annotator' },
  { user_id: 'reviewer-1', username: 'review-only', role: 'reviewer' },
  { user_id: 'viewer-1', username: 'view-only', role: 'viewer' },
];
function media(id: string) { return { asset_id: `source-${id}`, asset_revision_id: id, project_id: 'project-1', original_name: `${id}.png`, original_sha256: 'a'.repeat(64), canonical_sha256: 'b'.repeat(64), canonical_width: 32, canonical_height: 24, exif_orientation: 1, original_to_canonical: [1,0,0,0,1,0,0,0,1], source_group_id: 'group-1' }; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function lease(id: string, fence: number, holder = actor.user_id) { return response({ task_id: id, holder_id: holder, fencing_token: fence, expires_at_unix: 1_900_000_000, lease_seconds: 60, heartbeat_seconds: 20 }); }
let requests: { url: URL; method: string; body: Record<string, unknown> }[];
let handle: (url: URL, init: RequestInit, body: Record<string, unknown>) => Promise<Response>;
const http = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  requests.push({ url, method: init.method ?? 'GET', body });
  return handle(url, init, body);
});
async function normal(url: URL, _init: RequestInit, body: Record<string, unknown>): Promise<Response> {
  if (url.pathname.endsWith('/tasks')) return response({ items: [task, second], next_cursor: null });
  if (url.pathname.endsWith('/members')) return response(url.searchParams.has('cursor') ? { items: [], next_cursor: null } : { items: members, next_cursor: 'viewer-1' });
  if (url.pathname.endsWith('/assets')) return response(url.searchParams.has('cursor') ? { items: [media('asset-2')], next_cursor: null } : { items: [media('asset-1')], next_cursor: 'asset-1' });
  if (url.pathname.endsWith('/ontologies')) return response({ items: ['ontology-old', 'ontology-second'].map((id, index) => ({ ontology_version_id: id, project_id: 'project-1', version_no: index + 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false })), next_cursor: null });
  if (url.pathname.endsWith('/lease')) return lease(url.pathname.split('/')[3]!, body.action === 'acquire' ? 42 : 42);
  throw new Error(`Unexpected HTTP path ${url.pathname}`);
}
function Harness({ session = actor, projectId = 'project-1', prepare, open, prepareCreate }: { session?: Session; projectId?: string; prepare?: (task: ReviewTask, ticket: Preparation) => Promise<Preparation>; open?: (task: ReviewTask, lease: LocalLease) => void; prepareCreate?: (target: TaskCreateTarget) => Promise<TaskCreatePreparation> }) {
  const [held, setHeld] = useState<LocalLease | null>(null);
  const [context, setContext] = useState<ReviewTask | null>(null);
  const onLeaseChange = useCallback((value: LocalLease | null) => setHeld(value), []);
  const onPrepareTaskOpen = async (target: ReviewTask) => {
    const ticket: Preparation = { token: Symbol('test-preparation'), isCurrent: () => true, validateCurrent: async () => true, onTaskOpen: (fixed, value) => { setContext(fixed); open?.(fixed, value); }, release: () => undefined };
    return prepare ? prepare(target, ticket) : ticket;
  };
  const props = { projectId, session, onLeaseChange, onSubmitTask: async () => undefined, onPrepareTaskOpen, onPrepareTaskCreate: prepareCreate ?? (async () => ({ token: Symbol(), isCurrent: () => true, validateCurrent: async () => true, release: () => undefined })) };
  return <><ReviewPanel {...props} /><output data-testid="held-context">{held ? `${held.task_id}/${held.fencing_token}/${held.ontology_version_id}` : 'readonly'}</output><output data-testid="fixed-context">{context ? `${context.asset_revision_id}/${context.ontology_version_id}` : 'ordinary'}</output></>;
}
async function claim(id: string) { fireEvent.click(within(screen.getByTestId(`review-task-${id}`)).getByRole('button', { name: '领取任务' })); await act(async () => { await Promise.resolve(); }); }
function writes(action?: string) { return requests.filter((item) => item.method === 'POST' && item.url.pathname.endsWith('/lease') && (!action || item.body.action === action)); }

beforeEach(() => { requests = []; handle = normal; http.mockClear(); vi.stubGlobal('fetch', http); });
afterEach(() => { cleanup(); controlledCanvas.commit = null; controlledCanvas.committedDocument = null; workbenchBoundary.host = null; workbenchBoundary.generation = 0; workbenchBoundary.session = null; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
afterEach(() => { vi.doUnmock('react'); });

describe('C06 fixed task open and lease fences', () => {
  it('flushes the old context while its lease is held BEFORE release, then opens the target fixed asset and ontology', async () => {
    const flush = deferred<Preparation>();
    let pending!: Preparation;
    const order: string[] = [];
    handle = async (url, init, body) => { if (url.pathname.endsWith('/lease')) order.push(`${body.action}:${url.pathname.split('/')[3]}`); return normal(url, init, body); };
    render(<Harness prepare={async (target, ticket) => { if (target.task_id === second.task_id) { order.push('flush-old'); pending = ticket; return flush.promise; } return ticket; }} open={(fixed) => order.push(`open:${fixed.task_id}`)} />);
    await screen.findByTestId('review-task-task-1');
    await claim('task-1');
    await waitFor(() => expect(screen.getByTestId('held-context').textContent).toContain('task-1/42'));
    order.length = 0;
    await claim('task-2');
    expect(order).toEqual(['flush-old']);
    expect(screen.getByTestId('held-context').textContent).toBe('task-1/42/ontology-old');
    await act(async () => { flush.resolve(pending); });
    await waitFor(() => expect(screen.getByTestId('fixed-context').textContent).toBe('asset-2/ontology-second'));
    expect(order).toEqual(['flush-old', 'release:task-1', 'acquire:task-2', 'open:task-2']);
  });

  it('does not release the old lease or change the document if preparation cannot confirm a flush', async () => {
    render(<Harness prepare={async (target, ticket) => { if (target.task_id === second.task_id) throw new Error('Unconfirmed flush'); return ticket; }} />);
    await screen.findByTestId('review-task-task-1'); await claim('task-1');
    await waitFor(() => expect(screen.getByTestId('held-context').textContent).toContain('task-1/42'));
    await claim('task-2'); await screen.findByRole('alert');
    expect(writes('release')).toEqual([]);
    expect(writes('acquire').map((item) => item.url.pathname)).toEqual(['/api/tasks/task-1/lease']);
    expect(screen.getByTestId('fixed-context').textContent).toBe('asset-1/ontology-old');
  });

  it('leaves the old fixed context read-only after release succeeds but the target claim is rejected', async () => {
    handle = async (url, init, body) => url.pathname === '/api/tasks/task-2/lease' && body.action === 'acquire' ? response({ code: 'LEASE_NOT_HELD', message: 'Another holder', request_id: 'c06', details: null }, 409) : normal(url, init, body);
    render(<Harness />); await screen.findByTestId('review-task-task-1'); await claim('task-1');
    await waitFor(() => expect(screen.getByTestId('fixed-context').textContent).toBe('asset-1/ontology-old'));
    await claim('task-2'); await screen.findByRole('alert');
    expect(screen.getByTestId('held-context').textContent).toBe('readonly');
    expect(screen.getByTestId('fixed-context').textContent).toBe('asset-1/ontology-old');
  });

  it('does not install a late renew of the same task over a newly acquired fence', async () => {
    vi.useFakeTimers();
    const renew = deferred<Response>(); let acquired = 0;
    handle = async (url, init, body) => {
      if (url.pathname === '/api/tasks/task-1/lease' && body.action === 'renew') return renew.promise;
      if (url.pathname === '/api/tasks/task-1/lease' && body.action === 'acquire') return lease('task-1', ++acquired === 1 ? 42 : 43);
      return normal(url, init, body);
    };
    render(<Harness />); await act(async () => { await Promise.resolve(); });
    await claim('task-1'); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(writes('renew')).toHaveLength(1);
    await claim('task-1');
    expect(screen.getByTestId('held-context').textContent).toContain('task-1/43');
    await act(async () => { renew.resolve(lease('task-1', 42)); });
    expect(screen.getByTestId('held-context').textContent).toBe('task-1/43/ontology-old');
  });

  it.each(['project', 'actor'] as const)('does not adopt a late claim after the %s scope changes', async (changed) => {
    const acquire = deferred<Response>();
    handle = async (url, init, body) => url.pathname === '/api/tasks/task-1/lease' && body.action === 'acquire' ? acquire.promise : normal(url, init, body);
    const opened = vi.fn();
    const view = render(<Harness open={opened} />); await screen.findByTestId('review-task-task-1'); await claim('task-1');
    view.rerender(<Harness projectId={changed === 'project' ? 'project-2' : 'project-1'} session={changed === 'actor' ? { ...actor, user_id: 'different-actor' } : actor} open={opened} />);
    await act(async () => { acquire.resolve(lease('task-1', 42)); });
    expect(screen.getByTestId('held-context').textContent).toBe('readonly');
    expect(screen.getByTestId('fixed-context').textContent).toBe('ordinary');
    expect(opened).not.toHaveBeenCalled();
  });

  it('rechecks preparation currency before claiming and releases only the captured ticket', async () => {
    const flush = deferred<Preparation>(); const release = vi.fn(); let current = true;
    render(<Harness prepare={async (_target, ticket) => { return flush.promise.then(() => ({ ...ticket, isCurrent: () => current, release })); }} />);
    await screen.findByTestId('review-task-task-1'); await claim('task-1'); current = false;
    await act(async () => { flush.resolve({ token: Symbol(), isCurrent: () => false, validateCurrent: async () => false, release, onTaskOpen: () => undefined }); });
    expect(writes()).toEqual([]);
    expect(screen.getByTestId('held-context').textContent).toBe('readonly');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown claim distinct from rejection and only rechecks on explicit user action without another POST', async () => {
    handle = async (url, init, body) => url.pathname.endsWith('/lease') && body.action === 'acquire' ? Promise.reject(new TypeError('Network response lost')) : normal(url, init, body);
    render(<Harness />); await screen.findByTestId('review-task-task-1'); await claim('task-1');
    const unknown = await screen.findByTestId('task-claim-unknown');
    expect(unknown.getAttribute('role')).toBe('status');
    expect(writes('acquire')).toHaveLength(1);
    fireEvent.click(within(unknown).getByRole('button'));
    await act(async () => { await Promise.resolve(); });
    expect(writes('acquire')).toHaveLength(1);
    expect(screen.getByTestId('held-context').textContent).toBe('readonly');
    expect(unknown.textContent).toContain('task-1'); expect(unknown.textContent).toContain(actor.user_id);
    for (const button of screen.getAllByRole('button',{name:'领取任务'})) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
    const otherTransfer = screen.getByTestId('task-transfer-task-2');
    expect((otherTransfer as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(screen.getByTestId('review-task-task-2')).getByRole('combobox'),{target:{value:'annotator-1'}});
    fireEvent.submit(otherTransfer.closest('form')!);
    expect(writes()).toHaveLength(1);
  });

  it('opens through the preparation ticket callback captured before a same-scope rerender', async () => {
    const acquire = deferred<Response>();
    handle = async (url, init, body) => url.pathname.endsWith('/lease') && body.action === 'acquire' ? acquire.promise : normal(url, init, body);
    const captured = vi.fn(); const later = vi.fn();
    const view = render(<Harness open={captured} />);
    await screen.findByTestId('review-task-task-1'); await claim('task-1');
    view.rerender(<Harness open={later} />);
    await act(async () => { acquire.resolve(lease(task.task_id, 42)); });
    expect(captured).toHaveBeenCalledWith(task, { task_id: task.task_id, asset_revision_id: task.asset_revision_id, ontology_version_id: task.ontology_version_id, fencing_token: 42 });
    expect(later).not.toHaveBeenCalled();
  });

  it('does not release an unknown claim on unmount', async () => {
    handle = async (url, init, body) => url.pathname.endsWith('/lease') && body.action === 'acquire' ? Promise.reject(new TypeError('Lost response')) : normal(url, init, body);
    const view = render(<Harness />);
    await screen.findByTestId('review-task-task-1'); await claim('task-1');
    await screen.findByTestId('task-claim-unknown');
    view.unmount();
    expect(writes('release')).toEqual([]);
  });
});

describe('C06 lease response identity', () => {
  it.each(['task', 'holder'] as const)('does not open or install a claim with mismatched %s identity', async (mismatch) => {
    handle = async (url, init, body) => url.pathname.endsWith('/lease') && body.action === 'acquire'
      ? lease(mismatch === 'task' ? 'other-task' : task.task_id, 42, mismatch === 'holder' ? 'other-actor' : actor.user_id)
      : normal(url, init, body);
    render(<Harness />); await screen.findByTestId('review-task-task-1'); await claim('task-1');
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('held-context').textContent).toBe('readonly');
    expect(screen.getByTestId('fixed-context').textContent).toBe('ordinary');
  });

  it('does not clear the new fence when a late renewal of the old fence rejects', async () => {
    vi.useFakeTimers(); const renewal = deferred<Response>(); let count = 0;
    handle = async (url, init, body) => {
      if (url.pathname === '/api/tasks/task-1/lease' && body.action === 'renew') return renewal.promise;
      if (url.pathname === '/api/tasks/task-1/lease' && body.action === 'acquire') return lease(task.task_id, ++count === 1 ? 42 : 43);
      return normal(url, init, body);
    };
    render(<Harness />); await act(async () => { await Promise.resolve(); }); await claim(task.task_id);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await claim(task.task_id);
    await act(async () => { renewal.resolve(response({ code: 'LEASE_EXPIRED', message: 'Old fence expired', details: null, request_id: 'old-renew' }, 409)); });
    expect(screen.getByTestId('held-context').textContent).toBe('task-1/43/ontology-old');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('C06 project-qualified paginated task selectors', () => {
  it('uses member and media cursors, retains choices after a failed page, and creates a task with the selected immutable version', async () => {
    let failed = false;
    handle = async (url, init, body) => {
      if (url.pathname.endsWith('/members') && url.searchParams.get('cursor') === 'viewer-1') {
        if (!failed) { failed = true; return response({ code: 'MEMBERS_READ_FAILED' }, 500); }
        return response({ items: [{ user_id: 'annotator-2', username: 'qualified-two', role: 'annotator' }], next_cursor: null });
      }
      if (url.pathname.endsWith('/assets') && url.searchParams.get('cursor') === 'asset-1') return response({ items: [media('asset-2')], next_cursor: null });
      if (url.pathname.endsWith('/tasks') && init.method === 'POST') return response({ ...second, assignee_id: body.assignee_id }, 201);
      return normal(url, init, body);
    };
    render(<Harness />);
    const people = await screen.findByRole('combobox', { name: /指派/ });
    const optionIds = () => Array.from((people as HTMLSelectElement).options, (item) => item.value).filter(Boolean);
    await waitFor(() => expect(optionIds()).toEqual([actor.user_id, 'annotator-1']));
    expect(requests.filter((item) => item.url.pathname.endsWith('/members')).map((item) => item.url.searchParams.get('cursor'))).toEqual([null]);
    expect(requests.filter((item) => item.url.pathname.endsWith('/assets')).map((item) => item.url.searchParams.get('cursor'))).toEqual([null]);
    fireEvent.click(screen.getByTestId('task-members-more')); await screen.findByRole('alert');
    expect(optionIds()).toEqual([actor.user_id, 'annotator-1']);
    fireEvent.click(screen.getByTestId('task-members-more'));
    await waitFor(() => expect(optionIds()).toContain('annotator-2'));
    expect(requests.filter((item) => item.url.pathname.endsWith('/members')).map((item) => item.url.searchParams.get('cursor'))).toEqual([null, 'viewer-1', 'viewer-1']);
    fireEvent.click(screen.getByTestId('task-media-more'));
    const images = screen.getByRole('combobox', { name: /图片版本/ });
    await waitFor(() => expect(Array.from((images as HTMLSelectElement).options, (item) => item.value)).toContain('asset-2'));
    fireEvent.change(images, { target: { value: 'asset-2' } });
    fireEvent.change(people, { target: { value: 'annotator-2' } });
    fireEvent.change(screen.getByRole('combobox', { name: /类别规范版本/ }), { target: { value: 'ontology-old' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(requests.filter((item) => item.method === 'POST' && item.url.pathname.endsWith('/tasks')).map((item) => item.body)).toEqual([{ asset_revision_id: 'asset-2', ontology_version_id: 'ontology-old', assignee_id: 'annotator-2' }]));
    expect(requests.some((item) => item.url.pathname === '/api/users')).toBe(false);
  });

  it('keeps each task transfer target independent and excludes reviewer/viewer recipients', async () => {
    render(<Harness />); await screen.findByTestId('review-task-task-2');
    const row1 = within(screen.getByTestId('review-task-task-1'));
    const row2 = within(screen.getByTestId('review-task-task-2'));
    const select1 = await row1.findByRole('combobox', { name: /转交/ });
    const select2 = row2.getByRole('combobox', { name: /转交/ });
    expect(Array.from((select1 as HTMLSelectElement).options, (item) => item.value).filter(Boolean)).toEqual([actor.user_id, 'annotator-1']);
    fireEvent.change(select1, { target: { value: 'annotator-1' } });
    fireEvent.change(select2, { target: { value: actor.user_id } });
    expect((select1 as HTMLSelectElement).value).toBe('annotator-1');
    fireEvent.click(row1.getByTestId('task-transfer-task-1'));
    await waitFor(() => expect(writes('transfer').map((item) => ({ path: item.url.pathname, holder: item.body.holder_id }))).toEqual([{ path: '/api/tasks/task-1/lease', holder: 'annotator-1' }]));
  });

  it.each(['unknown', 'annotator', 'reviewer', 'viewer', 'nonmember'])('never requests project members for %s role, including platform admins without project-admin membership', async (role) => {
    render(<Harness session={{ ...actor, platform_admin: true, project_roles: role === 'nonmember' ? [] : [{ project_id: 'project-1', role }] }} />);
    await screen.findByTestId('review-task-task-1');
    expect(requests.some((item) => item.url.pathname.endsWith('/members') || item.url.pathname === '/api/users')).toBe(false);
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
  });
});

describe('C06 metadata creation consumer', () => {
  async function choose() {
    await waitFor(() => expect((screen.getByRole('combobox', { name: /指派/ }) as HTMLSelectElement).options.length).toBe(3));
    fireEvent.change(screen.getByRole('combobox', { name: /图片版本/ }), { target: { value: 'asset-1' } });
    fireEvent.change(screen.getByRole('combobox', { name: /类别规范版本/ }), { target: { value: 'ontology-old' } });
  }
  const creates = () => requests.filter(item => item.method === 'POST' && item.url.pathname.endsWith('/tasks'));
  it('freezes choices throughout preparation and the POST, then makes an unknown metadata result read-only', async () => {
    const preparation = deferred<TaskCreatePreparation>(), post = deferred<Response>();
    let released = false;
    handle = async (url, init, body) => init.method === 'POST' && url.pathname.endsWith('/tasks') ? post.promise : normal(url, init, body);
    render(<Harness prepareCreate={() => preparation.promise} />); await choose();
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    expect(creates()).toEqual([]);
    expect((screen.getByRole('combobox', { name: /图片版本/ }) as HTMLSelectElement).disabled).toBe(true);
    await act(async () => preparation.resolve({ token: Symbol(), isCurrent: () => true, validateCurrent: async () => true, release: () => { released = true; } }));
    await waitFor(() => expect(creates().length).toBe(1));
    expect(released).toBe(false);
    expect((screen.getByTestId('task-members-more') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => post.reject(new TypeError('connection lost')));
    expect(released).toBe(true);
    expect(screen.getByTestId('task-create-unknown').textContent).toContain('任务可能已经创建');
    fireEvent.click(screen.getByRole('button', { name: '只读核对任务' }));
    await act(async () => { await Promise.resolve(); });
    expect(creates().length).toBe(1);
    expect((screen.getByRole('button', { name: '创建任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes('release')).toEqual([]);
  });
  it('shows actionable parent rejection details and sends no metadata request', async () => {
    render(<Harness prepareCreate={async () => { throw new Error('目标图片原作者缺失；请先救援。'); }} />); await choose();
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    expect((await screen.findByRole('alert')).textContent).toContain('目标图片原作者缺失');
    expect(creates()).toEqual([]);
  });
});

describe('C06 unknown metadata creation is retained by project and actor', () => {
  type CreateScope = { projectId: string; session: Session };
  const admin: Session = { ...actor, project_roles: [{ project_id: 'project-1', role: 'admin' }, { project_id: 'project-2', role: 'admin' }] };
  const a: CreateScope = { projectId: 'project-1', session: admin };
  const alternatives = [
    { name: 'project', scope: { projectId: 'project-2', session: admin } },
    { name: 'actor', scope: { projectId: 'project-1', session: { ...admin, user_id: 'admin-2', username: 'second-admin' } } },
  ];
  const targetFor = ({ projectId, session }: CreateScope): TaskCreateTarget => ({ project_id: projectId, asset_revision_id: projectId + '-asset', ontology_version_id: projectId + '-ontology', assignee_id: session.user_id });
  const bodyFor = (scope: CreateScope) => ({ asset_revision_id: targetFor(scope).asset_revision_id, ontology_version_id: targetFor(scope).ontology_version_id, assignee_id: scope.session.user_id });
  const createButton = () => screen.getByRole('button', { name: '创建任务' }) as HTMLButtonElement;
  afterEach(() => setCsrfToken(null));

  // Real ReviewPanel and required preparation; HTTP and authorization token are controlled,
  // not Native, Undo, or server authorization evidence. Every list belongs to its URL project.
  function controlledScopes(post: (scope: CreateScope, body: Record<string, unknown>) => Promise<Response>) {
    let active = a;
    let scopeGeneration = 0;
    const observed: { projectId: string; actorId: string; csrf: string | null; body: Record<string, unknown> }[] = [];
    const prepared: { projectId: string; actorId: string; target: TaskCreateTarget; ticket: TaskCreatePreparation }[] = [];
    const prepareCreate = vi.fn(async (target: TaskCreateTarget): Promise<TaskCreatePreparation> => {
      const captured = active;
      const capturedGeneration = scopeGeneration;
      expect(target).toEqual(targetFor(captured));
      expect(Object.isFrozen(target)).toBe(true);
      const ticket: TaskCreatePreparation = { token: Symbol('scope-preparation'), isCurrent: () => active === captured && scopeGeneration === capturedGeneration, validateCurrent: async () => active === captured && scopeGeneration === capturedGeneration, release: vi.fn() };
      prepared.push({ projectId: captured.projectId, actorId: captured.session.user_id, target, ticket });
      return ticket;
    });
    handle = async (url, init, body) => {
      const projectId = url.pathname.split('/')[3]!;
      expect(['project-1', 'project-2']).toContain(projectId);
      if (url.pathname.endsWith('/tasks')) {
        if (init.method === 'POST') {
          const captured = active;
          expect(projectId).toBe(captured.projectId);
          observed.push({ projectId, actorId: captured.session.user_id, csrf: new Headers(init.headers).get('x-csrf-token'), body });
          return post(captured, body);
        }
        return response({ items: [{ ...task, task_id: projectId + '-listed', project_id: projectId, asset_revision_id: projectId + '-asset', ontology_version_id: projectId + '-ontology', assignee_id: active.session.user_id }], next_cursor: null });
      }
      if (url.pathname.endsWith('/members')) return response({ items: [
        { user_id: 'admin-1', username: 'project-admin', role: 'admin' },
        { user_id: 'admin-2', username: 'second-admin', role: 'admin' },
        { user_id: projectId + '-annotator', username: 'qualified-annotator', role: 'annotator' },
      ], next_cursor: null });
      if (url.pathname.endsWith('/assets')) return response({ items: [{ ...media(projectId + '-asset'), project_id: projectId }], next_cursor: null });
      if (url.pathname.endsWith('/ontologies')) return response({ items: [{ ontology_version_id: projectId + '-ontology', project_id: projectId, version_no: 1, labels: [], guidelines_markdown: '', allow_out_of_bounds: false }], next_cursor: null });
      throw new Error('Unexpected scoped HTTP path ' + url.pathname);
    };
    const activate = (scope: CreateScope) => { scopeGeneration++; active = scope; setCsrfToken('scope-csrf-' + scope.session.user_id); };
    activate(a);
    const view = render(<Harness projectId={a.projectId} session={a.session} prepareCreate={prepareCreate} />);
    return { observed, prepared, prepareCreate, switchTo(scope: CreateScope) { activate(scope); view.rerender(<Harness projectId={scope.projectId} session={scope.session} prepareCreate={prepareCreate} />); } };
  }
  async function ready(scope: CreateScope) {
    await screen.findByTestId('review-task-' + scope.projectId + '-listed');
    await waitFor(() => {
      expect(Array.from((screen.getByRole('combobox', { name: /图片版本/ }) as HTMLSelectElement).options, item => item.value)).toEqual(['', scope.projectId + '-asset']);
      expect(Array.from((screen.getByRole('combobox', { name: /类别规范版本/ }) as HTMLSelectElement).options, item => item.value)).toEqual(['', scope.projectId + '-ontology']);
      expect(Array.from((screen.getByRole('combobox', { name: /指派/ }) as HTMLSelectElement).options, item => item.value)).toEqual(['', 'admin-1', 'admin-2', scope.projectId + '-annotator']);
    });
  }
  async function submit(scope: CreateScope) {
    await ready(scope);
    expect(createButton().disabled).toBe(false);
    fireEvent.change(screen.getByRole('combobox', { name: /图片版本/ }), { target: { value: targetFor(scope).asset_revision_id } });
    fireEvent.change(screen.getByRole('combobox', { name: /类别规范版本/ }), { target: { value: targetFor(scope).ontology_version_id } });
    fireEvent.change(screen.getByRole('combobox', { name: /指派/ }), { target: { value: scope.session.user_id } });
    fireEvent.click(createButton());
    await act(async () => { await Promise.resolve(); });
  }
  function expectPosts(actual: ReturnType<typeof controlledScopes>['observed'], scopes: CreateScope[]) {
    expect(actual).toEqual(scopes.map(scope => ({ projectId: scope.projectId, actorId: scope.session.user_id, csrf: 'scope-csrf-' + scope.session.user_id, body: bodyFor(scope) })));
    expect(requests.filter(item => item.method === 'POST').map(item => ({ path: item.url.pathname, body: item.body }))).toEqual(scopes.map(scope => ({ path: '/api/projects/' + scope.projectId + '/tasks', body: bodyFor(scope) })));
  }
  async function readonlyCheck(scope: CreateScope) {
    await ready(scope);
    expect(screen.getByTestId('task-create-unknown').textContent).toContain('任务可能已经创建');
    expect(createButton().disabled).toBe(true);
    const before = requests.length;
    fireEvent.click(screen.getByRole('button', { name: '只读核对任务' }));
    await waitFor(() => expect(requests.slice(before).map(item => ({ method: item.method, path: item.url.pathname }))).toEqual([{ method: 'GET', path: '/api/projects/' + scope.projectId + '/tasks' }]));
    expect(createButton().disabled).toBe(true);
  }

  it.each(alternatives)('allows an independent $name creation after A is unknown, but never reposts A on return', async ({ scope: b }) => {
    const fixture = controlledScopes(async (scope, body) => {
      if (scope === a) throw new TypeError('A metadata connection lost');
      return response({ ...task, ...body, project_id: scope.projectId, task_id: scope.projectId + '-created' }, 201);
    });
    await submit(a); await screen.findByTestId('task-create-unknown');
    expectPosts(fixture.observed, [a]);
    fixture.switchTo(b); await ready(b);
    expect(screen.queryByTestId('task-create-unknown')).toBeNull();
    await submit(b); await waitFor(() => expect(createButton().disabled).toBe(false));
    expectPosts(fixture.observed, [a, b]);
    expect(fixture.prepared.map(item => ({ projectId: item.projectId, actorId: item.actorId, target: item.target }))).toEqual([a, b].map(scope => ({ projectId: scope.projectId, actorId: scope.session.user_id, target: targetFor(scope) })));
    expect(fixture.prepared[0]!.ticket.isCurrent()).toBe(false);
    for (const item of fixture.prepared) expect(item.ticket.release).toHaveBeenCalledTimes(1);
    fixture.switchTo(a); await readonlyCheck(a);
    expectPosts(fixture.observed, [a, b]);
    expect(fixture.prepareCreate).toHaveBeenCalledTimes(2);
  });

  it('preserves A unknown across role loss/restoration and same-actor identity changes', async () => {
    const fixture = controlledScopes(async () => { throw new TypeError('A metadata connection lost'); });
    await submit(a); await screen.findByTestId('task-create-unknown');
    const viewer: CreateScope = { ...a, session: { ...a.session, project_roles: [{ project_id: a.projectId, role: 'viewer' }] } };
    fixture.switchTo(viewer); await screen.findByTestId('review-task-project-1-listed');
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
    fixture.switchTo(a); await readonlyCheck(a);
    const renamed: CreateScope = { ...a, session: { ...a.session, username: 'renamed-same-actor', platform_admin: true, project_roles: [...a.session.project_roles].reverse() } };
    fixture.switchTo(renamed); await readonlyCheck(renamed);
    fixture.switchTo(a); await readonlyCheck(a);
    expectPosts(fixture.observed, [a]);
    expect(fixture.prepareCreate).toHaveBeenCalledTimes(1);
  });

  for (const { name, scope: b } of alternatives) {
    it.each(['network failure', 'confirmed success'])('keeps a late A %s in A after the ' + name + ' changes, without clearing B unknown or reposting A', async (outcome) => {
      const pending = deferred<Response>();
      const fixture = controlledScopes(async (scope) => scope === a ? pending.promise : Promise.reject(new TypeError('B metadata connection lost')));
      await submit(a); await waitFor(() => expectPosts(fixture.observed, [a]));
      expect(createButton().disabled).toBe(true);
      expect(fixture.prepared[0]!.ticket.release).not.toHaveBeenCalled();
      fixture.switchTo(b); await ready(b);
      expect(fixture.prepared[0]!.ticket.isCurrent()).toBe(false);
      expect(screen.queryByTestId('task-create-unknown')).toBeNull();
      await submit(b); await screen.findByTestId('task-create-unknown');
      expectPosts(fixture.observed, [a, b]);
      await act(async () => {
        if (outcome === 'network failure') pending.reject(new TypeError('late A metadata connection lost'));
        else pending.resolve(response({ ...task, ...bodyFor(a), project_id: a.projectId, task_id: 'A-confirmed-created' }, 201));
      });
      expect(fixture.prepared[0]!.ticket.release).toHaveBeenCalledTimes(1);
      await readonlyCheck(b);
      expect(screen.queryByTestId('review-error')).toBeNull();
      expectPosts(fixture.observed, [a, b]);
      fixture.switchTo(a); await ready(a);
      if (outcome === 'network failure') await readonlyCheck(a);
      else {
        expect(screen.queryByTestId('task-create-unknown')).toBeNull();
        expect(createButton().disabled).toBe(false);
        fireEvent.click(screen.getByTestId('task-media-refresh'));
        await act(async () => { await Promise.resolve(); });
      }
      expectPosts(fixture.observed, [a, b]);
      expect(fixture.prepareCreate).toHaveBeenCalledTimes(2);
      fixture.switchTo(b); await readonlyCheck(b);
      expectPosts(fixture.observed, [a, b]);
    });
  }
});


describe('C06 real Workbench + SaveQueue creation barrier (controlled HTTP/storage/Native boundaries)', () => {
  let saves: SaveQueue;
  let projectId: string;
  let targetId: string;
  let currentId: string;
  let disk: Map<string, DraftRecord>;
  let diskStorage: InMemoryDraftStorage;
  async function commitDisk(envelope: DraftBranchEnvelope, guard: () => boolean = () => true) {
    const receipt = await diskStorage.put(envelope, guard);
    if (receipt) disk.set(envelope.asset_revision_id, structuredClone(envelope.record) as DraftRecord);
    return receipt;
  }
  async function seedDisk(record: DraftRecord) {
    const envelope = { asset_revision_id: record.asset_revision_id, draft_id: crypto.randomUUID(), write_token: crypto.randomUUID(), record, sources: [] };
    await commitDisk(envelope); return envelope;
  }
  let serial = 0;
  const creates = () => requests.filter(item => item.method === 'POST' && item.url.pathname.endsWith('/tasks'));
  const doc = (id: string): AnnotationDocument => ({ schema_version: 1, asset_revision_id: id, ontology_version_id: 'ontology-old', coordinate_space: { type: 'canonical_image_pixels', width: 32, height: 24 }, completion: 'in_progress', objects: [] });
  async function mount(sameAsset = false, taskOverrides: Partial<ReviewTask> = {}, platformAdmin = false, withNext = false, ordinaryTasks: 'assigned' | 'untasked' | 'page2' | 'late-assignment' = 'assigned', interrupt?: { gate: Promise<Response> | null; run(view: ReturnType<typeof render>): Promise<void> }) {
    projectId = 'create-consumer-' + ++serial; targetId = projectId + '-target'; currentId = sameAsset ? targetId : projectId + '-current';
    disk = new Map(); diskStorage = new InMemoryDraftStorage(); workbenchBoundary.generation = 0; workbenchBoundary.host = null;
    workbenchBoundary.session = { ...actor, platform_admin: platformAdmin, project_roles: [{ project_id: projectId, role: 'admin' }] };
    const items = [...new Set([currentId, targetId, ...(withNext ? [projectId + '-next'] : [])])].map(id => ({ ...media(id), project_id: projectId }));
    const norms = ['ontology-old', 'ontology-second'].map((id, index) => ({ ontology_version_id: id, project_id: projectId, version_no: index + 1, guidelines_markdown: '', allow_out_of_bounds: false as const, labels: [{ label_id: 'class', name: '类别', color: '#ffff00', shortcut: null, allowed_geometry_types: ['bbox_xyxy' as const], attributes: [] }] }));
    history.replaceState(null, '', '?asset_revision_id=' + currentId + (sameAsset ? '&ontology_version_id=ontology-old' : ''));
    vi.spyOn(IndexedDbDraftStorage.prototype, 'get').mockImplementation(diskStorage.get.bind(diskStorage));
    vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(diskStorage.list.bind(diskStorage));
    vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard) => { const record = envelope.record as DraftRecord; return commitDisk(envelope, guard); });
    const bind = SaveQueue.prototype.setWriteOwner;
    vi.spyOn(SaveQueue.prototype, 'setWriteOwner').mockImplementation(function(this: SaveQueue, owner: SaveQueueOwner) { saves = this; bind.call(this, owner); });
    vi.spyOn(api, 'projects').mockResolvedValue({ items: [{ project_id: projectId, name: '测试项目', description: '', allow_self_review: false, role: 'admin' }], next_cursor: null });
    vi.spyOn(api, 'assets').mockResolvedValue(items);
    vi.spyOn(api, 'ontologies').mockResolvedValue({ items: norms, next_cursor: null });
    vi.spyOn(api, 'annotationHeads').mockResolvedValue({ items: sameAsset ? [{ ontology_version_id: 'ontology-old', annotation_revision_id: 'base', revision_no: 1, content_hash: 'a'.repeat(64), completion: 'in_progress', object_count: 0, approved_review_id: null }] : [], next_cursor: null });
    vi.spyOn(api, 'annotation').mockResolvedValue({ ...previousRevisionForWorkbench(), document: doc(currentId) });
    vi.spyOn(api, 'image').mockResolvedValue(new Blob());
    let assignmentVisible = ordinaryTasks !== 'late-assignment';
    handle = async (url, init, body) => {
      if (url.pathname.endsWith('/tasks') && interrupt?.gate) return interrupt.gate;
      if (url.pathname.endsWith('/members')) return response({ items: members, next_cursor: null });
      if (url.pathname.endsWith('/assets')) return response({ items, next_cursor: null });
      if (url.pathname.endsWith('/tasks')) return response({ items: sameAsset && assignmentVisible && ordinaryTasks !== 'untasked' && (ordinaryTasks !== 'page2' || url.searchParams.get('cursor') === 'second') ? [{ ...task, project_id: projectId, asset_revision_id: targetId, ...taskOverrides }] : [], next_cursor: ordinaryTasks === 'page2' && !url.searchParams.get('cursor') ? 'second' : null });
      return normal(url, init, body);
    };
    const view = render(<Workbench projectId={projectId} />);
    if (interrupt) { await interrupt.run(view); return view; }
    await waitFor(() => expect((screen.getByTestId('ontology-selector') as HTMLSelectElement).disabled).toBe(false));
    if (sameAsset) await waitFor(() => expect(workbenchBoundary.host?.status).toBe('ready'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: /指派/ }) as HTMLSelectElement).options.length).toBe(3));
    // Historical/race regressions: assignment appears after an initially untasked
    // server snapshot. This does not authorize already-assigned ordinary entry.
    if (ordinaryTasks === 'late-assignment') {
      assignmentVisible = true;
      fireEvent.click(screen.getByTestId('task-list-refresh'));
      await screen.findByTestId('review-task-task-1');
    }
    fireEvent.change(screen.getByRole('combobox', { name: /图片版本/ }), { target: { value: targetId } });
    fireEvent.change(screen.getByRole('combobox', { name: /类别规范版本/ }), { target: { value: 'ontology-second' } });
    return view;
  }
  function previousRevisionForWorkbench() { return { annotation_revision_id: 'base', parent_revision_id: null, revision_no: 1, document: doc(currentId), content_hash: 'a'.repeat(64), created_at: '2026-10-10T00:00:00Z', created_by: actor.user_id }; }
  it.each(['open', 'closed', 'unknown'])('blocks ordinary entry for %s assigned tasks at real parent and SaveQueue boundaries', async state => {
    await mount(true, { state });
    const nativeCommand = vi.spyOn(workbenchBoundary.host!, 'dispatch');
    const prepare = vi.spyOn(saves as unknown as { prepareOperation(...args: unknown[]): unknown }, 'prepareOperation');
    fireEvent.change(screen.getByTestId('completion-state'), { target: { value: 'complete' } });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(nativeCommand).not.toHaveBeenCalled();
    expect(screen.getByTestId('completion-state')).toHaveProperty('disabled', true);
    const before = saves.toRecord(currentId);
    const delta: EditorDelta = { generation: 1, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [], error: null };
    act(() => controlledCanvas.commit!({ ...doc(currentId), completion: 'complete' }, delta));
    expect(saves.toRecord(currentId)).toMatchObject({ generation: before!.generation, document: before!.document, pending: before!.pending, draft_owner: before!.draft_owner });
    await act(async () => saves.flush(currentId));
    expect(requests.filter(row => row.method === 'PUT')).toEqual([]);
    // Direct SaveQueue callers must not mint a fresh request either.
    act(() => saves.enqueue({ asset_revision_id: currentId, ontology_version_id: 'ontology-old', generation: 1, document: { ...doc(currentId), completion: 'complete' } }));
    await act(async () => saves.flush(currentId));
    expect(saves.toRecord(currentId)!.pending).toBeNull();
    expect(requests.filter(row => row.method === 'PUT')).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/普通入口只读/);
  });
  it('blocks matching task found only on page two', async () => {
    await mount(true, { state: 'closed' }, false, false, 'page2');
    expect(screen.getByTestId('completion-state')).toHaveProperty('disabled', true);
    expect(requests.some(row => row.url.searchParams.get('cursor') === 'second')).toBe(true);
  });
  it('keeps ordinary untasked images editable and persists real parent deltas', async () => {
    await mount(true, {}, false, false, 'untasked');
    expect(screen.getByTestId('completion-state')).toHaveProperty('disabled', false);
    const delta: EditorDelta = { generation: 1, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [], error: null };
    act(() => controlledCanvas.commit!({ ...doc(currentId), completion: 'complete' }, delta));
    await saves.whenPersisted(currentId);
    expect(saves.toRecord(currentId)).toMatchObject({ generation: 1, document: { completion: 'complete' } });
  });
  it.each(['actor', 'project', 'asset', 'ontology'] as const)('does not open Native when an empty task read arrives after %s changes', async change => {
    const read = deferred<Response>();
    const interrupt = { gate: read.promise as Promise<Response> | null, run: async (view: ReturnType<typeof render>) => {
      await waitFor(() => expect(requests.filter(row => row.url.pathname.endsWith('/tasks')).length).toBeGreaterThanOrEqual(2));
      expect(workbenchBoundary.host).toBeNull();
      interrupt.gate = null;
      if (change === 'actor') {
        workbenchBoundary.session = { ...workbenchBoundary.session!, user_id: 'different-actor' };
        view.rerender(<Workbench projectId={projectId} />);
      } else if (change === 'project') view.rerender(<Workbench projectId={projectId + '-different'} />);
      else if (change === 'ontology') fireEvent.change(screen.getByTestId('ontology-selector'), { target: { value: 'ontology-second' } });
      else fireEvent.click(within(screen.getByTestId('asset-grid')).getByRole('button', { name: new RegExp(projectId + '-next') }));
      await act(async () => read.resolve(response({ items: [], next_cursor: null })));
      await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByTestId('tool-box')).toHaveProperty('disabled', true));
      expect(requests.filter(row => row.method === 'PUT')).toEqual([]);
    } };
    await mount(true, { state: 'closed' }, false, true, 'assigned', interrupt);
  });
  it('keeps ordinary entry read-only when task qualification cannot be read', async () => {
    const read = deferred<Response>();
    const interrupt = { gate: read.promise as Promise<Response> | null, run: async () => {
      await waitFor(() => expect(requests.filter(row => row.url.pathname.endsWith('/tasks')).length).toBeGreaterThanOrEqual(2));
      expect(workbenchBoundary.host).toBeNull();
      await act(async () => read.resolve(response({ code: 'TASK_READ_FAILED', message: 'controlled read unavailable' }, 503)));
      await waitFor(() => expect(screen.getAllByRole('alert').some(node => node.textContent?.includes('编辑资格尚未确认'))).toBe(true));
      await waitFor(() => expect(workbenchBoundary.host?.status).toBe('ready'));
      expect(screen.getByTestId('completion-state')).toHaveProperty('disabled', true);
      expect(requests.filter(row => row.method === 'PUT')).toEqual([]);
    } };
    await mount(true, {}, false, false, 'assigned', interrupt);
  });
  it('rescues the complete cached raw source after a later exact read failure without admitting or certifying it', async () => {
    await mount();
    const raw = { schema_version: 77, future: { nested: [1, 'untouched'], extra: { canonical: 'raw' } } };
    const source = { asset_revision_id: currentId, draft_id: 'cached-source', write_token: 'cached-token', record: raw, sources: [] };
    await diskStorage.put(source);
    fireEvent(window, new Event('focus'));
    await screen.findByRole('radio', { name: /cached-source/ });
    await waitFor(() => expect(screen.getByRole('radio', { name: /cached-source/ })).not.toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('radio', { name: /cached-source/ }));
    const rescue = () => within(screen.getByRole('radio', { name: /cached-source/ }).closest('label')!.parentElement!).getByRole('button', { name: '下载选中分支原始草稿' });
    await waitFor(() => expect(rescue()).not.toHaveProperty('disabled', true));
    const beforeNative = workbenchBoundary.host?.getSnapshot();
    const beforeEvidence = saves.getStatus(currentId).local_commit ?? null;
    let downloaded: Blob | null = null;
    const OriginalURL = URL;
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:owned-cached-rescue'; } static revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.spyOn(IndexedDbDraftStorage.prototype, 'get').mockRejectedValue(new Error('owned source read failed'));
    fireEvent.click(rescue());
    await waitFor(() => expect(downloaded).not.toBeNull());
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(downloaded!); });
    expect(JSON.parse(text)).toEqual(raw);
    expect(screen.getByRole('alert').textContent).toMatch(/缓存.*读取失败|读取失败.*缓存/);
    expect(saves.getStatus(currentId).local_commit ?? null).toEqual(beforeEvidence);
    expect(workbenchBoundary.host?.getSnapshot()).toEqual(beforeNative);
    expect((await diskStorage.get(currentId, source.draft_id))!.record).toEqual(raw);
  });
  it('waits for the original norm PUT and its latest local commit for target A while current B is selected', async () => {
    await mount(); const put = deferred<Response>(), commit = deferred<void>();
    const previous = handle;
    handle = async (url, init, body) => init.method === 'PUT' ? put.promise : previous(url, init, body);
    act(() => {
      saves.initializeFromServerRevision({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', annotation_revision_id: 'base', generation: 0, document: doc(targetId) });
      saves.enqueue({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', generation: 1, document: { ...doc(targetId), completion: 'complete' } });
    });
    vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard) => { const record = envelope.record as DraftRecord;
      if (record.asset_revision_id === targetId && record.base_revision_id === 'saved') await commit.promise;
      return commitDisk(envelope, guard);
    });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(requests.some(item => item.method === 'PUT')).toBe(true));
    expect(creates()).toEqual([]);
    const sent = requests.find(item => item.method === 'PUT')!.body;
    await act(async () => put.resolve(response({ operation_id: sent.operation_id, revision: { ...previousRevisionForWorkbench(), annotation_revision_id: 'saved', parent_revision_id: 'base', revision_no: 2, document: sent.document }, idempotent_replay: false })));
    expect(creates()).toEqual([]);
    expect((screen.getByRole('button', { name: '创建任务' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => commit.resolve());
    await waitFor(() => expect(creates().length).toBe(1));
    expect(disk.get(targetId)).toMatchObject({ base_revision_id: 'saved', pending: null, generation: 1, synced_generation: 1, ontology_version_id: 'ontology-old' });
  });
  it('refuses a different target IDB-only legacy dirty record without rewriting it or sending metadata', async () => {
    await mount();
    const original: DraftRecord = { schema_version: 1, asset_revision_id: targetId, ontology_version_id: 'ontology-old', base_revision_id: 'base', generation: 1, synced_generation: 0, synced_intent_seq: 0, document: doc(targetId), pending: null, intent_journal: [], updated_at: '2026-10-10T00:00:00Z' };
    await seedDisk(original);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await screen.findByTestId('review-error');
    expect(creates()).toEqual([]); expect(disk.get(targetId)).toEqual(original); expect(saves.toRecord(targetId)).toBeNull();
  });
  it('claims fresh ordinary LEASE_REQUIRED, then clears pending only after the new operation ACK and confirms local commit', async () => {
    await mount(true, {}, false, false, 'late-assignment'); const originalHost = workbenchBoundary.host;
    const previous = handle, receipt = deferred<Response>(), commit = deferred<void>(); let rejected = true;
    handle = async (url, init, body) => init.method === 'PUT'
      ? rejected ? response({ code: 'LEASE_REQUIRED', message: 'lease required', details: null, request_id: 'fresh' }, 409) : receipt.promise
      : previous(url, init, body);
    const committedDocument: AnnotationDocument = { ...doc(targetId), completion: 'complete' };
    const delta: EditorDelta = { generation: 1, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [], error: null };
    expect(controlledCanvas.commit).not.toBeNull();
    act(() => controlledCanvas.commit!(committedDocument, delta));
    expect(originalHost!.getSnapshot()).toEqual(committedDocument);
    expect(originalHost!.getCommittedSnapshot(delta)).toEqual(committedDocument);
    expect(originalHost!.getGeneration()).toBe(delta.generation);
    await act(async () => saves.flush(targetId));
    const pending = saves.toRecord(targetId)!.pending!;
    fireEvent.click(within(screen.getByTestId('review-task-task-1')).getByRole('button', { name: '领取任务' }));
    await screen.findByTestId('active-task-lease');
    expect(workbenchBoundary.host).toBe(originalHost);
    expect(saves.toRecord(targetId)!.pending).toEqual(pending);
    expect(saves.getStatus(targetId).writes_paused).toBe(true);
    expect(requests.filter(item => item.method === 'PUT')).toHaveLength(1);
    rejected = false;
    vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard = () => true) => { const record = envelope.record as DraftRecord;
      if (record.base_revision_id === 'saved') await commit.promise;
      if (!guard()) return false;
      return commitDisk(envelope, guard);
    });
    fireEvent.click(screen.getByTestId('save-retry'));
    await waitFor(() => expect(requests.filter(item => item.method === 'PUT')).toHaveLength(2));
    const retried = requests.filter(item => item.method === 'PUT')[1]!.body;
    expect(retried.operation_id).not.toBe(pending.operation_id);
    expect(retried.lease).toEqual({ task_id: 'task-1', fencing_token: 42 });
    expect(retried.document).toEqual(pending.request.document);
    expect(saves.toRecord(targetId)).toMatchObject({ pending: { operation_id: retried.operation_id }, synced_generation: 0 });
    await act(async () => receipt.resolve(ack(retried)));
    expect(saves.toRecord(targetId)).toMatchObject({ pending: null, synced_generation: 1, base_revision_id: 'saved' });
    expect(saves.getStatus(targetId).local_commit).toBeNull();
    expect(disk.get(targetId)?.base_revision_id).toBe('base');
    expect(workbenchBoundary.host).toBe(originalHost);
    await act(async () => commit.resolve()); await act(async () => saves.whenPersisted(targetId));
    expect(disk.get(targetId)).toMatchObject({ pending: null, synced_generation: 1, base_revision_id: 'saved' });
    expect(saves.toRecord(targetId)).toMatchObject({ pending: null, generation: 1, synced_generation: 1, base_revision_id: 'saved' });
    expect(saves.getStatus(targetId)).toMatchObject({ phase: 'synced', dirty: false, saving: false, synced_generation: 1, local_commit: { generation: 1, edit_seq: disk.get(targetId)!.edit_seq } });
    expect(workbenchBoundary.host).toBe(originalHost);
  });
  it.each(['REVISION_CONFLICT', 'unknown'])('does not turn %s ordinary pending into lease recovery or a new operation', async code => {
    await mount(true); const previous = handle;
    handle = async (url, init, body) => {
      if (init.method === 'PUT') { if (code === 'unknown') throw new TypeError('lost response'); return response({ code, message: 'conflict', details: null, request_id: 'different' }, 409); }
      return previous(url, init, body);
    };
    workbenchBoundary.generation = 1;
    act(() => saves.enqueue({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', generation: 1, document: doc(targetId) }));
    await act(async () => saves.flush(targetId)); const original = saves.toRecord(targetId)!.pending;
    fireEvent.click(within(screen.getByTestId('review-task-task-1')).getByRole('button', { name: '领取任务' }));
    await screen.findByTestId('review-error');
    expect(writes('acquire')).toEqual([]); expect(saves.toRecord(targetId)!.pending).toEqual(original);
  });
  it('does not post metadata when a successful PUT cannot commit locally', async () => {
    await mount(); const previous = handle;
    handle = async (url, init, body) => init.method === 'PUT' ? response({ operation_id: body.operation_id, revision: { ...previousRevisionForWorkbench(), annotation_revision_id: 'saved', document: body.document }, idempotent_replay: false }) : previous(url, init, body);
    vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard) => { const record = envelope.record as DraftRecord;
      if (record.base_revision_id === 'saved') throw new Error('storage failed');
      return commitDisk(envelope, guard);
    });
    act(() => {
      saves.initializeFromServerRevision({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', annotation_revision_id: 'base', generation: 0, document: doc(targetId) });
      saves.enqueue({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', generation: 1, document: doc(targetId) });
    });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await screen.findByTestId('review-error');
    expect(creates()).toEqual([]);
    expect(saves.toRecord(targetId)).toMatchObject({ pending: null, base_revision_id: 'saved' });
    expect(saves.getStatus(targetId).last_error?.kind).toBe('storage');
    expect(saves.getStatus(targetId).local_commit).toBeNull();
  });
  function seedDirty(id = targetId) {
    saves.initializeFromServerRevision({ asset_revision_id: id, ontology_version_id: 'ontology-old', annotation_revision_id: 'base', generation: 0, document: doc(id) });
    saves.enqueue({ asset_revision_id: id, ontology_version_id: 'ontology-old', generation: 1, document: { ...doc(id), completion: 'complete' } });
  }
  function ack(body: Record<string, unknown>, id = 'saved') {
    return response({ operation_id: body.operation_id, revision: { ...previousRevisionForWorkbench(), annotation_revision_id: id, parent_revision_id: 'base', revision_no: 2, document: body.document }, idempotent_replay: false });
  }
  const transitions = ['actor', 'role', 'project', 'direct auth epoch'] as const;
  for (const stage of ['barrier', 'IDB', 'POST'] as const) {
    it.each(transitions)(stage + ' discards stale creation after %s scope transition', async transition => {
      const view = await mount(); const ownedQueue = saves;
      const read = deferred<readonly DraftBranchEnvelope[]>(), put = deferred<Response>(), post = deferred<Response>();
      const previous = handle; let readStarted = false;
      if (stage === 'IDB') vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(async id => {
        if (id === targetId) { readStarted = true; return read.promise; }
        return diskStorage.list(id);
      });
      if (stage === 'barrier') act(() => seedDirty());
      handle = async (url, init, body) => init.method === 'PUT' ? put.promise
        : init.method === 'POST' && url.pathname.endsWith('/tasks') ? post.promise : previous(url, init, body);
      fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
      await waitFor(() => expect(stage === 'IDB' ? readStarted : stage === 'barrier' ? requests.some(item => item.method === 'PUT') : creates().length === 1).toBe(true));
      const sent = requests.find(item => item.method === 'PUT')?.body;
      const retained = ownedQueue.toRecord(targetId)?.pending;
      await act(async () => {
        if (transition === 'direct auth epoch') setCsrfToken('matrix-epoch-' + projectId);
        else {
          if (transition === 'actor') workbenchBoundary.session = { ...workbenchBoundary.session!, user_id: 'other-actor' };
          if (transition === 'role') workbenchBoundary.session = { ...workbenchBoundary.session!, project_roles: [{ project_id: projectId, role: 'viewer' }] };
          view.rerender(<Workbench projectId={transition === 'project' ? projectId + '-other' : projectId} />);
        }
      });
      const taskReads = requests.filter(item => item.method === 'GET' && item.url.pathname.endsWith('/tasks')).length;
      await act(async () => {
        if (stage === 'IDB') read.resolve([]);
        else if (stage === 'barrier') put.resolve(ack(sent!));
        else post.resolve(response({ ...task, project_id: projectId, asset_revision_id: targetId }, 201));
      });
      expect(creates()).toHaveLength(stage === 'POST' ? 1 : 0);
      expect(requests.filter(item => item.method === 'GET' && item.url.pathname.endsWith('/tasks'))).toHaveLength(taskReads);
      if (stage === 'barrier') {
        expect(ownedQueue.toRecord(targetId)?.pending).toEqual(retained);
        expect(ownedQueue.toRecord(targetId)?.synced_generation).toBe(0);
        expect(ownedQueue.getStatus(targetId).local_commit).toBeNull();
      }
    });
  }
  it('blocks metadata on a late unhandled branch without replacing newer authoritative memory', async () => {
    await mount(); const read = deferred<readonly DraftBranchEnvelope[]>(); let reading = false;
    vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(async id => {
      if (id === targetId) { reading = true; return read.promise; }
      return diskStorage.list(id);
    });
    const previous = handle;
    handle = async (url, init, body) => init.method === 'PUT' ? ack(body) : previous(url, init, body);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(reading).toBe(true));
    act(() => seedDirty());
    const stale: DraftRecord = { ...saves.toRecord(targetId)!, generation: 99, draft_owner: { actor_id: 'foreign', project_id: projectId }, document: { ...doc(targetId), completion: 'confirmed_negative' } };
    await act(async () => read.resolve([{ asset_revision_id: targetId, draft_id: 'foreign-branch', write_token: 'foreign-token', record: stale, sources: [] }]));
    await screen.findByTestId('review-error');
    expect(creates()).toEqual([]);
    expect(saves.toRecord(targetId)).toMatchObject({ generation: 1, synced_generation: 0, document: { ...doc(targetId), completion: 'complete' } });
    expect(requests.filter(item => item.method === 'PUT')).toEqual([]);
  });
  it.each(['missing draft', 'foreign draft actor', 'foreign draft project', 'missing pending', 'foreign pending actor', 'foreign pending project'] as const)('blocks independent provenance: %s without rewriting the retained operation', async binding => {
    await mount();
    const owner = { actor_id: actor.user_id, project_id: projectId };
    const record: DraftRecord = { schema_version: 1, asset_revision_id: targetId, ontology_version_id: 'ontology-old', base_revision_id: 'base', generation: 1, synced_generation: 0, synced_intent_seq: 0, document: doc(targetId), intent_journal: [], updated_at: '2026-10-10T00:00:00Z', draft_owner: owner, pending_owner: owner,
      pending: { operation_id: 'retained-op', generation: 1, journal_seq_end: 0, edit_seq: 1, prepared_at: '2026-10-10T00:00:00Z', request: { operation_id: 'retained-op', base_revision_id: 'base', document: doc(targetId), suggestion_decisions: [], lease: null } } };
    if (binding === 'missing draft') record.draft_owner = null;
    if (binding === 'foreign draft actor') record.draft_owner = { ...owner, actor_id: 'foreign' };
    if (binding === 'foreign draft project') record.draft_owner = { ...owner, project_id: 'foreign-project' };
    if (binding === 'missing pending') record.pending_owner = null;
    if (binding === 'foreign pending actor') record.pending_owner = { ...owner, actor_id: 'foreign' };
    if (binding === 'foreign pending project') record.pending_owner = { ...owner, project_id: 'foreign-project' };
    if (binding.includes('draft')) record.pending = null;
    await seedDisk(record);
    if (record.pending) await act(async () => { const source = await seedDisk(record); await saves.forkFromRecord(source, { expectedCurrent: saves.getStatus(targetId).local_commit }); });
    // toRecord generates updated_at on each read; it is not a mutation marker.
    // Compare every memory payload field; retain exact full-record disk equality.
    const retainedPayload = (value: DraftRecord | null) => {
      if (value === null) return null;
      const { updated_at: _readTimestamp, ...payload } = value;
      return payload;
    };
    const before = retainedPayload(saves.toRecord(targetId));
    await act(async () => saves.whenPersisted(targetId));
    const stored = structuredClone(disk.get(targetId));
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await screen.findByTestId('review-error');
    expect(creates()).toEqual([]); expect(requests.filter(item => item.method === 'PUT')).toEqual([]);
    expect(retainedPayload(saves.toRecord(targetId))).toEqual(before); expect(disk.get(targetId)).toEqual(stored);
  });
  it('blocks unknown annotation import even when it uses another norm on the creation target', async () => {
    await mount();
    const intent: ImportIntent = { scope: projectId, target: { projectId, assetRevisionId: targetId, ontologyId: 'ontology-old' }, batchId: 'unknown-batch', payload: { operation_id: projectId + '-import', loss_ack: true, lease: null }, sending: false, receipt: null };
    act(() => putImportIntent(intent));
    try {
      fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
      await screen.findByTestId('review-error'); expect(creates()).toEqual([]);
      expect(requests.filter(item => item.method === 'PUT')).toEqual([]);
    } finally { act(() => removeImportIntent(intent)); }
  });
  it.each(['other norm', 'other actual assignee', 'platform admin other norm'] as const)('does not broaden fresh ordinary recovery to %s', async mismatch => {
    await mount(true, { ontology_version_id: mismatch.includes('norm') ? 'ontology-second' : 'ontology-old', assignee_id: mismatch === 'other actual assignee' ? 'annotator-1' : actor.user_id }, mismatch === 'platform admin other norm', false, 'late-assignment');
    const originalHost = workbenchBoundary.host, previous = handle;
    handle = async (url, init, body) => init.method === 'PUT' ? response({ code: 'LEASE_REQUIRED', message: 'lease required', details: null, request_id: 'ordinary' }, 409) : previous(url, init, body);
    workbenchBoundary.generation = 1;
    act(() => seedDirty()); await act(async () => saves.flush(targetId));
    const pending = saves.toRecord(targetId)!.pending;
    const claimButton = within(screen.getByTestId('review-task-task-1')).queryByRole('button', { name: '领取任务' });
    if (mismatch === 'other actual assignee') expect(claimButton).toBeNull();
    else { fireEvent.click(claimButton!); await screen.findByTestId('review-error'); }
    expect(writes('acquire')).toEqual([]); expect(saves.toRecord(targetId)!.pending).toEqual(pending);
    expect(requests.filter(item => item.method === 'PUT')).toHaveLength(1);
    expect(workbenchBoundary.host).toBe(originalHost);
  });
    it.each([false, true])('persists a fixed-task unknown ACK after UI lease release with future Native document=%s, without authorizing new edits', async future => {
      await mount(true);
      const first = deferred<Response>(), receipt = deferred<Response>(), localAck = deferred<void>();
      const previous = handle;
      const puts = () => requests.filter(item => item.method === 'PUT');
      handle = async (url, init, body) => {
        if (init.method === 'PUT') return puts().length === 1 ? first.promise : receipt.promise;
        return previous(url, init, body);
      };
      vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard = () => true) => { const record = envelope.record as DraftRecord;
        if (record.base_revision_id === 'saved') await localAck.promise;
        if (!guard()) return false;
        return commitDisk(envelope, guard);

      });
      await claim('task-1');
      await screen.findByTestId('active-task-lease');
      await waitFor(() => expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(false));
      const originalHost = workbenchBoundary.host;
      const originalDocument: AnnotationDocument = { ...doc(targetId), completion: 'complete' };
      const originalIntent = { suggestion_set_id: 'controlled-original', change_ids: ['original-change'], decision: 'accept' as const };
      const delta: EditorDelta = { generation: 1, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [originalIntent], error: null };
      act(() => controlledCanvas.commit!(originalDocument, delta));
      const firstFlush = saves.flush(targetId);
      await waitFor(() => expect(puts()).toHaveLength(1));
      const original = structuredClone(saves.toRecord(targetId)!.pending!);
      expect(original.request).toMatchObject({ base_revision_id: 'base', document: originalDocument, lease: { task_id: 'task-1', fencing_token: 42 }, suggestion_decisions: [originalIntent] });
      const latestDocument: AnnotationDocument = future ? { ...originalDocument, completion: 'in_progress' } : originalDocument;
      const futureIntent = { suggestion_set_id: 'controlled-future', change_ids: ['future-change'], decision: 'revert' as const };
      if (future) {
        // Controlled Native commit while PUT is in flight: parent-delta proof only,
        // not real Native/GPU/undo evidence or evidence of a server commit.
        act(() => controlledCanvas.commit!(latestDocument, { ...delta, generation: 2, suggestion_decisions: [futureIntent] }));
        expect(saves.toRecord(targetId)!.pending).toEqual(original);
      }
      await act(async () => { first.reject(new TypeError('controlled transport response loss')); await firstFlush; });
      await act(async () => saves.whenPersisted(targetId));
      expect(saves.toRecord(targetId)).toMatchObject({ pending: original, pending_outcome: 'unknown', synced_generation: 0 });
      fireEvent.click(screen.getByRole('button', { name: '释放当前任务' }));
      await waitFor(() => expect(screen.queryByTestId('active-task-lease')).toBeNull());
      expect(writes('acquire')).toHaveLength(1);
      expect(writes('release').map(item => item.body)).toEqual([{ action: 'release' }]);
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
      expect(workbenchBoundary.host).toBe(originalHost);
      fireEvent.click(screen.getByTestId('save-retry'));
      await waitFor(() => expect(puts()).toHaveLength(2));
      await act(async () => saves.whenPersisted(targetId));
      const beforeAckRecord = structuredClone(disk.get(targetId)!);
      const beforeAckCertificate = saves.getStatus(targetId).local_commit;
      expect(beforeAckRecord.pending).toEqual(original);
      expect(puts().map(item => item.body)).toEqual([original.request, original.request]);
      await act(async () => receipt.resolve(response({ operation_id: original.operation_id, revision: { ...previousRevisionForWorkbench(), annotation_revision_id: 'saved', parent_revision_id: 'base', revision_no: 2, document: original.request.document }, idempotent_replay: true })));
      expect(saves.toRecord(targetId)).toMatchObject({ pending: null, synced_generation: 1, synced_intent_seq: 1, base_revision_id: 'saved', generation: future ? 2 : 1, document: latestDocument });
      expect(saves.getStatus(targetId).local_commit).toBeNull();
      expect(disk.get(targetId)).toEqual(beforeAckRecord);
      await act(async () => { localAck.resolve(); await saves.whenPersisted(targetId); });
      // A certificate for a record containing pending does not certify the ACK.
      expect({ ...disk.get(targetId), updated_at: '' }).toEqual({ ...saves.toRecord(targetId), updated_at: '' });
      expect(disk.get(targetId)).toMatchObject({ pending: null, base_revision_id: 'saved', synced_generation: 1, synced_intent_seq: 1, generation: future ? 2 : 1, document: latestDocument });
      expect(disk.get(targetId)!.intent_journal.map(entry => ({ generation: entry.generation, intent: entry.intent }))).toEqual(future ? [{ generation: 1, intent: originalIntent }, { generation: 2, intent: futureIntent }] : [{ generation: 1, intent: originalIntent }]);
      const status = saves.getStatus(targetId);
      expect(status).toMatchObject({ saving: false, dirty: future, synced_generation: 1, last_ack: { revision_id: 'saved', generation: 1 }, local_commit: { generation: future ? 2 : 1, edit_seq: disk.get(targetId)!.edit_seq } });
      expect(status.local_commit!.persist_seq).toBeGreaterThan(beforeAckCertificate?.persist_seq ?? 0);
      expect(puts().map(item => item.body)).toEqual([original.request, original.request]);
      expect(writes('acquire')).toHaveLength(1);
      expect(creates()).toEqual([]);
      expect(screen.queryByTestId('active-task-lease')).toBeNull();
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
      expect(workbenchBoundary.host).toBe(originalHost);
      expect(originalHost!.getSnapshot()).toEqual(latestDocument);
      expect(originalHost!.getGeneration()).toBe(future ? 2 : 1);
    });
    it('allows only the historical unknown operation ACK, never a new operation using a newly claimed lease', async () => { await mount(true, {}, false, false, 'late-assignment'); const previous = handle; let attempt = 0;
    const receipt = deferred<Response>();
    handle = async (url, init, body) => {
      if (init.method === 'PUT') {
        attempt++;
        if (attempt === 1) throw new TypeError('response lost');
        if (attempt === 2) return response({ code: 'LEASE_REQUIRED', message: 'lease required', details: null, request_id: 'historical' }, 409);
        return receipt.promise;
      }
      return previous(url, init, body);
    };
    workbenchBoundary.generation = 1;
    act(() => seedDirty()); await act(async () => saves.flush(targetId));
    const original = saves.toRecord(targetId)!.pending!;
    fireEvent.click(screen.getByTestId('save-retry'));
    await waitFor(() => expect(attempt).toBe(2));
    await waitFor(() => expect(saves.getStatus(targetId).saving).toBe(false));
    expect(saves.toRecord(targetId)!.pending_outcome).toBe('unknown');
    fireEvent.click(within(screen.getByTestId('review-task-task-1')).getByRole('button', { name: '领取任务' }));
    await screen.findByTestId('review-error'); expect(writes('acquire')).toEqual([]);
    fireEvent.click(screen.getByTestId('save-retry'));
    await waitFor(() => expect(attempt).toBe(3));
    const puts = requests.filter(item => item.method === 'PUT');
    expect(puts.map(item => item.body)).toEqual([original.request, original.request, original.request]);
    expect(saves.toRecord(targetId)!.pending).toEqual(original);
    expect(saves.toRecord(targetId)!.synced_generation).toBe(0);
    await act(async () => receipt.resolve(ack(puts[2]!.body)));
    await act(async () => saves.whenPersisted(targetId));
    expect(saves.toRecord(targetId)).toMatchObject({ pending: null, generation: 1, synced_generation: 1, base_revision_id: 'saved' });
    expect(saves.getStatus(targetId)).toMatchObject({ dirty: false, saving: false, synced_generation: 1 });
    expect(disk.get(targetId)).toMatchObject({ pending: null, synced_generation: 1 });
    expect(creates()).toEqual([]); });
  // Post-receipt regressions exercise real Workbench/ReviewPanel/queue/controller.
  // HTTP, durable storage and Native commits remain controlled boundaries; no
  // assertion here claims real server authorization, Native undo or GPU proof.
  async function confirmedReleasedFuture() {
    let view = await mount(true);
    let activeStorage = IndexedDbDraftStorage;
    const catalogProjects = structuredClone(await api.projects());
    const catalogOntologies = structuredClone(await api.ontologies(projectId));
    const first = deferred<Response>(), replay = deferred<Response>(), stableAck = deferred<void>();
    const previous = handle;
    const puts = () => requests.filter(item => item.method === 'PUT');
    let acquired = 0;
    let taskOverride: Partial<ReviewTask> = {};
    const revisions = new Map<string, Awaited<ReturnType<typeof api.annotation>>>();
    revisions.set('base', structuredClone(previousRevisionForWorkbench()));
    let headId = 'base';
    vi.mocked(api.annotation).mockImplementation(async (assetId, ontologyId) => {
      if (assetId !== targetId || ontologyId !== 'ontology-old') throw new Error('controlled head scope mismatch');
      return structuredClone(revisions.get(headId)!);
    });
    vi.mocked(api.annotationHeads).mockImplementation(async assetId => {
      if (assetId !== targetId) throw new Error('controlled summary scope mismatch');
      const head = revisions.get(headId)!;
      return { items: [{ ontology_version_id: head.document.ontology_version_id, annotation_revision_id: head.annotation_revision_id, revision_no: head.revision_no, content_hash: head.content_hash, completion: head.document.completion, object_count: head.document.objects.length, approved_review_id: null }], next_cursor: null };
    });
    handle = async (url, init, body) => {
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/projects') return response(catalogProjects);
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/projects/' + projectId + '/ontologies') return response(catalogOntologies);
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/assets/' + targetId + '/annotation-heads') {
        const head = revisions.get(headId)!;
        return response({ items: [{ ontology_version_id: head.document.ontology_version_id, annotation_revision_id: head.annotation_revision_id, revision_no: head.revision_no, content_hash: head.content_hash, completion: head.document.completion, object_count: head.document.objects.length, approved_review_id: null }], next_cursor: null });
      }
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/assets/' + targetId + '/image') return new Response(new Blob(), { status: 200 });
      if (url.pathname.startsWith('/api/annotation-revisions/') && (init.method ?? 'GET') === 'GET') {
        const revision = revisions.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
        return revision ? response(revision) : response({ code: 'ANNOTATION_REVISION_NOT_FOUND', message: 'controlled immutable revision missing', details: null, request_id: 'controlled-read' }, 404);
      }
      if (url.pathname === '/api/assets/' + targetId + '/annotation' && (init.method ?? 'GET') === 'GET') {
        if (url.searchParams.get('ontology_version_id') !== 'ontology-old') throw new Error('controlled transport head scope mismatch');
        return response(revisions.get(headId)!);
      }
      if (init.method === 'PUT') return puts().length === 1 ? first.promise : replay.promise;
      if (url.pathname.endsWith('/lease') && body.action === 'acquire') return lease('task-1', ++acquired === 1 ? 42 : 43, workbenchBoundary.session!.user_id);
      if (url.pathname.endsWith('/tasks') && init.method !== 'POST') return response({ items: [{ ...task, project_id: projectId, asset_revision_id: targetId, ...taskOverride }], next_cursor: null });
      return previous(url, init, body);
    };
    vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockImplementation(async (envelope, guard = () => true) => { const record = envelope.record as DraftRecord;
      if (record.base_revision_id === 'saved' && record.pending === null) await stableAck.promise;
      if (!guard()) return false;
      return commitDisk(envelope, guard);
    });
    const originalIntent = { suggestion_set_id: 'controlled-original', change_ids: ['original-change'], decision: 'accept' as const };
    const futureIntent = { suggestion_set_id: 'controlled-future', change_ids: ['future-change'], decision: 'revert' as const };
    const originalDocument: AnnotationDocument = { ...doc(targetId), completion: 'complete', objects: [{ object_id: 'box-original', label_id: 'class', geometry: { type: 'bbox_xyxy', x_min: 1, y_min: 2, x_max: 10, y_max: 12 }, attributes: {}, origin: { type: 'manual', prediction_id: null, model_run_id: null, import_batch_id: null } }] };
    const latestDocument: AnnotationDocument = { ...originalDocument, completion: 'in_progress', objects: [...originalDocument.objects, { ...originalDocument.objects[0]!, object_id: 'box-future', geometry: { type: 'bbox_xyxy', x_min: 15, y_min: 3, x_max: 25, y_max: 18 } }] };
    const delta: EditorDelta = { generation: 1, changed_objects: originalDocument.objects, removed_object_ids: [], selected_object_ids: ['box-original'], can_undo: true, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [originalIntent], error: null };
    let unknownRecord!: DraftRecord;
    let original!: NonNullable<DraftRecord['pending']>;
    try {
      await claim('task-1'); await screen.findByTestId('active-task-lease');
      await waitFor(() => expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(false));
      const originalHost = workbenchBoundary.host;
      act(() => controlledCanvas.commit!(originalDocument, delta));
      const flush = saves.flush(targetId);
      await waitFor(() => expect(puts()).toHaveLength(1));
      original = structuredClone(saves.toRecord(targetId)!.pending!);
      expect(original.request).toMatchObject({ document: originalDocument, lease: { task_id: 'task-1', fencing_token: 42 }, base_revision_id: 'base', suggestion_decisions: [originalIntent] });
      act(() => controlledCanvas.commit!(latestDocument, { ...delta, generation: 2, changed_objects: latestDocument.objects, selected_object_ids: ['box-future'], can_redo: true, suggestion_decisions: [futureIntent] }));
      expect(saves.toRecord(targetId)!.pending).toEqual(original);
      // The controlled server retains its immutable generation-1 receipt even
      // though the client loses that response. It never reports generation 2.
      revisions.set('saved', structuredClone({ ...previousRevisionForWorkbench(), annotation_revision_id: 'saved', parent_revision_id: 'base', revision_no: 2, document: originalDocument }));
      headId = 'saved';
      await act(async () => { first.reject(new TypeError('controlled old receipt response loss')); await flush; await saves.whenPersisted(targetId); });
      unknownRecord = structuredClone(disk.get(targetId)!);
      expect(unknownRecord).toMatchObject({ generation: 2, synced_generation: 0, pending: original, pending_outcome: 'unknown', document: latestDocument });
      fireEvent.click(screen.getByRole('button', { name: '释放当前任务' }));
      await waitFor(() => expect(screen.queryByTestId('active-task-lease')).toBeNull());
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId('save-retry'));
      await waitFor(() => expect(puts()).toHaveLength(2));
      expect(puts().map(item => item.body)).toEqual([original.request, original.request]);
      await act(async () => replay.resolve(response({ operation_id: original.operation_id, revision: revisions.get('saved'), idempotent_replay: true })));
      expect(saves.getStatus(targetId).local_commit).toBeNull();
      expect(disk.get(targetId)!.pending).toEqual(original);
      await act(async () => { stableAck.resolve(); await saves.whenPersisted(targetId); });
      expect(disk.get(targetId)).toMatchObject({ base_revision_id: 'saved', generation: 2, synced_generation: 1, synced_intent_seq: 1, pending: null, writes_paused: true, document: latestDocument });
      expect(saves.getStatus(targetId)).toMatchObject({ writes_paused: true, dirty: true, saving: false, last_ack: { revision_id: 'saved', generation: 1 }, local_commit: { generation: 2, edit_seq: disk.get(targetId)!.edit_seq } });
      expect(workbenchBoundary.host).toBe(originalHost);
      expect(originalHost!.getSnapshot()).toEqual(latestDocument);
      expect(creates()).toEqual([]);
      return {
        puts, original, originalIntent, futureIntent, latestDocument, unknownRecord, revisions,
        get view() { return view; },
        get storage() { return activeStorage; },
        acceptRevision(revision: Awaited<ReturnType<typeof api.annotation>>) {
          if (revisions.has(revision.annotation_revision_id)) throw new Error('controlled immutable revision cannot be replaced');
          revisions.set(revision.annotation_revision_id, structuredClone(revision));
          headId = revision.annotation_revision_id;
        },
        async reload(record = structuredClone(disk.get(targetId)!), override: Partial<ReviewTask> = {}) {
          const oldQueue = saves;
          await oldQueue.whenPersisted(targetId);
          view.unmount();
          await oldQueue.whenPersisted(targetId);
          const priorEnvelope = (await diskStorage.get(targetId, oldQueue.getDraftBranchSnapshot(targetId)!.envelope.draft_id))!;
          const source = { ...priorEnvelope, write_token: crypto.randomUUID(), record: structuredClone(record) };
          await commitDisk(source);
          taskOverride = override;
          workbenchBoundary.host = null; workbenchBoundary.generation = 0;
          // A component remount reuses Workbench's projectSaveQueues map. A
          // page reload instead evaluates a fresh module graph: reset it here,
          // retaining only the renderer's React instance and controlled I/O.
          // No old queue fields/map entries or last_ack are copied or cleared.
          vi.resetModules();
          vi.doMock('react', () => ReactRuntime);
          // A closed-page recovery must load a fresh module graph after vi.resetModules(), not reuse this page's writer state.
          const [{ Workbench: ColdWorkbench }, { SaveQueue: ColdQueue }, { IndexedDbDraftStorage: ColdStorage }] = await Promise.all([
            import('../workbench/Workbench'),
            import('../../lib/persistence/save-queue'),
            import('../../lib/persistence/draft-store'),
          ]);
          activeStorage = ColdStorage;
          vi.spyOn(ColdStorage.prototype, 'get').mockImplementation(diskStorage.get.bind(diskStorage));
          vi.spyOn(ColdStorage.prototype, 'list').mockImplementation(diskStorage.list.bind(diskStorage));
          vi.spyOn(ColdStorage.prototype, 'put').mockImplementation(async (stored, guard = () => true) => {
            if (!guard()) return false;
            return commitDisk(stored, guard);
          });
          const bindColdOwner = ColdQueue.prototype.setWriteOwner;
          vi.spyOn(ColdQueue.prototype, 'setWriteOwner').mockImplementation(function(this: SaveQueue, owner: SaveQueueOwner) {
            saves = this; bindColdOwner.call(this, owner);
          });
          // Fresh API and FetchSaveTransport remain real: catalog/head/image
          // and immutable base reads use the retained controlled HTTP handler.
          // Only stored fields enter the fresh queue. Native initializes its
          // generation from the actual fresh Workbench load request.
          history.replaceState(null, '', '?task_id=task-1&asset_revision_id=' + targetId + '&ontology_version_id=ontology-old');
          view = render(<ColdWorkbench projectId={projectId} />);
          const selection = await screen.findByRole('radio', { name: new RegExp(source.draft_id) });
          await waitFor(() => expect((selection as HTMLInputElement).disabled).toBe(false));
          fireEvent.click(selection);
          expect((selection as HTMLInputElement).checked).toBe(true);
          const recover = () => {
            const row = screen.getByRole('radio', { name: new RegExp(source.draft_id) }).closest('label')?.parentElement;
            if (!row) throw new Error('Expected the selected source row in the current recovery surface');
            const button = within(row).getByRole('button', { name: '恢复选中分支' });
            if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the actual source recovery button');
            return button;
          };
          const ownedSource = record.draft_owner?.actor_id === workbenchBoundary.session!.user_id && record.draft_owner?.project_id === projectId;
          if (record.base_revision_id === null || !ownedSource) {
            await waitFor(() => expect(recover().disabled).toBe(true));
            await waitFor(() => expect((screen.getByRole('button', { name: '下载选中分支原始草稿' }) as HTMLButtonElement).disabled).toBe(false));
            expect(saves.getStatus(targetId).local_commit ?? null).toBeNull();
          } else {
            await waitFor(() => expect(recover().disabled).toBe(false));
            fireEvent.click(recover());
            await waitFor(() => expect(saves.toRecord(targetId) !== null || screen.queryByText(/工作区载入失败；未开启离线编辑/) !== null).toBe(true));
            await waitFor(() => expect(recover().disabled).toBe(false));
            if (saves.getStatus(targetId).local_commit) await waitFor(() => expect(workbenchBoundary.host?.status).toBe('ready'));
          }
          await screen.findByTestId('review-task-task-1');
          expect(saves).not.toBe(oldQueue);

          await act(async () => saves.whenPersisted(targetId));
        },
      };
    } finally {
      // Failed assertions must never strand the module-wide storage lane.
      stableAck.resolve();
      first.resolve(response({ code: 'CONTROLLED_CLEANUP', message: 'cleanup', details: null, request_id: 'cleanup' }, 500));
      replay.resolve(response({ code: 'CONTROLLED_CLEANUP', message: 'cleanup', details: null, request_id: 'cleanup' }, 500));
    }
  }

  it.each(['live', 'full reload'] as const)('reclaims the SAME fixed task after certified old ACK with a future full document (%s), then saves only on explicit retry', async mode => {
    const fixture = await confirmedReleasedFuture();
    const receipt = deferred<Response>(), stableNewAck = deferred<void>();
    const previous = handle;
    try {
      if (mode === 'full reload') {
        await fixture.reload();
        expect(workbenchBoundary.host!.getSnapshot()).toEqual(fixture.latestDocument);
        expect(workbenchBoundary.host!.getGeneration()).toBe(2);
        expect(saves.toRecord(targetId)).toMatchObject({ pending: null, base_revision_id: 'saved', generation: 2, synced_generation: 1, document: fixture.latestDocument });
      }
      const currentHost = workbenchBoundary.host;
      const beforeClaim = structuredClone(disk.get(targetId)!);
      handle = async (url, init, body) => init.method === 'PUT' ? receipt.promise : previous(url, init, body);
      vi.spyOn(fixture.storage.prototype, 'put').mockImplementation(async (envelope, guard = () => true) => { const record = envelope.record as DraftRecord;
        if (record.base_revision_id === 'saved-future' && record.pending === null) await stableNewAck.promise;
        if (!guard()) return false;
        return commitDisk(envelope, guard);
      });
      await claim('task-1');
      await screen.findByTestId('active-task-lease');
      expect(writes('acquire').map(item => item.url.pathname)).toEqual(['/api/tasks/task-1/lease', '/api/tasks/task-1/lease']);
      expect(writes('release').map(item => ({ path: item.url.pathname, body: item.body }))).toEqual([{ path: '/api/tasks/task-1/lease', body: { action: 'release' } }]);
      expect(fixture.puts().map(item => item.body)).toEqual([fixture.original.request, fixture.original.request]);
      expect(creates()).toEqual([]);
      expect(requests.filter(item => item.method === 'POST' && !item.url.pathname.endsWith('/lease'))).toEqual([]);
      expect(workbenchBoundary.host).toBe(currentHost);
      expect(currentHost!.getSnapshot()).toEqual(fixture.latestDocument);
      expect(currentHost!.getGeneration()).toBe(2);
      expect(saves.getStatus(targetId).writes_paused).toBe(true);
      expect(saves.toRecord(targetId)).toMatchObject({ pending: null, base_revision_id: 'saved', generation: 2, synced_generation: 1, document: fixture.latestDocument, intent_journal: beforeClaim.intent_journal });
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
      expect(fixture.puts()).toHaveLength(2);
      expect(saves.getStatus(targetId).writes_paused).toBe(true);
      fireEvent.click(screen.getByTestId('save-retry'));
      await waitFor(() => expect(fixture.puts()).toHaveLength(3));
      const next = fixture.puts()[2]!.body;
      expect(next.operation_id).not.toBe(fixture.original.operation_id);
      expect(next).not.toEqual(fixture.original.request);
      expect(next).toMatchObject({ base_revision_id: 'saved', lease: { task_id: 'task-1', fencing_token: 43 }, document: fixture.latestDocument, suggestion_decisions: [fixture.futureIntent] });
      expect(saves.toRecord(targetId)).toMatchObject({ synced_generation: 1, pending: { operation_id: next.operation_id, request: next } });
      await act(async () => saves.whenPersisted(targetId));
      const beforeAck = structuredClone(disk.get(targetId)!);
      const revision = { ...fixture.revisions.get('saved')!, annotation_revision_id: 'saved-future', parent_revision_id: 'saved', revision_no: 3, document: fixture.latestDocument };
      fixture.acceptRevision(revision);
      await act(async () => receipt.resolve(response({ operation_id: next.operation_id, revision, idempotent_replay: false })));
      expect(saves.getStatus(targetId).local_commit).toBeNull();
      expect(disk.get(targetId)).toEqual(beforeAck);
      expect(workbenchBoundary.host).toBe(currentHost);
      await act(async () => { stableNewAck.resolve(); await saves.whenPersisted(targetId); });
      expect(disk.get(targetId)).toMatchObject({ base_revision_id: 'saved-future', generation: 2, synced_generation: 2, synced_intent_seq: 2, pending: null, document: fixture.latestDocument });
      expect(saves.getStatus(targetId)).toMatchObject({ dirty: false, saving: false, writes_paused: false, last_ack: { revision_id: 'saved-future', generation: 2 }, local_commit: { generation: 2, edit_seq: disk.get(targetId)!.edit_seq } });
      await waitFor(() => expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(false));
      // Live selection/history must remain actionable after the new ACK is durable,
      // independently of virtual-row measurement. Reload does not promise
      // restored Native undo history or a persisted selection.
      if (mode === 'live') {
        expect((screen.getByTestId('undo') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByTestId('redo') as HTMLButtonElement).disabled).toBe(false);
        await waitFor(() => {
          expect((screen.getByTestId('object-hide-selected') as HTMLButtonElement).disabled).toBe(false);
          expect((screen.getByTestId('object-lock-selected') as HTMLButtonElement).disabled).toBe(false);
        });
      }
      expect(workbenchBoundary.host).toBe(currentHost);
      expect(currentHost!.getSnapshot()).toEqual(fixture.latestDocument);
      expect(fixture.puts()).toHaveLength(3); expect(creates()).toEqual([]);
      expect(requests.filter(item => item.method === 'POST' && !item.url.pathname.endsWith('/lease'))).toEqual([]);
    } finally {
      stableNewAck.resolve();
      receipt.resolve(response({ code: 'CONTROLLED_CLEANUP', message: 'cleanup', details: null, request_id: 'cleanup' }, 500));
      fixture.view.unmount();
      await saves.whenPersisted(targetId);
    }
  });

  it.each(['foreign draft actor', 'foreign draft project', 'legacy owner', 'null base', 'pending unknown', 'other fixed norm', 'foreign current actor', 'read-only role'] as const)('does not borrow post-receipt future eligibility for %s', async mismatch => {
    const fixture = await confirmedReleasedFuture();
    try {
      const retained = structuredClone(disk.get(targetId)!);
      const owner = retained.draft_owner!;
      let override: Partial<ReviewTask> = {};
      if (mismatch === 'foreign draft actor') retained.draft_owner = { ...owner, actor_id: 'foreign' };
      if (mismatch === 'foreign draft project') retained.draft_owner = { ...owner, project_id: 'foreign-project' };
      if (mismatch === 'legacy owner') delete retained.draft_owner;
      if (mismatch === 'null base') retained.base_revision_id = null as unknown as DraftRecord['base_revision_id'];
      if (mismatch === 'pending unknown') {
        retained.pending = fixture.unknownRecord.pending;
        retained.pending_owner = fixture.unknownRecord.pending_owner;
        retained.pending_outcome = 'unknown';
        retained.base_revision_id = fixture.unknownRecord.base_revision_id;
        retained.synced_generation = fixture.unknownRecord.synced_generation;
        retained.synced_intent_seq = fixture.unknownRecord.synced_intent_seq;
        retained.save_error = fixture.unknownRecord.save_error;
      }
      if (mismatch === 'other fixed norm') override = { ontology_version_id: 'ontology-second' };
      if (mismatch === 'foreign current actor') workbenchBoundary.session = { ...workbenchBoundary.session!, user_id: 'foreign' };
      if (mismatch === 'read-only role') workbenchBoundary.session = { ...workbenchBoundary.session!, platform_admin: false, project_roles: [{ project_id: projectId, role: 'viewer' }] };
      await fixture.reload(retained, override);
      if (mismatch === 'null base') expect(disk.get(targetId)).toEqual(retained);
      const payload = (record: DraftRecord) => { const { updated_at: _timestamp, ...rest } = record; return rest; };
      const before = saves.toRecord(targetId) ? payload(saves.toRecord(targetId)!) : null;
      const diskBefore = structuredClone(disk.get(targetId)!);
      const button = within(screen.getByTestId('review-task-task-1')).queryByRole('button', { name: '领取任务' });
      if (mismatch === 'foreign current actor' || mismatch === 'read-only role') expect(button).toBeNull();
      else { expect(button).not.toBeNull(); expect((button as HTMLButtonElement).disabled).toBe(false); fireEvent.click(button!); await screen.findByTestId('review-error'); }
      await act(async () => saves.whenPersisted(targetId));
      expect(writes('acquire')).toHaveLength(1);
      expect(writes('release')).toHaveLength(1);
      expect(fixture.puts().map(item => item.body)).toEqual([fixture.original.request, fixture.original.request]);
      expect(creates()).toEqual([]);
      expect(requests.filter(item => item.method === 'POST' && !item.url.pathname.endsWith('/lease'))).toEqual([]);
      if (saves.toRecord(targetId)) expect(payload(saves.toRecord(targetId)!)).toEqual(before);
      expect(disk.get(targetId)).toEqual(diskBefore);
      if (mismatch === 'null base') {
        expect((screen.getByRole('button', { name: '恢复选中分支' }) as HTMLButtonElement).disabled).toBe(true);
        expect(disk.get(targetId)).toEqual(retained);
        expect(saves.toRecord(targetId)).toBeNull();
        expect((screen.getByRole('button', { name: '下载选中分支原始草稿' }) as HTMLButtonElement).disabled).toBe(false);
      }
      if (saves.toRecord(targetId)) expect(saves.getStatus(targetId).writes_paused).toBe(true);
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      fixture.view.unmount();
      await saves.whenPersisted(targetId);
    }
  });


  it.each(['unrelated', 'rewritten', 'removed', 'raw'] as const)('blocks same-task reclaim after explicit recovery when a source is %s', async mode => {
    const fixture = await confirmedReleasedFuture();
    try {
      await fixture.reload();
      const snapshot = saves.getDraftBranchSnapshot(targetId)!;
      const original = snapshot.envelope.sources.find(ref => ref.action === 'recover')!;
      const source = (await diskStorage.get(targetId, original.draft_id))!;
      if (mode === 'unrelated') await seedDisk({ ...structuredClone(source.record) as DraftRecord, document: { ...(source.record as DraftRecord).document, completion: 'confirmed_negative' } });
      if (mode === 'rewritten') await diskStorage.put({ ...source, write_token: crypto.randomUUID() });
      if (mode === 'removed') await diskStorage.delete(targetId, source.draft_id);
      if (mode === 'raw') await diskStorage.put({ ...source, record: { schema_version: 99, unknown: true } });
      const before = saves.toRecord(targetId)!;
      await claim('task-1'); await screen.findByTestId('review-error');
      expect(writes('acquire')).toHaveLength(1);
      expect(writes('release')).toHaveLength(1);
      expect(screen.queryByTestId('active-task-lease')).toBeNull();
      expect(saves.toRecord(targetId)!.document).toEqual(before.document);
      expect(saves.toRecord(targetId)!.pending).toBeNull();
      expect(creates()).toEqual([]);
    } finally { fixture.view.unmount(); await saves.whenPersisted(targetId); }
  });
  it.each(['token', 'snapshot'] as const)('releases its acquired same-task lease when the recover source %s changes during HTTP', async mode => {
    const fixture = await confirmedReleasedFuture(), responseGate = deferred<Response>();
    const previous = handle;
    try {
      await fixture.reload();
      const host = workbenchBoundary.host, snapshot = saves.getDraftBranchSnapshot(targetId)!;
      const original = snapshot.envelope.sources.find(ref => ref.action === 'recover')!;
      const source = (await diskStorage.get(targetId, original.draft_id))!;
      handle = async (url, init, body) => url.pathname.endsWith('/lease') && body.action === 'acquire' ? responseGate.promise : previous(url, init, body);
      await claim('task-1'); await waitFor(() => expect(writes('acquire')).toHaveLength(2));
      await diskStorage.put(mode === 'token' ? { ...source, write_token: crypto.randomUUID() } : { ...source, record: { ...(source.record as DraftRecord), document: { ...(source.record as DraftRecord).document, completion: 'complete' } } });
      await act(async () => responseGate.resolve(lease('task-1', 43, workbenchBoundary.session!.user_id)));
      await waitFor(() => expect(writes('release')).toHaveLength(2));
      expect(screen.queryByTestId('active-task-lease')).toBeNull();
      expect(workbenchBoundary.host).toBe(host);
      expect(saves.toRecord(targetId)!.document).toEqual(fixture.latestDocument);
      expect(fixture.puts()).toHaveLength(2);
    } finally { responseGate.resolve(lease('task-1', 43)); fixture.view.unmount(); await saves.whenPersisted(targetId); }
  });

  it('defers a queued media job late catalog while task POST is outstanding and preserves the current host', async () => {
    await mount(true); const originalHost = workbenchBoundary.host;
    const post = deferred<Response>(), catalog = deferred<Awaited<ReturnType<typeof api.assets>>>();
    const previous = handle; let jobReads = 0;
    const newMedia = { ...media(projectId + '-imported'), project_id: projectId };
    handle = async (url, init, body) => {
      if (init.method === 'POST' && url.pathname.endsWith('/assets')) return response({ import_job_id: 'queued-media-job', duplicate: false });
      if (url.pathname.endsWith('/jobs/queued-media-job')) {
        jobReads++;
        return response({ job_id: 'queued-media-job', kind: 'media_import', state: jobReads === 1 ? 'queued' : 'succeeded', progress_completed: jobReads === 1 ? 0 : 1, progress_total: 1,
          result: jobReads === 1 ? null : { items: [{ item_index: 0, state: 'succeeded', error: null, error_code: null }] } });
      }
      if (init.method === 'POST' && url.pathname.endsWith('/tasks')) return post.promise;
      return previous(url, init, body);
    };
    fireEvent.change(screen.getByLabelText('媒体文件'), { target: { files: [new File(['synthetic'], 'queued.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: '上传媒体' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '重新检查状态' }) as HTMLButtonElement).disabled).toBe(false));
    const assetRead = vi.spyOn(api, 'assets').mockImplementation(() => catalog.promise); assetRead.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '重新检查状态' }));
    await waitFor(() => expect(assetRead).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    await act(async () => catalog.resolve([{ ...media(targetId), project_id: projectId }, newMedia]));
    expect(screen.queryByTestId('asset-item-' + newMedia.asset_revision_id)).toBeNull();
    expect(workbenchBoundary.host).toBe(originalHost);
    expect((screen.getByRole('button', { name: '重新检查状态' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重新检查状态' }));
    fireEvent.click(screen.getByRole('button', { name: '上传媒体' }));
    expect(jobReads).toBe(2);
    await act(async () => post.resolve(response({ ...task, project_id: projectId, asset_revision_id: targetId }, 201)));
    await screen.findByTestId('asset-item-' + newMedia.asset_revision_id);
    expect(workbenchBoundary.host).toBe(originalHost);
    expect(requests.filter(item => item.method === 'POST' && item.url.pathname.endsWith('/assets'))).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    expect(assetRead).toHaveBeenCalledTimes(1);
  });
  it.each([
    ...(['success', 'storage failure', 'certificate replacement', 'generation', 'document', 'auth epoch'] as const).map(mode => ({stage: 'tasks' as const, mode})),
    ...(['prepare', 'acquire'] as const).flatMap(stage => (['document', 'certificate replacement'] as const).map(mode => ({stage,mode}))),
    {stage: 'acquire' as const, mode: 'unknown acquire' as const},
    {stage: 'acquire' as const, mode: 'unknown cleanup' as const},
  ])('continues through real parent callbacks with frozen proof at $stage: $mode', async ({stage,mode}) => {
    const view = await mount(true, {}, false, true);
    const originalTask = { ...task, project_id: projectId, asset_revision_id: targetId };
    const nextTask = { ...second, project_id: projectId, asset_revision_id: projectId + '-next' };
    let currentRevision: Awaited<ReturnType<typeof api.annotation>> = previousRevisionForWorkbench();
    const nextRevision = { ...currentRevision, annotation_revision_id: 'next-base', document: { ...doc(nextTask.asset_revision_id), ontology_version_id: nextTask.ontology_version_id } };
    vi.mocked(api.annotation).mockImplementation(async asset => asset === nextTask.asset_revision_id ? nextRevision : currentRevision);
    vi.mocked(api.annotationHeads).mockImplementation(async asset => {
      const revision = asset === nextTask.asset_revision_id ? nextRevision : currentRevision;
      return { items: [{ ontology_version_id: revision.document.ontology_version_id, annotation_revision_id: revision.annotation_revision_id, revision_no: revision.revision_no, content_hash: revision.content_hash, completion: revision.document.completion, object_count: revision.document.objects.length, approved_review_id: null }], next_cursor: null };
    });
    vi.spyOn(api, 'session').mockResolvedValue(workbenchBoundary.session!);
    const submitReceipt = { review_id: 'continue-review', task_id: 'task-1', submitted_by: actor.user_id, revision_ids: ['saved-continue'], state: 'pending', created_at: '2026-10-13T00:00:00Z', lease_ended: true };
    const lastPage = deferred<Response>();
    const branchGate = deferred<readonly DraftBranchEnvelope[]>(), acquireGate = deferred<Response>();
    let branchStarted = false;
    let continuing = false;
    const previous = handle;
    handle = async (url, init, body) => {
      if (init.method === 'PUT') {
        const revision = { ...previousRevisionForWorkbench(), annotation_revision_id: 'saved-continue', parent_revision_id: 'base', revision_no: 2, document: body.document as AnnotationDocument };
        currentRevision = revision;
        return response({ operation_id: body.operation_id, revision, idempotent_replay: false });
      }
      if (url.pathname.endsWith('/submit') || url.pathname.endsWith('/submission')) return response(submitReceipt);
      if (continuing && stage === 'acquire' && url.pathname.endsWith('/lease') && body.action === 'acquire') return acquireGate.promise;
      if (continuing && mode === 'unknown cleanup' && url.pathname.endsWith('/lease') && body.action === 'release') throw new TypeError('lost cleanup receipt');
      if (url.pathname.endsWith('/tasks')) {
        if (!continuing) return response({ items: [originalTask], next_cursor: null });
        if (url.searchParams.has('cursor')) return lastPage.promise;
        return response({ items: [originalTask, { ...nextTask, task_id: 'foreign', assignee_id: 'other' }], next_cursor: 'continue-last' });
      }
      return previous(url, init, body);
    };
    try {
      await claim('task-1');
      await waitFor(() => expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(false));
      const fixedHost = workbenchBoundary.host!;
      const completed = { ...doc(targetId), completion: 'complete' as const };
      const delta: EditorDelta = { generation: 1, changed_objects: [], removed_object_ids: [], selected_object_ids: [], can_undo: false, can_redo: false, document_changed: true, repaint: true, suggestion_decisions: [], error: null };
      act(() => controlledCanvas.commit!(completed, delta));
      fireEvent.click(screen.getByTestId('task-submit'));
      await screen.findByRole('button', { name: '完成并继续' });
      await act(async () => saves.whenPersisted(targetId));
      expect(saves.getStatus(targetId)).toMatchObject({ phase: 'synced', local_commit: { generation: 1 }, base_revision_id: 'saved-continue' });
      expect(workbenchBoundary.host).toBe(fixedHost);
      expect(screen.queryByTestId('active-task-lease')).toBeNull();
      expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(true);
      continuing = true;
      if (stage === 'prepare') vi.spyOn(IndexedDbDraftStorage.prototype, 'list').mockImplementation(async id => {
        if (id === targetId && !branchStarted) { branchStarted = true; return branchGate.promise; }
        return diskStorage.list(id);
      });
      fireEvent.click(screen.getByRole('button', { name: '完成并继续' }));
      await waitFor(() => expect(requests.some(item => item.url.searchParams.get('cursor') === 'continue-last')).toBe(true));
      if (stage !== 'tasks') {
        await act(async () => lastPage.resolve(response({items:[nextTask],next_cursor:null})));
        if (stage === 'prepare') await waitFor(() => expect(branchStarted).toBe(true));
        else await waitFor(() => expect(writes('acquire')).toHaveLength(2));
      }
      expect(workbenchBoundary.host).toBe(fixedHost);
      expect(fixedHost.getSnapshot()).toEqual(completed);
      expect(new URL(location.href).searchParams.get('task_id')).toBe('task-1');
      expect(writes('acquire')).toHaveLength(stage === 'acquire' ? 2 : 1);
      if (mode === 'storage failure') {
        vi.spyOn(IndexedDbDraftStorage.prototype, 'put').mockRejectedValue(new Error('explicit durable storage failure'));
        act(() => saves.enqueue({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', base_revision_id: 'saved-continue', generation: 1, document: completed }));
        await act(async () => saves.whenPersisted(targetId));
        expect(saves.getStatus(targetId).local_commit).toBeNull();
        expect(saves.getStatus(targetId).last_error?.kind).toBe('storage');
      }
      if (mode === 'certificate replacement') {
        const originalCommit = saves.getStatus(targetId).local_commit!;
        if (stage === 'tasks') {
          act(() => saves.enqueue({ asset_revision_id: targetId, ontology_version_id: 'ontology-old', base_revision_id: 'saved-continue', generation: 1, document: completed }));
          await act(async () => saves.whenPersisted(targetId));
        } else {
          // Controlled certificate replacement while the real preparation owns the queue barrier.
          saves.getStatus(targetId).local_commit = {...originalCommit,persist_seq:originalCommit.persist_seq+1,write_token:crypto.randomUUID()};
        }
        const newCommit = saves.getStatus(targetId).local_commit!;
        expect(newCommit).not.toEqual(originalCommit);
        expect(newCommit.generation).toBe(originalCommit.generation);
        expect(newCommit.persist_seq).toBeGreaterThan(originalCommit.persist_seq);
        expect(newCommit.write_token).not.toBe(originalCommit.write_token);
        expect(saves.getStatus(targetId).phase).toBe('synced');
        expect(fixedHost.getSnapshot()).toEqual(completed);
      }
      if (mode === 'generation') act(() => controlledCanvas.commit!(completed, { ...delta, generation: 2, document_changed: false }));
      if (mode === 'document' || mode === 'unknown cleanup') act(() => controlledCanvas.commit!({ ...completed, completion: 'in_progress' }, { ...delta, document_changed: false }));
      if (mode === 'auth epoch') act(() => setCsrfToken('continue-epoch-' + projectId));
      await act(async () => lastPage.resolve(response({ items: [nextTask], next_cursor: null })));
      if (stage === 'prepare') await act(async () => branchGate.resolve(await diskStorage.list(targetId)));
      if (stage === 'acquire') await act(async () => {
        if (mode === 'unknown acquire') acquireGate.reject(new TypeError('lost acquire receipt'));
        else acquireGate.resolve(lease(nextTask.task_id,43,actor.user_id));
      });
      if (mode === 'success') {
        await screen.findByTestId('active-task-lease');
        await waitFor(() => expect((screen.getByTestId('tool-box') as HTMLButtonElement).disabled).toBe(false));
        expect(new URL(location.href).searchParams.get('task_id')).toBe(nextTask.task_id);
        expect(new URL(location.href).searchParams.get('asset_revision_id')).toBe(nextTask.asset_revision_id);
        expect(workbenchBoundary.host!.getSnapshot()).toEqual(nextRevision.document);
        expect(new URL(location.href).searchParams.get('ontology_version_id')).toBe(nextTask.ontology_version_id);
        expect(saves.canAcceptEdits(nextTask.asset_revision_id, nextTask.ontology_version_id)).toBe(true);
        expect(saves.getStatus(nextTask.asset_revision_id)).toMatchObject({ base_revision_id: 'next-base', local_generation: 0 });
        expect(writes('acquire').map(item => item.url.pathname)).toEqual(['/api/tasks/task-1/lease', '/api/tasks/task-2/lease']);
      } else {
        await screen.findByTestId('review-error');
        expect(writes('acquire')).toHaveLength(stage === 'acquire' ? 2 : 1);
        expect(new URL(location.href).searchParams.get('task_id')).toBe('task-1');
        expect(new URL(location.href).searchParams.get('asset_revision_id')).toBe(targetId);
        expect(screen.queryByTestId('active-task-lease')).toBeNull();
        expect(workbenchBoundary.host).toBe(fixedHost);
        expect(fixedHost.getSnapshot()).toEqual(mode === 'document' || mode === 'unknown cleanup' ? {...completed,completion:'in_progress'} : completed);
        if (mode === 'unknown acquire' || mode === 'unknown cleanup') {
          const continueButton = screen.getByRole('button',{name:'完成并继续'});
          expect((continueButton as HTMLButtonElement).disabled).toBe(true); fireEvent.click(continueButton);
          for (const button of screen.queryAllByRole('button',{name:'领取任务'})) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
          for (const button of screen.queryAllByRole('button',{name:'转交任务'})) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
          const before = requests.filter(item => item.method === 'POST').length;
          fireEvent.click(screen.getByRole('button',{name:'只读核对租约相关任务'}));
          await waitFor(() => expect((screen.getByTestId('task-list-refresh') as HTMLButtonElement).disabled).toBe(false));
          fireEvent.click(continueButton);
          expect(requests.filter(item => item.method === 'POST')).toHaveLength(before);
          expect((screen.getByRole('button',{name:'完成并继续'}) as HTMLButtonElement).disabled).toBe(true);
        }
      }
      expect(writes('release')).toHaveLength(stage === 'acquire' && mode !== 'unknown acquire' ? 1 : 0);
      expect(requests.filter(item => item.method === 'POST' && item.url.pathname.endsWith('/submit'))).toHaveLength(1);
      expect(requests.filter(item => item.method === 'PUT')).toHaveLength(1);
    } finally { lastPage.resolve(response({ items: [], next_cursor: null })); branchGate.resolve([]); acquireGate.resolve(lease(nextTask.task_id,43,actor.user_id)); view.unmount(); await saves.whenPersisted(targetId); }
  });

});
