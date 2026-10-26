import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { useSession } from '../../app/providers';
import { api, ApiFailure, saveAuthorizationEpoch, subscribeSaveAuthorization } from '../../lib/t15/api';
import { LossReportView } from '../import-export/LossReportView';
import { failureText, isAmbiguous, type LossReport } from '../import-export/loss-report';
import type { AssetAnnotationHead } from '../../../../../packages/contracts/generated/AssetAnnotationHead';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';

import { planDelivery } from './delivery-plan';
import { CAP, uuid, hash, object, eligible, strictReport, readArtifact, type Format, type Artifact } from './delivery-protocol';
import '../projects/project-delivery.css';
export type DeliveryTarget = { projectId: string; assetRevisionId: string; ontologyVersionId: string; annotationRevisionId: string | null; mode: 'workbench' | 'review' };
type Choice = { disposition: 'include' | 'exclude' | 'outside'; split: 'train' | 'val' | 'test'; reason: string; row: AssetAnnotationHead };
type Page = { cursor: string | null; items: AssetAnnotationHead[]; next: string | null };
type Intent = { readonly scope: string; readonly kind: 'snapshot' | 'export'; readonly path: string; readonly body: string; uncertain: boolean; sending: boolean; view?: { base: string; ontology: string; format: Format; pages: Page[]; pageIndex: number; choices: Map<string, Choice>; snapshot: string; revision: number; plan?: Awaited<ReturnType<typeof planDelivery>> | null; batch?: number; batchSnapshots?: Record<number, string>; planConfirmed?: boolean } };

export function Datasets({ projectId, onWorkbench }: { projectId: string; onWorkbench: (target?: DeliveryTarget) => void }) {
  const { entry } = useSession();
  const epoch = useSyncExternalStore(subscribeSaveAuthorization, saveAuthorizationEpoch, saveAuthorizationEpoch);
  const session = entry.kind === 'authenticated' ? entry.session : null;
  const member = Boolean(session?.project_roles.some(role => role.project_id === projectId));
  const base = JSON.stringify([session?.user_id ?? null, projectId, epoch, member]);
  // Retain uncertain original packets across view changes; never replay under a new actor or scope.
  const retained = useRef<Intent[]>([]);
  const [, refreshRetained] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onRetainedChanged = useCallback(() => { if (mounted.current) refreshRetained(value => value + 1); }, []);
  return <DatasetDelivery key={base} projectId={projectId} onWorkbench={onWorkbench} base={base} epoch={epoch} member={member} retained={retained} onRetainedChanged={onRetainedChanged} />;
}

