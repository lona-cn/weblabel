import type { AttributeDef } from '../../../../../packages/contracts/generated/AttributeDef';
import type { AnnotationObject } from '../../../../../packages/contracts/generated/AnnotationObject';
import type { Scalar } from '../../../../../packages/contracts/generated/Scalar';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import { composeBBox, geometryDraft, sameBBox, type GeometryField, type GeometryDraft } from './geometry-values';
import { action, element, labeled, option } from './view-elements';
import { selectedIds, type WorkspaceState } from './workspace-state';
import type { EditorPort } from './editor-port';

export function commonAttributes(objects: readonly AnnotationObject[], ontology: OntologyVersion): AttributeDef[] {
  const schemas = [...new Set(objects.map(object => object.label_id))].map(id => ontology.labels.find(label => label.label_id === id)?.attributes ?? []);
  const common: AttributeDef[] = [];
  for (const definition of schemas[0] ?? []) {
    const definitions = schemas.map(schema => schema.find(item => item.key === definition.key));
    if (definitions.some(item => !item || item.kind !== definition.kind)) continue;
    const defs = definitions as AttributeDef[], mins = defs.flatMap(item => item.min === null ? [] : [item.min]), maxs = defs.flatMap(item => item.max === null ? [] : [item.max]);
    common.push({ ...definition, required: defs.some(item => item.required), enum_values: definition.enum_values.filter(value => defs.every(item => item.enum_values.includes(value))), min: mins.length ? Math.max(...mins) : null, max: maxs.length ? Math.min(...maxs) : null });
  }
  return common;
}
export function attributeState(objects: readonly AnnotationObject[], key: string): { kind: 'mixed' | 'missing' | 'uniform'; value?: Scalar } {
  if (!objects.length) return { kind: 'missing' };
  const present = Object.hasOwn(objects[0].attributes, key), value = objects[0].attributes[key];
  if (objects.some(object => Object.hasOwn(object.attributes, key) !== present || present && object.attributes[key] !== value)) return { kind: 'mixed' };
  return { kind: present ? 'uniform' : 'missing', value };
}
function invalidAttribute(definition: AttributeDef, value: Scalar | undefined, present: boolean): boolean {
  if (!present) return definition.required;
  if (value === null) return false;
  if (definition.kind === 'enum') return typeof value !== 'string' || !definition.enum_values.includes(value);
  if (definition.kind === 'boolean') return typeof value !== 'boolean';
  if (definition.kind === 'number') return typeof value !== 'number' || !Number.isFinite(value) || definition.min !== null && value < definition.min || definition.max !== null && value > definition.max;
  return typeof value !== 'string';
}
interface AttributeField {
  wrapper: HTMLElement; input: HTMLInputElement | HTMLSelectElement; value: HTMLElement; error: HTMLElement;
  dirty: boolean; composing: boolean; definition: AttributeDef; baseline: object | null; buttons: HTMLButtonElement[];
}
export function mountAttributesView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): () => void {
  const title = element('h2', '对象属性'), info = element('p'), warning = element('p'); warning.setAttribute('role', 'status');
  const category = element('select'); category.dataset.testid = 'selected-label';
  const fieldsRoot = element('div', undefined, 'r07-attribute-fields'), other = element('div'); other.setAttribute('role', 'note');
  const geometry = element('section', undefined, 'r07-geometry'); geometry.dataset.testid = 'numeric-geometry'; geometry.setAttribute('aria-label', '几何数值');
  const geometryError = element('p'); geometryError.dataset.testid = 'geometry-error'; geometryError.setAttribute('role', 'alert');
  const geometryFields = element('div', undefined, 'r07-geometry-fields'), inputs = new Map<GeometryField, HTMLInputElement>();
  const explanation = element('p', 'Enter 应用完整几何；Esc 取消。一次提交对应一次撤销。');
  let composingGeometry = false, geometryDirty = false;
  let baseline: { scope: object; generation: number | null; id: string; bbox: BBox } | null = null;
  const resetGeometry = () => {
    const ids = selectedIds(state), object = ids.length === 1 ? state.objects.find(item => item.object_id === ids[0]) : null;
    baseline = object ? { scope: state.scope, generation: state.host?.getGeneration() ?? null, id: object.object_id, bbox: object.geometry } : null;
    const draft = object ? geometryDraft(object.geometry) : { x: '', y: '', w: '', h: '' };
    for (const [key, input] of inputs) input.value = draft[key];
    geometryDirty = false; geometryError.textContent = '';
  };
  const commitGeometry = () => {
    if (!baseline || !geometryDirty || composingGeometry || !port.selectionWritable()) return;
    const ids = selectedIds(state), object = state.objects.find(item => item.object_id === baseline!.id), document = port.getSnapshot();
    if (!object || !document || ids.length !== 1 || ids[0] !== baseline.id || baseline.scope !== state.scope || state.host?.getGeneration() !== baseline.generation || !sameBBox(object.geometry, baseline.bbox)) { resetGeometry(); geometryError.textContent = '选择或文档已变化，旧几何输入已取消。'; return; }
    const draft = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value])) as GeometryDraft;
    const outcome = composeBBox(draft, document.coordinate_space);
    if ('error' in outcome) { geometryError.textContent = outcome.error; return; }
    const original = geometryDraft(baseline.bbox);
    if (draft.x === original.x && draft.w === original.w) { outcome.bbox.x_min = baseline.bbox.x_min; outcome.bbox.x_max = baseline.bbox.x_max; }
    if (draft.y === original.y && draft.h === original.h) { outcome.bbox.y_min = baseline.bbox.y_min; outcome.bbox.y_max = baseline.bbox.y_max; }
    if (sameBBox(object.geometry, outcome.bbox)) { geometryDirty = false; return; }
    const delta = port.dispatch({ kind: 'replace_geometry', object_id: baseline.id, geometry: outcome.bbox });
    if (!delta || delta.error) geometryError.textContent = delta?.error?.message ?? '当前禁止修改几何。';
  };
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    const input = element('input'); input.inputMode = 'decimal'; input.dataset.testid = 'geometry-' + key; input.setAttribute('aria-label', key + ' canonical 像素'); inputs.set(key, input);
    input.addEventListener('input', () => { geometryDirty = true; }, { signal });
    input.addEventListener('compositionstart', () => { composingGeometry = true; }, { signal }); input.addEventListener('compositionend', () => { composingGeometry = false; }, { signal });
    input.addEventListener('keydown', event => { if (event.isComposing || composingGeometry) return; if (event.key === 'Enter') { event.preventDefault(); commitGeometry(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); resetGeometry(); } }, { signal });
    geometryFields.append(labeled(key + ' (px)', input));
  }
  const apply = action('应用完整几何', 'geometry-apply', signal, commitGeometry), cancel = action('取消几何输入', 'geometry-cancel', signal, resetGeometry);
  geometry.append(element('h3', '几何 · canonical 连续像素'), geometryError, geometryFields, apply, cancel, explanation);
  root.append(title, info, warning, labeled('类别', category), element('small', '必填表示键必须存在；null、false、空字符串与缺少键不同。默认值不回填已有对象。'), fieldsRoot, other, geometry);
  const fields = new Map<string, AttributeField>();
  let identity = '', schema = '', editScope = state.scope, categoryOntology: OntologyVersion | null = null;
  function commitField(field: AttributeField, explicit?: Scalar) {
    if (field.composing || !port.selectionWritable() || field.baseline !== state.scope) return;
    if (explicit === undefined && !field.dirty) return;
    const definition = field.definition;
    let value: Scalar = explicit === undefined ? field.input.value : explicit;
    if (explicit === undefined && definition.kind === 'number') {
      const raw = field.input.value.trim(); value = Number(raw);
      if (!raw || !Number.isFinite(value) || definition.min !== null && value < definition.min || definition.max !== null && value > definition.max) { field.error.textContent = '请输入共同范围内的有限数字；清空输入不等于 null。'; field.input.setAttribute('aria-invalid', 'true'); return; }
    } else if (explicit === undefined && definition.kind === 'text' && [...field.input.value].length > 4096) { field.error.textContent = '文字最多 4096 个字符。'; field.input.setAttribute('aria-invalid', 'true'); return; }
    field.dirty = true;
    const delta = port.attribute(definition.key, value);
    if (!delta || delta.error) { field.error.textContent = delta?.error?.message ?? '属性未更新；保留当前输入，请核对编辑器状态。'; field.input.setAttribute('aria-invalid', 'true'); return; }
    field.dirty = false; field.error.textContent = ''; update();
  }
  function buildField(definition: AttributeDef) {
    const wrapper = element('div', undefined, 'r07-attribute-field'), value = element('small'), error = element('p'); error.setAttribute('role', 'alert');
    const input = definition.kind === 'text' || definition.kind === 'number' ? element('input') : element('select');
    input.dataset.testid = 'attribute-' + definition.key; input.id = 'r07-attribute-' + definition.key;
    error.id = input.id + '-error'; input.setAttribute('aria-describedby', error.id);
    const field: AttributeField = { wrapper, input, value, error, dirty: false, composing: false, definition, baseline: state.scope, buttons: [] };
    wrapper.append(labeled(definition.key + (definition.required ? ' *' : ''), input), value);
    if (input instanceof HTMLSelectElement) {
      const mixed = option('mixed', '混合值'), missing = option('missing', '缺少键'), invalid = option('invalid', '源值无效'); mixed.disabled = missing.disabled = invalid.disabled = true;
      input.append(mixed, missing, invalid, option('null', 'null（空值）'));
      if (definition.kind === 'boolean') input.append(option('true', 'true'), option('false', 'false'));
      else for (const [index, item] of definition.enum_values.entries()) input.append(option('value:' + index, item === '' ? '空字符串' : item));
      input.addEventListener('change', () => { if (!port.selectionWritable()) return; const raw = input.value; if (raw === 'null') commitField(field, null); else if (raw === 'true' || raw === 'false') commitField(field, raw === 'true'); else if (raw.startsWith('value:')) commitField(field, field.definition.enum_values[Number(raw.slice(6))]); }, { signal });
    } else {
      input.inputMode = definition.kind === 'number' ? 'decimal' : 'text'; input.autocomplete = 'off';
      input.addEventListener('input', () => { field.dirty = true; field.error.textContent = ''; field.input.setAttribute('aria-invalid', 'false'); }, { signal });
      input.addEventListener('compositionstart', () => { field.composing = true; }, { signal }); input.addEventListener('compositionend', () => { field.composing = false; }, { signal });
      input.addEventListener('keydown', event => { if (event.isComposing || field.composing) return; if (event.key === 'Enter') { event.preventDefault(); commitField(field); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); field.dirty = false; field.error.textContent = ''; update(); } }, { signal });
      for (const scalar of definition.kind === 'text' ? [null, ''] : [null]) {
        const button = action(scalar === null ? '设为 null' : '设为空字符串', 'attribute-value-' + definition.key + '-' + (scalar === null ? 'null' : 'empty'), signal, () => commitField(field, scalar));
        button.addEventListener('mousedown', event => event.preventDefault(), { signal }); field.buttons.push(button); wrapper.append(button);
      }
      wrapper.append(element('small', 'Enter 或离开字段提交；Esc 取消。'));
      wrapper.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !wrapper.contains(event.relatedTarget)) commitField(field); }, { signal });
      wrapper.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && !field.composing) { event.preventDefault(); event.stopPropagation(); field.dirty = false; field.error.textContent = ''; update(); } }, { signal });
    }
    wrapper.append(error); fieldsRoot.append(wrapper); fields.set(definition.key, field);
  }
  function update() {
    const ids = selectedIds(state), selected = new Set(ids), objects = state.objects.filter(object => selected.has(object.object_id)), ontology = state.loaded?.ontology;
    const writable = port.selectionWritable(), nextIdentity = JSON.stringify([ids, state.host?.getGeneration(), writable]);
    if (identity !== nextIdentity || editScope !== state.scope) {
      editScope = state.scope; identity = nextIdentity; resetGeometry(); for (const field of fields.values()) { field.dirty = false; field.composing = false; field.baseline = state.scope; field.error.textContent = ''; }
    }
    info.textContent = ids.length ? '已选择 ' + ids.length + ' 个对象；修改包含过滤外和隐藏对象。' : '选择对象后查看属性。';
    warning.textContent = ids.some(id => state.flags[id]?.locked) ? '选择包含锁定对象，整批禁止修改。' : writable ? '可编辑 · 已解锁' : '只读；请核对权限、任务、保存状态和画布。';
    if (categoryOntology !== ontology) { categoryOntology = ontology ?? null; category.replaceChildren(option('', '选择类别')); for (const label of ontology?.labels ?? []) category.append(option(label.label_id, label.name)); }
    category.value = objects.length && objects.every(object => object.label_id === objects[0].label_id) ? objects[0].label_id : ''; category.disabled = !writable;
    const definitions = ontology ? commonAttributes(objects, ontology) : [], nextSchema = JSON.stringify(definitions);
    if (schema !== nextSchema) { for (const field of fields.values()) field.wrapper.remove(); fields.clear(); schema = nextSchema; for (const definition of definitions) buildField(definition); }
    for (const definition of definitions) {
      const field = fields.get(definition.key)!; field.definition = definition; field.baseline = state.scope;
      const value = attributeState(objects, definition.key);
      field.value.textContent = value.kind === 'mixed' ? '混合值' : value.kind === 'missing' ? '缺少键' : value.value === '' ? '空字符串' : JSON.stringify(value.value);
      field.value.dataset.valueState = value.kind;
      field.input.disabled = !writable || definition.kind === 'number' && definition.min !== null && definition.max !== null && definition.min > definition.max;
      for (const button of field.buttons) button.disabled = !writable;
      const invalid = objects.some(object => { const original = ontology?.labels.find(label => label.label_id === object.label_id)?.attributes.find(item => item.key === definition.key); return !!original && invalidAttribute(original, object.attributes[definition.key], Object.hasOwn(object.attributes, definition.key)); });
      const sourceError = '源文档中存在缺失必填键或不符合类别规范的值；原值保持不变，请显式修正。';
      if (!field.dirty && !field.composing && (invalid || field.error.textContent === sourceError)) field.error.textContent = invalid ? sourceError : '';
      field.input.setAttribute('aria-invalid', String(invalid || !!field.error.textContent));
      if (!field.dirty && !field.composing) {
        if (field.input instanceof HTMLSelectElement) field.input.value = value.kind !== 'uniform' ? value.kind : value.value === null ? 'null' : definition.kind === 'boolean' && typeof value.value === 'boolean' ? String(value.value) : typeof value.value === 'string' && definition.enum_values.includes(value.value) ? 'value:' + definition.enum_values.indexOf(value.value) : 'invalid';
        else { field.input.value = value.value == null ? '' : String(value.value); field.input.placeholder = value.kind === 'mixed' ? '混合值' : value.kind === 'missing' ? '缺少键' : ''; }
      }
    }
    const common = new Set(definitions.map(item => item.key)), unknown = [...new Set(objects.flatMap(object => [...Object.keys(object.attributes), ...(ontology?.labels.find(label => label.label_id === object.label_id)?.attributes.map(item => item.key) ?? [])]))].filter(key => !common.has(key));
    other.textContent = unknown.length ? '非共同、不兼容或未知属性（只读）：' + unknown.map(key => key + ': ' + JSON.stringify(attributeState(objects, key))).join('；') : '';
    for (const input of inputs.values()) input.disabled = !writable || ids.length !== 1;
    apply.disabled = cancel.disabled = !writable || ids.length !== 1;
  }
  category.addEventListener('change', () => port.relabel(category.value), { signal });
  const unsubscribe = state.subscribe(update); update(); return unsubscribe;
}
