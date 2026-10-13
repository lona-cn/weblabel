import { Blob as BrowserCompatibleBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import * as matchers from '@testing-library/jest-dom/matchers';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { Datasets } from './Datasets';
import { setCsrfToken, type Session } from '../../lib/t15/api';
import type { AssetAnnotationHead } from '../../../../../packages/contracts/generated/AssetAnnotationHead';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';

expect.extend(matchers);
const auth = vi.hoisted(() => ({ entry: {} as { kind: string; session?: Session } }));
vi.mock('../../app/providers', () => ({ useSession: () => ({ entry: auth.entry, logout: vi.fn() }) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1), Q = id(2), U = id(3), O = id(4), O2 = id(5), S = id(6), J = id(7);
const digest = 'a'.repeat(64);
const ontology = (project_id = P, ontology_version_id = O, version_no = 1): OntologyVersion => ({
  project_id, ontology_version_id, version_no, labels: [{ label_id: id(9), name: '物体', color: '#ffffff', shortcut: null, allowed_geometry_types: ['bbox_xyxy'], attributes: [] }], guidelines_markdown: '', allow_out_of_bounds: false,
});
const asset = (n: number, project = P, fixedOntology = O): AssetAnnotationHead => ({
  media: { asset_id: id(10000 + n), asset_revision_id: id(20000 + n), project_id: project, original_name: `image-${n}.png`, original_sha256: digest, canonical_sha256: digest, canonical_width: 20, canonical_height: 20, exif_orientation: 1, original_to_canonical: [1, 0, 0, 0, 1, 0, 0, 0, 1], source_group_id: id(10) },
  head: { ontology_version_id: fixedOntology, annotation_revision_id: id(30000 + n), revision_no: 1, content_hash: digest, completion: 'confirmed_negative', object_count: 0, approved_review_id: id(40000 + n) },
});
const report = { losses: [{ field: 'annotation.attributes', reason: 'not representable in target format' }] };
const zipBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array<number>(18).fill(0)]);
const zipDigest = '8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85';
const artifact = (format = 'native') => ({ export_id: J, format, download_url: `/api/exports/${J}/download`, byte_size: zipBytes.byteLength, object_sha256: zipDigest, loss_report: { losses: [] } });
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type SnapshotItem = { asset_revision_id: string; annotation_revision_id: string; split: string };
type ExcludedItem = { asset_revision_id: string; reason: string };
type RequestBody = { format: string; loss_ack: boolean; operation_id: string; items: SnapshotItem[]; excluded: ExcludedItem[] };
type Call = { path: string; url: URL; method: string; raw: string | null; body: RequestBody | null; headers: Headers };
type Hook = (call: Call) => Response | Promise<Response> | undefined;
let calls: Call[];
let hook: Hook;
let count: number;
let missing: Set<number>;
let incomplete: Set<number>;
let user: ReturnType<typeof userEvent.setup>;
let downloaded: MockInstance;
function writes(suffix: string) { return calls.filter(call => call.method === 'POST' && call.path.endsWith(suffix)); }
function installBoundary() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const raw = typeof init.body === 'string' ? init.body : null;
    const call: Call = { url, path: url.pathname, method: init.method ?? 'GET', raw, body: raw ? JSON.parse(raw) : null, headers: new Headers(init.headers) };
    calls.push(call);
    const intercepted = hook(call); if (intercepted !== undefined) return intercepted;
    const project = call.path.includes(Q) ? Q : P;
    if (call.path === '/api/session') return json(auth.entry.session);
    if (call.path === '/api/projects') return json({ items: [{ project_id: project, name: 'Delivery', description: '', allow_self_review: false, role: auth.entry.session?.project_roles.find(r => r.project_id === project)?.role }], next_cursor: null });
    if (call.path.endsWith('/members')) return json({ items: [{ user_id: U, username: 'delivery-user', role: auth.entry.session?.project_roles.find(r => r.project_id === project)?.role ?? 'viewer' }], next_cursor: null });
    if (call.path.endsWith('/ontologies')) return json({ items: [ontology(project), ontology(project, O2, 2)], next_cursor: null });
    if (call.path.endsWith('/assets') || call.path.endsWith('/annotation-heads')) {
      const offset = Number(call.url.searchParams.get('cursor') ?? 0);
      const fixedOntology = call.url.searchParams.get('ontology_version_id') ?? O;
      const items = Array.from({ length: Math.min(100, count - offset) }, (_, i) => {
        const n = offset + i; const value = asset(n, project, fixedOntology);
        if (missing.has(n)) value.head = null;
        if (incomplete.has(n) && value.head) value.head.completion = 'in_progress';
        return value;
      });
      return json({ items: call.path.endsWith('/assets') ? items.map(item => item.media) : items, next_cursor: offset + items.length < count ? String(offset + items.length) : null });
    }
    if (call.path.endsWith('/annotation')) {
      const n = Number(call.path.split('/')[3].slice(-12)) - 20000;
      if (missing.has(n)) return json({ code: 'ANNOTATION_NOT_FOUND', message: 'unavailable', request_id: id(90), details: null }, 404);
      const value = asset(n, project, call.url.searchParams.get('ontology_version_id') ?? O);
      return json({ annotation_revision_id: value.head!.annotation_revision_id, parent_revision_id: null, revision_no: 1, document: { schema_version: 1, asset_revision_id: value.media.asset_revision_id, ontology_version_id: value.head!.ontology_version_id, coordinate_space: { type: 'canonical_image_pixels', width: 20, height: 20 }, completion: incomplete.has(n) ? 'in_progress' : 'confirmed_negative', objects: [] }, created_at: '2026-10-10T00:00:00Z', created_by: U, content_hash: digest });
    }
    if (call.method === 'POST' && call.path.endsWith('/dataset-versions')) return json({ dataset_version_id: S, manifest_sha256: digest }, 201);
    if (call.method === 'POST' && call.path.endsWith('/exports')) return json({ job_id: J, state: 'queued', format: call.body!.format, loss_report: { losses: [] } }, 202);
    if (call.path === `/api/jobs/${J}`) return json({ job_id: J, kind: 'dataset_export', state: 'succeeded', progress_completed: 1, progress_total: 1, result: artifact(writes('/exports').at(-1)?.body?.format) });
    if (call.path.endsWith('/download')) return new Response(zipBytes.slice(), { headers: { 'content-type': 'application/zip', 'content-length': String(zipBytes.byteLength) } });
    throw new Error(`Unhandled test boundary: ${call.method} ${call.path}`);
  }));
}
beforeEach(() => {
  calls = []; hook = () => undefined; count = 3; missing = new Set(); incomplete = new Set();
  vi.stubGlobal('Blob', BrowserCompatibleBlob);
  vi.stubGlobal('crypto', webcrypto);
  user = userEvent.setup();
  auth.entry = { kind: 'authenticated', session: { user_id: U, username: 'delivery-user', platform_admin: false, project_roles: [{ project_id: P, role: 'admin' }, { project_id: Q, role: 'admin' }] } };
  setCsrfToken('delivery-csrf'); sessionStorage.setItem('weblabel_csrf', 'delivery-csrf');
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return 'blob:delivery-test'; }
    static revokeObjectURL() {}
  });
  downloaded = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  installBoundary();
});
afterEach(() => { cleanup(); setCsrfToken(null); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const readButton = () => screen.getByRole('button', { name: /读取.*标注|浏览.*图片|加载.*摘要/ });
const freezeButton = () => screen.getByRole('button', { name: /冻结|固定所选/ });
const exportButton = () => screen.getByRole('button', { name: /生成导出并检查|检查.*损失.*导出/ });
const downloadButton = () => screen.getByRole('button', { name: /下载数据包|重新下载已有产物/ });
async function open(project = P) {
  const view = render(<Datasets projectId={project} onWorkbench={() => {}} />);
  await screen.findByRole('option', { name: '第 1 版' }); return view;
}
async function browse() {
  await user.selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O);
  await user.click(readButton());
  await screen.findByTestId(`dataset-disposition-${id(20000)}`);
}
function scopeControl(n: number) { return screen.getByTestId(`dataset-disposition-${id(20000 + n)}`); }
async function choose(n: number, scope: 'include' | 'exclude' | 'outside') { await user.selectOptions(scopeControl(n), scope); }
async function nextPage() { await user.click(screen.getByTestId('dataset-next-page')); }
async function bulk(scope: 'include' | 'exclude') { await user.click(screen.getByRole('button', { name: scope === 'include' ? /本页.*纳入|纳入本页|本页.*包含/ : /本页.*排除|排除本页/ })); }
async function readySnapshot() { await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await screen.findByRole('combobox', { name: /导出格式/ }); }
async function startExport() { await userEvent.setup().click(exportButton()); }
async function ack() { await userEvent.setup().click(screen.getByRole('checkbox', { name: /接受.*损失|确认.*损失/ })); await userEvent.setup().click(screen.getByRole('button', { name: /确认损失.*导出/ })); }

it('requires an explicit fixed ontology and does not read revisions while no ontology is chosen', async () => {
  await open(); expect(screen.getByRole('combobox', { name: /类别规范版本/ })).toHaveValue('');
  expect(readButton()).toBeDisabled(); expect(calls.filter(c => c.path.endsWith('/annotation') || c.path.endsWith('/annotation-heads'))).toEqual([]);
});
it('does not automatically include eligible rows or turn incomplete/missing rows into exclusions', async () => {
  missing.add(1); incomplete.add(2); await open(); await browse();
  const control = scopeControl(0);
  if (control instanceof HTMLSelectElement) expect(control).toHaveValue('outside');
  else expect(control).not.toBeChecked();
  await choose(0, 'include');
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: `数据划分 ${id(20000)}` }), 'val');
  await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton());
  await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  expect(writes('/dataset-versions')[0].body).toMatchObject({ items: [{ asset_revision_id: id(20000), annotation_revision_id: id(30000), split: 'val' }], excluded: [] });
});
it('zero included rows cannot create a snapshot even with explicitly excluded rows', async () => {
  await open(); await browse(); for (let n = 0; n < count; n++) await choose(n, 'exclude');
  expect(freezeButton()).toBeDisabled(); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); expect(writes('/dataset-versions')).toEqual([]);
});
it('keeps include, exclude, outside and unbrowsed distinct in the actual snapshot body', async () => {
  count = 150; await open(); await browse(); await choose(0, 'include'); await choose(1, 'exclude'); await choose(2, 'outside');
  await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  const body = writes('/dataset-versions')[0].body!;
  expect(body.items.map(item => item.asset_revision_id)).toEqual([id(20000)]);
  expect(body.excluded.map(item => item.asset_revision_id)).toEqual([id(20001)]);
  expect(body.excluded[0].reason.trim()).not.toBe('');
});
it('browses 1300+ rows without truncation, retaining cross-page choices on back', async () => {
  count = 1301; await open(); await browse(); await choose(0, 'include'); await choose(1, 'exclude');
  // Wait for the specific row, not a label scan of every element on each page.
  const visibleRow = async (n: number) => {
    const control = await screen.findByTestId(`dataset-disposition-${id(20000 + n)}`);
    expect(control).toHaveAccessibleName(`image-${n}.png`);
    return control;
  };
  for (let page = 1; page <= 13; page++) { await nextPage(); await visibleRow(page * 100); }
  await choose(1300, 'include');
  const pageControls = within(screen.getByTestId('dataset-next-page').parentElement!);
  await user.click(pageControls.getByRole('button', { name: '上一页' }));
  await visibleRow(1200); await nextPage(); expect(await visibleRow(1300)).toHaveValue('include');
  await user.click(screen.getByTestId('snapshot-create')); await user.click(screen.getByTestId('snapshot-create')); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  expect(writes('/dataset-versions')[0].body!.items.map(item => item.asset_revision_id)).toEqual([id(20000), id(21300)]);
  expect(writes('/dataset-versions')[0].body!.excluded.map(item => item.asset_revision_id)).toEqual([id(20001)]);
  expect(calls.some(c => c.path.endsWith('/annotation-heads') && c.url.searchParams.get('cursor') === '1300')).toBe(true);
  expect(calls.filter(c => c.path.endsWith('/annotation'))).toEqual([]);
});
it('explicitly plans larger selected scope into real bounded snapshots including exclusions', async () => {
  count = 1099; await open(); await browse();
  for (let page = 0; page < 11; page++) {
    await bulk(page === 0 ? 'exclude' : 'include');
    if (page < 10) await nextPage();
  }
  expect(freezeButton()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '预览整组划分与分批范围' }));
  expect(freezeButton()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '确认整组划分' }));
  await user.click(freezeButton()); expect(writes('/dataset-versions')).toHaveLength(0);
  await user.click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  await user.selectOptions(screen.getByLabelText('当前交付批次'), '1');
  await user.click(freezeButton()); await user.click(freezeButton());
  await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(2));
  expect(writes('/dataset-versions')[1].body!.items).toHaveLength(75);
  expect(new Set(writes('/dataset-versions').flatMap(w => [...w.body!.items, ...w.body!.excluded].map(v => v.asset_revision_id))).size).toBe(1099);
  const first = writes('/dataset-versions')[0].body!;
  expect(first.items.length + first.excluded.length).toBe(1024);
  expect(new Set([...first.items, ...first.excluded].map(v => v.asset_revision_id)).size).toBe(1024);
}, 15000);
it('retries a failed keyset page without losing earlier scope choices', async () => {
  count = 150; let failed = false;
  hook = c => { if (c.path.endsWith('/annotation-heads') && c.url.searchParams.get('cursor') === '100' && !failed) { failed = true; throw new TypeError('page disconnected'); } return undefined; };
  await open(); await browse(); await choose(0, 'include'); await nextPage(); await screen.findByRole('alert');
  await userEvent.setup().click(screen.getByRole('button', { name: /重试.*页|重新.*页|重试.*读取/ })); await screen.findByLabelText(/image-100\.png/);
  await choose(100, 'exclude'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  expect(writes('/dataset-versions')[0].body!.items.map(v => v.asset_revision_id)).toEqual([id(20000)]);
  expect(writes('/dataset-versions')[0].body!.excluded.map(v => v.asset_revision_id)).toEqual([id(20100)]);
});

it.each(['snapshot', 'export'] as const)('an ambiguous %s is replayed only explicitly with the exact original body', async kind => {
  const suffix = kind === 'snapshot' ? '/dataset-versions' : '/exports'; let failed = false;
  hook = c => { if (c.method === 'POST' && c.path.endsWith(suffix) && !failed) { failed = true; throw new TypeError('acknowledgement lost'); } return undefined; };
  if (kind === 'snapshot') { await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); } else { await readySnapshot(); await startExport(); }
  await screen.findByRole('alert'); expect(writes(suffix)).toHaveLength(1);
  const original = writes(suffix)[0];
  expect(kind === 'snapshot' ? freezeButton() : exportButton()).toBeDisabled();
  await userEvent.setup().click(screen.getByRole('button', { name: /重放.*同一|重试.*原.*请求/ }));
  await waitFor(() => expect(writes(suffix)).toHaveLength(2));
  expect(writes(suffix)[1].path).toBe(original.path); expect(writes(suffix)[1].raw).toBe(original.raw);
  expect(writes(suffix)[1].headers.get('x-csrf-token')).toBe('delivery-csrf');
});
it('a known job with a failed GET is retried by GET only, never another export POST', async () => {
  let failed = false; hook = c => { if (c.path === `/api/jobs/${J}` && !failed) { failed = true; throw new TypeError('read disconnected'); } return undefined; };
  await readySnapshot(); await startExport(); await screen.findByRole('alert', {}, { timeout: 3000 });
  await userEvent.setup().click(screen.getByRole('button', { name: /重新检查.*状态|重试.*作业|检查.*已有.*作业/ }));
  await screen.findByRole('button', { name: /下载数据包|重新下载已有产物/ }, { timeout: 3000 });
  expect(writes('/exports')).toHaveLength(1); expect(calls.filter(c => c.path === `/api/jobs/${J}`).map(c => c.method)).toEqual(['GET', 'GET']);
});
it('C1 details.loss_report permits only a fresh explicitly acknowledged intent after definitive 422', async () => {
  hook = c => c.method === 'POST' && c.path.endsWith('/exports') && !c.body!.loss_ack ? json({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: id(91), details: { loss_report: report } }, 422) : undefined;
  await readySnapshot(); await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /导出格式/ }), 'yolo'); await startExport();
  await screen.findByRole('region', { name: /损失报告/ }).catch(() => screen.findByRole('heading', { name: /信息损失|实际损失报告/ }));
  expect(writes('/exports')).toHaveLength(1); await ack(); await waitFor(() => expect(writes('/exports')).toHaveLength(2));
  const [first, second] = writes('/exports'); expect(second.body).toMatchObject({ format: 'yolo', loss_ack: true });
  expect(second.body!.operation_id).not.toBe(first.body!.operation_id); expect(second.path).toBe(first.path);
});
it.each([undefined, null, {}, { losses: 'invalid' }, { losses: [{ field: '', reason: 'x' }] }, { losses: [{ field: 'x', reason: 1 }] }, { losses: [], unexpected: true }, { losses: [{ field: 'x', reason: 'y', unexpected: true }] }])('missing/malformed C1 loss evidence %j never unlocks acknowledgement', async loss_report => {
  hook = c => c.method === 'POST' && c.path.endsWith('/exports') ? json({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: id(92), details: { loss_report } }, 422) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert');
  const confirm = screen.queryByRole('button', { name: /确认损失.*导出/ }); if (confirm) expect(confirm).toBeDisabled();
  const checkbox = screen.queryByRole('checkbox', { name: /接受.*损失|确认.*损失/ }); if (checkbox) { await userEvent.setup().click(checkbox); if (confirm) await userEvent.setup().click(confirm); }
  expect(writes('/exports')).toHaveLength(1);
});
it.each([400, 500])('LOSS_ACK_REQUIRED with HTTP %i is not definitive permission for a new acknowledged write', async status => {
  hook = c => c.method === 'POST' && c.path.endsWith('/exports') ? json({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: id(93), details: { loss_report: report } }, status) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert');
  const checkbox = screen.queryByRole('checkbox', { name: /接受.*损失|确认.*损失/ }); if (checkbox) await userEvent.setup().click(checkbox);
  const confirm = screen.queryByRole('button', { name: /确认损失.*导出/ }); if (confirm) { expect(confirm).toBeDisabled(); await userEvent.setup().click(confirm); }
  expect(writes('/exports')).toHaveLength(1);
});
it.each(['format', 'snapshot'] as const)('loss acknowledgement follows the exact %s binding without modifying frozen scope', async binding => {
  hook = c => c.method === 'POST' && c.path.endsWith('/exports') ? json({ code: 'LOSS_ACK_REQUIRED', message: 'loss', request_id: id(94), details: { loss_report: report } }, 422) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert');
  await userEvent.setup().click(screen.getByRole('checkbox', { name: /接受.*损失|确认.*损失/ }));
  if (binding === 'format') await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /导出格式/ }), 'coco'); else await choose(1, 'include');
  if (binding === 'snapshot') { expect(scopeControl(1)).toBeDisabled(); expect(screen.getByRole('checkbox', { name: /接受.*损失|确认.*损失/ })).toBeChecked(); expect(writes('/dataset-versions')).toHaveLength(1); return; }
  expect(screen.queryByRole('checkbox', { name: /接受.*损失|确认.*损失/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /确认损失.*导出/ })).not.toBeInTheDocument(); expect(writes('/exports')).toHaveLength(1);
});
it.each([undefined, { losses: [{ field: 'x', reason: '' }] }])('malformed successful job report %j does not make an artifact downloadable', async loss_report => {
  hook = c => c.path === `/api/jobs/${J}` ? json({ job_id: J, kind: 'dataset_export', state: 'succeeded', progress_completed: 1, progress_total: 1, result: { ...artifact(), loss_report } }) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(screen.queryByRole('button', { name: /下载数据包|重新下载已有产物/ })).not.toBeInTheDocument(); expect(downloaded).not.toHaveBeenCalled();
});
it('download retry fetches the same known artifact without snapshot or export writes', async () => {
  let failed = false; hook = c => { if (c.path.endsWith('/download') && !failed) { failed = true; throw new TypeError('download disconnected'); } return undefined; };
  await readySnapshot(); await startExport(); await screen.findByRole('button', { name: /下载数据包|重新下载已有产物/ }, { timeout: 3000 });
  await userEvent.setup().click(downloadButton()); await screen.findByRole('alert'); await userEvent.setup().click(downloadButton());
  await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
  expect(calls.filter(c => c.path.endsWith('/download')).map(c => [c.method, c.path])).toEqual([['GET', `/api/exports/${J}/download`], ['GET', `/api/exports/${J}/download`]]);
  expect(writes('/exports')).toHaveLength(1); expect(writes('/dataset-versions')).toHaveLength(1);
});

