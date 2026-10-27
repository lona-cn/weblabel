import type { AnnotationRevision } from '../../../../../packages/contracts/generated/AnnotationRevision';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';
import type { BBox } from '../../../../../packages/contracts/generated/BBox';
import { api } from '../../lib/t15/api';
import type { ReviewIssue } from './api';
import { element, actions, details, lifetime } from '../import-export/delivery-dom';
import { mountReviewList } from './review-list';
const NS = 'http://www.w3.org/2000/svg';
export function assertRevision(revision: AnnotationRevision, revisionId: string, assetId: string, ontologyId: string) {
  if (revision.annotation_revision_id !== revisionId || revision.document.asset_revision_id !== assetId || revision.document.ontology_version_id !== ontologyId) throw new Error('固定版本与指定图片或规范不一致，不会替换为其他图片或当前 head。');
}
export function mountReadonlyProjection(root: HTMLElement, document: AnnotationDocument, ontology: OntologyVersion, url: string) {
  const svg = window.document.createElementNS(NS, 'svg'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '只读图像与标注投影，非可编辑 wgpu');
  const { width, height } = document.coordinate_space; svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const image = window.document.createElementNS(NS, 'image'); image.setAttribute('href', url); image.setAttribute('width', String(width)); image.setAttribute('height', String(height)); svg.append(image);
  for (const object of document.objects) {
    const box = object.geometry; const group = window.document.createElementNS(NS, 'g'); const rect = window.document.createElementNS(NS, 'rect');
    rect.dataset.objectId = object.object_id; rect.setAttribute('x', String(box.x_min)); rect.setAttribute('y', String(box.y_min)); rect.setAttribute('width', String(box.x_max - box.x_min)); rect.setAttribute('height', String(box.y_max - box.y_min)); rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', ontology.labels.find(label => label.label_id === object.label_id)?.color ?? '#edf2f3'); rect.setAttribute('stroke-width', '2'); rect.setAttribute('vector-effect', 'non-scaling-stroke');
    const title = window.document.createElementNS(NS, 'title'); title.textContent = `${ontology.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id} · ${object.object_id}`; group.append(rect, title); svg.append(group);
  }
  root.replaceChildren(svg); return svg;
}
export function mountRevisionReviewView(root: HTMLElement, context: { projectId: string; revision: AnnotationRevision; parent: AnnotationRevision | null; issues: readonly ReviewIssue[]; signal: AbortSignal; isCurrent?(): boolean; fixedPage?: boolean }) {
  const life = lifetime(context.signal), { revision, parent } = context;
  const action = actions(life.signal);
  const section = element('section'); section.setAttribute('aria-label', '不可变版本只读视觉审阅');
  const controls = element('div', undefined, 'delivery-toolbar'); const graphic = element('div'); const objectsRoot = element('div'); const issuesRoot = element('div'); const differences = element('div'); const status = element('p', '正在读取固定图像与规范…'); status.setAttribute('role', 'status');
  const columns = element('div', undefined, 'delivery-grid'), inspection = element('div'), sidebar = element('aside');
  inspection.append(controls, status, graphic, differences);
  const fixedObject = context.fixedPage ? element('section', undefined, 'revision-fixed-object') : null;
  if (fixedObject) {
    const identity = element('section', undefined, 'revision-fixed-identity'), values = element('dl'); identity.dataset.testid = 'fixed-revision-identity';
    for (const [name, value] of [['项目', context.projectId], ['图片版本', revision.document.asset_revision_id], ['规范版本', revision.document.ontology_version_id], ['固定 revision', revision.annotation_revision_id], ['父版本', parent?.annotation_revision_id ?? '无父版本'], ['修订序号', String(revision.revision_no)]]) values.append(element('dt', name), element('dd', value));
    identity.append(element('h3', '固定目标与版本凭证'), values); sidebar.append(identity);
    fixedObject.dataset.testid = 'fixed-object-detail'; fixedObject.setAttribute('aria-label', '所选对象只读详情'); sidebar.append(fixedObject);
  }
  const issueHeading = element('h3', '问题与定位'); issueHeading.hidden = issuesRoot.hidden = !!context.fixedPage && !context.issues.length;
  sidebar.append(element('h3', '只读对象属性'), objectsRoot, issueHeading, issuesRoot); columns.append(inspection, sidebar);
  section.append(element('p', `只读图像 + SVG 投影（不是可编辑 wgpu）。固定版本 ${revision.annotation_revision_id}；新 head 不继承旧批准。`), columns); root.append(section);
  let url: string | null = null, ontology: OntologyVersion | null = null, version: 'before' | 'after' = 'after'; let focused: string | null = null, region: BBox | null = null;
  const before = new Map((parent?.document.objects ?? []).map(object => [object.object_id, object])); const after = new Map(revision.document.objects.map(object => [object.object_id, object]));
  const changed = !parent && context.fixedPage ? [] : [...new Set([...before.keys(), ...after.keys()])].filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
  const changedIds = new Set(changed);
  const objects = mountReviewList<AnnotationDocument['objects'][number]>(objectsRoot, '审核对象', object => object.object_id, (object, signal) => {
    const row = element('div'), action = actions(signal); row.append(action(`${ontology?.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id} · ${object.object_id} · ${!parent && context.fixedPage ? '无基线' : changedIds.has(object.object_id) ? '变化' : '无变化'}：定位对象`, () => { focused = object.object_id; region = null; paint(); }), details('只读对象属性与几何', object)); return row;
  }, life.signal);
  const issues = mountReviewList<ReviewIssue>(issuesRoot, '审核问题', issue => issue.issue_id, (issue, signal) => {
    const row = element('div'), action = actions(signal); const locate = action('定位问题', () => {
      if (issue.annotation_revision_id !== revision.annotation_revision_id || issue.ontology_version_id !== revision.document.ontology_version_id) return;
      version = 'after'; focused = issue.object_id; region = null;
      const value = issue.region as BBox | null;
      if (value && [value.x_min, value.y_min, value.x_max, value.y_max].every(Number.isFinite) && value.x_max > value.x_min && value.y_max > value.y_min) region = value;
      paint();
    }); locate.disabled = issue.annotation_revision_id !== revision.annotation_revision_id || issue.ontology_version_id !== revision.document.ontology_version_id || (!issue.object_id && !issue.region);
    row.append(element('p', issue.message), details('问题来源', `${issue.code} · ${issue.annotation_revision_id}`), locate);
    if (issue.object_id && !after.has(issue.object_id)) row.append(element('p', '对象不在指定版本中；问题来源保留，请检查全图或问题区域。')); return row;
  }, life.signal); issues.update(context.issues);
  const afterButton = action('提交后版本', () => { version = 'after'; focused = null; region = null; paint(); });
  const beforeButton = action('基线前版本', () => { if (!parent) return; version = 'before'; focused = null; region = null; paint(); }); beforeButton.disabled = !parent;
  controls.append(beforeButton, afterButton, action('检查全图（含无变化区域）', () => { focused = null; region = null; paint(); }));
  function paint() {
    if (!life.alive || context.isCurrent?.() === false || !url || !ontology) return;
    const shown = version === 'before' && parent ? parent : revision; const svg = mountReadonlyProjection(graphic, shown.document, ontology, url);
    const box = shown.document.objects.find(object => object.object_id === focused)?.geometry ?? region;
    const labelSize = (box ? Math.max(40, box.y_max - box.y_min + 40) : shown.document.coordinate_space.height) / 35;
    if (context.fixedPage) for (const [index, object] of shown.document.objects.entries()) {
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(object.geometry.x_min)); label.setAttribute('y', String(Math.max(labelSize + 2, object.geometry.y_min - 4))); label.setAttribute('font-size', String(labelSize));
      label.setAttribute('class', 'revision-fixed-label'); label.setAttribute('aria-hidden', 'true'); label.textContent = `${ontology.labels.find(item => item.label_id === object.label_id)?.name ?? object.label_id} · ${object.object_id}`;
      svg.children[index + 1]?.append(label);
    }
    svg.setAttribute('aria-label', `固定版本 ${shown.annotation_revision_id} 的只读标注投影`);
    if (box) svg.setAttribute('viewBox', `${Math.max(0, box.x_min - 20)} ${Math.max(0, box.y_min - 20)} ${Math.max(40, box.x_max - box.x_min + 40)} ${Math.max(40, box.y_max - box.y_min + 40)}`);
    for (const rect of svg.querySelectorAll('rect')) if (rect.dataset.objectId === focused) { rect.setAttribute('stroke', '#f1c975'); rect.setAttribute('stroke-width', '3'); }
    if (region) { const rect = document.createElementNS(NS, 'rect'); for (const [name, value] of Object.entries({ x: region.x_min, y: region.y_min, width: region.x_max - region.x_min, height: region.y_max - region.y_min })) rect.setAttribute(name, String(value)); rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', '#f1c975'); rect.setAttribute('stroke-width', '3'); rect.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(rect); }
    beforeButton.setAttribute('aria-pressed', String(version === 'before')); afterButton.setAttribute('aria-pressed', String(version === 'after')); objects.update(shown.document.objects);
    if (fixedObject) {
      const object = shown.document.objects.find(value => value.object_id === focused);
      fixedObject.replaceChildren(element('h3', '所选对象 · 只读'));
      if (!object) fixedObject.append(element('p', '选择对象以查看此固定版本的属性与 canonical 坐标。'));
      else {
        const values = element('dl'); const label = ontology.labels.find(value => value.label_id === object.label_id);
        for (const [name, value] of [['对象', object.object_id], ['类别', label?.name ?? object.label_id], ...Object.entries(object.geometry).filter(([key]) => key !== 'type').map(([key, value]) => [key, String(value)]), ...Object.entries(object.attributes).map(([key, value]) => [key, JSON.stringify(value)])]) values.append(element('dt', name), element('dd', value));
        fixedObject.append(values);
      }
    }
    status.textContent = `${shown.document.objects.length} 个对象；完成状态 ${shown.document.completion}。空对象不是已确认负样本。`;
  }
  differences.append(element('h3', '固定版本差异'), element('p', `完成状态：${parent?.document.completion ?? '无基线'} → ${revision.document.completion}`));
  if (context.fixedPage && parent && changed.length) {
    const table = element('table'), header = element('tr'), body = element('tbody'); table.setAttribute('aria-label', '已变化对象的固定版本对照');
    for (const name of ['对象', '变化字段', '基线前版本', '提交后版本']) header.append(element('th', name)); const thead = element('thead'); thead.append(header); table.append(thead, body);
    const addRow = (id: string, field: string, oldValue: string, newValue: string) => { const row = element('tr'); row.append(element('td', id), element('td', field), element('td', oldValue), element('td', newValue)); body.append(row); };
    for (const id of changed) {
      const oldObject = before.get(id), newObject = after.get(id), start = body.childElementCount;
      if (!oldObject || !newObject) addRow(id, '对象', oldObject ? JSON.stringify(oldObject) : '不存在', newObject ? JSON.stringify(newObject) : '不存在');
      else {
        if (oldObject.label_id !== newObject.label_id) addRow(id, '类别', oldObject.label_id, newObject.label_id);
        if (JSON.stringify(oldObject.geometry) !== JSON.stringify(newObject.geometry)) {
          const xyxy = (box: BBox) => `[${box.x_min}, ${box.y_min}, ${box.x_max}, ${box.y_max}]`;
          addRow(id, 'canonical xyxy', xyxy(oldObject.geometry), xyxy(newObject.geometry));
        }
        for (const key of new Set([...Object.keys(oldObject.attributes), ...Object.keys(newObject.attributes)])) {
          const value = (object: AnnotationDocument['objects'][number]) => Object.hasOwn(object.attributes, key) ? JSON.stringify(object.attributes[key]) ?? '无法显示' : '缺少键';
          const oldValue = value(oldObject), newValue = value(newObject);
          if (oldValue !== newValue) addRow(id, '属性 · ' + key, oldValue, newValue);
        }
        if (JSON.stringify(oldObject.origin) !== JSON.stringify(newObject.origin)) addRow(id, '来源', JSON.stringify(oldObject.origin), JSON.stringify(newObject.origin));
      }
      if (body.childElementCount === start) addRow(id, '完整记录结构或顺序', JSON.stringify(oldObject), JSON.stringify(newObject));
    }
    differences.append(table);
  }
  for (const id of changed) differences.append(details(`对象变更 · ${id}`, { before: before.get(id) ?? null, after: after.get(id) ?? null }));
  if (!parent && context.fixedPage) differences.append(element('p', '无父版本，不能比较前后差异。'));
  else if (!changed.length) differences.append(element('p', '对象几何与属性无差异；仍须检查全图所有区域。'));
  void (async () => {
    if (parent) assertRevision(parent, revision.parent_revision_id ?? '', revision.document.asset_revision_id, revision.document.ontology_version_id);
    const [image, page] = await Promise.all([api.image(revision.document.asset_revision_id, life.signal), api.ontologies(context.projectId, life.signal)]);
    if (!life.alive || context.isCurrent?.() === false) return;
    ontology = page.items.find(item => item.project_id === context.projectId && item.ontology_version_id === revision.document.ontology_version_id) ?? null;
    if (!ontology) throw new Error('指定固定规范不可读取，不能使用当前规范代替。');
    url = URL.createObjectURL(image); paint();
  })().catch(error => { if (life.alive && context.isCurrent?.() !== false) { status.setAttribute('role', 'alert'); status.textContent = `${error instanceof Error ? error.message : '读取失败'}；图像未就绪不能视为完成视觉检查。`; } });
  life.add(() => { if (url) URL.revokeObjectURL(url); objects.dispose(); issues.dispose(); section.remove(); }); return life.dispose;
}
