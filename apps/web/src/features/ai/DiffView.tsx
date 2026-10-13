import { useEffect, useMemo, useState } from 'react';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { Change } from '../../../../../packages/contracts/generated/Change';
import type { SuggestionSet } from '../../../../../packages/contracts/generated/SuggestionSet';
import { projectRelabel } from '../../lib/editor/loader';
import { CandidateVisual } from './CandidateVisual';

function values(value: Record<string, unknown> | null): string {
  return value === null ? '—' : Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join(', ') || '—';
}


type Projection = { key: symbol; object: AnnotationObject | null; error: string | null };

export function DiffView({ change, objects, set, fixedDocument, fixedOntology, selected, onToggle, disabled, activeAsset = set.context.asset_revision_id, rejected = false, rejectDisabled = true, onReject }: {
  change: Change;
  objects: ReadonlyMap<string, AnnotationObject>;
  set: SuggestionSet;
  fixedDocument: AnnotationDocument | null;
  fixedOntology: OntologyVersion | null;
  selected: boolean;
  onToggle: (changeId: string, selected: boolean) => void;
  disabled: boolean;
  activeAsset?: string;
  rejected?: boolean;
  rejectDisabled?: boolean;
  onReject?: () => void;
}) {
  // useRun publishes cloned, read-only snapshots: a new scope replaces identities,
  // never mutates a fixed document/ontology/change/context in place. A token change
  // hides the old result during render, before effect cleanup can run.
  const key = useMemo(() => Symbol(), [fixedDocument, fixedOntology, change, set.context, set.model_run_id, set.suggestion_set_id]);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (change.kind !== 'set_label') return;
    let active = true;
    setProjection(null);
    if (!fixedDocument || !fixedOntology ||
      fixedDocument.asset_revision_id !== set.context.asset_revision_id ||
      fixedDocument.ontology_version_id !== set.context.ontology_version_id ||
      fixedOntology.ontology_version_id !== set.context.ontology_version_id ||
      fixedOntology.project_id !== set.context.project_id ||
      set.context.object_hashes[change.object_id] !== change.before_hash) {
      setProjection({ key, object: null, error: '固定标注或类别规范不可用，无法投影建议。' });
      return;
    }
    // The shared helper clones all inputs synchronously before loading WASM.
    // This read-only call never touches an EditorHost or SaveQueue.
    void projectRelabel(fixedDocument, fixedOntology, change).then(object => {
      if (!active) return;
      setProjection({ key, object, error: null });
    }).catch(() => {
      if (!active) return;
      setProjection({ key, object: null, error: '建议投影失败，不能采纳。请重新确认固定版本。' });
    });
    return () => { active = false; };
  }, [key]);
  const currentProjection = projection?.key === key ? projection : null;
  const projectionReady = change.kind !== 'set_label' || currentProjection?.object != null;
  const objectId = change.kind === 'create' ? change.object.object_id : change.object_id;
  const before = change.kind === 'create' ? null : change.kind === 'set_label'
    ? fixedDocument?.objects.find(object => object.object_id === objectId) ?? null
    : objects.get(objectId) ?? null;
  const beforeSummary = before === null ? '—' : '类别： ' + (fixedOntology?.labels.find(label => label.label_id === before.label_id)?.name ?? before.label_id) + '; ' + values(before.attributes);
  const after = change.kind === 'create' ? change.object : change.kind === 'set_attributes'
    ? before ? { ...before, attributes: { ...before.attributes, ...change.values } } : null
    : currentProjection?.object ?? null;
  const afterSummary = after ? '类别： ' + (fixedOntology?.labels.find(label => label.label_id === after.label_id)?.name ?? after.label_id) + '; ' + values(after.attributes) : '无法读取建议值';
  const afterGeometry = after ? JSON.stringify(after.geometry) : '无法读取';
  const reason = change.reason || '未提供理由';
  const labelName = after ? fixedOntology?.labels.find(label => label.label_id === after.label_id)?.name ?? after.label_id : before ? fixedOntology?.labels.find(label => label.label_id === before.label_id)?.name ?? before.label_id : '类别未知';
  const ordinal = fixedDocument?.objects.findIndex(object => object.object_id === objectId) ?? -1;
  return (
    <li data-testid={`candidate-${change.change_id}`}>
      <label>
        <input type="checkbox" checked={selected} disabled={disabled || !projectionReady} onChange={(event) => onToggle(change.change_id, event.currentTarget.checked)} aria-label={`选择建议 ${change.change_id}`} />
        <strong>{{ create: '新增对象', set_attributes: '修改属性', set_label: '修改类别' }[change.kind]}</strong> · 对象 <code>{objectId}</code>
      </label>
      <p><span>{labelName}</span> {ordinal >= 0 ? '#' + (ordinal + 1) : '（候选新增对象）'}</p>
      {rejected ? <p role="status">已拒绝（服务器记录）</p> : null}
      <button type="button" onClick={() => setFocus(value => !value)} aria-pressed={focus}>{focus ? '查看整图对照' : '定位建议局部'}</button>
      <CandidateVisual document={fixedDocument} before={before} after={after} activeAsset={activeAsset} focus={focus} />
      {onReject ? <button type="button" disabled={rejectDisabled || rejected} onClick={onReject}>拒绝此项</button> : null}
      {change.kind === 'set_label' && !projectionReady ? currentProjection?.error
        ? <p role="alert">{currentProjection.error}</p>
        : <p role="status">正在读取固定版本的建议投影…</p> : null}
      <dl>
        <dt>原值</dt><dd>{beforeSummary}</dd>
        <dt>建议值</dt><dd>{afterSummary}</dd>
      </dl><details><summary>形状与来源详情</summary><dl>
        <dt>形状</dt><dd>{change.kind === 'set_attributes' ? '未改变' : afterGeometry}</dd>
        <dt>来源</dt><dd>预测 <code>{set.prediction_id}</code> · 运行 <code>{set.model_run_id}</code></dd>
        <dt>评分</dt><dd>{set.score === null ? '未提供' : '模型评分，不代表正确率'}</dd>
      </dl></details>
      <p>{reason}</p>
    </li>
  );
}