it.each(['viewer', 'reviewer'])('actual %s membership can freeze and export without requiring platform admin', async role => {
  auth.entry.session!.project_roles = [{ project_id: P, role }]; await readySnapshot(); await startExport();
  await screen.findByRole('button', { name: /下载数据包|重新下载已有产物/ }, { timeout: 3000 }); expect(writes('/dataset-versions')).toHaveLength(1); expect(writes('/exports')).toHaveLength(1);
});
it('platform admin without actual project membership cannot submit a snapshot', async () => {
  auth.entry.session!.platform_admin = true; auth.entry.session!.project_roles = [];
  await open(); await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O);
  if (!readButton().hasAttribute('disabled')) { await userEvent.setup().click(readButton()); await screen.findByLabelText(/image-0\.png/); await choose(0, 'include'); const freeze = screen.queryByRole('button', { name: /冻结|固定所选/ }); if (freeze) await userEvent.setup().click(freeze); }
  expect(writes('/dataset-versions')).toEqual([]);
});
it.each(['project', 'ontology', 'auth'] as const)('late revision reads cannot repopulate the new %s scope', async scope => {
  const pending = deferred<Response>(); let captured = false; let keyset = false;
  hook = c => { if ((c.path.endsWith('/annotation') || c.path.endsWith('/annotation-heads')) && !captured) { captured = true; keyset = c.path.endsWith('/annotation-heads'); return pending.promise; } };
  const view = await open(); await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O); await userEvent.setup().click(readButton());
  await waitFor(() => expect(captured).toBe(true));
  if (scope === 'project') view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />);
  if (scope === 'ontology') await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O2);
  if (scope === 'auth') { auth.entry = { kind: 'login' }; act(() => setCsrfToken(null)); view.rerender(<Datasets projectId={P} onWorkbench={() => {}} />); }
  await act(async () => { pending.resolve(json(keyset ? { items: [asset(0)], next_cursor: null } : { annotation_revision_id: id(30000), document: { completion: 'confirmed_negative' } })); });
  expect(screen.queryByLabelText(/image-0\.png/)).not.toBeInTheDocument();
  expect(writes('/dataset-versions')).toEqual([]);
});
it.each(['project', 'ontology', 'auth', 'unmount'] as const)('a late snapshot acknowledgement cannot unlock export after %s invalidation', async scope => {
  const pending = deferred<Response>(); hook = c => c.method === 'POST' && c.path.endsWith('/dataset-versions') ? pending.promise : undefined;
  const view = await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  if (scope === 'project') view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />);
  if (scope === 'ontology') await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O2);
  if (scope === 'auth') { act(() => setCsrfToken('other-session')); auth.entry.session = { ...auth.entry.session!, user_id: id(11) }; view.rerender(<Datasets projectId={P} onWorkbench={() => {}} />); }
  if (scope === 'unmount') view.unmount();
  await act(async () => { pending.resolve(json({ dataset_version_id: S, manifest_sha256: digest }, 201)); });
  expect(screen.queryByRole('button', { name: /生成导出并检查|检查.*损失.*导出/ })).not.toBeInTheDocument(); expect(writes('/exports')).toEqual([]);
});
it('stale finally must not release a newer operation single-flight guard', async () => {
  const old = deferred<Response>(), current = deferred<Response>(); let index = 0;
  hook = c => c.method === 'POST' && c.path.endsWith('/dataset-versions') ? (++index === 1 ? old.promise : current.promise) : undefined;
  const view = await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton());
  view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />); await screen.findByRole('option', { name: '第 1 版' }); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton());
  await waitFor(() => expect(index).toBe(2)); await act(async () => { old.resolve(json({ dataset_version_id: S }, 201)); });
  expect(freezeButton()).toBeDisabled(); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); expect(index).toBe(2);
  await act(async () => { current.resolve(json({ dataset_version_id: id(12), manifest_sha256: digest }, 201)); });
});
it('auth invalidation during a known job read blocks late artifact publication and download', async () => {
  const pending = deferred<Response>(); hook = c => c.path === `/api/jobs/${J}` ? pending.promise : undefined;
  await readySnapshot(); await startExport(); await waitFor(() => expect(calls.some(c => c.path === `/api/jobs/${J}`)).toBe(true), { timeout: 3000 });
  act(() => setCsrfToken(null)); await act(async () => { pending.resolve(json({ job_id: J, kind: 'dataset_export', state: 'succeeded', progress_completed: 1, progress_total: 1, result: artifact() })); });
  expect(screen.queryByRole('button', { name: /下载数据包|重新下载已有产物/ })).not.toBeInTheDocument(); expect(downloaded).not.toHaveBeenCalled();
});
it('a pending artifact GET cannot trigger browser download after auth changes', async () => {
  const pending = deferred<Response>(); hook = c => c.path.endsWith('/download') ? pending.promise : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('button', { name: /下载数据包|重新下载已有产物/ }, { timeout: 3000 }); await userEvent.setup().click(downloadButton());
  act(() => setCsrfToken(null)); await act(async () => { pending.resolve(new Response(zipBytes.slice(), { headers: { 'content-type': 'application/zip', 'content-length': String(zipBytes.byteLength) } })); });
  expect(downloaded).not.toHaveBeenCalled(); expect(writes('/exports')).toHaveLength(1);
});

