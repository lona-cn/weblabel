import { useEffect, useMemo, useState } from 'react';
import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import { api } from '../../lib/t15/api';
import type { ReviewIssue } from './api';
import { VirtualReviewList } from './VirtualReviewList';

type Props = { projectId: string; revision: AnnotationRevision; parent: AnnotationRevision | null; issues: readonly ReviewIssue[] };
export function RevisionReviewView({ projectId, revision, parent, issues }: Props) {
  const [resource, setResource] = useState<{ revisionId: string; url: string; ontology: OntologyVersion } | null>(null);
  const [failure, setFailure] = useState('');
  const [version, setVersion] = useState<'before' | 'after'>('after');
  const [focused, setFocused] = useState<string | null>(null);
  const [region, setRegion] = useState<BBox | null>(null);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setResource(null); setFailure(''); setFocused(null); setRegion(null); setVersion('after');
    void Promise.all([api.image(revision.document.asset_revision_id), api.ontologies(projectId)]).then(([image, page]) => {
      if (!alive) return;
      const ontology = page.items.find(item => item.ontology_version_id === revision.document.ontology_version_id && item.project_id === projectId);
      if (!ontology) throw new Error('指定的固定类别规范不可读取，不能使用当前规范代替。');
      url = URL.createObjectURL(image);
      setResource({ revisionId: revision.annotation_revision_id, url, ontology });
    }).catch(error => { if (alive) setFailure(error instanceof Error ? error.message : '审核图像读取失败'); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [projectId, revision.annotation_revision_id, revision.document.asset_revision_id, revision.document.ontology_version_id]);
  const compatibleParent = parent && parent.document.asset_revision_id === revision.document.asset_revision_id && parent.document.ontology_version_id === revision.document.ontology_version_id ? parent : null;
  const shown = version === 'before' && compatibleParent ? compatibleParent : revision;
  const changed = useMemo(() => {
    const before = new Map((parent?.document.objects ?? []).map(object => [object.object_id, JSON.stringify(object)]));
    const after = new Map(revision.document.objects.map(object => [object.object_id, JSON.stringify(object)]));
    return new Set([...before.keys(), ...after.keys()].filter(id => before.get(id) !== after.get(id)));
  }, [parent, revision]);
  const selected = shown.document.objects.find(object => object.object_id === focused)?.geometry ?? region;
  const { width, height } = revision.document.coordinate_space;
  const viewBox = selected ? `${Math.max(0, selected.x_min - 20)} ${Math.max(0, selected.y_min - 20)} ${Math.max(40, selected.x_max - selected.x_min + 40)} ${Math.max(40, selected.y_max - selected.y_min + 40)}` : `0 0 ${width} ${height}`;
  const labels = new Map(resource?.ontology.labels.map(label => [label.label_id, label]) ?? []);
  return <section aria-label="不可变版本只读视觉审阅">
    <p>只读图像 + SVG 投影（不是可编辑 wgpu）。指定版本：{revision.annotation_revision_id}；固定规范：{revision.document.ontology_version_id}。</p>
    {failure && <p role="alert">{failure}；几何与差异仍保留，图像未就绪不能视为完成视觉检查。</p>}
    <button type="button" aria-pressed={version === 'after'} onClick={() => setVersion('after')}>提交后版本</button>
    <button type="button" disabled={!compatibleParent} aria-pressed={version === 'before'} onClick={() => setVersion('before')}>基线前版本</button>
    <button type="button" onClick={() => { setFocused(null); setRegion(null); }}>检查全图（含无变化区域）</button>
    {resource?.revisionId === revision.annotation_revision_id ? <svg role="img" aria-label={`固定版本 ${shown.annotation_revision_id} 的标注投影`} viewBox={viewBox} style={{ width: '100%', maxHeight: 500, background: '#151b20' }}>
      <image href={resource.url} width={width} height={height} />
      {shown.document.objects.map(object => <g key={object.object_id}><rect data-object-id={object.object_id} x={object.geometry.x_min} y={object.geometry.y_min} width={object.geometry.x_max - object.geometry.x_min} height={object.geometry.y_max - object.geometry.y_min} fill="none" stroke={focused === object.object_id ? '#ffea00' : changed.has(object.object_id) ? '#ff7c45' : labels.get(object.label_id)?.color ?? '#ffffff'} strokeWidth={focused === object.object_id ? 3 : 1.5} vectorEffect="non-scaling-stroke" /><title>{labels.get(object.label_id)?.name ?? object.label_id} · {object.object_id} · {changed.has(object.object_id) ? '有变化' : '无变化'}</title></g>)}
      {region && <rect x={region.x_min} y={region.y_min} width={region.x_max - region.x_min} height={region.y_max - region.y_min} fill="none" stroke="#ffea00" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
    </svg> : <p role="status">固定图像与规范尚未就绪。</p>}
    <p>本版本 {shown.document.objects.length} 个对象，完整投影；橙色为变化，黄色为定位。</p>
    <VirtualReviewList items={shown.document.objects} itemKey={object => object.object_id} label="审核对象">{object => <div><button type="button" onClick={() => { setFocused(object.object_id); setRegion(null); }}>{labels.get(object.label_id)?.name ?? object.label_id} · {object.object_id} · {changed.has(object.object_id) ? '变化' : '无变化'}：定位对象</button><details><summary>只读对象属性</summary><pre>{JSON.stringify(object.attributes, null, 2)}</pre></details></div>}</VirtualReviewList>
    <VirtualReviewList items={issues} itemKey={issue => issue.issue_id} label="审核问题">{issue => <div><p>{issue.message}</p><details><summary>问题来源</summary>{issue.code} · {issue.annotation_revision_id}</details><button type="button" disabled={issue.annotation_revision_id !== revision.annotation_revision_id || (!issue.object_id && !issue.region)} onClick={() => {
      setVersion('after'); setFocused(issue.object_id); setRegion(null);
      if (issue.region && typeof issue.region === 'object' && 'x_min' in issue.region && 'y_min' in issue.region && 'x_max' in issue.region && 'y_max' in issue.region) {
        const value = issue.region as BBox;
        if ([value.x_min, value.y_min, value.x_max, value.y_max].every(Number.isFinite) && value.x_max > value.x_min && value.y_max > value.y_min) setRegion(value);
      }
    }}>定位问题</button>{issue.object_id && !revision.document.objects.some(object => object.object_id === issue.object_id) && <p>对象不在指定版本中，问题来源保留；可检查全图或问题区域。</p>}</div>}</VirtualReviewList>
  </section>;
}
