import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { AttributeDef } from '../../../../../packages/contracts/generated/AttributeDef';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
type Props = { objects: readonly AnnotationObject[]; ontology: OntologyVersion; onChange?: (key: string, value: Scalar) => void; disabled?: boolean; locked?: boolean; editContext?: string };
type ValueState = { kind: 'missing' | 'mixed' | 'uniform'; value: Scalar | undefined };
function stateFor(objects: readonly AnnotationObject[], key: string): ValueState {
  const first = objects[0], present = Object.hasOwn(first.attributes, key), value = first.attributes[key];
  for (const object of objects) if (Object.hasOwn(object.attributes, key) !== present || (present && object.attributes[key] !== value)) return { kind: 'mixed', value: undefined };
  return { kind: present ? 'uniform' : 'missing', value };
}
function invalidValue(definition: AttributeDef, value: Scalar | undefined, present: boolean): boolean {
  if (!present) return definition.required;
  if (value === null) return false;
  if (definition.kind === 'enum') return typeof value !== 'string' || !definition.enum_values.includes(value);
  if (definition.kind === 'boolean') return typeof value !== 'boolean';
  if (definition.kind === 'number') return typeof value !== 'number' || !Number.isFinite(value) || (definition.min !== null && value < definition.min) || (definition.max !== null && value > definition.max);
  return typeof value !== 'string';
}
const text = (value: Scalar | undefined) => value == null ? '' : String(value);
function DraftAttribute({ definition, state, invalid, unavailable, onChange }: { definition: AttributeDef; state: ValueState; invalid: boolean; unavailable: boolean; onChange: Props['onChange'] }) {
  const [draft, setDraft] = useState(() => text(state.value));
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false), composing = useRef(false);
  const id = 'attribute-' + definition.key, numeric = definition.kind === 'number';
  const emptyRange = numeric && definition.min !== null && definition.max !== null && definition.min > definition.max;
  useEffect(() => { if (!dirty.current) setDraft(text(state.value)); }, [state.value, state.kind]);
  const reset = () => { dirty.current = false; setDraft(text(state.value)); setError(null); };
  const submit = (value: Scalar) => { dirty.current = false; setDraft(text(value)); setError(null); if (state.kind !== 'uniform' || state.value !== value) onChange?.(definition.key, value); };
  const commit = () => {
    if (unavailable || !dirty.current || composing.current) return;
    dirty.current = false;
    if (numeric) {
      const value = Number(draft.trim());
      if (!draft.trim() || !Number.isFinite(value)) { setError('请输入有限数字；清空输入不等于 null。'); return; }
      if (emptyRange || (definition.min !== null && value < definition.min) || (definition.max !== null && value > definition.max)) { setError('数值超出共同范围。'); return; }
      submit(value);
    } else if ([...draft].length > 4096) setError('文字最多 4096 个字符。');
    else submit(draft);
  };
  return <div onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) commit(); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); reset(); } }}>
    <input id={id} data-testid={id} type="text" inputMode={numeric ? 'decimal' : undefined} autoComplete="off" placeholder={state.kind === 'mixed' ? '混合值' : state.kind === 'missing' ? '缺少键' : undefined} value={draft} disabled={unavailable || emptyRange} aria-invalid={invalid || !!error} onChange={event => { dirty.current = true; setDraft(event.target.value); setError(null); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.nativeEvent.isComposing || composing.current) return; if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
    <small>Enter 或离开字段提交；Esc 取消。{numeric ? '清空输入不等于 null。' : '空文本提交为空字符串。'}</small>
    {emptyRange ? <small>类别的数字区间没有交集，仅可设为 null。</small> : null}
    <div className="attribute-value-actions">{(numeric ? [null] : [null, '']).map(value => <button key={value === null ? 'null' : 'empty'} type="button" disabled={unavailable || (state.kind === 'uniform' && state.value === value && !dirty.current)} onMouseDown={event => event.preventDefault()} onClick={() => { if (!unavailable && !composing.current) submit(value); }}>{value === null ? '设为 null' : '设为空字符串'}</button>)}</div>
    {error ? <span className="field-error" role="alert">{error}</span> : null}
  </div>;
}
export function AttributePanel({ objects, ontology, onChange, disabled = false, locked = false, editContext }: Props) {
  const projection = useMemo(() => {
    const labels = new Map(ontology.labels.map(label => [label.label_id, label]));
    const schemas = [...new Set(objects.map(object => object.label_id))].map(id => labels.get(id)?.attributes ?? []);
    const common: AttributeDef[] = [];
    for (const definition of schemas[0] ?? []) {
      const definitions = schemas.map(schema => schema.find(item => item.key === definition.key));
      if (definitions.some(item => !item || item.kind !== definition.kind)) continue;
      const defs = definitions as AttributeDef[];
      const mins = defs.flatMap(item => item.min === null ? [] : [item.min]), maxs = defs.flatMap(item => item.max === null ? [] : [item.max]);
      common.push({ ...definition, required: defs.some(item => item.required), enum_values: definition.enum_values.filter(value => defs.every(item => item.enum_values.includes(value))), min: mins.length ? Math.max(...mins) : null, max: maxs.length ? Math.min(...maxs) : null });
    }
    const keys = new Set(common.map(item => item.key));
    const other = [...new Set(objects.flatMap(object => [...Object.keys(object.attributes), ...(labels.get(object.label_id)?.attributes.map(item => item.key) ?? [])]))].filter(key => !keys.has(key));
    return { labels, common, other };
  }, [objects, ontology]);
  const unavailable = disabled || locked || !onChange;
  const identity = useMemo(() => JSON.stringify([editContext, objects.map(object => [object.object_id, object.label_id]), ontology, unavailable]), [editContext, objects, ontology, unavailable]);
  return <section className="attribute-panel" aria-labelledby="attribute-heading"><div className="panel-heading"><h2 id="attribute-heading">属性</h2></div>
    {!objects.length ? <p className="muted">选择对象后查看属性</p> : <>
      <p className="selected-object" title={objects.length === 1 ? projection.labels.get(objects[0].label_id)?.name ?? objects[0].label_id : undefined}>{objects.length === 1 ? projection.labels.get(objects[0].label_id)?.name ?? objects[0].label_id : `已选择 ${objects.length} 个对象`}</p>
      <p>修改作用于全部 {objects.length} 个选中对象，包含过滤外和隐藏对象。</p>
      {locked ? <p role="status">选择中有锁定对象，整批禁止修改。</p> : null}
      <details className="object-details"><summary>对象详情与类别分布</summary>{[...new Set(objects.map(object => object.label_id))].map(id => <p key={id}>{projection.labels.get(id)?.name ?? id}：{objects.filter(object => object.label_id === id).length}</p>)}</details>
      <p className="muted">必填表示键必须存在；null、false、空字符串与缺少键不同。默认值不会回填已有对象。</p>
      <div className="attribute-fields">{projection.common.map(definition => {
        const state = stateFor(objects, definition.key), invalid = objects.some(object => { const original = projection.labels.get(object.label_id)?.attributes.find(item => item.key === definition.key); return !!original && invalidValue(original, object.attributes[definition.key], Object.hasOwn(object.attributes, definition.key)); });
        const id = 'attribute-' + definition.key;
        const value = state.kind !== 'uniform' ? state.kind : state.value === null ? 'null' : definition.kind === 'enum' && typeof state.value === 'string' && definition.enum_values.includes(state.value) ? 'value:' + definition.enum_values.indexOf(state.value) : definition.kind === 'boolean' && typeof state.value === 'boolean' ? String(state.value) : 'invalid';
        return <div className="attribute-field" key={definition.key}><label htmlFor={id}>{definition.key}{definition.required ? ' *' : ''}</label><small data-value-state={state.kind}>{state.kind === 'mixed' ? '混合值' : state.kind === 'missing' ? '缺少键' : state.value === null ? 'null（空值）' : state.value === '' ? '空字符串' : String(state.value)}</small>
          {definition.kind === 'text' || definition.kind === 'number' ? <DraftAttribute key={identity + definition.key} definition={definition} state={state} invalid={invalid} unavailable={unavailable} onChange={onChange} /> : <select id={id} data-testid={id} value={value} disabled={unavailable} aria-invalid={invalid} onChange={event => { if (unavailable) return; const raw = event.target.value; if (raw === 'null') onChange?.(definition.key, null); else if (definition.kind === 'boolean' && (raw === 'true' || raw === 'false')) onChange?.(definition.key, raw === 'true'); else if (raw.startsWith('value:')) onChange?.(definition.key, definition.enum_values[Number(raw.slice(6))]); }}><option value="mixed" disabled>混合值</option><option value="missing" disabled>缺少键</option><option value="invalid" disabled>非法源值</option><option value="null">null（空值）</option>{definition.kind === 'boolean' ? <><option value="false">false（否）</option><option value="true">true（是）</option></> : definition.enum_values.map((entry, index) => <option value={'value:' + index} key={entry}>{entry === '' ? '空字符串' : entry}</option>)}</select>}
          {invalid ? <span className="field-error" role="alert">缺少必填键或源值不符合类别要求</span> : null}</div>;
      })}</div>
      {projection.other.length ? <div className="unknown-values" role="alert" aria-label="未知属性值"><strong>非共同、不兼容或未知属性（只读）</strong>{projection.other.map(key => { const state = stateFor(objects, key); return <p key={key}>{key}: {state.kind === 'mixed' ? '混合值（在对象列表逐个选择查看）' : state.kind === 'missing' ? '缺少键' : JSON.stringify(state.value)}</p>; })}</div> : null}
    </>}
  </section>;
}