it.each(['project', 'ontology', 'auth', 'unmount'] as const)('late export POST acknowledgement cannot begin job reads after %s invalidation', async scope => {
  const pending = deferred<Response>(); hook = c => c.method === 'POST' && c.path.endsWith('/exports') ? pending.promise : undefined;
  const view = await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await screen.findByRole('combobox', { name: /导出格式/ }); await startExport();
  await waitFor(() => expect(writes('/exports')).toHaveLength(1));
  if (scope === 'project') view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />);
  if (scope === 'ontology') await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /类别规范版本/ }), O2);
  if (scope === 'auth') act(() => setCsrfToken(null));
  if (scope === 'unmount') view.unmount();
  await act(async () => { pending.resolve(json({ job_id: J, state: 'queued', format: 'native', loss_report: { losses: [] } }, 202)); });
  // Exercise the baseline poll interval; a cancelled write must not start any follow-on read.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(calls.filter(c => c.path === `/api/jobs/${J}`)).toEqual([]); expect(downloaded).not.toHaveBeenCalled();
});
it.each(['project', 'format', 'unmount'] as const)('pending artifact download is discarded when %s scope changes', async scope => {
  const pending = deferred<Response>(); hook = c => c.path.endsWith('/download') ? pending.promise : undefined;
  const view = await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await screen.findByRole('combobox', { name: /导出格式/ }); await startExport();
  await screen.findByRole('button', { name: /下载数据包|重新下载已有产物/ }, { timeout: 3000 }); await userEvent.setup().click(downloadButton());
  if (scope === 'project') view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />);
  if (scope === 'format') await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /导出格式/ }), 'coco');
  if (scope === 'unmount') view.unmount();
  await act(async () => { pending.resolve(new Response(zipBytes.slice(), { headers: { 'content-type': 'application/zip', 'content-length': String(zipBytes.byteLength) } })); });
  expect(downloaded).not.toHaveBeenCalled(); expect(writes('/exports')).toHaveLength(1);
});
it('auth epoch change removes replay permission for an ambiguous old actor operation', async () => {
  hook = c => { if (c.method === 'POST' && c.path.endsWith('/dataset-versions')) throw new TypeError('lost acknowledgement'); return undefined; };
  const view = await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await screen.findByRole('alert');
  auth.entry.session = { ...auth.entry.session!, user_id: id(11) }; act(() => setCsrfToken('other-actor')); view.rerender(<Datasets projectId={P} onWorkbench={() => {}} />);
  const replay = screen.queryByRole('button', { name: /重放.*同一|重试.*原.*请求/ });
  if (replay) { expect(replay).toBeDisabled(); await userEvent.setup().click(replay); }
  expect(writes('/dataset-versions')).toHaveLength(1);
});
it('rejects a successful job result whose export identity belongs to another job', async () => {
  const otherJob = id(8);
  hook = c => c.path === `/api/jobs/${J}` ? json({ job_id: J, kind: 'dataset_export', state: 'succeeded', progress_completed: 1, progress_total: 1, result: { ...artifact(), export_id: otherJob, download_url: `/api/exports/${otherJob}/download` } }) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert', {}, { timeout: 3000 });
  expect(screen.queryByRole('button', { name: /下载数据包|重新下载已有产物/ })).not.toBeInTheDocument();
  expect(calls.filter(c => c.path.endsWith('/download'))).toEqual([]); expect(downloaded).not.toHaveBeenCalled();
});

