import type { AnnotationImportContext } from './import-context';
import type { TransfersMountContext } from '../workbench/workbench-context';
import { api, ApiFailure, type AnnotationImportPreview } from '../../lib/t15/api';
import { getOutboxSnapshot, putImportIntent, removeImportIntent, subscribeOutbox, type ImportIntent } from './outbox';
import { element, field, actions, options, details, lossView, lifetime } from './delivery-dom';
import { diagnosticText as failureText, fileText, isAmbiguous, readLossReport } from './loss-report';
import { mountReadonlyProjection } from '../review/revision-review-view';
type Coco = { images: { id: number; file_name: string }[]; categories: { id: number; name: string; label_id?: string }[]; raw: Record<string, unknown> };
export function parseCocoSource(value: unknown): Coco {
  if (!value || typeof value !== 'object' || !('images' in value) || !Array.isArray(value.images) || !('categories' in value) || !Array.isArray(value.categories)) throw new Error('COCO文件需要images/categories。');
  const images: Coco['images'] = [], categories: Coco['categories'] = []; const imageIds = new Set<number>(), categoryIds = new Set<number>();
  for (const image of value.images) { if (!image || !Number.isSafeInteger(image.id) || typeof image.file_name !== 'string' || imageIds.has(image.id)) throw new Error('COCO来源图标识必须为唯一整数。'); imageIds.add(image.id); images.push({ id: image.id, file_name: image.file_name }); }
  for (const category of value.categories) { if (!category || !Number.isSafeInteger(category.id) || typeof category.name !== 'string' || categoryIds.has(category.id)) throw new Error('COCO类别标识必须为唯一整数。'); categoryIds.add(category.id); categories.push({ id: category.id, name: category.name, ...(typeof category.label_id === 'string' ? { label_id: category.label_id } : {}) }); }
  if (!images.length) throw new Error('COCO没有来源图。'); return { images, categories, raw: value as Record<string, unknown> };
}
export function mountAnnotationImportView(root: HTMLElement, context: TransfersMountContext): () => void {
  const life = lifetime(context.signal); let scope = context.getScope(); let busy = false, load = 0, source: File | null = null, coco: Coco | null = null, mapping: Record<string, string> = {}, yolo: string[] = [], ack = false, conflict = false;
  const action = actions(life.signal);
  let preview: { scopeKey: object; context: AnnotationImportContext; result: AnnotationImportPreview } | null = null; let previewUrl: string | null = null;
  const section = element('section'); section.setAttribute('aria-label', '标注格式导入'); const target = element('p'); const inputs = element('fieldset'); inputs.append(element('legend', '源文件与显式类别映射'));
  const format = element('select'); options(format, [{ value: 'native', text: 'Native原生包' }, { value: 'yolo', text: 'YOLO' }, { value: 'coco', text: 'COCO' }], 'coco');
  const file = element('input'); file.type = 'file'; file.accept = '.json'; const sourceImage = element('select'); const sourceImageLabel = field('COCO来源图', sourceImage); const mappingRoot = element('div');
  const addYolo = action('增加YOLO类别编号', () => { if (held() || busy) return; yolo.push(''); buildMapping(); }); const removeYolo = action('移除最后YOLO类别编号', () => { if (held() || busy || yolo.length < 2) return; yolo.pop(); buildMapping(); });
  const make = action('生成只读预览', () => void makePreview()); inputs.append(field('标注格式', format), field('标注源文件', file), sourceImageLabel, mappingRoot, addYolo, removeYolo, make);
  const output = element('div'), retained = element('div'), error = element('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const ackInput = element('input'); ackInput.type = 'checkbox'; const ackLabel = field('我已阅读并确认导入损失', ackInput); const commitButton = action('确认导入', () => void commit()); commitButton.className = 'primary';
  const cancel = action('取消预览', () => { if (!preview || busy || pending()) return; context.releaseImport(preview.scopeKey); clearPreview(); error.hidden = true; render(); });
  const columns = element('div', undefined, 'delivery-grid delivery-import-grid'), confirmation = element('div');
  confirmation.append(output, ackLabel, commitButton, cancel); columns.append(inputs, confirmation);
  section.append(element('h3', '标注导入预览'), target, columns, retained, error); root.append(section);
  function current(key: object) { const now = context.getScope(); return life.alive && now.scopeKey === key; }
  function records() { const now = context.getScope(); return getOutboxSnapshot().imports.filter(record => record.target.projectId === context.projectId && record.target.assetRevisionId === now.asset?.asset_revision_id && record.target.ontologyId === now.ontology?.ontology_version_id); }
  function pending() { const all = records(); return all.find(record => record.scope === context.getScope().scopeKey) ?? all[0] ?? null; }
  function held() { return !!preview || !!pending(); }
  function clearPreview() { preview = null; ack = false; conflict = false; output.replaceChildren(); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
  function showError(cause: unknown) { if (!life.alive) return; error.hidden = false; error.textContent = failureText(cause); }
  function buildMapping() {
    mappingRoot.replaceChildren(); const labels = context.getScope().ontology?.labels ?? [];
    sourceImageLabel.hidden = !coco || format.value !== 'coco'; addYolo.hidden = removeYolo.hidden = format.value !== 'yolo';
    if (format.value === 'coco' && coco) {
      options(sourceImage, [{ value: '', text: '请选择明确来源图' }, ...coco.images.map(image => ({ value: String(image.id), text: `${image.file_name} (ID ${image.id})` }))]);
      if (coco.images.length === 1) sourceImage.value = String(coco.images[0].id);
      for (const category of coco.categories) { const select = element('select'); options(select, [{ value: '', text: '请选择目标类别' }, ...labels.map(label => ({ value: label.label_id, text: label.name }))], mapping[String(category.id)] ?? ''); select.addEventListener('change', () => { if (!held() && !busy) mapping[String(category.id)] = select.value; }, { signal: life.signal }); mappingRoot.append(field(`类别映射 ${category.name}`, select)); }
    }
    if (format.value === 'yolo') { mappingRoot.append(element('p', '类别编号从0开始，按以下明确顺序映射；必须合法且唯一。')); yolo.forEach((id, index) => { const select = element('select'); options(select, [{ value: '', text: '请选择目标类别' }, ...labels.map(label => ({ value: label.label_id, text: label.name }))], id); select.addEventListener('change', () => { if (!held() && !busy) yolo[index] = select.value; }, { signal: life.signal }); mappingRoot.append(field(`YOLO类别 ${index}`, select)); }); }
    if (format.value === 'native') mappingRoot.append(element('p', 'Native使用包内固定类别身份；由服务端校验与目标规范的一致性，不猜测或重映射。'));
  }
  function render() {
    if (!life.alive) return; const now = context.getScope(), operation = pending(), report = preview ? readLossReport(preview.result.loss_report) : null;
    target.textContent = `目标图片：${now.asset?.original_name ?? '未选择媒体'} · 固定规范 ${now.ontology?.ontology_version_id ?? '未载入'}`;
    section.setAttribute('aria-busy', String(busy)); inputs.disabled = busy || held() || !now.canWrite || !now.asset || !now.ontology; make.disabled = !source; ackLabel.hidden = !preview || !report?.losses.length; ackInput.checked = ack; ackInput.disabled = busy || !!operation || conflict;
    commitButton.hidden = !preview || !!operation; commitButton.disabled = busy || !now.canWrite || conflict || !report || (!!report.losses.length && !ack) || preview?.scopeKey !== now.scopeKey;
    cancel.hidden = !preview || !!operation; cancel.disabled = busy;
    retained.replaceChildren();
    for (const record of records()) { const block = element('section'); block.append(element('p', `固定批次 ${record.batchId} · 原操作 ${record.payload.operation_id} · ${record.receipt ? `已确认版本 ${record.receipt.annotation_revision_id}` : '结果未知，原载荷与租约保留'}`));
      if (record.scope !== now.scopeKey) block.append(element('p', '原请求属于不同范围，只供核对；不会采用旧响应或释放原操作锁，也不会创建替代请求。'));
      else if (record.receipt) { const adopt = action('重新采用已确认导入版本', () => void commit()); adopt.disabled = busy || record.sending || !now.canWrite; block.append(adopt); }
      else { const check = action('只读重新核对原导入版本', () => void reconcile(record)); check.disabled = busy; block.append(check); }
      retained.append(block);
    }
  }
  file.addEventListener('change', () => { if (busy || held() || !context.getScope().canWrite) return; source = file.files?.[0] ?? null; coco = null; mapping = {}; error.hidden = true; const key = context.getScope().scopeKey, sequence = ++load; buildMapping(); render(); if (!source || format.value !== 'coco') return;
    void fileText(source, life.signal).then(text => { if (!current(key) || sequence !== load) return; coco = parseCocoSource(JSON.parse(text)); mapping = Object.fromEntries(coco.categories.map(category => [String(category.id), context.getScope().ontology?.labels.some(label => label.label_id === category.label_id) ? category.label_id! : ''])); buildMapping(); render(); }).catch(cause => { if (current(key) && sequence === load) showError(new Error(`COCO来源无法读取，尚未生成预览或提交。${cause instanceof Error ? cause.message : ''}`)); });
  }, { signal: life.signal });
  format.addEventListener('change', () => { if (busy || held()) return; load++; source = null; file.value = ''; coco = null; mapping = {}; yolo = context.getScope().ontology?.labels.map(label => label.label_id) ?? []; file.accept = format.value === 'coco' ? '.json' : format.value === 'yolo' ? '.txt' : '.zip'; buildMapping(); render(); }, { signal: life.signal });
  ackInput.addEventListener('change', () => { if (!busy && !pending()) ack = ackInput.checked; render(); }, { signal: life.signal });
  async function makePreview() {
    const now = context.getScope(); if (!life.alive || busy || held() || !now.canWrite || !now.asset || !now.ontology || !source) return;
    const key = now.scopeKey, original = source, selectedFormat = format.value; const legal = new Set(now.ontology.labels.map(label => label.label_id));
    if (selectedFormat === 'coco' && (!coco || !sourceImage.value || coco.categories.some(category => !legal.has(mapping[String(category.id)])))) { showError(new Error('请明确选择COCO来源图，并将每个来源类别映射到固定规范。')); return; }
    if (selectedFormat === 'yolo' && (!yolo.length || yolo.some(id => !legal.has(id)) || new Set(yolo).size !== yolo.length)) { showError(new Error('YOLO有序类别必须合法且唯一。')); return; }
    busy = true; error.hidden = true; render(); let prepared = false;
    try {
      const ticket = await context.prepareImport(); prepared = true;
      if (!current(key)) { context.releaseImport(key); prepared = false; return; }
      if (!context.getScope().canWrite || ticket.asset_revision_id !== now.asset.asset_revision_id || ticket.ontology_version_id !== now.ontology.ontology_version_id) throw new Error('导入目标已变化。');
      const body = new FormData(); body.append('format', selectedFormat); body.append('ontology_version_id', ticket.ontology_version_id);
      if (selectedFormat === 'coco' && coco) { body.append('source_image_id', sourceImage.value); const categories = coco.raw.categories; if (!Array.isArray(categories)) throw new Error('COCO类别无效。'); body.append('data', new Blob([JSON.stringify({ ...coco.raw, categories: categories.map(category => ({ ...category, label_id: mapping[String(category.id)] })) })], { type: 'application/json' }), original.name); }
      else { if (selectedFormat === 'yolo') body.append('label_ids', JSON.stringify(yolo)); body.append('data', original, original.name); }
      const result = await api.previewAnnotationImport(ticket.asset_revision_id, body);
      if (!current(key)) { context.releaseImport(key); prepared = false; return; }
      if (!result?.import_batch_id || result.base_revision_id !== ticket.base_revision_id || result.document?.asset_revision_id !== ticket.asset_revision_id || result.document?.ontology_version_id !== ticket.ontology_version_id || !Array.isArray(result.document.objects) || !readLossReport(result.loss_report)) throw new Error('预览身份、可空基线或损失报告无效。');
      preview = { scopeKey: key, context: ticket, result }; ack = false; conflict = false; output.replaceChildren(element('h3', '只读预览 · 非编辑画布'), element('p', `实际对象 ${result.document.objects.length} · 完成状态 ${result.document.completion}；空对象不等于已确认负样本。`), details('实际文档与明确映射', { document: result.document, source_image_id: selectedFormat === 'coco' ? sourceImage.value : null, mapping: selectedFormat === 'coco' ? mapping : yolo }), lossView(readLossReport(result.loss_report)!));
      const graphic = element('div'); output.prepend(graphic);
      void api.image(ticket.asset_revision_id, life.signal).then(image => { if (!current(key) || preview?.result !== result) return; previewUrl = URL.createObjectURL(image); mountReadonlyProjection(graphic, result.document, now.ontology!, previewUrl); }).catch(cause => { if (current(key)) showError(cause); });
      prepared = false;
    } catch (cause) { if (current(key)) showError(cause); if (prepared) context.releaseImport(key); }
    finally { busy = false; render(); }
  }
  async function commit() {
    const now = context.getScope(); let operation = pending(); if (!life.alive || busy || !now.canWrite || conflict) return;
    if (operation && (operation.scope !== now.scopeKey || operation.sending || !operation.receipt)) return;
    if (!operation) { if (!preview || preview.scopeKey !== now.scopeKey) return; const report = readLossReport(preview.result.loss_report); if (!report || (report.losses.length && !ack)) return;
      operation = { scope: preview.scopeKey, target: Object.freeze({ projectId: context.projectId, assetRevisionId: preview.context.asset_revision_id, ontologyId: preview.context.ontology_version_id }), batchId: preview.result.import_batch_id, payload: Object.freeze({ operation_id: crypto.randomUUID(), loss_ack: ack, lease: preview.context.lease ? Object.freeze({ ...preview.context.lease }) : null }), receipt: null, sending: false };
    }
    const fixed = { ...operation, sending: true }; const key = now.scopeKey; const wasUnknown = !operation.receipt && !!pending(); let confirmed = fixed.receipt;
    busy = true; putImportIntent(fixed); error.hidden = true; render();
    try {
      if (!confirmed) { const response = await api.commitAnnotationImport(fixed.batchId, fixed.payload); if (response.import_batch_id !== fixed.batchId || !response.revision?.annotation_revision_id || response.revision.document.asset_revision_id !== fixed.target.assetRevisionId || response.revision.document.ontology_version_id !== fixed.target.ontologyId) throw new Error('导入响应无法确认原批次身份。'); confirmed = response.revision; putImportIntent({ ...fixed, receipt: confirmed, sending: false }); }
      if (!current(key) || fixed.scope !== key) return; await context.commitImport(confirmed, key); removeImportIntent(fixed); clearPreview();
    } catch (cause) {
      const rejected = !confirmed && !wasUnknown && !isAmbiguous(cause);
      if (rejected) removeImportIntent(fixed); else putImportIntent({ ...fixed, receipt: confirmed, sending: false });
      if (current(key)) { if (rejected && cause instanceof ApiFailure && cause.code === 'REVISION_CONFLICT') { conflict = true; ack = false; } showError(confirmed ? new Error('服务器ACK已确认导入；本地IndexedDB持久采用尚未完成，不能宣称本地已保存。保留原范围锁与实际版本，只重新采用同一回执，不再次POST。') : rejected ? cause : new Error(`导入结果未知，原批次、载荷与租约保留，仅只读核对。${failureText(cause)}`)); }
    } finally { busy = false; render(); }
  }
  async function reconcile(record: ImportIntent) {
    if (!life.alive || busy || record.scope !== context.getScope().scopeKey) return; busy = true; render(); const key = context.getScope().scopeKey;
    try { const revision = await api.annotation(record.target.assetRevisionId, record.target.ontologyId, life.signal); if (!current(key)) return;
      // A current head cannot prove which POST created it. Preserve the original packet and lock.
      showError(new Error(`只读观察到版本 ${revision.annotation_revision_id}，不能唯一确认原导入操作 ${record.payload.operation_id}；保持未知，不重新提交或采用。`));
    } catch (cause) { if (current(key)) showError(cause); } finally { busy = false; render(); }
  }
  life.add(context.subscribe(() => { const next = context.getScope(); if (next.scopeKey !== scope.scopeKey) { load++; if (preview && !getOutboxSnapshot().imports.some(record => record.scope === preview!.scopeKey)) context.releaseImport(preview.scopeKey); clearPreview(); if (next.asset?.asset_revision_id !== scope.asset?.asset_revision_id || next.ontology?.ontology_version_id !== scope.ontology?.ontology_version_id) { source = null; file.value = ''; coco = null; mapping = {}; yolo = next.ontology?.labels.map(label => label.label_id) ?? []; } scope = next; buildMapping(); } render(); }));
  life.add(subscribeOutbox(render)); life.add(context.session.subscribe(render));
  life.add(() => { load++; if (preview && !getOutboxSnapshot().imports.some(record => record.scope === preview!.scopeKey)) context.releaseImport(preview.scopeKey); clearPreview(); section.remove(); }); yolo = scope.ontology?.labels.map(label => label.label_id) ?? []; buildMapping(); render(); return life.dispose;
}
