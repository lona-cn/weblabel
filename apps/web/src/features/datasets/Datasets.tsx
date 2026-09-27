import { useEffect, useRef, useState } from 'react';

type Asset = { asset_revision_id: string; original_name: string };
type Ontology = { ontology_version_id: string; version_no: number; labels: { label_id: string; name: string }[] };
type Row = { asset_revision_id: string; annotation_revision_id: string; split: 'train' | 'val' | 'test'; selected: boolean; exclusionReason?: string };
type Loss = { field: string; reason: string };
type ExportResult = { export_id: string; format: string; download_url: string; byte_size: number; object_sha256: string; loss_report: { losses: Loss[] } };
type ExportJob = { job_id: string; state: 'queued' | 'running' | 'succeeded' | 'failed'; result: (ExportResult & { code?: string }) | null };
const MAX_DATASET_ASSETS = 512;
const MAX_CONCURRENT_REVISION_READS = 16;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  const csrf = globalThis.sessionStorage?.getItem('weblabel_csrf');
  if (csrf && init.method && init.method !== 'GET') headers.set('x-csrf-token', csrf);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({})) as { code?: string; message?: string; loss_report?: { losses: Loss[] } };
  if (!response.ok) {
    const error = new Error(body.message ?? `Request failed (${response.status})`) as Error & { code?: string; lossReport?: { losses: Loss[] } };
    error.code = body.code;
    error.lossReport = body.loss_report;
    throw error;
  }
  return body as T;
}

