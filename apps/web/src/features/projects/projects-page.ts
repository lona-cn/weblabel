import type { PageContext } from '../../ui/page-context';
import type { Project } from '../../lib/t15/api';
import { createProjectController } from './project-controller';
import { compareOntologyDraft, formatOntologyDiffValue, newLabel, type AttributeDraft, type LabelDraft, type OntologyDiffField } from './ontology-draft';
import { accountScope, el, button, inputField, selectField, textareaField, checkField, errorSummary, status, table, panel, sessionCanManage, message } from './account-dom';
import { mountMemberManager } from './member-manager-page';
import { mountExternalProcessingPolicy } from './external-processing-policy';
import './accounts.css';

export interface ProjectsPageContext extends PageContext { onOpen: (project: Project) => void; createdUsername: string | null }
export function mountProjectsPage(root: HTMLElement, context: ProjectsPageContext): () => void {
  const page = el('section', undefined, 'accounts-page accounts-projects'); page.dataset.testid = 'projects-page'; root.append(page);
  const scope = accountScope(page, context);
  const entry = context.session.getSnapshot();
  if (entry.kind !== 'authenticated') {
    const forbidden = status(); forbidden.textContent = '账户身份未确认，不能读取或创建项目。请先重新检查会话。'; page.append(el('h1', '项目'), forbidden);
    return () => { scope.dispose(); page.remove(); };
  }
  const controller = createProjectController(context.onOpen, scope.current, scope.signal);
  let editorVisible = false, creationStarted = false, shape = '', childDispose: (() => void) | null = null, childProjectId: string | null = null;
  function openCreation() {
    if (!scope.current() || create.disabled) return;
    controller.newProject(); creationStarted = true; editorVisible = true; render(); name.control.focus();
  }
  const heading = el('div', undefined, 'accounts-heading'); heading.append(el('h1', '项目'));
  const create = button('＋ 新建项目', 'project-create-toggle', scope.signal, openCreation, true); heading.append(create);
  const guide = el('details', undefined, 'accounts-delivery-guide'), steps = el('ol', undefined, 'accounts-delivery-steps');
  guide.append(el('summary', '首次人工交付四步'), steps); steps.setAttribute('aria-label', '首次人工交付四步');
  let guidePopulated: boolean | null = null;
  for (const [index, text] of ['项目规范：定义类别与属性', '导入：图片及已有标注', '标注保存：确认服务端保存', '交付：单图导出或审核后冻结数据集'].entries()) {
    const item = el('li'), number = el('span', String(index + 1), 'accounts-delivery-number'); number.setAttribute('aria-hidden', 'true'); item.append(number, el('span', text)); steps.append(item);
  }
  const summary = errorSummary(), notice = status(), loading = status();
  const listing = table(['项目名称', '我的角色', '操作']);
  const reload = button('重新读取项目列表', 'projects-reload', scope.signal, () => {
    const restoreFocus = document.activeElement === reload;
    void controller.listing().then(() => { if (scope.current() && restoreFocus && document.activeElement === document.body && !listArea.hidden) reload.focus(); });
  });
  const viewDraft = button('查看保留的新建草稿', 'project-draft-view', scope.signal, () => {
    const s = controller.getSnapshot(); if (!scope.current() || !creationStarted || s.selected || s.confirmed) return;
    editorVisible = true; render(); title.tabIndex = -1; title.focus();
  });
  const placeholder = el('div', undefined, 'accounts-project-skeleton'); placeholder.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) placeholder.append(el('span'));
  const empty = el('div', undefined, 'accounts-project-empty'); empty.dataset.testid = 'projects-empty';
  const emptyMessage = el('div'); emptyMessage.setAttribute('role', 'status');
  emptyMessage.append(el('h3', '尚无可访问项目'), el('p', '项目列表已读取，当前账户没有可访问的项目。新建项目后定义类别与属性，再导入图片。'));
  empty.append(emptyMessage);
  const listPanel = el('section', undefined, 'accounts-project-list');
  listPanel.append(el('h2', '项目列表'), listing.wrap, placeholder, loading, empty, reload);
  const listArea = el('section');
  const deliveryNotice = el('p', undefined, 'accounts-project-notice');
  deliveryNotice.append(el('span', '单图导出不等于已批准数据集。'), el('span', '团队交付需独立审核，默认禁止自审核。'));
  listArea.append(listPanel, guide, deliveryNotice, viewDraft, el('p', '账号创建仅限平台管理员；项目成员由项目管理员按真实 user_id 管理。', 'accounts-project-roles'));
  const platform = el('div'), members = el('div');
  const platformButton = button('平台账号管理', 'platform-accounts-open', scope.signal, () => { if (!scope.current()) return; childDispose?.(); childProjectId = null; members.replaceChildren(); members.hidden = false; childDispose = mountMemberManager(members, { ...context, project: null }); members.scrollIntoView({ block: 'start' }); });
  if (entry.session.platform_admin) platform.append(platformButton);
  const form = el('form', undefined, 'accounts-ontology-form'); form.noValidate = true; form.dataset.testid = 'project-create';
  const title = el('h1', '新建项目'), name = inputField('project-name', '项目名称', 'text', '最多 128 UTF-8 字节。');
  const version = selectField('ontology-version', '查看 / 复制已发布版本', [['', '选择固定版本']]);
  version.control.addEventListener('change', () => { const found = controller.getSnapshot().versions.find(v => v.ontology_version_id === version.control.value); if (found) controller.copyVersion(found); }, { signal: scope.signal });
  name.control.addEventListener('input', () => controller.edit({ name: name.control.value }), { signal: scope.signal });
  const columns = el('div', undefined, 'accounts-ontology-columns'), editor = el('div'), labels = el('div'), preview = panel('默认对象属性预览（不创建几何）'), differences = panel('规范版本检查 / 发布差异');
  const guidelines = textareaField('ontology-guidelines', '标注指南', '最多 65536 UTF-8 字节；发布不会迁移旧图片、任务或草稿。'); guidelines.control.rows = 2; guidelines.control.addEventListener('input', () => controller.edit({ guidelines: guidelines.control.value }), { signal: scope.signal });
  const add = button('＋ 添加类别', 'ontology-add-label', scope.signal, () => { controller.edit({ labels: [...controller.getSnapshot().labels, newLabel()] }); });
  const submit = el('button', '创建项目', 'accounts-primary'); submit.type = 'submit'; submit.dataset.testid = 'project-submit';
  const back = button('返回项目列表', 'project-editor-back', scope.signal, () => { editorVisible = false; render(); const target = !create.disabled ? create : !viewDraft.hidden ? viewDraft : reload; target.focus(); });
  const reconcile = button('只读核对结果', 'project-reconcile', scope.signal, () => { void controller.reconcile(); });
  const actions = el('div', undefined, 'accounts-actions accounts-ontology-actions'); actions.append(back, submit, reconcile);
  const budget = el('p', '', 'accounts-ontology-budget'); budget.dataset.testid = 'ontology-budget';
  differences.dataset.testid = 'ontology-differences';
  editor.append(name.element, version.element, labels, add, guidelines.element, budget); columns.append(editor, preview); form.append(title, columns, differences, actions);
  const brand = el('header', undefined, 'accounts-brand'), navigation = el('nav'), contextBar = el('section', undefined, 'accounts-project-context');
  brand.append(el('strong', 'WL'), el('span', 'WebLabel')); navigation.setAttribute('aria-label', '工作区导航');
  const currentNav = el('span', '项目'); currentNav.setAttribute('aria-current', 'page'); navigation.append(currentNav);
  const navigationHelp = el('small', '请先从列表进入明确项目；交付、任务和审核均绑定项目。管理通过项目行或平台账号管理入口操作。');
  navigationHelp.id = 'projects-navigation-help'; contextBar.append(el('span', '项目'), navigationHelp);
  for (const name of ['工作台', '交付', '我的任务', '待审核', '管理']) {
    const control = el('button', name); control.type = 'button'; control.disabled = true; control.title = navigationHelp.textContent!; control.setAttribute('aria-describedby', navigationHelp.id); navigation.append(control);
  }
  const logout = button('退出', 'logout', scope.signal, () => {
    if (scope.current()) void context.session.logout().catch(reason => { if (scope.current()) summary.set(message(reason)); });
  });
  brand.append(navigation, el('span', entry.session.username, 'accounts-project-identity'), logout);
  page.append(brand, contextBar, heading, summary.node, notice, listArea, platform, members, form);
  if (context.createdUsername) { const account = status(); account.dataset.testid = 'bootstrap-account'; account.textContent = `本地账户已创建：${context.createdUsername}。请保存用户名，之后使用设置的密码登录。`; heading.after(account); }
  const bindings: (() => void)[] = [];
  function changeLabel(id: string, patch: Partial<LabelDraft>) { controller.edit({ labels: controller.getSnapshot().labels.map(label => label.id === id ? { ...label, ...patch } : label) }); }
  function changeAttribute(id: string, index: number, patch: Partial<AttributeDraft>) {
    const label = controller.getSnapshot().labels.find(label => label.id === id); if (label) changeLabel(id, { attributes: label.attributes.map((attribute, i) => i === index ? { ...attribute, ...patch } : attribute) });
  }
  function renderLabels() {
    const state = controller.getSnapshot();
    const nextShape = JSON.stringify([state.selected?.project_id, state.baseline?.ontology_version_id, state.labels.map(label => [label.id, label.attributes.map(attribute => attribute.kind)])]);
    const focused = document.activeElement instanceof HTMLElement && labels.contains(document.activeElement) ? document.activeElement : null;
    const focusedLabelId = focused?.closest<HTMLElement>('[data-testid="ontology-label"]')?.dataset.labelId;
    if (shape !== nextShape) {
      shape = nextShape; labels.replaceChildren(); bindings.length = 0;
      state.labels.forEach((label, index) => {
        const group = el('fieldset', undefined, 'accounts-label'); group.dataset.testid = 'ontology-label'; group.dataset.labelId = label.id; group.append(el('legend', `类别 ${index + 1}`));
        const identity = el('details', undefined, 'accounts-label-identity'); identity.append(el('summary', '稳定类别身份'), el('code', label.id));
        const row = el('div', undefined, 'accounts-label-fields');
        for (const [key, text] of [['name', '类别名称'], ['color', '颜色'], ['shortcut', '快捷键']] as const) {
          const field = inputField(`label-${label.id}-${key}`, text); field.control.value = label[key];
          field.control.addEventListener('input', () => changeLabel(label.id, { [key]: field.control.value }), { signal: scope.signal }); row.append(field.element);
          bindings.push(() => { const value = controller.getSnapshot().labels.find(l => l.id === label.id)?.[key] ?? ''; if (field.control.value !== value) field.control.value = value; });
        }
        group.append(row);
        const labelError = el('p', '', 'accounts-field-error'); labelError.id = `label-${label.id}-error`; group.setAttribute('aria-describedby', labelError.id); group.append(labelError);
        bindings.push(() => { const error = controller.getSnapshot().invalidLabels[label.id]; labelError.textContent = error ?? ''; labelError.hidden = !error; group.setAttribute('aria-invalid', String(!!error)); });
        label.attributes.forEach((attribute, j) => {
          const attr = el('div', undefined, 'accounts-attribute'); attr.dataset.testid = 'ontology-attribute'; attr.setAttribute('role', 'group'); attr.setAttribute('aria-label', `对象属性 ${j + 1}`);
          const key = inputField(`attr-${label.id}-${j}-key`, '属性键'); key.control.value = attribute.key; key.control.addEventListener('input', () => changeAttribute(label.id, j, { key: key.control.value }), { signal: scope.signal });
          const kind = selectField(`attr-${label.id}-${j}-kind`, '类型', [['enum', 'enum · 枚举'], ['boolean', 'boolean · 布尔'], ['number', 'number · 数值'], ['text', 'text · 文本']]); kind.control.value = attribute.kind;
          kind.control.addEventListener('change', () => changeAttribute(label.id, j, { kind: kind.control.value as AttributeDraft['kind'], value: kind.control.value === 'boolean' ? 'false' : '', values: '', min: '', max: '' }), { signal: scope.signal });
          const required = checkField(`attr-${label.id}-${j}-required`, '必填'), isNull = checkField(`attr-${label.id}-${j}-null`, '默认值为空'); required.control.checked = attribute.required; isNull.control.checked = attribute.isNull;
          required.control.addEventListener('change', () => changeAttribute(label.id, j, { required: required.control.checked }), { signal: scope.signal }); isNull.control.addEventListener('change', () => changeAttribute(label.id, j, { isNull: isNull.control.checked }), { signal: scope.signal });
          attr.append(key.element, kind.element, required.element, isNull.element);
          const config = el('div', undefined, 'accounts-attribute-config'); config.dataset.kind = attribute.kind;
          const value = attribute.kind === 'boolean' ? selectField(`attr-${label.id}-${j}-value`, '默认值', [['false', 'false'], ['true', 'true']]) : inputField(`attr-${label.id}-${j}-value`, '默认值'); value.control.value = attribute.value;
          value.control.addEventListener('input', () => changeAttribute(label.id, j, { value: value.control.value }), { signal: scope.signal }); attr.append(config);
          bindings.push(() => {
            const latest = controller.getSnapshot().labels.find(l => l.id === label.id)?.attributes[j];
            if (!latest) return;
            if (key.control.value !== latest.key) key.control.value = latest.key;
            if (kind.control.value !== latest.kind) kind.control.value = latest.kind;
            required.control.checked = latest.required;
            isNull.control.checked = latest.isNull;
            if (value.control.value !== latest.value) value.control.value = latest.value;
            value.control.disabled = latest.isNull;
          });
          if (attribute.kind === 'enum') {
            const values = textareaField(`attr-${label.id}-${j}-values`, '枚举值（每行一个）', '空行是空串，选项不可重复。'); values.control.rows = 2; values.control.value = attribute.values; values.control.addEventListener('input', () => changeAttribute(label.id, j, { values: values.control.value }), { signal: scope.signal }); config.append(values.element);
            bindings.push(() => {
              const latest = controller.getSnapshot().labels.find(l => l.id === label.id)?.attributes[j];
              if (latest && values.control.value !== latest.values) values.control.value = latest.values;
            });
          }
          if (attribute.kind === 'number') for (const [key, text] of [['min', '最小值'], ['max', '最大值']] as const) {
            const limit = inputField(`attr-${label.id}-${j}-${key}`, text); limit.control.value = attribute[key]; limit.control.addEventListener('input', () => changeAttribute(label.id, j, { [key]: limit.control.value }), { signal: scope.signal }); config.append(limit.element);
            bindings.push(() => {
              const latest = controller.getSnapshot().labels.find(l => l.id === label.id)?.attributes[j];
              if (latest && limit.control.value !== latest[key]) limit.control.value = latest[key];
            });
          }
          config.append(value.element);
          attr.append(button('删除属性', `attr-${label.id}-${j}-remove`, scope.signal, () => { const latest = controller.getSnapshot().labels.find(l => l.id === label.id); if (latest) changeLabel(label.id, { attributes: latest.attributes.filter((_, i) => i !== j) }); })); group.append(attr);
        });
        const controls = el('div', undefined, 'accounts-actions');
        controls.append(button('＋ 添加属性', `label-${label.id}-add-attribute`, scope.signal, () => { const latest = controller.getSnapshot().labels.find(l => l.id === label.id); if (latest) changeLabel(label.id, { attributes: [...latest.attributes, { key: '', kind: 'text', required: false, isNull: true, value: '', values: '', min: '', max: '' }] }); }));
        const remove = button('删除类别', `label-${label.id}-remove`, scope.signal, () => controller.edit({ labels: controller.getSnapshot().labels.filter(l => l.id !== label.id) })); remove.disabled = state.labels.length <= 1; controls.append(remove, identity); group.append(controls); labels.append(group);
      });
    }
    bindings.forEach(bind => bind());
    if (focused && !focused.isConnected) {
      const replacement = focused.id ? document.getElementById(focused.id) : null;
      const fallback = focusedLabelId ? [...labels.querySelectorAll<HTMLButtonElement>('button')].find(control => control.dataset.testid === `label-${focusedLabelId}-add-attribute`) : null;
      if (replacement && labels.contains(replacement)) replacement.focus();
      else (fallback ?? add).focus();
    }
  }
  function render() {
    if (!scope.current()) return; const s = controller.getSnapshot();
    const populated = s.listingReady && s.projects.length > 0;
    listArea.dataset.listPopulated = String(populated);
    const frozen = s.busy || !!s.unknown || (!!s.creationDraft && !s.selected) || (!!s.selected && !sessionCanManage(context, s.selected.project_id));
    heading.hidden = editorVisible; listArea.hidden = editorVisible; form.hidden = !editorVisible;
    platform.hidden = editorVisible || !s.listingReady && !s.projects.length;
    members.hidden = platform.hidden || childProjectId !== null && !s.projects.some(project => project.project_id === childProjectId);
    create.disabled = s.busy || !s.listingReady || s.unknown === 'ontology' || !!s.confirmed;
    empty.hidden = s.busy || !s.listingReady || !!s.projects.length;
    const createContainer = empty.hidden ? heading : empty;
    if (create.parentElement !== createContainer) createContainer.append(create);
    guide.hidden = !s.listingReady;
    if (s.listingReady && guidePopulated !== populated) { guidePopulated = populated; guide.open = !populated; }
    viewDraft.hidden = s.listingReady || !creationStarted || !!s.selected || !!s.confirmed;
    listing.wrap.hidden = !s.projects.length;
    placeholder.hidden = !s.busy || s.listingReady; listing.wrap.setAttribute('aria-busy', String(s.busy && !s.listingReady));
    const listError = !editorVisible && !s.busy && !s.listingReady && !!s.error;
    summary.set(listError ? `项目列表读取失败：${s.error}` : s.error); notice.textContent = s.notice ?? ''; reload.disabled = s.busy;
    loading.textContent = s.busy && !s.listingReady ? '正在读取项目列表…尚未取得列表，不能判断是否为空；读取成功前不能创建。'
      : s.busy ? '正在处理…' : !s.listingReady ? '尚未取得项目列表，不能判断是否为空；读取成功前不能创建。' : '';
    loading.hidden = !loading.textContent;
    listing.body.replaceChildren();
    for (const project of s.projects) {
      const row = el('tr'), actions = el('td'); actions.className = 'accounts-actions';
      const listed = () => scope.current() && controller.getSnapshot().projects.some(item => item.project_id === project.project_id);
      actions.append(button('进入工作台', `project-${project.project_id}-open`, scope.signal, () => { if (listed() && !controller.getSnapshot().busy) context.onOpen(project); }));
      const configure = button('查看规范', `project-${project.project_id}-ontology`, scope.signal, () => { if (!listed()) return; void controller.configure(project).then(() => { if (listed() && controller.getSnapshot().selected?.project_id === project.project_id) { editorVisible = true; render(); title.tabIndex = -1; title.focus(); } }); }); configure.disabled = s.busy || s.unknown === 'ontology' || !!s.confirmed; actions.append(configure);
      const manage = button('管理成员', `project-${project.project_id}-members`, scope.signal, () => {
        if (!listed() || !sessionCanManage(context, project.project_id)) return; childDispose?.(); childProjectId = project.project_id; members.replaceChildren(); members.hidden = false;
        const memberRoot = el('div'), policyRoot = el('div'); members.append(memberRoot, policyRoot);
        const a = mountMemberManager(memberRoot, { ...context, project }); const b = mountExternalProcessingPolicy(policyRoot, { ...context, projectId: project.project_id, projectName: project.name }); childDispose = () => { a(); b(); }; members.scrollIntoView({ block: 'start' });
      }); manage.disabled = !sessionCanManage(context, project.project_id) || s.busy; actions.append(manage);
      row.append(el('td', project.name), el('td', ({ admin: '项目管理员', annotator: '标注员', reviewer: '审核员', viewer: '只读员' } as Record<string, string>)[project.role ?? ''] ?? '权限未知'), actions); listing.body.append(row);
    }
    const unknownVersionReview = s.unknown === 'ontology' && !controller.hasPublicationAck() && !!s.selected && !!s.baseline;
    const focusWasInEditor = unknownVersionReview && !columns.hidden && columns.contains(document.activeElement);
    columns.hidden = unknownVersionReview;
    if (version.element.parentElement !== (unknownVersionReview ? actions : editor)) {
      if (unknownVersionReview) actions.prepend(version.element);
      else editor.insertBefore(version.element, labels);
    }
    title.textContent = unknownVersionReview ? `${s.selected!.name} · 发布结果未知` : s.selected ? `${s.selected.name} · 不可变规范配置` : s.confirmed ? '项目已创建 · 补充规范' : '新建项目';
    if (focusWasInEditor) title.focus();
    if (name.control.value !== s.name) name.control.value = s.name; name.control.readOnly = frozen || !!s.selected || !!s.confirmed;
    if (guidelines.control.value !== s.guidelines) guidelines.control.value = s.guidelines; guidelines.control.readOnly = frozen;
    budget.textContent = `已配置 ${s.labels.length} 个类别 · ${s.labels.reduce((count, label) => count + label.attributes.length, 0)} 个属性。名称 / 属性键 ≤128 字节；文本默认值 ≤4096 字节；指南 ${new TextEncoder().encode(s.guidelines).byteLength}/65536 UTF-8 字节。null 为显式空值，"" 为空字符串。`;
    version.element.hidden = !s.selected;
    if (version.control.options.length !== s.versions.length + 1 || s.versions.some((v, i) => version.control.options[i + 1]?.value !== v.ontology_version_id)) {
      version.control.replaceChildren(new Option('选择固定版本', ''), ...s.versions.map(v => new Option(`第 ${v.version_no} 版 · ${v.ontology_version_id}`, v.ontology_version_id)));
    }
    version.control.disabled = s.busy || !!s.unknown;
    renderLabels(); labels.querySelectorAll<HTMLFieldSetElement>(':scope > fieldset').forEach(group => { group.disabled = frozen; });
    add.disabled = frozen; submit.disabled = frozen || !s.listingReady; submit.textContent = s.busy ? '处理中…' : s.selected ? '发布不可变新版本' : s.confirmed ? '仅发布规范' : '创建项目';
    reconcile.hidden = !s.unknown && !s.creationDraft; reconcile.disabled = s.busy; back.disabled = s.busy || s.unknown === 'ontology' || !!s.confirmed;
    form.setAttribute('aria-busy', String(s.busy));
    preview.replaceChildren(el('h2', '默认对象属性预览（不创建几何）'), el('p', '只读 · null 是显式空值，不是缺少键。空字符串以 "" 显示。'));
    s.labels.forEach(label => { preview.append(el('h3', label.name || '未命名类别')); const dl = el('dl'); label.attributes.forEach(a => { dl.append(el('dt', `${a.key || '未命名属性'}${a.required ? ' · 必填' : ''}`), el('dd', a.isNull ? 'null' : a.kind === 'text' || a.kind === 'enum' ? JSON.stringify(a.value) : a.value)); }); preview.append(dl); });
    differences.hidden = !s.baseline; differences.replaceChildren(el('h2', '规范版本检查 / 发布差异'));
    if (s.baseline) {
      differences.append(el('p', `固定基线：${s.baseline.ontology_version_id} · 第 ${s.baseline.version_no} 版。旧图片、任务和草稿不迁移。`));
      const comparison = compareOntologyDraft(s.baseline, s.labels, s.guidelines);
      const diagnosis = el('p', comparison.validationError ? `草稿尚不可发布：${comparison.validationError}。下方仍逐项保留原输入用于比较。` : `已逐项核对类别、属性与指南：${comparison.changes.length} 项变化。`);
      diagnosis.dataset.testid = 'ontology-diff-diagnosis'; if (comparison.validationError) diagnosis.setAttribute('role', 'status'); differences.append(diagnosis);
      const fields: Record<OntologyDiffField, string> = { name: '类别名称', color: '颜色', shortcut: '快捷键', kind: '属性类型', required: '必填', default_value: '默认值', enum_values: '枚举选项（逐行）', min: '最小值', max: '最大值', guidelines_markdown: '标注指南' };
      const diff = table(['类别 / 属性 / 变更', `固定第 ${s.baseline.version_no} 版`, '提交草稿']); diff.node.classList.add('accounts-semantic-diff');
      for (const change of comparison.changes) {
        const row = el('tr'); row.dataset.testid = 'ontology-diff-row'; row.dataset.entity = change.entity; row.dataset.field = change.field; row.dataset.change = change.kind;
        if (change.labelId !== null) row.dataset.labelId = change.labelId;
        if (change.attributeKey !== null) { row.dataset.attributeKey = change.attributeKey; row.dataset.occurrence = String(change.occurrence); }
        const identity = el('th'); identity.scope = 'row';
        identity.append(el('strong', change.entity === 'guidelines' ? '项目规范' : `${change.labelName || '未命名类别'}${change.attributeKey !== null ? ` / ${change.attributeKey || '未命名属性'}${change.occurrence ? `（重复项 ${change.occurrence + 1}）` : ''}` : ''}`));
        identity.append(el('span', `${fields[change.field]} · ${{ added: '新增', removed: '删除', changed: '修改' }[change.kind]}`, 'accounts-diff-kind'));
        if (change.labelId !== null) identity.append(el('code', change.labelId));
        const before = el('td', formatOntologyDiffValue(change.before)), after = el('td', formatOntologyDiffValue(change.after));
        row.append(identity, before, after); diff.body.append(row);
      }
      if (comparison.changes.length) differences.append(diff.wrap);
      else { const unchanged = el('p', '与固定版本语义一致，没有类别、属性或指南变更。'); unchanged.dataset.testid = 'ontology-diff-unchanged'; differences.append(unchanged); }
      differences.append(el('p', s.unknown ? controller.hasPublicationAck() ? '发布已确认，后续核对未完成。请只读核对，不会重复发布。' : '发布结果未知：原发布输入已保留，不自动重发。相似版本不能证明属于此次发布。' : '发布只产生新的固定规范，不修改已发布版本。'));
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void controller.submit().then(() => { if (scope.current() && controller.getSnapshot().error && !controller.getSnapshot().unknown) summary.node.focus(); }); }, { signal: scope.signal });
  const unsubscribe = controller.subscribe(render);
  const dispose = () => { scope.dispose(); unsubscribe(); controller.dispose(); childDispose?.(); page.remove(); };
  scope.signal.addEventListener('abort', () => { unsubscribe(); controller.dispose(); childDispose?.(); }, { once: true });
  render(); void controller.listing();
  return dispose;
}