function DatasetDelivery({ projectId, onWorkbench, base, epoch, member, retained, onRetainedChanged }: { projectId: string; onWorkbench: (target?: DeliveryTarget) => void; base: string; epoch: number; member: boolean; retained: MutableRefObject<Intent[]>; onRetainedChanged: () => void }) {
  const restored = useRef(retained.current.find(intent => intent.uncertain && intent.view?.base === base)?.view).current;
  const [ontologies, setOntologies] = useState<OntologyVersion[]>([]);
  const [ontology, setOntology] = useState(restored?.ontology ?? '');
  const [format, setFormat] = useState<Format>(restored?.format ?? 'native');
  const [pages, setPages] = useState<Page[]>(restored?.pages ?? []);
  const [pageIndex, setPageIndex] = useState(restored?.pageIndex ?? 0);
  const [failedPage, setFailedPage] = useState<{ cursor: string | null; index: number } | null>(null);
  const [choices, setChoices] = useState<Map<string, Choice>>(() => restored?.choices ?? new Map());
  const [snapshot, setSnapshot] = useState(restored?.snapshot ?? '');
  const [job, setJob] = useState<{ id: string; scope: string; format: Format; state: string } | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loss, setLoss] = useState<{ report: LossReport; scope: string; snapshot: string; format: Format } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seed, setSeed] = useState(restored?.plan?.seed ?? '17');
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof planDelivery>> | null>(restored?.plan ?? null);
  const [batch, setBatch] = useState(restored?.batch ?? 0);
  const [freezeConfirmed, setFreezeConfirmed] = useState(false);
  const [planConfirmed, setPlanConfirmed] = useState(restored?.planConfirmed ?? false);
  const [batchSnapshots, setBatchSnapshots] = useState<Record<number, string>>(restored?.batchSnapshots ?? {});
  const [, redraw] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const revision = useRef(restored?.revision ?? 0);
  const live = useRef({ ontology, format, choices, snapshot }); live.current = { ontology, format, choices, snapshot };
  const flight = useRef<symbol | null>(null);
  const scope = () => JSON.stringify([base, live.current.ontology, live.current.format, revision.current]);
  const current = (fixed: string) => mounted.current && member && saveAuthorizationEpoch() === epoch && scope() === fixed;
  const unresolved = () => retained.current.find(intent => intent.uncertain && !intent.sending && intent.view?.base === base);
  const canEdit = () => current(scope()) && !unresolved();
  function begin(fixed: string): symbol | null {
    if (!current(fixed) || flight.current) return null;
    const token = Symbol(); flight.current = token; setBusy(true); setError(''); return token;
  }
  function end(token: symbol, fixed: string) {
    if (flight.current === token && current(fixed)) { flight.current = null; setBusy(false); redraw(value => value + 1); }
  }
  function revoke(includeSnapshot: boolean) {
    setFreezeConfirmed(false);
    revision.current++; flight.current = null; setBusy(false); setError(''); setJob(null); setArtifact(null); setLoss(null); setAck(false);
    if (includeSnapshot) { live.current.snapshot = ''; setSnapshot(''); }
  }
  useEffect(() => {
    mounted.current = true; heading.current?.focus();
    let active = true;
    void api.ontologies(projectId).then(result => { if (active && saveAuthorizationEpoch() === epoch) setOntologies(result.items.filter(value => value.project_id === projectId)); }).catch(reason => { if (active && saveAuthorizationEpoch() === epoch) setError(failureText(reason)); });
    return () => { active = false; mounted.current = false; flight.current = null; };
  }, [projectId, epoch]);

  async function loadPage(cursor: string | null, index: number) {
    const fixed = scope(); if (!canEdit() || !live.current.ontology) return;
    const token = begin(fixed); if (!token) return;
    try {
      const page = await api.projectAnnotationHeads(projectId, live.current.ontology, cursor);
      if (!current(fixed)) return;
      if (page.items.some(row => row.media.project_id !== projectId || (row.head && row.head.ontology_version_id !== live.current.ontology)) || (page.next_cursor !== null && (page.next_cursor === cursor || pages.some(value => value.cursor === page.next_cursor)))) throw new Error('分页摘要范围无效。');
      setPages(all => [...all.slice(0, index), { cursor, items: page.items, next: page.next_cursor }]); setPageIndex(index); setFailedPage(null);
    } catch (reason) { if (current(fixed)) { setFailedPage({ cursor, index }); setError(failureText(reason)); } }
    finally { end(token, fixed); }
  }
  const changeChoices = useCallback((rows: AssetAnnotationHead[], disposition?: Choice['disposition'], split?: Choice['split'], reason?: string) => {
    if (live.current.snapshot && !plan) return;
    if (!canEdit() || flight.current || Object.keys(batchSnapshots).length > 0) return;
    const next = new Map(live.current.choices);
    for (const row of rows) {
      if (disposition === 'include' && !eligible(row, live.current.ontology)) { setError('本页包含未完成或未经审批的标注，不能纳入。'); return; }
      const previous = next.get(row.media.asset_revision_id) ?? { disposition: 'outside', split: 'train', reason: 'user_excluded', row };
      next.set(row.media.asset_revision_id, { ...previous, row, ...(disposition ? { disposition } : {}), ...(split ? { split } : {}), ...(reason !== undefined ? { reason } : {}) });
    }
    if (split) { const groups = new Set(rows.map(r => r.media.source_group_id)); for (const [id, c] of next) if (groups.has(c.row.media.source_group_id)) next.set(id, { ...c, split }); }
    setPlan(null);
    revoke(true); live.current.choices = next; setChoices(next);
  }, [base, epoch, member, retained, batchSnapshots, plan]);
  async function poll(known: NonNullable<typeof job>) {
    const token = begin(known.scope); if (!token) return;
    try {
      while (current(known.scope)) {
        const status = object(await api.request<unknown>(`/api/jobs/${known.id}`));
        if (!current(known.scope)) return;
        if (status.job_id !== known.id || status.kind !== 'dataset_export' || !['queued', 'running', 'succeeded', 'failed'].includes(String(status.state))) throw new Error('作业响应身份或状态无效。');
        setJob({ ...known, state: String(status.state) });
        if (status.state === 'succeeded') { const result = readArtifact(status.result, known.id, known.format); setArtifact(result); setLoss(null); setAck(false); return; }
        if (status.state === 'failed') throw new Error(`导出作业失败：${String(object(status.result).code ?? 'EXPORT_FAILED')}`);
        await new Promise<void>(resolve => setTimeout(resolve, 500)); if (!current(known.scope)) return;
      }
    } catch (reason) { if (current(known.scope)) setError(`已有作业保留，仅重新检查状态。${failureText(reason)}`); }
    finally { end(token, known.scope); }
  }
  async function send(intent: Intent) {
    const token = begin(intent.scope); if (!token) return;
    const wasUnknown = intent.uncertain;
    intent.view ??= { base, ontology: live.current.ontology, format: live.current.format, pages: [...pages], pageIndex, choices: new Map(live.current.choices), snapshot: live.current.snapshot, revision: revision.current, plan, batch, batchSnapshots: { ...batchSnapshots }, planConfirmed };
    intent.sending = true; intent.uncertain = true;
    if (!retained.current.includes(intent)) retained.current.push(intent);
    let known: NonNullable<typeof job> | null = null;
    try {
      const response = object(await api.request<unknown>(intent.path, { method: 'POST', body: intent.body }));
      if (intent.kind === 'snapshot') {
        if (!uuid(response.dataset_version_id) || !hash(response.manifest_sha256)) throw new Error('快照确认响应无效。');
        intent.uncertain = false;
        if (!current(intent.scope)) return;
        live.current.snapshot = response.dataset_version_id; setSnapshot(response.dataset_version_id); setLoss(null); setAck(false);
        if (plan) setBatchSnapshots(old => ({ ...old, [batch]: String(response.dataset_version_id) }));
      } else {
        const payload = JSON.parse(intent.body) as { format: Format };
        if (!uuid(response.job_id) || !['queued', 'running', 'succeeded', 'failed'].includes(String(response.state)) || response.format !== payload.format || !strictReport(response.loss_report)) throw new Error('导出确认响应无效。');
        intent.uncertain = false;
        if (!current(intent.scope)) return;
        known = { id: response.job_id, scope: intent.scope, format: payload.format, state: String(response.state) }; setJob(known); setLoss(null); setAck(false);
      }
    } catch (reason) {
      intent.uncertain = wasUnknown || isAmbiguous(reason);
      if (!current(intent.scope)) return;
      if (!wasUnknown && reason instanceof ApiFailure && reason.status === 422 && reason.code === 'LOSS_ACK_REQUIRED' && intent.kind === 'export') {
        const report = strictReport(reason.details?.loss_report);
        if (report && report.losses.length > 0 && uuid(reason.request_id)) setLoss({ report, scope: intent.scope, snapshot: live.current.snapshot, format: live.current.format });
        else setLoss(null);
        setAck(false); setError(report?.losses.length ? '请阅读实际损失报告，明确接受后再导出。' : '损失报告未知或无效，不能确认无损或授权继续。');
      } else { setLoss(null); setAck(false); setError(intent.uncertain ? `结果未知；保留原请求，只能显式重放同一操作。${failureText(reason)}` : failureText(reason)); }
    } finally {
      intent.sending = false; retained.current = retained.current.filter(value => value.uncertain);
      end(token, intent.scope); onRetainedChanged();
    }
    if (known && current(intent.scope)) await poll(known);
  }
  async function previewPlan() {
    const fixed = scope(); if (!canEdit() || snapshot || Object.keys(batchSnapshots).length) return;
    const token = begin(fixed); if (!token) return;
    try { const planned = await planDelivery([...live.current.choices.values()].filter(c => c.disposition !== 'outside').map(c => ({ id: c.row.media.asset_revision_id, group: c.row.media.source_group_id, disposition: c.disposition as 'include' | 'exclude' })), seed); if (!current(fixed)) return; setPlan(planned); setPlanConfirmed(false); setFreezeConfirmed(false); setBatch(0); }
    catch (e) { if (current(fixed)) setError(e instanceof Error ? e.message : '划分预览失败'); }
    finally { end(token, fixed); }
  }
  function freeze() {
    if (!canEdit() || flight.current || !live.current.ontology || snapshot || (plan && !planConfirmed)) return;
    if (!freezeConfirmed) { setFreezeConfirmed(true); return; }
    const allSelected = [...live.current.choices.values()].filter(choice => choice.disposition !== 'outside');
    const plannedIds = plan ? new Set(plan.batches[batch].map(item => item.id)) : null;
    const selected = plannedIds ? allSelected.filter(choice => plannedIds.has(choice.row.media.asset_revision_id)) : allSelected;
    const included = selected.filter(choice => choice.disposition === 'include');
    if (!included.length || selected.length > CAP || included.some(choice => !eligible(choice.row, live.current.ontology)) || selected.some(choice => choice.disposition === 'exclude' && !choice.reason.trim())) return;
    const body = JSON.stringify({ operation_id: crypto.randomUUID(), ontology_version_id: live.current.ontology, items: included.map(choice => ({ asset_revision_id: choice.row.media.asset_revision_id, annotation_revision_id: choice.row.head!.annotation_revision_id, split: choice.split })), excluded: selected.filter(choice => choice.disposition === 'exclude').map(choice => ({ asset_revision_id: choice.row.media.asset_revision_id, reason: choice.reason.trim() })), split_seed: plan?.seed ?? null, split_ratios: plan ? [80, 10, 10] : null });
    void send({ kind: 'snapshot', scope: scope(), path: `/api/projects/${encodeURIComponent(projectId)}/dataset-versions`, body, uncertain: false, sending: false });
  }
  function start(accepted: boolean) {
    if (!canEdit() || flight.current || !live.current.snapshot || job || artifact || (accepted && (!ack || !loss || loss.scope !== scope() || loss.snapshot !== live.current.snapshot || loss.format !== live.current.format))) return;
    if (!accepted && loss) return;
    void send({ kind: 'export', scope: scope(), path: `/api/dataset-versions/${live.current.snapshot}/exports`, body: JSON.stringify({ format: live.current.format, loss_ack: accepted, operation_id: crypto.randomUUID() }), uncertain: false, sending: false });
  }
  async function download() {
    if (!artifact || !job || artifact.format !== live.current.format) return;
    const fixed = scope(), token = begin(fixed); if (!token) return;
    try {
      const file = await api.download(artifact.download_url); if (!current(fixed)) return;
      if (file.bytes.size !== artifact.byte_size || file.bytes.type.split(';')[0] !== 'application/zip') throw new Error('下载字节或 ZIP 类型不匹配。');
      const bytes = await file.bytes.arrayBuffer(); if (!current(fixed)) return;
      const signature = new Uint8Array(bytes, 0, 4);
      if (signature[0] !== 0x50 || signature[1] !== 0x4b || !((signature[2] === 3 && signature[3] === 4) || (signature[2] === 5 && signature[3] === 6))) throw new Error('下载不是 ZIP 数据包。');
      const digest = await crypto.subtle.digest('SHA-256', bytes); if (!current(fixed)) return;
      if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== artifact.object_sha256) throw new Error('下载 SHA-256 不匹配。');
      const url = URL.createObjectURL(file.bytes);
      try { if (!current(fixed)) return; const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dataset-${snapshot}-${artifact.format}.zip`; anchor.click(); }
      finally { URL.revokeObjectURL(url); }
    } catch (reason) { if (current(fixed)) setError(`产物已保留，重新下载不会创建新导出。${reason instanceof ApiFailure ? failureText(reason) : reason instanceof Error ? reason.message : String(reason)}`); }
    finally { end(token, fixed); }
  }
  const page = pages[pageIndex];
  const selected = [...choices.values()].filter(choice => choice.disposition !== 'outside');
  const included = selected.filter(choice => choice.disposition === 'include').length;
  const activeIds = plan ? new Set(plan.batches[batch].map(item => item.id)) : null;
  const activeSelected = activeIds ? selected.filter(c => activeIds.has(c.row.media.asset_revision_id)) : selected;
  const splitCounts = { train: 0, val: 0, test: 0 };
  for (const c of activeSelected) if (c.disposition === 'include') splitCounts[c.split]++;
  const pending = unresolved();
  const disabled = !member || busy || Boolean(pending);
  return <main className="app-shell dataset-export" aria-labelledby="dataset-export-title">
    <header className="topbar"><nav aria-label="主导航"><button type="button" onClick={() => onWorkbench()}>工作台</button><button type="button" aria-current="page">数据集与导出</button></nav></header>
    <div className="dataset-content"><div className="section-heading"><h1 ref={heading} id="dataset-export-title" tabIndex={-1}>数据集与导出</h1></div>
      <ol className="dataset-steps" aria-label="数据交付状态"><li><strong>选择范围</strong><small>纳入 {included} · 明确排除 {selected.length - included} / 上限 {CAP}</small></li><li data-ready={Boolean(snapshot)}><strong>固定快照</strong><small>{snapshot ? '版本已固定' : '等待固定所选版本'}</small></li><li data-ready={Boolean(artifact)}><strong>导出</strong><small>{artifact ? '导出已完成' : '等待导出'}</small></li></ol>
      {!member && <p role="status">当前账户没有此项目的实际成员资格，不能冻结或导出。</p>}
      {error && <p className="api-error" role="alert">{error}</p>}
      <div className="dataset-scope"><label>类别规范版本 <select data-testid="dataset-ontology" value={ontology} disabled={Boolean(pending) || Object.keys(batchSnapshots).length > 0} onChange={event => { if (unresolved() || !mounted.current || saveAuthorizationEpoch() !== epoch || Object.keys(batchSnapshots).length > 0) return; const value = event.target.value; revoke(true); live.current.ontology = value; live.current.choices = new Map(); setPlan(null); setPlanConfirmed(false); setBatch(0); setBatchSnapshots({}); setOntology(value); setPages([]); setPageIndex(0); setChoices(new Map()); setFailedPage(null); }}><option value="">明确选择固定版本</option>{ontologies.map(value => <option key={value.ontology_version_id} value={value.ontology_version_id}>第 {value.version_no} 版</option>)}</select></label><button type="button" disabled={disabled || !ontology || pages.length > 0} onClick={() => void loadPage(null, 0)}>浏览图片与标注摘要</button></div>
      <p data-testid="dataset-scope-summary">已浏览 {pages.reduce((total, value) => total + value.items.length, 0)} 张；范围外的已浏览图片不进入快照。{page?.next ? '仍有未浏览图片，不会自动纳入或排除。' : '未浏览图片不会写入请求。'}</p>
      {page && <div className="dataset-page-controls"><button type="button" disabled={disabled || pageIndex === 0} onClick={() => { if (canEdit() && !flight.current) setPageIndex(value => value - 1); }}>上一页</button><span>第 {pageIndex + 1} 页</span><button type="button" data-testid="dataset-next-page" disabled={disabled || !page.next} onClick={() => { if (!canEdit() || flight.current || !page.next) return; if (pages[pageIndex + 1]) setPageIndex(value => value + 1); else void loadPage(page.next, pageIndex + 1); }}>下一页</button><button type="button" disabled={disabled || Boolean(snapshot) || Object.keys(batchSnapshots).length > 0} onClick={() => changeChoices(page.items, 'include')}>纳入本页</button><button type="button" disabled={disabled || Boolean(snapshot) || Object.keys(batchSnapshots).length > 0} onClick={() => changeChoices(page.items, 'exclude')}>排除本页</button></div>}
      {failedPage && <button type="button" data-testid="dataset-page-retry" disabled={disabled} onClick={() => void loadPage(failedPage.cursor, failedPage.index)}>重试读取原页</button>}
      {page && <section aria-label="分批交付计划">
        <h2>明确范围与整组划分</h2><p>只处理显式纳入 / 排除的 {selected.length} 项；未选择与未浏览均在范围外。每批最多1024项（含排除），无重复或漏项。仅当前浏览范围，不宣称无限规模。</p>
        <label>确定性 seed<input value={seed} disabled={disabled || Boolean(snapshot) || Object.keys(batchSnapshots).length > 0} onChange={e => setSeed(e.target.value)} /></label>
        <button type="button" disabled={disabled || Boolean(snapshot) || Object.keys(batchSnapshots).length > 0 || !selected.length} onClick={() => void previewPlan()}>预览整组划分与分批范围</button>
        {plan && <><p>seed {plan.seed} · SHA-256整组80/10/10分配，数量不保证精确比例；共 {plan.batches.length} 批。</p>
          <ol>{plan.batches.map((items, i) => <li key={i}>批 {i + 1}：{items.length} 项，纳入 {items.filter(v => v.disposition === 'include').length}，排除 {items.filter(v => v.disposition === 'exclude').length}；{batchSnapshots[i] ? '快照已固定' : '尚未冻结'}<details><summary>本批精确范围与划分</summary><ul>{items.map(item => <li key={item.id}>{choices.get(item.id)?.row.media.original_name} · {item.id} · {item.disposition} · {item.split}</li>)}</ul></details></li>)}</ol>
          <button type="button" disabled={disabled || planConfirmed} onClick={() => { const next = new Map(live.current.choices); for (const item of plan.batches.flat()) next.set(item.id, { ...next.get(item.id)!, split: item.split }); revoke(true); live.current.choices = next; setChoices(next); setPlanConfirmed(true); }}>确认整组划分</button>
          <label>当前交付批次<select disabled={disabled || !planConfirmed} value={batch} onChange={e => { const index = Number(e.target.value); revoke(true); setBatch(index); const fixed = batchSnapshots[index] ?? ''; live.current.snapshot = fixed; setSnapshot(fixed); }}>{plan.batches.map((_, i) => <option key={i} value={i}>批 {i + 1}</option>)}</select></label>
        </>}
      </section>}
      <section aria-label="冻结确认摘要"><h2>冻结范围摘要</h2><p>当前批次：训练 {splitCounts.train} · 验证 {splitCounts.val} · 测试 {splitCounts.test} · 明确排除 {activeSelected.filter(c => c.disposition === 'exclude').length}；范围外不写入快照。</p><p>项数预算：{activeSelected.length} / 1024。体积预算：未知，项数不等于体积；不宣称预估是真实ZIP大小。服务端仍复验资格、分组和96 MiB真实ZIP上限。</p>{freezeConfirmed && <p role="status">已展示冻结确认摘要。再次点击将提交当前不可变版本；已冻结范围不能更改。后续选择另批仅创建另一个快照。</p>}</section>
      <div className="dataset-actionbar">{page && <button type="button" className="primary-action" data-testid="snapshot-create" disabled={disabled || Boolean(snapshot) || !included || activeSelected.length > CAP || (Boolean(plan) && !planConfirmed) || activeSelected.some(choice => choice.disposition === 'exclude' && !choice.reason.trim())} onClick={freeze}>{freezeConfirmed ? '确认冻结所选修订' : '冻结所选修订'}</button>}
        {pending && <button type="button" data-testid={pending.kind === 'snapshot' ? 'snapshot-retry' : 'export-retry'} disabled={busy || !current(pending.scope)} onClick={() => { if (current(pending.scope) && !flight.current) void send(pending); }}>重放同一原始请求</button>}
        {pending?.view && pending.scope !== scope() && <button type="button" data-testid="dataset-restore-pending-scope" disabled={busy || !current(scope())} onClick={() => { const view = pending.view; if (!view || view.base !== base || !current(scope()) || flight.current) return; revoke(true); revision.current = view.revision; live.current = { ontology: view.ontology, format: view.format, choices: view.choices, snapshot: view.snapshot }; setOntology(view.ontology); setFormat(view.format); setChoices(view.choices); setSnapshot(view.snapshot); setPages(view.pages); setPageIndex(view.pageIndex); setFailedPage(null); setPlan(view.plan ?? null); setBatch(view.batch ?? 0); setBatchSnapshots(view.batchSnapshots ?? {}); setPlanConfirmed(view.planConfirmed ?? false); setSeed(view.plan?.seed ?? '17'); }}>恢复原请求固定范围</button>
        }
        {snapshot && <div className="dataset-export-controls"><p role="status">快照已固定。</p><details><summary>快照编号</summary><code>{snapshot}</code></details><label>导出格式 <select data-testid="export-format" value={format} disabled={Boolean(pending)} onChange={event => { if (unresolved() || !current(scope())) return; revoke(false); live.current.format = event.target.value as Format; setFormat(event.target.value as Format); }}><option value="native">原生格式（无损）</option><option value="yolo">YOLO</option><option value="coco">COCO</option></select></label><button type="button" data-testid="export-start" disabled={disabled || Boolean(job || artifact || loss)} onClick={() => start(false)}>生成导出并检查信息损失</button></div>}
        {loss && <><label className="dataset-ack"><input type="checkbox" data-testid="export-loss-ack" checked={ack} onChange={event => { if (current(loss.scope) && !flight.current) setAck(event.target.checked); }} />我已阅读并明确接受上述信息损失</label><button type="button" data-testid="export-confirm" disabled={disabled || !ack} onClick={() => start(true)}>确认损失并生成导出</button></>}
        {job && !artifact && <><p role="status">已有作业：{job.state}</p><button type="button" data-testid="export-status-check" disabled={busy || !current(job.scope)} onClick={() => void poll(job)}>重新检查已有作业状态</button></>}
        {artifact && <div><p role="status">导出已完成（{artifact.byte_size} 字节）。</p><details><summary>文件校验信息</summary><code>{artifact.object_sha256}</code></details><button type="button" className="primary-action" data-testid="export-download" disabled={busy || !member} onClick={() => void download()}>下载数据包</button></div>}
      </div>
      {(loss || artifact) && <div className="dataset-feedback"><LossReportView report={loss?.report ?? artifact!.loss_report} /></div>}
      {page && <fieldset className="dataset-table"><legend>图片与数据划分</legend>{page.items.map(row => <DatasetRow key={row.media.asset_revision_id} row={row} choice={choices.get(row.media.asset_revision_id)} ontology={ontology} disabled={disabled || Boolean(snapshot) || Object.keys(batchSnapshots).length > 0} onChange={changeChoices} onOpen={onWorkbench} />)}</fieldset>}
    </div>
  </main>;
}

type ChangeChoices = (rows: AssetAnnotationHead[], disposition?: Choice['disposition'], split?: Choice['split'], reason?: string) => void;
const DatasetRow = memo(function DatasetRow({ row, choice, ontology, disabled, onChange, onOpen }: { row: AssetAnnotationHead; choice: Choice | undefined; ontology: string; disabled: boolean; onChange: ChangeChoices; onOpen: (target?: DeliveryTarget) => void }) {
  const id = row.media.asset_revision_id;
  return <div className="dataset-row" data-testid={`dataset-row-${id}`} data-selected={choice?.disposition === 'include'}>
    <label>{row.media.original_name}<select aria-label={row.media.original_name} data-testid={`dataset-disposition-${id}`} value={choice?.disposition ?? 'outside'} disabled={disabled} onChange={event => onChange([row], event.target.value as Choice['disposition'])}><option value="outside">范围外（未选择）</option><option value="include" disabled={!eligible(row, ontology)}>纳入</option><option value="exclude">明确排除</option></select></label>
    <div className="dataset-revision"><span>{row.head?.annotation_revision_id ?? '没有标注版本'}</span><small>{eligible(row, ontology) ? '已完成且已审批' : '未完成或未经审批，不能纳入'}</small>{choice?.disposition === 'exclude' && <label>明确排除理由 <input aria-label={`排除理由 ${id}`} value={choice.reason} disabled={disabled} onChange={event => onChange([row], undefined, undefined, event.target.value)} /></label>}</div>
    <p>{!row.head ? '没有保存的标注版本' : !['complete', 'confirmed_negative'].includes(row.head.completion) ? '此固定版本未完成' : !row.head.approved_review_id ? '此固定版本尚无批准（摘要不提供历史批准信息）' : '此固定版本已批准'}</p><button type="button" onClick={() => onOpen({ projectId: row.media.project_id, assetRevisionId: id, ontologyVersionId: ontology, annotationRevisionId: row.head?.annotation_revision_id ?? null, mode: row.head && ['complete', 'confirmed_negative'].includes(row.head.completion) ? 'review' : 'workbench' })}>{row.head && ['complete', 'confirmed_negative'].includes(row.head.completion) ? '审核此固定版本' : '打开此图片标注'}</button>
    <label>数据划分 <select aria-label={`数据划分 ${id}`} data-testid={`dataset-split-${id}`} value={choice?.split ?? 'train'} disabled={disabled} onChange={event => onChange([row], undefined, event.target.value as Choice['split'])}><option value="train">训练集</option><option value="val">验证集</option><option value="test">测试集</option></select></label>
  </div>;
});