export function Datasets({ projectId, onWorkbench }: { projectId: string; onWorkbench: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [ontologies, setOntologies] = useState<Ontology[]>([]);
  const [assetLimitExceeded, setAssetLimitExceeded] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [ontologyId, setOntologyId] = useState('');
  const [format, setFormat] = useState<'native' | 'yolo' | 'coco'>('native');
  const [snapshotId, setSnapshotId] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);
  const [jobState, setJobState] = useState('');
  const [operationId, setOperationId] = useState('');
  const [lossReport, setLossReport] = useState<Loss[]>([]);
  const [ackRequired, setAckRequired] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      (async () => {
        const items: Asset[] = [];
        let cursor: string | null = null;
        let exceeded = false;
        do {
          const page: { items: Asset[]; next_cursor: string | null } = await api(`/api/projects/${encodeURIComponent(projectId)}/assets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          const remaining = MAX_DATASET_ASSETS - items.length;
          items.push(...page.items.slice(0, remaining));
          cursor = page.next_cursor;
          if (items.length === MAX_DATASET_ASSETS && cursor !== null) {
            exceeded = true;
            break;
          }
        } while (cursor !== null);
        return { items, exceeded };
      })(),
      api<{ items: Ontology[] }>(`/api/projects/${encodeURIComponent(projectId)}/ontologies`),
    ]).then(([assetLoad, ontologyPage]) => {
      if (!active) return;
      setAssets(assetLoad.items);
      setAssetLimitExceeded(assetLoad.exceeded);
      setOntologies(ontologyPage.items);
      setOntologyId(ontologyPage.items[0]?.ontology_version_id ?? '');
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [projectId]);

  async function resolveRows() {
    setError(''); setBusy(true); setRows([]); setSnapshotId(''); setOperationId(''); setResult(null);
    try {
      if (assetLimitExceeded) {
        throw new Error(`项目媒体超过快照上限 ${MAX_DATASET_ASSETS}；当前预览不完整，已禁用快照创建。`);
      }
      const ontology = encodeURIComponent(ontologyId);
      const selected: Row[] = [];
      for (let offset = 0; offset < assets.length; offset += MAX_CONCURRENT_REVISION_READS) {
        const batch = await Promise.all(assets.slice(offset, offset + MAX_CONCURRENT_REVISION_READS).map(async (asset) => {
          try {
            const revision = await api<{ annotation_revision_id: string; document: { completion: string } }>(`/api/assets/${encodeURIComponent(asset.asset_revision_id)}/annotation?ontology_version_id=${ontology}`);
            if (revision.document.completion === 'unprocessed' || revision.document.completion === 'in_progress') {
              return { asset_revision_id: asset.asset_revision_id, annotation_revision_id: revision.annotation_revision_id, split: 'train' as const, selected: false, exclusionReason: `annotation_${revision.document.completion}` };
            }
            return { asset_revision_id: asset.asset_revision_id, annotation_revision_id: revision.annotation_revision_id, split: 'train' as const, selected: true };
          } catch (reason) {
            if ((reason as Error & { code?: string }).code === 'ANNOTATION_NOT_FOUND') {
              return { asset_revision_id: asset.asset_revision_id, annotation_revision_id: '', split: 'train' as const, selected: false, exclusionReason: 'no_current_annotation_revision' };
            }
            throw reason;
          }
        }));
        selected.push(...batch);
      }
      setRows(selected);
      if (selected.some((row) => row.exclusionReason)) setError('未处理或无当前修订的媒体已列入明确排除预览；其他读取错误会阻止创建快照。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function createSnapshot() {
    setBusy(true); setError(''); setResult(null); setLossReport([]); setAckRequired(false); setAcknowledged(false);
    try {
      const snapshot = await api<{ dataset_version_id: string }>('/api/projects/' + encodeURIComponent(projectId) + '/dataset-versions', {
        method: 'POST', body: JSON.stringify({ operation_id: crypto.randomUUID(), ontology_version_id: ontologyId, items: rows.filter((row) => row.selected).map(({ asset_revision_id, annotation_revision_id, split }) => ({ asset_revision_id, annotation_revision_id, split })), excluded: rows.filter((row) => !row.selected).map((row) => ({ asset_revision_id: row.asset_revision_id, reason: row.exclusionReason ?? 'user_excluded' })), split_seed: null, split_ratios: null }),
      });
      setSnapshotId(snapshot.dataset_version_id);
      setOperationId('');
      setLossReport([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function requestExport(lossAck: boolean) {
    if (!snapshotId) return;
    setBusy(true); setError('');
    try {
      const currentOperationId = operationId || crypto.randomUUID();
      setOperationId(currentOperationId);
      const started = await api<{ job_id: string }>(`/api/dataset-versions/${encodeURIComponent(snapshotId)}/exports`, { method: 'POST', body: JSON.stringify({ format, loss_ack: lossAck, operation_id: currentOperationId }) });
      let job: ExportJob;
      do {
        setJobState('queued');
        await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
        job = await api<ExportJob>(`/api/jobs/${encodeURIComponent(started.job_id)}`);
        setJobState(job.state);
      } while (job.state === 'queued' || job.state === 'running');
      if (job.state !== 'succeeded' || !job.result) throw new Error(`导出作业失败：${job.result?.code ?? 'EXPORT_FAILED'}`);
      if (job.result.format !== format) throw new Error('作业结果格式与当前所选格式不一致。');
      setResult(job.result); setLossReport(job.result.loss_report.losses); setAckRequired(false); setAcknowledged(false);
    } catch (reason) {
      const failure = reason as Error & { code?: string; lossReport?: { losses: Loss[] } };
      if (failure.code === 'LOSS_ACK_REQUIRED') { setLossReport(failure.lossReport?.losses ?? []); setAckRequired(true); }
      setError(failure.message);
    } finally { setBusy(false); }
  }

  async function download() {
    if (!result || result.format !== format) return;
    setBusy(true);
    try {
      const response = await fetch(result.download_url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dataset-${snapshotId}-${result.format}.zip`; anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <main className="app-shell dataset-export" aria-labelledby="dataset-export-title">
    <header className="topbar"><a className="brand" href="/" aria-label="WebLabel 项目"><span className="brand-mark" aria-hidden="true">W</span><span>WebLabel</span></a>
      <nav aria-label="主导航" className="main-nav"><button type="button" onClick={onWorkbench}>工作台</button><button type="button" aria-current="page">数据集与导出</button></nav>
    </header>
    <h1 ref={heading} id="dataset-export-title" tabIndex={-1}>数据集快照与导出</h1>
    {assetLimitExceeded && <p role="alert">项目媒体超过快照上限 {MAX_DATASET_ASSETS}；当前仅显示部分媒体，无法创建不完整快照。请先缩小项目范围。</p>}
    <label>固定Ontology版本 <select value={ontologyId} onChange={(event) => { setOntologyId(event.target.value); setRows([]); setSnapshotId(''); setOperationId(''); setResult(null); }}>
      {ontologies.map((value) => <option key={value.ontology_version_id} value={value.ontology_version_id}>v{value.version_no} · {value.ontology_version_id}</option>)}
    </select></label>
    <button type="button" disabled={busy || !ontologyId || assets.length === 0 || assetLimitExceeded} onClick={() => void resolveRows()}>读取当前修订并选择快照范围</button>
    {rows.length > 0 && <fieldset><legend>固定修订及显式划分</legend>{rows.map((row, index) => <div key={row.asset_revision_id} className="dataset-row">
      <label><input type="checkbox" disabled={Boolean(row.exclusionReason)} checked={row.selected} onChange={(event) => { setRows((all) => all.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item)); setSnapshotId(''); setOperationId(''); setResult(null); }} />{assets.find((asset) => asset.asset_revision_id === row.asset_revision_id)?.original_name ?? row.asset_revision_id}{row.exclusionReason ? ` · 已排除：${row.exclusionReason}` : ''}</label>
      <label>Annotation revision <input aria-label={`修订 ${row.asset_revision_id}`} value={row.annotation_revision_id} onChange={(event) => { setRows((all) => all.map((item, i) => i === index ? { ...item, annotation_revision_id: event.target.value } : item)); setSnapshotId(''); setOperationId(''); setResult(null); }} /></label>
      <label>Split <select value={row.split} onChange={(event) => { setRows((all) => all.map((item, i) => i === index ? { ...item, split: event.target.value as Row['split'] } : item)); setSnapshotId(''); setOperationId(''); setResult(null); }}><option value="train">train</option><option value="val">val</option><option value="test">test</option></select></label>
    </div>)}</fieldset>}
    {rows.length > 0 && <button type="button" disabled={busy || rows.every((row) => !row.selected)} onClick={() => void createSnapshot()}>冻结所选修订</button>}
    {snapshotId && <div><p role="status">快照已固定：<code>{snapshotId}</code></p><label>导出格式 <select disabled={busy} value={format} onChange={(event) => { setFormat(event.target.value as typeof format); setResult(null); setJobState(''); setOperationId(''); setLossReport([]); setAckRequired(false); setAcknowledged(false); }}><option value="native">Native（无损）</option><option value="yolo">YOLO</option><option value="coco">COCO</option></select></label>
      <button type="button" disabled={busy} onClick={() => void requestExport(false)}>生成导出与损失预览</button></div>}
    {lossReport.length > 0 && <section aria-label="导出损失报告"><h3>信息损失</h3><ul>{lossReport.map((loss, index) => <li key={`${loss.field}-${index}`}><strong>{loss.field}</strong>: {loss.reason}</li>)}</ul></section>}
    {ackRequired && <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />我已阅读并明确接受上述信息损失</label>}
    {ackRequired && <button type="button" disabled={busy || !acknowledged} onClick={() => void requestExport(true)}>确认损失并生成导出</button>}
    {jobState && jobState !== 'succeeded' && <p role="status">导出作业：{jobState}</p>}
    {result && result.format === format && <div><p role="status">导出已完成：SHA-256 {result.object_sha256}（{result.byte_size} bytes）</p><button type="button" disabled={busy} onClick={() => void download()}>下载授权数据包</button></div>}
  </main>;
}
