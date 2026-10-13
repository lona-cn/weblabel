import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './import-export.css';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import { api, ApiFailure, type ApiMedia, type RevisionExportArtifact, type RevisionExportIntent } from '../../lib/t15/api';
import { failureText, isAmbiguous, LossReportView, readLossReport, type LossReport } from './LossReportView';
import { getOutboxSnapshot, putExportIntent, removeExportIntent, subscribeOutbox, type IntentTarget } from './outbox';
type Props = { scopeKey: string; media: ApiMedia | null; canStart: boolean; prepareExport: () => Promise<AnnotationRevision> };
type Operation = { scope: string; target: IntentTarget; revisionId: string; payload: RevisionExportIntent; uncertain: boolean };
export function RevisionExportPanel(props: Props) {
  const latest = useRef(props); latest.current = props; const mounted = useRef(true); const single = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [format, setFormat] = useState<RevisionExportIntent['format']>('native'); const [operation, setOperation] = useState<Operation | null>(null); const operationRef = useRef<Operation | null>(null);
  const [report, setReport] = useState<LossReport | null>(null); const [ack, setAck] = useState(false); const [artifact, setArtifact] = useState<RevisionExportArtifact | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [downloaded, setDownloaded] = useState(false);
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
  const records = outbox.exports.filter(record => record.target.projectId === props.media?.project_id && record.target.assetRevisionId === props.media?.asset_revision_id);
  const retained = records.find(record => record.scope === props.scopeKey && !record.artifact) ?? records.filter(record => record.scope === props.scopeKey).at(-1) ?? records.find(record => !record.artifact) ?? records.at(-1);
  const viewKey = JSON.stringify([props.scopeKey, props.media?.project_id ?? null, props.media?.asset_revision_id ?? null]);
  const restoredView = useRef<string | null>(null);
  useEffect(() => {
    const moved = restoredView.current !== viewKey;
    restoredView.current = viewKey;
    const active = operationRef.current;
    // Restore a new view or settle its own operation, never an older rescue artifact over a current decision.
    if (!moved && (!active || retained?.payload.operation_id !== active.payload.operation_id)) return;
    if (moved) { setAck(false); setFailure(null); setError(''); setDownloaded(false); }
    if (retained) {
      const restored: Operation = { scope: retained.scope, target: retained.target, revisionId: retained.revisionId, payload: retained.payload, uncertain: !retained.artifact };
      operationRef.current = restored; setOperation(restored); setFormat(restored.payload.format); setArtifact(retained.artifact);
      setReport(retained.artifact ? readLossReport(retained.artifact.loss_report) : null);
    } else if (moved) { operationRef.current = null; setOperation(null); setReport(null); setArtifact(null); }
  }, [retained, viewKey]);
  const current = (scope: string) => mounted.current && latest.current.scopeKey === scope;
  async function download(existing: RevisionExportArtifact, scope: string) {
    try {
      const file = await api.download(existing.download_url); if (!current(scope)) return;
      const url = URL.createObjectURL(file.bytes); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `weblabel-${existing.export_id}.${existing.format === 'coco' ? 'json' : 'zip'}`; anchor.click(); URL.revokeObjectURL(url);
      setDownloaded(true); setError('');
    } catch (reason) { if (current(scope)) { setDownloaded(false); setError(`产物已创建，但下载失败。重新下载只读取已有产物，不再提交导出。${failureText(reason)}`); } }
  }
  async function send(fixed: Operation, wasUnknown: boolean) {
    putExportIntent({ scope: fixed.scope, target: fixed.target, revisionId: fixed.revisionId, payload: fixed.payload, artifact: null, sending: true });
    try {
      const result = await api.createRevisionExport(fixed.revisionId, fixed.payload);
      if (!result || typeof result.export_id !== 'string' || !result.export_id || result.format !== fixed.payload.format || typeof result.download_url !== 'string' || !/^\/api\/exports\/[^/]+\/download$/.test(result.download_url) || !Number.isSafeInteger(result.byte_size) || result.byte_size < 0 || typeof result.object_sha256 !== 'string' || !result.object_sha256 || !readLossReport(result.loss_report)) throw new Error('Invalid export acknowledgement');
      putExportIntent({ scope: fixed.scope, target: fixed.target, revisionId: fixed.revisionId, payload: fixed.payload, artifact: result, sending: false }); fixed.uncertain = false;
      if (current(fixed.scope)) operationRef.current = fixed;
      if (!current(fixed.scope)) return;
      setOperation({ ...fixed }); setArtifact(result); setReport(readLossReport(result.loss_report)); setFailure(null); setAck(false);
      await download(result, fixed.scope);
    } catch (reason) {
      const record = { scope: fixed.scope, target: fixed.target, revisionId: fixed.revisionId, payload: fixed.payload, artifact: null, sending: false };
      fixed.uncertain = wasUnknown || isAmbiguous(reason);
      if (fixed.uncertain) putExportIntent(record); else removeExportIntent(record);
      if (current(fixed.scope)) operationRef.current = fixed;
      if (!current(fixed.scope)) return;
      if (!wasUnknown && reason instanceof ApiFailure && reason.status === 422 && reason.code === 'LOSS_ACK_REQUIRED') {
        setOperation({ ...fixed }); setFailure(reason); setAck(false);
        const actual = readLossReport(reason.details?.loss_report);
        setReport(actual); setError(actual ? '请阅读服务端实际损失，明确确认后再继续。' : '损失报告无效或未知，不能声称无损，也不能确认继续。');
      } else if (fixed.uncertain) { setOperation({ ...fixed }); setFailure(reason instanceof ApiFailure ? reason : null); setReport(null); setAck(false); setError(`导出结果未知，保留固定版本、格式、操作及原载荷；此次拒绝不能确认原请求未创建产物，仅可显式重放同一请求。${failureText(reason)}`); }
      else { setOperation({ ...fixed }); setFailure(reason instanceof ApiFailure ? reason : null); setError(failureText(reason)); }
    }
  }
  async function start() {
    if (single.current || !latest.current.canStart || !latest.current.media || operationRef.current?.uncertain || artifact || records.some(record => !record.artifact)) return;
    const scope = props.scopeKey; single.current = true; setBusy(true); setError('');
    try {
      const revision = await latest.current.prepareExport(); if (!current(scope)) return;
      if (!revision?.annotation_revision_id || revision.document?.asset_revision_id !== latest.current.media?.asset_revision_id) throw new Error('无法固定导出版本');
      const fixed: Operation = { scope, target: Object.freeze({ projectId: latest.current.media!.project_id, assetRevisionId: revision.document.asset_revision_id, ontologyId: revision.document.ontology_version_id }), revisionId: revision.annotation_revision_id, payload: Object.freeze({ format, loss_ack: false, operation_id: crypto.randomUUID() }), uncertain: true };
      operationRef.current = fixed; setOperation(fixed); setReport(null); setFailure(null); setAck(false); setDownloaded(false); await send(fixed, false);
    } catch (reason) { if (current(scope)) setError(failureText(reason)); }
    finally { single.current = false; if (mounted.current) setBusy(false); }
  }
  async function continueExport(replay: boolean) {
    const fixed = operationRef.current;
    if (single.current || !fixed || !current(fixed.scope) || artifact || retained?.sending) return;
    if (!replay) {
      if (fixed.uncertain || !ack || !report || failure?.status !== 422 || failure.code !== 'LOSS_ACK_REQUIRED') return;
      // An initial definite 422 permits this explicit change; historical unknown never reaches this path.
      fixed.payload = Object.freeze({ ...fixed.payload, loss_ack: true }); fixed.uncertain = true;
    } else if (!fixed.uncertain) return;
    single.current = true; setBusy(true); setError(''); await send(fixed, replay); single.current = false; if (mounted.current) setBusy(false);
  }
  async function checkRevision() {
    if (single.current || operationRef.current?.uncertain) return; const scope = props.scopeKey; single.current = true; setBusy(true);
    try {
      const revision = await latest.current.prepareExport(); if (!current(scope)) return;
      if (revision.annotation_revision_id !== operationRef.current?.revisionId) { operationRef.current = null; setOperation(null); setReport(null); setAck(false); setFailure(null); setArtifact(null); setDownloaded(false); setError('实际版本已变化，旧损失确认已撤销。请重新检查损失并导出。'); }
    } catch (reason) { if (current(scope)) setError(failureText(reason)); }
    finally { single.current = false; if (mounted.current) setBusy(false); }
  }
  const stale = !!operation && operation.scope !== props.scopeKey;
  return <section className="attribute-panel import-export-panel" aria-label="单图版本导出" aria-busy={busy}><h3>单图版本导出</h3><p>原生包保留单图标注及规范，不是完整项目备份。</p>
    <label>导出格式<select aria-label="导出格式" value={format} disabled={busy || operation?.uncertain} onChange={event => { if (operationRef.current?.uncertain) return; setFormat(event.target.value as RevisionExportIntent['format']); operationRef.current = null; setOperation(null); setReport(null); setAck(false); setFailure(null); setArtifact(null); setDownloaded(false); setError(''); }}><option value="native">原生包</option><option value="coco">COCO</option><option value="yolo">YOLO</option></select></label>
    <button type="button" disabled={busy || !props.canStart || !props.media || !!operation || !!artifact} onClick={() => void start()}>检查损失并导出</button>
    {operation && <p>固定版本 {operation.revisionId}；格式 {operation.payload.format}；操作 {operation.payload.operation_id}</p>}
    {report && !stale && <LossReportView report={report} />}
    {failure?.request_id && <p>请求 {failure.request_id}</p>}
    {failure && <details><summary>完整服务端诊断</summary><pre>{JSON.stringify({ code: failure.code, request_id: failure.request_id, details: failure.details }, null, 2)}</pre></details>}
    {failure?.status === 422 && failure.code === 'LOSS_ACK_REQUIRED' && report && !artifact && !operation?.uncertain && !stale && <><label><input type="checkbox" checked={ack} disabled={busy} onChange={event => setAck(event.target.checked)} />我已阅读并确认导出损失</label><button type="button" disabled={busy || !ack} onClick={() => void continueExport(false)}>确认损失并继续导出</button></>}
    {operation?.uncertain && <button type="button" disabled={busy || stale || retained?.sending} onClick={() => void continueExport(true)}>重放同一导出请求</button>}
    {artifact && <><p role="status">服务端实际产物：{artifact.byte_size} 字节，SHA256 {artifact.object_sha256}{downloaded ? '；已发起下载。' : ''}{stale ? '；属于原范围，仅可读取救援产物，不代表新工作台已导出。' : ''}</p><button type="button" disabled={busy} onClick={async () => { if (single.current) return; single.current = true; setBusy(true); await download(artifact, props.scopeKey); single.current = false; if (mounted.current) setBusy(false); }}>重新下载已有产物</button></>}
    {operation && !operation.uncertain && !stale && <button type="button" disabled={busy} onClick={() => void checkRevision()}>重新检查导出版本</button>}
    {operation && !operation.uncertain && !artifact && <button type="button" disabled={busy} onClick={() => { operationRef.current = null; setOperation(null); setReport(null); setAck(false); setFailure(null); setError(''); }}>取消此次导出</button>}
    {stale && <p role={artifact ? 'status' : 'alert'}>{artifact ? '原范围产物已确认，仅可下载原固定版本救援，不代表当前工作台已导出；要导出当前版本，请重新选择格式并检查。' : operation?.uncertain ? '原范围导出结果尚未确认，不能为新范围创建替代操作；返回原范围只重放原请求。' : '此操作属于原范围且未确认产物；不能代替当前工作台导出，请重新选择格式并检查当前固定版本。'}</p>}
    {records.filter(record => record.payload.operation_id !== operation?.payload.operation_id).map(record => <div key={record.payload.operation_id}><p>另有原范围操作 {record.payload.operation_id}，固定版本 {record.revisionId}；{record.artifact ? `已确认产物 ${record.artifact.export_id}` : '结果未知，不会替换或自动重放'}</p>{record.artifact && <button type="button" disabled={busy} onClick={() => void download(record.artifact!, props.scopeKey)}>下载原范围产物 {record.artifact.export_id}</button>}</div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
