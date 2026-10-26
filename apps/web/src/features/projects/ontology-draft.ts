import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';

export type AttributeDraft = { key: string; kind: 'enum' | 'boolean' | 'number' | 'text'; required: boolean; isNull: boolean; value: string; values: string; min: string; max: string };
export type LabelDraft = { id: string; name: string; color: string; shortcut: string; attributes: AttributeDraft[] };
export type OntologyBody = Pick<OntologyVersion, 'labels' | 'guidelines_markdown'>;
export const newLabel = (): LabelDraft => ({ id: crypto.randomUUID(), name: '', color: '#e2763d', shortcut: '', attributes: [] });
export function bounded(text: string, max: number, name: string, required = true) {
  if ((required && !text.trim()) || new TextEncoder().encode(text).byteLength > max) throw new Error(`${name}须为${required ? '1–' : '0–'}${max} UTF-8 字节`);
}
function numeric(text: string): number | null {
  if (text === '') return null;
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('数值必须有限');
  return Number(text);
}
export function build(labels: LabelDraft[], guidelines: string): OntologyBody {
  if (!labels.length) throw new Error('至少保留一个类别');
  bounded(guidelines, 65536, '指南', false);
  return { guidelines_markdown: guidelines, labels: labels.map(label => {
    bounded(label.name, 128, '类别名称'); bounded(label.id, 128, '类别 ID'); bounded(label.color, 32, '颜色');
    if (label.shortcut && new TextEncoder().encode(label.shortcut).byteLength !== 1) throw new Error('快捷键须为单字节字符');
    const keys = new Set<string>();
    return { label_id: label.id, name: label.name, color: label.color, shortcut: label.shortcut || null, allowed_geometry_types: ['bbox_xyxy'] as ['bbox_xyxy'], attributes: label.attributes.map(a => {
      bounded(a.key, 128, '属性键'); if (keys.has(a.key)) throw new Error('属性键重复'); keys.add(a.key);
      const values = a.kind === 'enum' ? a.values.split('\n') : [];
      if (new Set(values).size !== values.length) throw new Error('枚举值不可重复（空字符串也计为一个选项）');
      const min = numeric(a.min); const max = numeric(a.max);
      if (min !== null && max !== null && min > max) throw new Error('最小值不能大于最大值');
      const value = a.isNull ? null : a.kind === 'boolean' ? a.value === 'true' : a.kind === 'number' ? numeric(a.value) : a.value;
      if (!a.isNull && a.kind === 'number' && value === null) throw new Error('数值默认值不能为空');
      if (a.kind === 'enum' && value !== null && !values.includes(String(value))) throw new Error('枚举默认值必须在枚举值中');
      if (a.kind === 'text' && typeof value === 'string') bounded(value, 4096, '文本默认值', false);
      if (typeof value === 'number' && ((min !== null && value < min) || (max !== null && value > max))) throw new Error('默认值超出数值范围');
      return { key: a.key, kind: a.kind, required: a.required, default_value: value, enum_values: values, min, max };
    }) };
  }) };
}
export function fromVersion(version: OntologyVersion): LabelDraft[] {
  return version.labels.map(l => ({ id: l.label_id, name: l.name, color: l.color, shortcut: l.shortcut ?? '', attributes: l.attributes.map(a => ({ key: a.key, kind: a.kind, required: a.required, isNull: a.default_value === null, value: a.default_value === null ? '' : String(a.default_value), values: a.enum_values.join('\n'), min: a.min === null ? '' : String(a.min), max: a.max === null ? '' : String(a.max) })) }));
}

export type OntologyDiffValue = string | number | boolean | null | readonly string[] | undefined;
export type OntologyDiffField = 'name' | 'color' | 'shortcut' | 'kind' | 'required' | 'default_value' | 'enum_values' | 'min' | 'max' | 'guidelines_markdown';
export interface OntologyChange {
  entity: 'category' | 'attribute' | 'guidelines';
  labelId: string | null;
  labelName: string;
  attributeKey: string | null;
  occurrence: number;
  field: OntologyDiffField;
  kind: 'added' | 'removed' | 'changed';
  before: OntologyDiffValue;
  after: OntologyDiffValue;
}
export interface OntologyComparison { changes: OntologyChange[]; validationError: string | null }