it.each(['snapshot', 'export'] as const)('preserves the exact %s packet through 5xx and malformed success', async kind => {
  const suffix = kind === 'snapshot' ? '/dataset-versions' : '/exports'; let attempts = 0;
  hook = call => { if (call.method === 'POST' && call.path.endsWith(suffix)) { attempts++; if (attempts === 1) return json({ code: 'UNAVAILABLE' }, 503); if (attempts === 2) return json({}); } };
  if (kind === 'snapshot') { await open(); await browse(); await choose(0, 'include'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); } else { await readySnapshot(); await startExport(); }
  await screen.findByRole('alert');
  await userEvent.setup().click(screen.getByTestId(kind === 'snapshot' ? 'snapshot-retry' : 'export-retry'));
  await waitFor(() => expect(writes(suffix)).toHaveLength(2));
  await waitFor(() => expect(screen.getByTestId(kind === 'snapshot' ? 'snapshot-retry' : 'export-retry')).toBeEnabled());
  expect(kind === 'snapshot' ? freezeButton() : exportButton()).toBeDisabled();
  await userEvent.setup().click(screen.getByTestId(kind === 'snapshot' ? 'snapshot-retry' : 'export-retry'));
  await waitFor(() => expect(writes(suffix)).toHaveLength(3));
  expect(writes(suffix).map(call => call.raw)).toEqual(Array(3).fill(writes(suffix)[0].raw));
});
it('a later 422 never authorizes a changed packet after an unknown original outcome', async () => {
  let attempts = 0; hook = call => { if (call.method === 'POST' && call.path.endsWith('/exports')) { if (++attempts === 1) throw new TypeError('ack lost'); return json({ code: 'LOSS_ACK_REQUIRED', request_id: id(96), details: { loss_report: report } }, 422); } };
  await readySnapshot(); await startExport(); await screen.findByRole('alert');
  await userEvent.setup().click(screen.getByTestId('export-retry')); await waitFor(() => expect(writes('/exports')).toHaveLength(2));
  expect(screen.queryByTestId('export-confirm')).not.toBeInTheDocument(); expect(screen.queryByTestId('export-loss-ack')).not.toBeInTheDocument();
  expect(writes('/exports')[1].raw).toBe(writes('/exports')[0].raw);
});
it('empty required-loss evidence never authorizes acknowledgement', async () => {
  hook = call => call.method === 'POST' && call.path.endsWith('/exports') ? json({ code: 'LOSS_ACK_REQUIRED', request_id: id(97), details: { loss_report: { losses: [] } } }, 422) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert');
  expect(screen.queryByTestId('export-loss-ack')).not.toBeInTheDocument(); expect(screen.queryByTestId('export-confirm')).not.toBeInTheDocument(); expect(writes('/exports')).toHaveLength(1);
});
it.each(['unprocessed', 'unapproved'] as const)('%s rows cannot be individually or atomically bulk included', async readiness => {
  hook = call => { if (call.path.endsWith('/annotation-heads')) { const rows = [asset(0), asset(1)]; if (readiness === 'unprocessed') rows[1].head!.completion = 'unprocessed'; else rows[1].head!.approved_review_id = null; return json({ items: rows, next_cursor: null }); } };
  await open(); await browse(); expect(within(scopeControl(1)).getByRole('option', { name: /纳入/ })).toBeDisabled();
  await bulk('include'); await screen.findByRole('alert'); expect(scopeControl(0)).toHaveValue('outside'); expect(freezeButton()).toBeDisabled();
  await choose(0, 'include'); await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: `数据划分 ${id(20000)}` }), 'test');
  await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  expect(writes('/dataset-versions')[0].body).toMatchObject({ items: [{ asset_revision_id: id(20000), annotation_revision_id: id(30000), split: 'test' }], excluded: [] });
});
it.each([{ download_url: 'https://other.invalid/evil.zip' }, { format: 'coco' }, { byte_size: -1 }, { byte_size: 100663297 }, { object_sha256: 'not-a-sha256' }])('rejects inconsistent artifact %j before download', async corruption => {
  hook = call => call.path === `/api/jobs/${J}` ? json({ job_id: J, kind: 'dataset_export', state: 'succeeded', result: { ...artifact(), ...corruption } }) : undefined;
  await readySnapshot(); await startExport(); await screen.findByRole('alert'); expect(screen.queryByTestId('export-download')).not.toBeInTheDocument(); expect(calls.filter(call => call.path.endsWith('/download'))).toEqual([]);
});
it.each(['bytes', 'hash'] as const)('rejects actual ZIP %s inconsistent with the artifact', async corruption => {
  hook = call => { if (call.path.endsWith('/download')) { const bytes = corruption === 'bytes' ? zipBytes.slice(0, -1) : zipBytes.slice(); if (corruption === 'hash') bytes[21] = 1; return new Response(bytes, { headers: { 'content-type': 'application/zip' } }); } };
  await readySnapshot(); await startExport(); await screen.findByTestId('export-download'); await userEvent.setup().click(downloadButton()); await screen.findByRole('alert');
  expect(downloaded).not.toHaveBeenCalled(); expect(writes('/exports')).toHaveLength(1); expect(screen.getByTestId('export-download')).toBeEnabled();
});
it('a synchronous double activation sends one snapshot packet', async () => {
  const pending = deferred<Response>(); hook = call => call.method === 'POST' && call.path.endsWith('/dataset-versions') ? pending.promise : undefined;
  await open(); await browse(); await choose(0, 'include'); await user.click(freezeButton()); act(() => { freezeButton().click(); freezeButton().click(); }); expect(writes('/dataset-versions')).toHaveLength(1);
  await act(async () => { pending.resolve(json({ dataset_version_id: S, manifest_sha256: digest }, 201)); });
});
it('returning to the original actor/project restores the exact pending scope and packet', async () => {
  let failed = false; hook = call => { if (call.method === 'POST' && call.path.endsWith('/dataset-versions') && !failed) { failed = true; throw new TypeError('ack lost'); } return undefined; };
  const view = await open(); await browse(); await choose(0, 'include'); await choose(1, 'exclude'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await screen.findByRole('alert');
  const original = writes('/dataset-versions')[0].raw;
  view.rerender(<Datasets projectId={Q} onWorkbench={() => {}} />); await screen.findByRole('option', { name: '第 1 版' }); expect(screen.queryByTestId('snapshot-retry')).not.toBeInTheDocument();
  view.rerender(<Datasets projectId={P} onWorkbench={() => {}} />); await screen.findByLabelText(/image-0\.png/); expect(scopeControl(0)).toHaveValue('include'); expect(scopeControl(1)).toHaveValue('exclude');
  await userEvent.setup().click(screen.getByTestId('snapshot-retry')); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(2)); expect(writes('/dataset-versions')[1].raw).toBe(original);
});
it('explicit exclusions require a visible nonblank reason and preserve the supplied reason', async () => {
  await open(); await browse(); await choose(0, 'include'); await choose(1, 'exclude');
  const reason = screen.getByRole('textbox', { name: `排除理由 ${id(20001)}` }); await userEvent.setup().clear(reason); expect(freezeButton()).toBeDisabled();
  await userEvent.setup().type(reason, 'duplicate acquisition'); await userEvent.setup().click(freezeButton()); await userEvent.setup().click(freezeButton()); await waitFor(() => expect(writes('/dataset-versions')).toHaveLength(1));
  expect(writes('/dataset-versions')[0].body!.excluded).toEqual([{ asset_revision_id: id(20001), reason: 'duplicate acquisition' }]);
});
it.each(['actor', 'epoch'] as const)('isolates an old unknown packet while the new %s publishes its own scope despite late retry failure', async transition => {
  const old = deferred<Response>(), newer = deferred<Response>(); let posts = 0;
  hook = call => { if (call.method === 'POST' && call.path.endsWith('/dataset-versions')) { posts++; if (posts === 1) throw new TypeError('first acknowledgement lost'); return posts === 2 ? old.promise : newer.promise; } return undefined; };
  const view = await open(); await browse(); await choose(0, 'include'); await user.click(freezeButton()); await user.click(freezeButton()); await screen.findByRole('alert');
  const original = writes('/dataset-versions')[0]; await user.click(screen.getByTestId('snapshot-retry')); await waitFor(() => expect(posts).toBe(2));
  if (transition === 'actor') auth.entry.session = { ...auth.entry.session!, user_id: id(11) };
  act(() => setCsrfToken('new-authorized-session')); view.rerender(<Datasets projectId={P} onWorkbench={() => {}} />);
  await screen.findByRole('option', { name: '第 1 版' }); expect(screen.queryByTestId('snapshot-retry')).not.toBeInTheDocument();
  await browse(); await choose(1, 'include'); await user.click(freezeButton()); await user.click(freezeButton()); await waitFor(() => expect(posts).toBe(3));
  await act(async () => { old.reject(new TypeError('old retry acknowledgement lost')); });
  expect(freezeButton()).toBeDisabled(); expect(screen.queryByTestId('export-start')).not.toBeInTheDocument(); expect(posts).toBe(3);
  await act(async () => { newer.resolve(json({ dataset_version_id: id(12), manifest_sha256: digest }, 201)); });
  await screen.findByTestId('export-start');
  const packets = writes('/dataset-versions'); expect(packets[1].raw).toBe(original.raw); expect(packets[1].headers.get('x-csrf-token')).toBe('delivery-csrf');
  expect(packets[2].headers.get('x-csrf-token')).toBe('new-authorized-session'); expect(packets[2].body!.operation_id).not.toBe(original.body!.operation_id);
  expect(packets[2].body!.items.map(item => item.asset_revision_id)).toEqual([id(20001)]); expect(packets[2].body!.excluded).toEqual([]);
  await startExport(); await waitFor(() => expect(writes('/exports')).toHaveLength(1)); expect(writes('/exports')[0].path).toBe(`/api/dataset-versions/${id(12)}/exports`);
});
it('a late unknown result after an ontology change exposes explicit original-context recovery, never a new packet', async () => {
  const pending = deferred<Response>(); let posts = 0;
  hook = call => { if (call.method === 'POST' && call.path.endsWith('/dataset-versions') && ++posts === 1) return pending.promise; return undefined; };
  await open(); await browse(); await choose(0, 'include'); await user.click(freezeButton()); await user.click(freezeButton()); await waitFor(() => expect(posts).toBe(1));
  const original = writes('/dataset-versions')[0].raw;
  await user.selectOptions(screen.getByTestId('dataset-ontology'), O2);
  await act(async () => { pending.reject(new TypeError('ack lost after scope change')); });
  await screen.findByTestId('dataset-restore-pending-scope'); expect(screen.getByTestId('snapshot-retry')).toBeDisabled(); expect(readButton()).toBeDisabled(); expect(posts).toBe(1);
  await user.click(screen.getByTestId('dataset-restore-pending-scope')); expect(screen.getByTestId('dataset-ontology')).toHaveValue(O); expect(scopeControl(0)).toHaveValue('include');
  await user.click(screen.getByTestId('snapshot-retry')); await waitFor(() => expect(posts).toBe(2)); expect(writes('/dataset-versions')[1].raw).toBe(original);
});
;
