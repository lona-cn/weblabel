import { useMemo, useState } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { DraftBranchEnvelope, DraftRecord } from '../../lib/persistence/types';
import { admitRawDraft } from '../../lib/persistence/draft-store';
export function DraftComparison({ envelope, server, readable }: { envelope: DraftBranchEnvelope; server?: AnnotationDocument; readable: boolean }) {
  const [expanded, setExpanded] = useState(false), [page, setPage] = useState(0);
  const record = useMemo(() => { if (!readable) return null; try { admitRawDraft(envelope.record, envelope.asset_revision_id); return envelope.record as DraftRecord; } catch { return null; } }, [envelope, readable]);
  const changes = useMemo(() => {
    if (!expanded || !record || !server || server.asset_revision_id !== record.asset_revision_id || server.ontology_version_id !== record.ontology_version_id) return null;
    const before = new Map(server.objects.map(object => [object.object_id, object])), after = new Map(record.document.objects.map(object => [object.object_id, object]));
    const result: { id: string; fields: string[]; before: unknown; after: unknown }[] = [];
    for (const [id, object] of after) {
      const original = before.get(id);
      const fields: string[] = [];
      if (!original) fields.push('新增对象');
      else {
        if (original.label_id !== object.label_id) fields.push('类别');
        const a = original.geometry, b = object.geometry;
        if (a.x_min !== b.x_min || a.x_max !== b.x_max || a.y_min !== b.y_min || a.y_max !== b.y_max) fields.push('几何');
        if (original.origin.type !== object.origin.type || original.origin.prediction_id !== object.origin.prediction_id || original.origin.model_run_id !== object.origin.model_run_id || original.origin.import_batch_id !== object.origin.import_batch_id) fields.push('来源');
        for (const key of new Set([...Object.keys(original.attributes), ...Object.keys(object.attributes)])) if (Object.hasOwn(original.attributes, key) !== Object.hasOwn(object.attributes, key) || original.attributes[key] !== object.attributes[key]) fields.push('属性 ' + key);
      }
      if (fields.length) result.push({ id, fields, before: original ?? null, after: object });
    }
    for (const [id, object] of before) if (!after.has(id)) result.push({ id, fields: ['删除对象'], before: object, after: null });
    return result;
  }, [record, server, expanded]);
  if (!record) return <p>此分支只能下载原始救援；不会读取、修正或合并内容。</p>;
  return <div><p>对象 {record.document.objects.length} · 完成状态 {record.document.completion} · 操作版本 {record.generation} / 已同步 {record.synced_generation} · {record.pending_outcome === 'unknown' ? '原请求结果未知' : record.writes_paused ? '保存暂停' : '未解除任何保存限制'}</p><details onToggle={event => setExpanded(event.currentTarget.open)}><summary>只读文档差异（与已读取服务版本比较，不自动合并）</summary>{!expanded ? null : changes === null ? <p>没有同图片、同固定规范的可比较服务版本。</p> : <><p>完成状态：服务 {server!.completion} → 本地 {record.document.completion}；变化对象 {changes.length}</p><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页差异</button><button type="button" disabled={(page + 1) * 50 >= changes.length} onClick={() => setPage(value => value + 1)}>下一页差异</button>{changes.slice(page * 50, (page + 1) * 50).map(change => <details key={change.id}><summary>{change.id} · {change.fields.join('、')}</summary><div><h4>服务版本</h4><pre>{JSON.stringify(change.before, null, 2)}</pre><h4>本地分支</h4><pre>{JSON.stringify(change.after, null, 2)}</pre></div></details>)}</>}</details></div>;
}
