import type { WorkbenchPageContext } from './workbench-context';
import type { TaskQueue } from '../review/workflow';
import { createDialog } from '../../ui/dialog';
import { createWorkbenchController } from './controller';
import { mountCanvasView } from './canvas-view';
import { mountObjectsView } from './objects-view';
import { mountAttributesView } from './attributes-view';
import { mountToolbarView, mountEditorKeyboard } from './toolbar-view';
import { COMPLETION_LABELS, mountSaveView } from './save-view';
import { mountAiWorkbenchView } from '../ai/ai-workbench-view';
import { readonlyVisual } from '../ai/readonly-visual';
import { mountActivityView } from './activity-view';
import { mountHelpView } from './help-view';
import { action, element, labeled, option } from './view-elements';
import { reportError, selectedIds, sessionCurrent, writableRole, type WorkspaceState } from './workspace-state';
import './native-workbench.css';

export function mountWorkbenchPage(root: HTMLElement, context: WorkbenchPageContext): () => void {
  const controller = createWorkbenchController(context, { projectId: context.projectId, assetId: context.route.assetId, ontologyId: context.route.ontologyId, taskId: context.initialTaskId ?? null });
  const { state, editorPort: port, taskSession, recovery, signal } = controller;
  if (signal.aborted) return controller.dispose;
  if (import.meta.env.MODE === 'test') void import('./test-observer').then(module => { if (!signal.aborted) module.observeRoutedWorkbench(controller); });
  const shell = element('main', undefined, 'r07-workbench'); shell.dataset.testid = 'workbench'; shell.lang = 'zh-CN';
  const header = element('header', undefined, 'r07-topbar'), brand = element('strong', 'WL  WebLabel', 'r07-brand'), navigation = element('nav'); navigation.setAttribute('aria-label', '工作区导航');
  function navigate(destination: 'projects' | 'datasets') {
    if (!sessionCurrent(state)) return;
    const url = new URL(location.href);
    url.searchParams.delete('annotation_revision_id'); url.searchParams.delete('review_queue');
    if (destination === 'projects') for (const key of ['project_id', 'asset_revision_id', 'ontology_version_id', 'task_id', 'dataset_view']) url.searchParams.delete(key);
    else { url.searchParams.set('project_id', context.projectId); url.searchParams.set('dataset_view', '1'); }
    context.navigate(url);
  }
  const projects = action('项目', 'nav-projects', signal, () => navigate('projects')), datasets = action('交付', 'nav-datasets', signal, () => navigate('datasets'));
  const currentNav = element('span', '工作台'); currentNav.setAttribute('aria-current', 'page');
  const reviewDetails = element('details'), managementDetails = element('details'), transferDetails = element('details'), activityDetails = element('details');
  reviewDetails.className = managementDetails.className = transferDetails.className = activityDetails.className = 'r07-expanded-section';
  const reviewSummary = element('summary', '任务与审核'), managementSummary = element('summary', '管理'), transferSummary = element('summary', '媒体导入、标注导入与固定版本导出'), activitySummary = element('summary', '自愿工时与运行摘要');
  reviewDetails.append(reviewSummary); managementDetails.append(managementSummary); transferDetails.append(transferSummary); activityDetails.append(activitySummary);
  let reviewQueue: TaskQueue = context.route.queue ?? 'all';
  const queueLink = (queue: 'mine' | 'pending') => {
    if (!sessionCurrent(state)) return;
    reviewQueue = queue; reviewDetails.open = true; reviewSummary.focus();
    const url = new URL(location.href); url.searchParams.set('project_id', state.projectId); url.searchParams.set('review_queue', queue); history.replaceState(null, '', url); state.notify();
  };
  navigation.append(projects, currentNav, datasets, action('我的任务', 'nav-my-tasks', signal, () => queueLink('mine')), action('待审核', 'nav-review', signal, () => queueLink('pending')),
    action('管理', 'nav-management', signal, () => { managementDetails.open = !managementDetails.open; if (managementDetails.open) managementSummary.focus(); }));
  const projectName = element('span', undefined, 'r07-project-name'), identity = element('span'), logout = action('退出', 'logout', signal, () => { if (sessionCurrent(state)) void context.session.logout().catch(reason => { state.error = reportError(reason); state.notify(); }); });
  header.append(brand, navigation, projectName, identity, logout);
  const contextBar = element('section', undefined, 'r07-contextbar'), title = element('h1'), position = element('span'), ontology = element('select'); ontology.dataset.testid = 'fixed-ontology'; ontology.setAttribute('aria-label', '固定规范版本');
  const previousImage = action('上一张图片', 'image-prev', signal, () => { const index = state.assets.findIndex(asset => asset.asset_revision_id === state.assetId); if (index > 0) void controller.selectAsset(state.assets[index - 1].asset_revision_id); });
  const nextImage = action('下一张图片', 'image-next', signal, () => { const index = state.assets.findIndex(asset => asset.asset_revision_id === state.assetId); if (index >= 0 && index + 1 < state.assets.length) void controller.selectAsset(state.assets[index + 1].asset_revision_id); });
  contextBar.append(title, previousImage, position, nextImage, labeled('固定规范', ontology));
  const launchers = element('div', undefined, 'r07-launchers'), workspace = element('div', undefined, 'r07-workspace');
  const assets = element('aside', undefined, 'r07-assets'), inspector = element('aside', undefined, 'r07-inspector'), center = element('section', undefined, 'r07-center');
  assets.id = 'workbench-sidebar'; inspector.id = 'workbench-inspector'; center.setAttribute('aria-label', '编辑表面');
  const assetsHome = element('div', undefined, 'r07-assets-home'), inspectorHome = element('div', undefined, 'r07-inspector-home'); assetsHome.append(assets); inspectorHome.append(inspector);
  const assetSearch = element('input'); assetSearch.type = 'search'; assetSearch.setAttribute('aria-label', '搜索图片'); assetSearch.placeholder = '搜索图片';
  const assetList = element('ul', undefined, 'r07-asset-list'), objectsRoot = element('section');
  assetList.dataset.testid = 'asset-grid';
  const importLaunch = action('导入图片 / 标注', 'open-import', signal, () => { transferDetails.open = true; transferSummary.focus(); });
  const resizeControls = element('div', undefined, 'r07-button-row'), resizeButtons: { delta: number; button: HTMLButtonElement }[] = [];
  for (const [delta, text] of [[-20, '缩窄图片与对象栏'], [20, '加宽图片与对象栏']] as const) {
    const button = action(text, 'resize-assets-' + delta, signal, () => {
      if (!sessionCurrent(state) || compact.matches) return;
      const width = Math.max(220, Math.min(360, assetsHome.getBoundingClientRect().width + delta));
      assetsHome.style.width = width + 'px'; shell.style.setProperty('--r07-assets-width', width + 'px'); updateResizeButtons();
    });
    resizeButtons.push({ delta, button }); resizeControls.append(button);
  }
  function updateResizeButtons() {
    const width = assetsHome.getBoundingClientRect().width;
    for (const { delta, button } of resizeButtons) button.disabled = !sessionCurrent(state) || compact.matches || (delta < 0 ? width <= 220 : width >= 360);
    if (!compact.matches && width >= 220 && width <= 360) shell.style.setProperty('--r07-assets-width', width + 'px');
  }
  const sidebarObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateResizeButtons);
  sidebarObserver?.observe(assetsHome); signal.addEventListener('abort', () => sidebarObserver?.disconnect(), { once: true });
  assets.append(element('h2', '图片与对象'), labeled('搜索图片', assetSearch), importLaunch, assetList, resizeControls, objectsRoot);
  const toolbar = element('div', undefined, 'r07-toolbar'), canvas = mountCanvasView(state, port, signal, context.hostOptions);
  toolbar.id = 'canvas-toolbar-row';
  const error = element('p', undefined, 'r07-workspace-error'); error.setAttribute('role', 'alert'); error.dataset.testid = 'workbench-error';
  const selectionSummary = element('section', undefined, 'r07-selection-summary'), selectionText = element('p');
  selectionSummary.dataset.testid = 'compact-selection-summary'; selectionSummary.setAttribute('aria-label', '当前选择'); selectionSummary.hidden = true;
  const selectionAttributes = action('打开属性', 'selection-open-attributes', signal, () => openInspector('attributes', selectionAttributes));
  selectionSummary.append(selectionText, selectionAttributes);
  center.append(toolbar, error, canvas.element, selectionSummary);
  const inspectorTabs = element('div', undefined, 'r07-inspector-tabs'), attributesRoot = element('section'), aiRoot = element('section');
  inspectorTabs.setAttribute('role', 'tablist'); inspectorTabs.setAttribute('aria-label', '检查器');
  let inspectorView: 'attributes' | 'ai' = 'attributes';
  const attributesTab = action('对象属性', 'inspector-attributes', signal, () => showInspector('attributes')), aiTab = action('AI 审校', 'inspector-ai', signal, () => showInspector('ai'));
  attributesRoot.id = 'r07-attributes'; aiRoot.id = 'r07-ai';
  for (const [tab, pane] of [[attributesTab, attributesRoot], [aiTab, aiRoot]] as const) { tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', pane.id); tab.id = pane.id + '-tab'; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', tab.id); }
  inspectorTabs.append(attributesTab, aiTab); inspector.append(inspectorTabs, attributesRoot, aiRoot);
  inspectorTabs.addEventListener('keydown', event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return; event.preventDefault(); showInspector(inspectorView === 'attributes' ? 'ai' : 'attributes'); (inspectorView === 'ai' ? aiTab : attributesTab).focus(); }, { signal });
  workspace.append(assetsHome, center, inspectorHome);
  const saveRoot = element('section', undefined, 'r07-save'), helpRoot = element('footer', undefined, 'r07-footer');
  const reviewRoot = element('div'), managementRoot = element('div'), transfersRoot = element('div'), activityRoot = element('div');
  reviewDetails.append(reviewRoot); managementDetails.append(managementRoot); transferDetails.append(transfersRoot); activityDetails.append(activityRoot);
  const assetsDialog = createDialog({ id: 'r07-assets-drawer', title: '图片与对象', testId: 'assets-drawer', signal }), inspectorDialog = createDialog({ id: 'r07-inspector-drawer', title: '对象属性与 AI 审校', testId: 'inspector-drawer', signal });
  assetsDialog.element.classList.add('r07-drawer', 'r07-drawer-left'); inspectorDialog.element.classList.add('r07-drawer', 'r07-drawer-right');
  for (const [dialog, id, name] of [[assetsDialog, 'close-assets', '关闭图片与对象'], [inspectorDialog, 'close-inspector', '关闭检查器']] as const) {
    const close = dialog.element.querySelector<HTMLButtonElement>('button')!; close.dataset.testid = id; close.setAttribute('aria-label', name); close.dataset.closePanel = ''; dialog.element.insertBefore(close, dialog.content);
  }
  const aiConfigDialog = createDialog({ id: 'r07-ai-config', title: 'AI 配置与提示', testId: 'ai-config', signal, fallbackFocus: () => aiLauncher });
  aiConfigDialog.element.classList.add('r07-ai-config');
  const aiConfigHeading = aiConfigDialog.element.querySelector('h2')!, aiConfigClose = aiConfigDialog.element.querySelector<HTMLButtonElement>('button')!;
  const aiConfigContext = element('div', undefined, 'r07-ai-config-contextbar'), aiConfigSource = element('section', undefined, 'r07-ai-config-source');
  const aiConfigForm = element('section', undefined, 'r07-ai-config-form'), aiConfigGuide = element('section', undefined, 'r07-ai-config-guide');
  const aiConfigFooter = element('footer', undefined, 'r07-ai-config-footer');
  aiConfigDialog.content.classList.add('r07-ai-config-grid');
  aiConfigDialog.element.insertBefore(aiConfigContext, aiConfigHeading);
  aiConfigDialog.content.append(aiConfigSource, aiConfigForm, aiConfigGuide);
  aiConfigGuide.append(element('h2', '使用规则'));
  const guidance = element('ol');
  for (const text of ['先确认范围：只处理所选对象；未选择时使用本版本全部对象。', '授权预览优先：图片及对象详情以服务端实际授权预览为准。', '配置与验证分离：配置就绪不代表真实运行已验证。']) guidance.append(element('li', text));
  aiConfigGuide.append(guidance, element('p', '人工标注不依赖 AI 配置。未配置时可返回工作台继续标注。'), element('p', '本页不接收密钥或启动参数；确认范围不会自动开始模型运行。'));
  aiConfigClose.textContent = '返回工作台';
  aiConfigFooter.append(element('p', '实际发送范围以服务端授权预览为准。'), aiConfigClose);
  aiConfigDialog.element.append(aiConfigFooter);
  let aiRunButton: HTMLButtonElement | null = null, aiRunNext: ChildNode | null = null;
  let aiConfigLast: { project: WorkspaceState['project']; loaded: WorkspaceState['loaded']; objects: WorkspaceState['objects']; selected: readonly string[]; document: WorkspaceState['document']; assetId: string } | null = null;
  const aiConfigLauncher = action('展开配置与提示', 'ai-config-open', signal, () => {
    if (!sessionCurrent(state) || aiConfigDialog.element.open) return;
    aiRunButton = aiRoot.querySelector<HTMLButtonElement>('[data-testid="ai-run"]');
    if (!aiRunButton) return;
    aiRunNext = aiRunButton.nextSibling;
    port.cancelGesture(); aiConfigLauncher.hidden = true;
    aiRoot.setAttribute('role', 'region'); aiRoot.removeAttribute('aria-labelledby'); aiRoot.setAttribute('aria-label', 'AI 配置');
    aiConfigForm.append(aiRoot); aiConfigFooter.append(aiRunButton);
    aiConfigDialog.open(aiConfigLauncher); state.modal = true; renderAiConfigContext(); state.notify();
  });
  function renderAiConfigContext() {
    if (!aiConfigDialog.element.open) return;
    const loaded = state.loaded, selected = selectedIds(state), document = port.getSnapshot();
    if (aiConfigLast && aiConfigLast.project === state.project && aiConfigLast.loaded === loaded && aiConfigLast.objects === state.objects && aiConfigLast.selected === selected && aiConfigLast.document === document && aiConfigLast.assetId === state.assetId) return;
    aiConfigLast = { project: state.project, loaded, objects: state.objects, selected, document, assetId: state.assetId };
    const selectedSet = new Set(selected), selectedObjects = state.objects.filter(object => selectedSet.has(object.object_id));
    aiConfigContext.textContent = [state.project?.name ?? '项目', loaded?.media.original_name ?? '未选择图片', loaded ? '规范版本 ' + loaded.ontology.version_no : '未选择规范'].join(' · ');
    aiConfigSource.replaceChildren(element('h2', '固定上下文'));
    const visual = readonlyVisual(document, state.assetId, [], selectedObjects.map(object => object.geometry));
    visual.querySelector('svg')?.setAttribute('aria-label', '只读 canonical 图片与所选对象轮廓');
    const caption = visual.querySelector('figcaption'); if (caption) caption.textContent = '只读 canonical 投影；实际授权范围以服务端预览为准。';
    aiConfigSource.append(visual);
    const details = element('dl');
    for (const [label, value] of [['图片', loaded?.media.original_name ?? '未选择'], ['规范', loaded ? '版本 ' + loaded.ontology.version_no : '未选择'], ['对象范围', selected.length ? selected.length + ' 个所选对象' : '本版本全部对象']]) details.append(element('dt', label), element('dd', value));
    aiConfigSource.append(details, element('h3', '已选对象'));
    if (!selectedObjects.length) aiConfigSource.append(element('p', selected.length ? '当前选择不可用；请返回工作台核对。' : '未选择对象；请求范围为本版本全部对象。'));
    else {
      const list = element('ul');
      for (const object of selectedObjects) list.append(element('li', (loaded?.ontology.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id) + ' · ' + object.object_id));
      aiConfigSource.append(list);
    }
  }
  aiConfigDialog.element.addEventListener('close', () => {
    if (aiRunButton && aiRunNext?.parentNode === aiRoot) aiRoot.insertBefore(aiRunButton, aiRunNext);
    aiRunButton = null; aiRunNext = null; aiConfigLast = null; inspector.append(aiRoot);
    aiRoot.setAttribute('role', 'tabpanel'); aiRoot.removeAttribute('aria-label'); aiRoot.setAttribute('aria-labelledby', aiTab.id);
    aiConfigLauncher.hidden = false; state.modal = !!shell.querySelector('dialog[open]'); state.notify();
    if (aiConfigLauncher.isConnected && aiConfigLauncher.getClientRects().length) aiConfigLauncher.focus();
  }, { signal });
  const unsubscribeAiConfig = state.subscribe(renderAiConfigContext);
  const compact = window.matchMedia('(max-width: 1099px)');
  const assetsLauncher = action('图片与对象', 'toggle-assets', signal, () => {
    if (compact.matches) { inspectorDialog.close(); assetsDialog.content.append(assets); assetsDialog.open(assetsLauncher); state.modal = true; port.cancelGesture(); state.notify(); }
    else { assetsHome.hidden = !assetsHome.hidden; shell.dataset.assetsCollapsed = String(assetsHome.hidden); }
  });
  const attributesLauncher = action('属性', 'toggle-attributes', signal, () => openInspector('attributes', attributesLauncher)), aiLauncher = action('AI 审校', 'toggle-ai', signal, () => openInspector('ai', aiLauncher));
  for (const [button, target] of [[assetsLauncher, assets], [attributesLauncher, attributesRoot], [aiLauncher, aiRoot]] as const) button.setAttribute('aria-controls', target.id);
  selectionAttributes.setAttribute('aria-controls', attributesRoot.id);
  launchers.append(assetsLauncher, attributesLauncher, aiLauncher); contextBar.append(launchers);
  function showInspector(view: 'attributes' | 'ai') {
    inspectorView = view; attributesRoot.hidden = view !== 'attributes'; aiRoot.hidden = view !== 'ai';
    attributesTab.setAttribute('aria-selected', String(view === 'attributes')); aiTab.setAttribute('aria-selected', String(view === 'ai'));
    attributesTab.tabIndex = view === 'attributes' ? 0 : -1; aiTab.tabIndex = view === 'ai' ? 0 : -1;
  }
  function openInspector(view: 'attributes' | 'ai', trigger: HTMLElement) {
    showInspector(view);
    if (compact.matches) { assetsDialog.close(); inspectorDialog.content.append(inspector); inspectorDialog.open(trigger); state.modal = true; port.cancelGesture(); state.notify(); }
    else { const collapse = !inspectorHome.hidden && inspectorHome.dataset.view === view; inspectorHome.hidden = collapse; inspectorHome.dataset.view = view; shell.dataset.inspectorCollapsed = String(collapse); }
  }
  function layout() {
    const active = document.activeElement;
    assetsDialog.close(); inspectorDialog.close();
    assetsHome.append(assets); inspectorHome.append(inspector); assetsHome.hidden = compact.matches; inspectorHome.hidden = compact.matches;
    shell.dataset.assetsCollapsed = String(compact.matches); shell.dataset.inspectorCollapsed = String(compact.matches);
    state.modal = !!shell.querySelector('dialog[open]');
    if (active instanceof Node && assets.contains(active)) assetsLauncher.focus(); else if (active instanceof Node && inspector.contains(active)) (inspectorView === 'ai' ? aiLauncher : attributesLauncher).focus();
    state.notify();
  }
  for (const dialog of [assetsDialog, inspectorDialog]) dialog.element.addEventListener('close', () => {
    state.modal = !!shell.querySelector('dialog[open]'); state.notify();
  }, { signal });
  compact.addEventListener('change', layout, { signal });
  shell.append(header, contextBar, workspace, saveRoot, transferDetails, reviewDetails, managementDetails, activityDetails, helpRoot, assetsDialog.element, inspectorDialog.element, aiConfigDialog.element); root.append(shell);
  const cleanup = [mountToolbarView(toolbar, state, port, signal), mountObjectsView(objectsRoot, state, port, signal), mountAttributesView(attributesRoot, state, port, signal), mountSaveView(saveRoot, state, port, recovery, signal), unsubscribeAiConfig];
  const ai = mountAiWorkbenchView(aiRoot, state, port, signal, context.navigate);
  const activityDialog = createDialog({ id: 'r07-activity-expanded', title: '自愿工时与运行摘要', testId: 'activity-expanded', signal });
  activityDialog.element.classList.add('r07-activity-expanded');
  const activityContext = element('p', undefined, 'r07-activity-context');
  const activityColumn = element('section', undefined, 'r07-activity-card'), outcomeColumn = element('section', undefined, 'r07-activity-card');
  const outcomeSlot = element('div'), noOutcome = element('div');
  noOutcome.setAttribute('role', 'status');
  noOutcome.append(element('h3', '运行结果 · 决策记录'), element('p', '当前图片没有匹配的运行摘要；未记录的工时和费用不填零。'));
  const activityOutcome = aiRoot.querySelector<HTMLElement>('[data-testid="ai-outcome"]')!;
  const activityRunStatus = aiRoot.querySelector<HTMLElement>('[data-testid="ai-status"]')!, activityRunStatusHome = activityRunStatus.parentElement!;
  activityColumn.append(element('h3', '工时记录')); outcomeColumn.append(outcomeSlot, noOutcome);
  activityDialog.content.classList.add('r07-activity-grid'); activityDialog.content.append(activityColumn, outcomeColumn);
  activityDialog.element.insertBefore(activityContext, activityDialog.content);
  const activityClose = activityDialog.element.querySelector<HTMLButtonElement>('button')!; activityClose.textContent = '返回工作台';
  const activityFooter = element('footer', undefined, 'r07-activity-footer');
  activityFooter.append(element('p', '工时由本人自愿记录；运行结果不代表准确率或人工修正归因。'), activityClose);
  activityDialog.element.append(activityFooter); shell.append(activityDialog.element);
  let activityReturnScroll: { element: Element; top: number; left: number } | null = null;
  function restoreActivityScroll() {
    if (!activityReturnScroll) return;
    activityReturnScroll.element.scrollTop = activityReturnScroll.top;
    activityReturnScroll.element.scrollLeft = activityReturnScroll.left;
    activityReturnScroll = null;
  }
  function renderActivityContext() {
    if (!activityDialog.element.open) return;
    const run = ai.getRunScope(), loaded = state.loaded;
    const matches = !!run && !!loaded && run.projectId === state.projectId && run.assetRevisionId === state.assetId && run.ontologyVersionId === loaded.ontology.ontology_version_id;
    activityContext.textContent = [state.project?.name ?? '项目', loaded?.media.original_name ?? '未选择图片', state.fixedTask ? '任务 ' + state.fixedTask.task_id : '未关联任务', matches ? '当前图片有匹配运行' : '当前图片无匹配运行'].join(' · ');
    outcomeSlot.hidden = !matches; noOutcome.hidden = matches;
  }
  const activityLauncher = action('展开工时与运行摘要', 'activity-expand', signal, () => {
    if (!sessionCurrent(state) || activityDialog.element.open) return;
    const scrolling = document.scrollingElement;
    if (scrolling) { activityReturnScroll = { element: scrolling, top: scrolling.scrollTop, left: scrolling.scrollLeft }; scrolling.scrollTop = 0; scrolling.scrollLeft = 0; }
    port.cancelGesture(); activityColumn.append(activityRoot); outcomeSlot.append(activityRunStatus, activityOutcome);
    try { activityDialog.open(activityLauncher); }
    catch (cause) { activityDetails.append(activityRoot); activityRunStatusHome.prepend(activityRunStatus); aiRoot.append(activityOutcome); restoreActivityScroll(); throw cause; }
    state.modal = true; renderActivityContext(); state.notify();
  });
  activityDetails.insertBefore(activityLauncher, activityRoot);
  activityDialog.element.addEventListener('close', () => {
    activityDetails.append(activityRoot); activityRunStatusHome.prepend(activityRunStatus); aiRoot.append(activityOutcome);
    state.modal = !!shell.querySelector('dialog[open]'); state.notify(); restoreActivityScroll();
  }, { signal });
  cleanup.push(state.subscribe(renderActivityContext));
  aiRoot.insertBefore(aiConfigLauncher, aiRoot.firstElementChild?.nextSibling ?? null);
  cleanup.push(mountActivityView(activityRoot, shell, state, ai.getRunScope, signal), mountHelpView(helpRoot, state, port, signal));
  mountEditorKeyboard(center, state, port, signal);
  // The listbox shares the same keyboard domain without granting controls canvas shortcuts.
  mountEditorKeyboard(objectsRoot, state, port, signal);
  const childContext = { session: context.session, navigate: context.navigate, route: context.route, signal };
  cleanup.push(context.mountReview(reviewRoot, { ...childContext, projectId: state.projectId, taskSession, initialQueue: context.route.queue ?? 'all', getQueue: () => reviewQueue,
    getScope: () => ({ session: sessionCurrent(state) ? state.session : null, project: state.project, assets: state.assets, ontologies: state.ontologies, assetId: state.assetId, ontologyId: state.ontologyId }), subscribe: state.subscribe,
    setReviewViewOpen(open) { if (open) port.cancelGesture(); state.modal = open || state.importViewModal || !!shell.querySelector('dialog[open]'); state.notify(); } }));
  let managementMounted = false;
  function mountManagementIfOpen() {
    if (!managementDetails.open || managementMounted) return;
    if (!state.catalogReady || !state.project || state.project.project_id !== state.projectId || !sessionCurrent(state)) { managementRoot.textContent = state.error ?? '正在读取并核实项目角色…'; return; }
    managementMounted = true; managementRoot.replaceChildren();
    cleanup.push(context.mountManagement(managementRoot, { ...childContext, projectId: state.projectId, getProject: () => sessionCurrent(state) ? state.project : null, onProfilesChanged: () => { void ai.refreshProfiles(); } }));
  }
  managementDetails.addEventListener('toggle', mountManagementIfOpen, { signal });
  cleanup.push(context.mountTransfers(transfersRoot, { ...childContext, projectId: state.projectId, getScope: () => ({
    asset: state.loaded?.media ?? state.assets.find(asset => asset.asset_revision_id === state.assetId) ?? null,
    ontology: state.loaded?.ontology ?? state.ontologies.find(item => item.ontology_version_id === state.ontologyId) ?? null,
    scopeKey: state.scope, canWrite: port.canImport(), canExport: port.canExport(),
    canUploadMedia: writableRole(state) && state.catalogReady && !state.modal && !state.preparation && !state.importing && !state.submission && !state.branchBusy,
  }), subscribe: state.subscribe,
    setImportViewOpen: open => { if (open) port.cancelGesture(); state.importViewModal = open; state.modal = open || !!shell.querySelector('dialog[open]'); state.notify(); },
    prepareImport: port.prepareImport, releaseImport: scopeKey => { if (state.scope === scopeKey) port.releaseImport(); }, commitImport: async (revision, scopeKey) => { if (state.scope !== scopeKey) throw new Error('导入回执作用域已变化；保留原请求。'); await port.commitImport(revision); }, prepareExport: port.prepareExport, refreshAssets: controller.refreshAssets }));
  reviewDetails.open = !!context.route.queue;
  let headsKey = '', routeKey = '';
  const saveSubscriptions = new Map<string, () => void>(), commitTokens = new Map<string, string>();
  const assetNodes = new Map<string, HTMLLIElement>();
  function renderAssets() {
    const present = new Set<string>(), query = assetSearch.value.trim().toLocaleLowerCase();
    for (const asset of state.assets) {
      const id = asset.asset_revision_id; present.add(id); let li = assetNodes.get(id);
      if (!li) {
        li = element('li'); const button = action(asset.original_name, 'asset-item-' + id, signal, () => { void controller.selectAsset(id); });
        const image = element('img'); image.alt = ''; image.loading = 'lazy'; image.src = '/api/assets/' + encodeURIComponent(id) + '/image'; button.prepend(image); li.append(button, element('small')); assetNodes.set(id, li); assetList.append(li);
      }
      li.hidden = !!query && !asset.original_name.toLocaleLowerCase().includes(query);
      const button = li.firstElementChild as HTMLButtonElement; button.setAttribute('aria-current', String(state.assetId === id));
      const summary = state.queue.getOwnedSummary(id, state.projectId, state.session?.user_id ?? ''); li.lastElementChild!.textContent = summary?.failed ? '保存待核对' : summary?.pending ? '待同步' : state.assetId === id && state.document ? COMPLETION_LABELS[state.document.completion] : '';
    }
    for (const [id, node] of assetNodes) if (!present.has(id)) { node.remove(); assetNodes.delete(id); }
  }
  let summaryObjects: WorkspaceState['objects'] | null = null, summaryId = '', summaryIndex = -1;
  function update() {
    for (const asset of state.assets) if (!saveSubscriptions.has(asset.asset_revision_id)) {
      const id = asset.asset_revision_id;
      saveSubscriptions.set(id, state.queue.subscribe(id, () => {
        const certificate = state.queue.getStatus(id).local_commit;
        if (id === state.assetId && certificate && commitTokens.get(id) !== certificate.write_token) {
          commitTokens.set(id, certificate.write_token);
          void recovery.refresh().catch(reason => { if (sessionCurrent(state)) { state.error = reportError(reason); state.notify(); } });
        }
        state.notify();
      }));
    }
    for (const [id, unsubscribe] of saveSubscriptions) if (!state.assets.some(asset => asset.asset_revision_id === id)) { unsubscribe(); saveSubscriptions.delete(id); }
    const nextRoute = JSON.stringify([state.assetId, state.ontologyId, state.fixedTask?.task_id]);
    if (routeKey !== nextRoute && sessionCurrent(state)) {
      routeKey = nextRoute;
      const url = new URL(location.href); url.searchParams.set('project_id', state.projectId);
      if (state.assetId) url.searchParams.set('asset_revision_id', state.assetId);
      if (state.ontologyId) url.searchParams.set('ontology_version_id', state.ontologyId);
      if (state.fixedTask) url.searchParams.set('task_id', state.fixedTask.task_id); else url.searchParams.delete('task_id');
      history.replaceState(null, '', url);
    }
    projectName.textContent = state.project?.name ?? state.projectId; identity.textContent = state.session?.username ?? '身份未核实'; title.textContent = state.loaded?.media.original_name ?? (state.phase === 'empty' ? '空项目 · 先导入图片' : '标注工作台');
    const index = state.assets.findIndex(asset => asset.asset_revision_id === state.assetId); position.textContent = index < 0 ? '' : index + 1 + ' / ' + state.assets.length;
    const switchingBlocked = !sessionCurrent(state) || !!state.preparation || !!state.importing || state.submission || state.branchBusy || !!(state.fixedTask && state.lease);
    previousImage.disabled = switchingBlocked || index <= 0; nextImage.disabled = switchingBlocked || index < 0 || index + 1 >= state.assets.length;
    updateResizeButtons();
    mountManagementIfOpen();
    const rendererError = state.host?.error;
    error.textContent = state.error ?? '';
    error.hidden = !state.error || rendererError?.code === 'WEBGPU_UNAVAILABLE' && state.error === reportError(rendererError);
    const key = JSON.stringify([state.heads, state.ontologies.map(item => [item.ontology_version_id, item.version_no])]);
    if (headsKey !== key) {
      headsKey = key; ontology.replaceChildren(option('', '明确选择固定规范'));
      for (const norm of state.ontologies) ontology.append(option(norm.ontology_version_id, 'ontology ' + norm.version_no + (state.heads.includes(norm.ontology_version_id) ? ' · 已有标注 head' : ' · 无 head，仅显式导入')));
    }
    ontology.value = state.ontologyId; ontology.disabled = !sessionCurrent(state) || !!state.fixedTask || !!state.preparation || !!state.importing || state.submission || state.branchBusy;
    renderAssets();
    const selected = selectedIds(state);
    selectionSummary.hidden = !compact.matches || !selected.length;
    if (!selectionSummary.hidden) {
      if (selected.length === 1) {
        if (summaryObjects !== state.objects || summaryId !== selected[0]) {
          summaryObjects = state.objects; summaryId = selected[0]; summaryIndex = state.objects.findIndex(object => object.object_id === summaryId);
        }
        const object = state.objects[summaryIndex], flag = state.flags[selected[0]];
        const category = object && (state.loaded?.ontology.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id);
        selectionText.textContent = object
          ? '当前选中 ' + category + ' #' + (summaryIndex + 1) + ' · ' + object.object_id + ' · ' + (port.getHost() && !flag?.locked ? '可编辑' : '只读') + ' · ' + (flag?.locked ? '已锁定' : '未锁定') + (flag?.hidden ? ' · 已隐藏' : '')
          : '当前选中对象不可用，请核对图片与规范。';
      } else selectionText.textContent = '已选择 ' + selected.length + ' 个对象';
    }
    selectionAttributes.setAttribute('aria-expanded', String(inspectorDialog.element.open && inspectorView === 'attributes'));
    assetsLauncher.setAttribute('aria-expanded', String(compact.matches ? assetsDialog.element.open : !assetsHome.hidden)); attributesLauncher.setAttribute('aria-expanded', String(compact.matches ? inspectorDialog.element.open && inspectorView === 'attributes' : !inspectorHome.hidden && inspectorView === 'attributes')); aiLauncher.setAttribute('aria-expanded', String(compact.matches ? inspectorDialog.element.open && inspectorView === 'ai' : !inspectorHome.hidden && inspectorView === 'ai'));
  }
  assetSearch.addEventListener('input', renderAssets, { signal }); ontology.addEventListener('change', () => { void controller.selectOntology(ontology.value); }, { signal });
  const unsubscribe = state.subscribe(update); showInspector('attributes'); layout(); update(); void controller.start();
  let disposed = false;
  function dispose() { if (disposed) return; disposed = true; controller.dispose(); for (const unsubscribe of saveSubscriptions.values()) unsubscribe(); saveSubscriptions.clear(); unsubscribe(); ai.dispose(); for (const unmount of cleanup.reverse()) unmount(); canvas.dispose(); assetsDialog.dispose(); inspectorDialog.dispose(); aiConfigDialog.dispose(); shell.remove(); }
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
}
