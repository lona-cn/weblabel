import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './import-export.css';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { SaveLease } from '../../../../../packages/contracts/generated/SaveLease';
import { api, ApiFailure, type ApiMedia, type AnnotationImportPreview } from '../../lib/t15/api';
import { failureText, fileText, isAmbiguous, LossReportView, readLossReport } from './LossReportView';
import { getOutboxSnapshot, putImportIntent, removeImportIntent, subscribeOutbox, type ImportIntent } from './outbox';
export type AnnotationImportContext = { asset_revision_id: string; ontology_version_id: string; base_revision_id: string | null; lease: SaveLease | null };
type Props = { scopeKey: string; media: ApiMedia | null; ontology: OntologyVersion | null; canWrite: boolean; prepareImport: () => Promise<AnnotationImportContext>; onCommit: (revision: AnnotationRevision, scopeKey: string) => Promise<void>; releaseImport: (scopeKey: string) => void };
type CocoSource = { images: { id: number; file_name: string }[]; categories: { id: number; name: string; label_id?: string }[]; raw: Record<string, unknown> };
type Preview = { scope: string; context: AnnotationImportContext; result: AnnotationImportPreview };
export function AnnotationImportPanel(props: Props) {
  const latest = useRef(props); latest.current = props; const mounted = useRef(true); const single = useRef(false); const load = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; load.current++; }; }, []);
  const [format, setFormat] = useState<'coco' | 'yolo'>('coco'); const [file, setFile] = useState<File | null>(null);
  const [coco, setCoco] = useState<CocoSource | null>(null); const [imageId, setImageId] = useState(''); const [mapping, setMapping] = useState<Record<string, string>>({});
  const [yoloLabels, setYoloLabels] = useState<string[]>([]); const [preview, setPreview] = useState<Preview | null>(null);
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
  const records = outbox.imports.filter(record => record.target.projectId === props.media?.project_id && record.target.assetRevisionId === props.media?.asset_revision_id && record.target.ontologyId === props.ontology?.ontology_version_id);
  const pending = records.find(record => record.scope === props.scopeKey) ?? records[0] ?? null; const pendingRef = useRef<ImportIntent | null>(null); pendingRef.current = pending;
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
  const targetKey = JSON.stringify([props.media?.project_id ?? null, props.media?.asset_revision_id ?? null, props.ontology?.ontology_version_id ?? null]);
  const previousScope = useRef({ scope: props.scopeKey, target: targetKey });
  useEffect(() => {
    if (previousScope.current.scope === props.scopeKey && previousScope.current.target === targetKey) return;
    const changedTarget = previousScope.current.target !== targetKey;
    previousScope.current = { scope: props.scopeKey, target: targetKey }; load.current++;
    if (!pendingRef.current) {
      setPreview(null); setAck(false); setConflict(false);
      if (changedTarget) { setFile(null); setCoco(null); setImageId(''); setMapping({}); setYoloLabels([]); setError(''); }
    }
  }, [props.scopeKey, targetKey]);
  const current = (scope: string) => mounted.current && latest.current.scopeKey === scope;
  const held = !!preview || !!pending; const stale = !!pending && pending.scope !== props.scopeKey;
  async function choose(source: File | null) {
    if (single.current || held || !latest.current.canWrite) return;
    const scope = props.scopeKey; const sequence = ++load.current; setFile(source); setCoco(null); setImageId(''); setMapping({}); setError('');
    if (!source || format !== 'coco') return;
    try {
      const value: unknown = JSON.parse(await fileText(source));
      if (!current(scope) || sequence !== load.current) return;
      if (!value || typeof value !== 'object' || !('images' in value) || !Array.isArray(value.images) || !('categories' in value) || !Array.isArray(value.categories)) throw new Error('COCO 文件需要 images/categories');
      const images: CocoSource['images'] = []; const categories: CocoSource['categories'] = []; const imageIds = new Set<number>(); const categoryIds = new Set<number>();
      for (const image of value.images) { if (!image || !Number.isSafeInteger(image.id) || typeof image.file_name !== 'string' || imageIds.has(image.id)) throw new Error('COCO 来源图标识必须为唯一整数'); imageIds.add(image.id); images.push({ id: image.id, file_name: image.file_name }); }
      for (const category of value.categories) { if (!category || !Number.isSafeInteger(category.id) || typeof category.name !== 'string' || categoryIds.has(category.id)) throw new Error('COCO 类别标识必须为唯一整数'); categoryIds.add(category.id); categories.push({ id: category.id, name: category.name, ...(typeof category.label_id === 'string' ? { label_id: category.label_id } : {}) }); }
      if (!images.length) throw new Error('COCO 没有来源图');
      // Preserve the complete source object; only categories[].label_id changes in the upload copy.
      const raw = value as Record<string, unknown>; setCoco({ images, categories, raw });
      setMapping(Object.fromEntries(categories.map(category => [String(category.id), props.ontology?.labels.some(label => label.label_id === category.label_id) ? category.label_id! : ''])));
      if (images.length === 1) setImageId(String(images[0].id));
    } catch (reason) { if (current(scope) && sequence === load.current) setError(reason instanceof SyntaxError ? `COCO JSON 无法解析，尚未生成预览或提交标注。请检查文件是否完整、括号及逗号格式；技术说明：${reason.message}` : `COCO 来源文件无法读取或不符合格式，尚未生成预览或提交标注。${reason instanceof Error ? reason.message : '请重新选择可读取的 COCO 文件。'}`); }
  }
  async function makePreview() {
    const now = latest.current; if (single.current || held || !now.canWrite || !now.media || !now.ontology || !file) return;
    const scope = now.scopeKey; const source = file; const targetFormat = format;
    const labels = targetFormat === 'yolo' ? (yoloLabels.length ? yoloLabels : now.ontology.labels.map(label => label.label_id)) : [];
    const legal = new Set(now.ontology.labels.map(label => label.label_id));
    if (targetFormat === 'coco' && (!coco || !imageId)) { setError('请选择明确的 COCO 来源图。'); return; }
    if (targetFormat === 'coco' && coco?.categories.some(category => !legal.has(mapping[String(category.id)]))) { setError('每个 COCO 类别必须映射到固定规范中的合法类别。'); return; }
    if (targetFormat === 'yolo' && (!labels.length || labels.some(label => !legal.has(label)) || new Set(labels).size !== labels.length)) { setError('YOLO 有序类别必须合法且唯一。'); return; }
    single.current = true; setBusy(true); setError(''); let prepared = false;
    try {
      const context = await now.prepareImport(); prepared = true;
      if (!current(scope)) { now.releaseImport(scope); return; }
      if (!latest.current.canWrite || context.asset_revision_id !== now.media.asset_revision_id || context.ontology_version_id !== now.ontology.ontology_version_id) throw new Error('导入目标已变化，请重新准备');
      const body = new FormData(); body.append('format', targetFormat); body.append('ontology_version_id', context.ontology_version_id);
      if (targetFormat === 'coco' && coco) {
        body.append('source_image_id', imageId);
        const categories = coco.raw.categories;
        if (!Array.isArray(categories)) throw new Error('COCO 类别无效');
        const copy = { ...coco.raw, categories: categories.map(category => ({ ...category, label_id: mapping[String(category.id)] })) };
        body.append('data', new Blob([JSON.stringify(copy)], { type: 'application/json' }), source.name);
      } else { body.append('label_ids', JSON.stringify(labels)); body.append('data', source, source.name); }
      const result = await api.previewAnnotationImport(context.asset_revision_id, body);
      if (!current(scope)) { now.releaseImport(scope); return; }
      if (!result || !result.import_batch_id || result.base_revision_id !== context.base_revision_id || result.document?.asset_revision_id !== context.asset_revision_id || result.document?.ontology_version_id !== context.ontology_version_id || !Array.isArray(result.document.objects) || !readLossReport(result.loss_report)) throw new Error('预览响应或损失报告无效，请核对目标后重新预览');
      setPreview({ scope, context: structuredClone(context), result }); setAck(false); setConflict(false);
    } catch (reason) {
      const sameTarget = mounted.current && latest.current.media?.project_id === now.media.project_id && latest.current.media?.asset_revision_id === now.media.asset_revision_id && latest.current.ontology?.ontology_version_id === now.ontology.ontology_version_id;
      if (current(scope) || (!prepared && sameTarget)) setError(reason instanceof ApiFailure ? failureText(reason) : reason instanceof Error ? reason.message : '预览失败');
      if (prepared) now.releaseImport(scope);
    }
    finally { single.current = false; if (mounted.current) setBusy(false); }
  }
  async function commit(replay: boolean) {
    const now = latest.current; if (single.current || !now.canWrite || stale || conflict) return;
    let operation = pendingRef.current;
    const wasUnknown = !!operation && !operation.receipt;
    if (!operation) {
      if (replay || !preview || !current(preview.scope) || !now.media || !now.ontology) return;
      const report = readLossReport(preview.result.loss_report); if (!report || (report.losses.length > 0 && !ack)) return;
      operation = { scope: preview.scope, target: Object.freeze({ projectId: now.media.project_id, assetRevisionId: preview.context.asset_revision_id, ontologyId: preview.context.ontology_version_id }), batchId: preview.result.import_batch_id, payload: Object.freeze({ operation_id: crypto.randomUUID(), loss_ack: ack, lease: preview.context.lease ? Object.freeze({ ...preview.context.lease }) : null }), receipt: null, sending: false };
    }
    if (!current(operation.scope) || operation.sending) return;
    const fixed = { ...operation, sending: true }; putImportIntent(fixed);
    single.current = true; setBusy(true); setError('');
    let confirmed = fixed.receipt;
    try {
      if (!confirmed) {
        const receipt = await api.commitAnnotationImport(fixed.batchId, fixed.payload);
        if (!receipt || receipt.import_batch_id !== fixed.batchId || !receipt.revision?.annotation_revision_id || receipt.revision.document?.asset_revision_id !== fixed.target.assetRevisionId || receipt.revision.document?.ontology_version_id !== fixed.target.ontologyId) throw new Error('导入响应无法确认');
        confirmed = receipt.revision; putImportIntent({ ...fixed, receipt: confirmed, sending: false });
      }
      if (!current(fixed.scope)) return;
      await latest.current.onCommit(confirmed, fixed.scope);
      // Adoption may advance the owner epoch; remove only this original completed operation.
      removeImportIntent(fixed);
      if (mounted.current) { setPreview(null); setAck(false); if (current(fixed.scope)) setError('导入成功，已采用服务端实际版本。'); }
    } catch (reason) {
      const rejected = !confirmed && !wasUnknown && !isAmbiguous(reason);
      if (rejected) removeImportIntent(fixed); else putImportIntent({ ...fixed, receipt: confirmed, sending: false });
      if (!current(fixed.scope)) return;
      if (rejected) { if (reason instanceof ApiFailure && reason.status === 409 && reason.code === 'REVISION_CONFLICT') { setConflict(true); setAck(false); } setError(failureText(reason)); }
      else setError(confirmed ? '服务端导入已确认，但工作台重建失败；只重新采用同一实际版本，不再次提交。' : `导入结果未知，保留原批次、操作、载荷及租约锁；此次拒绝不能确认原请求未提交，仅可重放原请求。${failureText(reason)}`);
    } finally { single.current = false; if (mounted.current) setBusy(false); }
  }
  const report = preview ? readLossReport(preview.result.loss_report) : null;
  return <section className="attribute-panel import-export-panel" aria-label="标注格式导入" aria-busy={busy}><h3>标注格式导入</h3><p>目标：{props.media?.original_name ?? '未选择媒体'} · 固定规范 {props.ontology?.ontology_version_id ?? '未载入'}</p>
    <fieldset disabled={busy || held || !props.canWrite || !props.media || !props.ontology}><legend>源文件与类别映射</legend>
      <label>标注格式<select aria-label="标注格式" value={format} onChange={event => { load.current++; setFormat(event.target.value as 'coco' | 'yolo'); setYoloLabels(props.ontology?.labels.map(label => label.label_id) ?? []); setFile(null); setCoco(null); setImageId(''); setMapping({}); setError(''); }}><option value="coco">COCO</option><option value="yolo">YOLO</option></select></label>
      <label>标注源文件<input key={`${targetKey}:${format}`} aria-label="标注源文件" type="file" accept={format === 'coco' ? '.json' : '.txt'} onChange={event => void choose(event.target.files?.[0] ?? null)} /></label>
      {coco && <><label>COCO 来源图<select aria-label="COCO 来源图" value={imageId} onChange={event => setImageId(event.target.value)}><option value="">请选择来源图</option>{coco.images.map(image => <option key={image.id} value={image.id}>{image.file_name} (ID {image.id})</option>)}</select></label>{coco.categories.map(category => <label key={category.id}>类别映射 {category.name}<select aria-label={`类别映射 ${category.name}`} value={mapping[String(category.id)] ?? ''} onChange={event => setMapping(previous => ({ ...previous, [String(category.id)]: event.target.value }))}><option value="">请选择目标类别</option>{props.ontology?.labels.map((label, index) => <option key={label.label_id} value={label.label_id}>{label.name} · {index + 1}</option>)}</select></label>)}</>}
      {format === 'yolo' && <><p>YOLO 类别编号按以下顺序，从 0 开始；每个类别只能出现一次。</p>{(yoloLabels.length ? yoloLabels : props.ontology?.labels.map(label => label.label_id) ?? []).map((id, index, rows) => <label key={index}>YOLO 类别 {index}<select aria-label={`YOLO 类别 ${index}`} value={id} onChange={event => { const copy = [...rows]; copy[index] = event.target.value; setYoloLabels(copy); }}>{props.ontology?.labels.map((label, index) => <option key={label.label_id} value={label.label_id}>{label.name} · {index + 1}</option>)}</select></label>)}<button type="button" onClick={() => setYoloLabels(previous => [...(previous.length ? previous : props.ontology?.labels.map(label => label.label_id) ?? []), ''])}>增加 YOLO 类别编号</button>{yoloLabels.length > 1 && <button type="button" onClick={() => setYoloLabels(previous => previous.slice(0, -1))}>移除末尾类别编号</button>}</>}
      <button type="button" disabled={!file} onClick={() => void makePreview()}>生成只读预览</button>
    </fieldset>
    {preview && preview.scope === props.scopeKey && <><h4>只读预览</h4><p>对象数 {preview.result.document.objects.length}；完成状态 {preview.result.document.completion}。空对象不是已确认负样本。</p><details><summary>服务端实际文档（只读）</summary><pre>{JSON.stringify(preview.result.document, null, 2)}</pre></details>{report && <LossReportView report={report} />}
      <section aria-label="迁移体检语义摘要"><h4>迁移体检：实际预览，不承诺无损兼容</h4><p>来源格式 {format.toUpperCase()} · 来源文件 {file?.name} · 源 image ID {format === 'coco' ? imageId : 'YOLO 当前目标图片'} · 实际对象 {preview.result.document.objects.length}</p><p>保留：以服务端实际预览对象、类别和属性为准。转换：来源类别映射至固定规范；坐标以实际文档为准。损失：{report?.losses.length ?? '未知'} 项。拒绝：预览失败不提交，不能静默降质。</p><ul>{preview.result.document.objects.map(obj => <li key={obj.object_id}>{props.ontology?.labels.find(l => l.label_id === obj.label_id)?.name ?? obj.label_id} · 实际属性 {JSON.stringify(obj.attributes)}</li>)}</ul><details><summary>映射与默认属性核对</summary><pre>{JSON.stringify({ source_image_id: format === 'coco' ? imageId : null, category_mapping: format === 'coco' ? mapping : (yoloLabels.length ? yoloLabels : props.ontology?.labels.map(l => l.label_id)), defaults: props.ontology?.labels.map(l => ({ category: l.name, attributes: l.attributes.map(a => ({ key: a.key, default_value: a.default_value, required: a.required })) })) }, null, 2)}</pre></details></section>
      {report && report.losses.length > 0 && <label><input type="checkbox" checked={ack} disabled={busy || !!pending || conflict} onChange={event => setAck(event.target.checked)} />我已阅读并确认导入损失</label>}
      {!pending && <button type="button" disabled={busy || !props.canWrite || conflict || !report || (report.losses.length > 0 && !ack)} onClick={() => void commit(false)}>确认导入</button>}
      {!pending && <button type="button" disabled={busy} onClick={() => { props.releaseImport(preview.scope); setPreview(null); setAck(false); setConflict(false); setError(''); }}>取消预览</button>}
    </>}
    {records.map(record => <div key={record.payload.operation_id}><p>固定批次 {record.batchId}；操作 {record.payload.operation_id}{record.receipt ? `；服务端实际版本 ${record.receipt.annotation_revision_id}` : '；请求结果尚未确认'}</p>{record === pending && <button type="button" disabled={busy || record.sending || !props.canWrite || stale} onClick={() => void commit(true)}>{record.receipt ? '重新采用已确认导入版本' : '重放同一导入请求'}</button>}{record.scope !== props.scopeKey && <p>原范围请求记录只供核对；不会重用旧租约或自动采用旧响应。请重新读取服务器实际版本。</p>}</div>)}
    {stale && <p role="alert">原导入请求属于不同范围；不会将旧响应应用到新工作台，也不会释放原操作锁。</p>}
    {error && <p role={error.startsWith('导入成功') ? 'status' : 'alert'}>{error}</p>}
  </section>;
}