function comparableNumber(text: string): number | null | string {
  try { return numeric(text); }
  catch { return text; } // Keep invalid input visible; comparison must not repair a draft.
}
function comparableAttribute(attribute: AttributeDraft) {
  let value: string | number | boolean | null = attribute.value;
  if (attribute.isNull) value = null;
  else if (attribute.kind === 'boolean') value = attribute.value === 'true' ? true : attribute.value === 'false' ? false : attribute.value;
  else if (attribute.kind === 'number') value = attribute.value === '' ? '' : comparableNumber(attribute.value);
  return {
    kind: attribute.kind, required: attribute.required, default_value: value,
    enum_values: attribute.kind === 'enum' ? attribute.values.split('\n') : [],
    min: comparableNumber(attribute.min), max: comparableNumber(attribute.max),
  };
}
/** Compare published and draft values through the same representation, never wire-vs-form JSON. */
export function compareOntologyDraft(baseline: OntologyVersion, labels: LabelDraft[], guidelines: string): OntologyComparison {
  const changes: OntologyChange[] = [];
  let validationError: string | null = null;
  try { build(labels, guidelines); }
  catch (reason) { validationError = reason instanceof Error ? reason.message : '规范草稿无效'; }
  function record(identity: Omit<OntologyChange, 'field' | 'kind' | 'before' | 'after'>, field: OntologyDiffField, before: OntologyDiffValue, after: OntologyDiffValue) {
    if (Object.is(before, after) || (Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.every((value, index) => value === after[index]))) return;
    changes.push({ ...identity, field, kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', before, after });
  }
  const oldLabels = fromVersion(baseline);
  const labelIds = new Set([...oldLabels.map(label => label.id), ...labels.map(label => label.id)]);
  for (const labelId of labelIds) {
    const old = oldLabels.find(label => label.id === labelId), draft = labels.find(label => label.id === labelId);
    const identity = { entity: 'category' as const, labelId, labelName: draft?.name ?? old?.name ?? labelId, attributeKey: null, occurrence: 0 };
    for (const field of ['name', 'color', 'shortcut'] as const) {
      record(identity, field, old ? field === 'shortcut' ? old.shortcut || null : old[field] : undefined, draft ? field === 'shortcut' ? draft.shortcut || null : draft[field] : undefined);
    }
    const keys = new Set([...(old?.attributes ?? []).map(attribute => attribute.key), ...(draft?.attributes ?? []).map(attribute => attribute.key)]);
    for (const key of keys) {
      const before = old?.attributes.filter(attribute => attribute.key === key) ?? [], after = draft?.attributes.filter(attribute => attribute.key === key) ?? [];
      // Invalid duplicate keys remain separate occurrences rather than disappearing into a Map.
      for (let occurrence = 0; occurrence < Math.max(before.length, after.length); occurrence++) {
        const oldAttribute = before[occurrence] ? comparableAttribute(before[occurrence]) : null;
        const draftAttribute = after[occurrence] ? comparableAttribute(after[occurrence]) : null;
        for (const field of ['kind', 'required', 'default_value', 'enum_values', 'min', 'max'] as const) {
          record({ ...identity, entity: 'attribute', attributeKey: key, occurrence }, field, oldAttribute ? oldAttribute[field] : undefined, draftAttribute ? draftAttribute[field] : undefined);
        }
      }
    }
  }
  record({ entity: 'guidelines', labelId: null, labelName: '', attributeKey: null, occurrence: 0 }, 'guidelines_markdown', baseline.guidelines_markdown, guidelines);
  return { changes, validationError };
}

export function formatOntologyDiffValue(value: OntologyDiffValue): string {
  if (value === undefined) return '未包含';
  if (value === null) return 'null · 显式空值';
  if (Array.isArray(value)) return value.length ? value.map(item => JSON.stringify(item)).join('\n') : '无枚举选项';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
