import type { PageContext } from '../../ui/page-context';
import type { AssetAnnotationHead } from '../../../../../packages/contracts/generated/AssetAnnotationHead';
import { api, ApiFailure } from '../../lib/t15/api';
import { element, actions, field, options, details, lossView, lifetime, downloadVerified, createAuthorizedReadScope } from '../import-export/delivery-dom';
import { diagnosticText as failureText, isAmbiguous, type LossReport } from '../import-export/loss-report';
import { planDelivery, type PlannedItem } from './delivery-plan';
import { CAP, ZIP_CAP, eligible, uuid, hash, object, strictReport, readArtifact, type Artifact, type Format } from './delivery-protocol';
export interface DatasetDeliveryTarget { projectId: string; assetRevisionId: string; ontologyVersionId: string; annotationRevisionId: string | null; mode: 'workbench' | 'review' }
export interface DatasetsPageContext extends PageContext { projectId: string; onWorkbench(target?: DatasetDeliveryTarget): void }
type Choice = { disposition: 'include' | 'exclude' | 'outside'; split: 'train' | 'val' | 'test'; reason: string; row: AssetAnnotationHead };
type Page = { cursor: string | null; items: AssetAnnotationHead[]; next: string | null };
type Plan = { batches: PlannedItem[][]; seed: string };
type Snapshot = { id: string; manifest: string; ontology: string; batch: number; request: string };
type Job = { id: string; snapshot: string; format: Format; state: string; artifact: Artifact | null; error: string | null; downloadConfirmed: boolean };
type Intent = { kind: 'snapshot' | 'export'; operationId: string; path: string; body: string; uncertain: boolean; sending: boolean };
type Delivery = { ontology: string; format: Format; pages: Page[]; pageIndex: number; visited: Set<string>; choices: Map<string, Choice>; seed: string; plan: Plan | null; planConfirmed: boolean; batch: number; snapshots: Map<number, Snapshot>; history: Snapshot[]; jobs: Job[]; intents: Intent[]; listeners: Set<() => void> };
// View-local intent retention is deliberately separate from annotation SaveQueue.
const deliveries = new Map<string, Delivery>();
export function mountDatasetsPage(root: HTMLElement, context: DatasetsPageContext): () => void {
  const life = lifetime(context.signal); const auth = context.session.getSnapshot(); const session = auth.kind === 'authenticated' ? auth.session : null;
  const action = actions(life.signal);
  const key = JSON.stringify([context.projectId, session?.user_id]); let delivery = deliveries.get(key);
  if (!delivery) { delivery = { ontology: '', format: 'native', pages: [], pageIndex: 0, visited: new Set(), choices: new Map(), seed: '17', plan: null, planConfirmed: false, batch: 0, snapshots: new Map(), history: [], jobs: [], intents: [], listeners: new Set() }; deliveries.set(key, delivery); }
  const state = delivery; let validScope = true, busy = false, revision = 0, freezeConfirmed = false, failedPage: { cursor: string | null; index: number } | null = null, timer: number | null = null;
  let loss: { snapshot: string; format: Format; report: LossReport } | null = null, ack = false;
  let viewedSnapshot: Snapshot | null = null;
  const main = element('main', undefined, 'native-delivery'); main.dataset.testid = 'datasets-page';
  const title = element('h1', '数据集与导出'); title.tabIndex = -1; const nav = element('nav'); nav.setAttribute('aria-label', '数据交付导航'); nav.append(action('工作台', () => context.onWorkbench()));
  const newRange = action('开始新的交付范围', beginNewDelivery, 'dataset-new-delivery'); nav.append(newRange);
  const returnRange = action('返回当前交付范围', () => {
    if (!canEdit() || busy) return;
    viewedSnapshot = null; invalidate(); renderFreezeDetails(); render();
  });
  nav.append(returnRange);
  const heading = element('div', undefined, 'dataset-heading'); heading.append(title, nav);
  const steps = element('ol'); steps.setAttribute('aria-label', '数据交付状态'); steps.append(element('li', '1 选择明确范围'), element('li', '2 固定不可变快照'), element('li', '3 检查损失并导出'));
  const error = element('p'); error.setAttribute('role', 'alert'); error.hidden = true; const status = element('p'); status.setAttribute('role', 'status');
  const ontology = element('select'); ontology.dataset.testid = 'dataset-ontology'; options(ontology, [{ value: '', text: '明确选择固定规范版本' }]);
  const read = action('读取图片范围', () => void loadPage(null, 0));
  const summary = element('p'); summary.dataset.testid = 'dataset-scope-summary';
  const pager = element('div', undefined, 'delivery-toolbar'); const previous = action('上一页', () => { if (!canEdit() || busy || !state.pageIndex) return; state.pageIndex--; renderRows(); render(); });
  const pageNumber = element('span'); const next = action('下一页', () => { if (!canEdit() || busy) return; const page = state.pages[state.pageIndex]; if (!page?.next) return; if (state.pages[state.pageIndex + 1]) { state.pageIndex++; renderRows(); render(); } else void loadPage(page.next, state.pageIndex + 1); }, 'dataset-next-page');
  const include = action('纳入本页', () => changeChoices(state.pages[state.pageIndex]?.items ?? [], 'include'));
  const exclude = action('明确排除本页', () => changeChoices(state.pages[state.pageIndex]?.items ?? [], 'exclude'));
  const retry = action('重试读取原页', () => { if (failedPage) void loadPage(failedPage.cursor, failedPage.index); }, 'dataset-page-retry');
  pager.append(previous, pageNumber, next, include, exclude, retry);
  const table = element('table'); table.setAttribute('aria-label', '图片与数据划分'); const head = element('thead'); const header = element('tr'); for (const name of ['图片 / 来源组', '固定修订与审核资格', '范围决定', '明确排除理由', '数据划分', '操作']) header.append(element('th', name)); head.append(header); const body = element('tbody'); table.append(head, body);
  const tableViewport = element('div', undefined, 'dataset-table-viewport'); tableViewport.setAttribute('role', 'region'); tableViewport.setAttribute('aria-label', '图片范围表格（可滚动）'); tableViewport.tabIndex = 0; tableViewport.append(table);
  const planning = element('section'); planning.setAttribute('aria-label', '分批交付计划'); const seed = element('input'); seed.value = state.seed;
  const previewPlan = action('预览整组划分与分批范围', () => void makePlan()); const confirmPlan = action('确认整组划分', () => {
    if (!canEdit() || busy || !state.plan || state.planConfirmed || state.snapshots.size) return;
    for (const item of state.plan.batches.flat()) { const choice = state.choices.get(item.id); if (choice) state.choices.set(item.id, { ...choice, split: item.split }); }
    state.planConfirmed = true; revision++; freezeConfirmed = false; renderRows(); render();
  });
  const batch = element('select'); const planRoot = element('div');
  planning.append(element('h2', '划分与分批计划'), element('p', '固定整组权重：训练80% / 验证10% / 测试10%；SHA-256按来源组确定性分配，数量不保证精确比例。每批最多1024项（含排除），每批至少一项纳入。'), field('确定性seed', seed), previewPlan, planRoot, confirmPlan, field('当前交付批次', batch));
  const freezeSummary = element('section'); freezeSummary.setAttribute('aria-label', '冻结确认摘要'); const freezeText = element('p'), freezeDetails = element('div');
  const freeze = action('冻结所选修订', () => void freezeSnapshot(), 'snapshot-create'); freeze.className = 'primary'; freezeSummary.append(element('h2', '固定快照 · 冻结确认'), freezeText, freezeDetails, freeze);
  const exports = element('section'); const snapshotText = element('p'); const format = element('select'); format.dataset.testid = 'export-format'; options(format, [{ value: 'native', text: '原生格式（无损）' }, { value: 'yolo', text: 'YOLO' }, { value: 'coco', text: 'COCO' }], state.format);
  const exportStart = action('生成导出并检查信息损失', () => void startExport(false), 'export-start');
  const lossRoot = element('div'); const ackInput = element('input'); ackInput.type = 'checkbox'; ackInput.dataset.testid = 'export-loss-ack'; const ackLabel = field('我已阅读并明确接受上述信息损失', ackInput);
  ackLabel.prepend(ackInput);
  const exportConfirm = action('确认损失并生成导出', () => void startExport(true), 'export-confirm'); exports.append(element('h2', '固定DatasetVersion导出'), snapshotText, field('导出格式', format), exportStart, lossRoot, ackLabel, exportConfirm);
  const pendingRoot = element('div'), historyRoot = element('section'), jobsRoot = element('section'); jobsRoot.setAttribute('aria-label', '导出作业与下载');
  historyRoot.setAttribute('aria-label', '已确认不可变快照历史');
  const scopePicker = element('div', undefined, 'dataset-scope-picker'); scopePicker.append(field('类别规范版本', ontology), read);
  main.append(heading, steps, status, error, scopePicker, summary, pager, tableViewport, planning, freezeSummary, exports, pendingRoot, historyRoot, jobsRoot); root.append(main); title.focus();
  function current() { return life.alive && validScope && reads.current(); }
  function unresolved() { return state.intents.find(intent => intent.uncertain); }
  function canEdit() { return current() && !unresolved(); }
  function selected() { return [...state.choices.values()].filter(choice => choice.disposition !== 'outside'); }
  function activeChoices() { const all = selected(); if (!state.plan) return all; const ids = new Set(state.plan.batches[state.batch].map(item => item.id)); return all.filter(choice => ids.has(choice.row.media.asset_revision_id)); }
  function showError(cause: unknown) { if (!life.alive) return; error.hidden = false; error.textContent = failureText(cause); }
  function invalidate() { revision++; freezeConfirmed = false; loss = null; ack = false; error.hidden = true; }
  function render() {
    if (!life.alive) return; const frozen = viewedSnapshot ?? state.snapshots.get(state.batch), pending = unresolved(), disabled = !current() || busy || !!pending, page = state.pages[state.pageIndex];
    main.setAttribute('aria-busy', String(busy)); status.textContent = !current() ? '当前身份没有此项目实际成员资格，或权限已改变；不能冻结或导出。' : pending ? '原写入结果未知，保留原请求，全部后续写入暂停。' : '固定revision与规范，后续工作台编辑不会改变已冻结DatasetVersion。';
    newRange.disabled = disabled || state.intents.some(intent => intent.sending);
    returnRange.hidden = viewedSnapshot === null; returnRange.disabled = disabled;
    ontology.disabled = disabled || state.snapshots.size > 0; ontology.value = state.ontology; read.disabled = disabled || !state.ontology || state.snapshots.size > 0;
    let included = 0, excluded = 0; for (const choice of state.choices.values()) { if (choice.disposition === 'include') included++; else if (choice.disposition === 'exclude') excluded++; }
    summary.textContent = `已浏览 ${state.visited.size} 张 · 纳入 ${included} · 明确排除 ${excluded} · 范围外 ${state.visited.size - included - excluded}；未浏览图片与范围外图片不会自动纳入或排除。`;
    previous.disabled = disabled || !state.pageIndex; next.disabled = disabled || !page?.next; pageNumber.textContent = `第${state.pageIndex + 1}页`; include.disabled = exclude.disabled = disabled || !page || !!state.snapshots.size; retry.hidden = !failedPage; retry.disabled = disabled;
    seed.disabled = disabled || state.snapshots.size > 0; previewPlan.disabled = disabled || state.snapshots.size > 0 || !selected().length; confirmPlan.hidden = !state.plan; confirmPlan.disabled = disabled || state.planConfirmed || state.snapshots.size > 0; batch.parentElement!.hidden = !state.plan;
    const batchOptions = state.plan?.batches.map((_, index) => ({ value: String(index), text: `批${index + 1}${state.snapshots.has(index) ? ' · 已冻结' : ' · 尚未冻结'}` })) ?? [];
    options(batch, batchOptions, String(state.batch)); batch.disabled = disabled || !state.planConfirmed;
    planRoot.replaceChildren(); if (state.plan) { planRoot.append(element('p', `seed ${state.plan.seed} · 共${state.plan.batches.length}批，精确范围不含未浏览项。`)); for (const [index, items] of state.plan.batches.entries()) planRoot.append(details(`批${index + 1}：${items.length}项 · 纳入${items.filter(item => item.disposition === 'include').length} · 排除${items.filter(item => item.disposition === 'exclude').length}`, items)); }
    const active = activeChoices(), counts = { train: 0, val: 0, test: 0 }; for (const choice of active) if (choice.disposition === 'include') counts[choice.split]++;
    freezeText.textContent = `当前批次${state.batch + 1}：训练${counts.train} · 验证${counts.val} · 测试${counts.test} · 排除${active.filter(choice => choice.disposition === 'exclude').length}；项数预算${active.length}/1024。体积未知；服务端复验资格、分组与96MiB真实ZIP独立上限。${freezeConfirmed ? '已展示冻结确认摘要，再次点击提交当前不可变版本。' : ''}`;
    freeze.textContent = freezeConfirmed ? '确认冻结所选修订' : '冻结所选修订'; freeze.disabled = disabled || !!frozen || !state.ontology || !active.some(choice => choice.disposition === 'include') || active.length > CAP || (!!state.plan && !state.planConfirmed) || active.some(choice => choice.disposition === 'exclude' && !choice.reason.trim());
    exports.hidden = !frozen; snapshotText.textContent = frozen ? `固定DatasetVersion ${frozen.id} · manifest SHA-256 ${frozen.manifest} · 固定规范 ${frozen.ontology}` : '';
    format.value = state.format; format.disabled = disabled;
    const existing = frozen ? state.jobs.some(job => job.snapshot === frozen.id && job.format === state.format) : false;
    exportStart.disabled = disabled || !frozen || existing || !!loss;
    lossRoot.replaceChildren(); if (loss) lossRoot.append(lossView(loss.report)); ackLabel.hidden = exportConfirm.hidden = !loss; ackInput.checked = ack; ackInput.disabled = disabled; exportConfirm.disabled = disabled || !ack || !loss || !frozen || loss.snapshot !== frozen.id || loss.format !== state.format;
    pendingRoot.replaceChildren(); for (const intent of state.intents.filter(intent => intent.uncertain)) { const block = element('section'); block.append(element('h3', '原请求核对 · 只读'), details(`原operation ${intent.operationId}`, { kind: intent.kind, path: intent.path, body: JSON.parse(intent.body) }), element('p', '结果未知，禁止创建新请求或改变原载荷；只读观察不能证明原POST唯一归因。'), action('只读核对原请求', () => void reconcile(intent))); pendingRoot.append(block); }
    historyRoot.replaceChildren(element('h2', '已确认不可变快照历史'));
    for (const fixed of [...state.history, ...state.snapshots.values()]) {
      const block = element('section');
      block.append(element('p', `DatasetVersion ${fixed.id} · 固定规范 ${fixed.ontology} · manifest SHA-256 ${fixed.manifest}`), details('原冻结范围与回执', JSON.parse(fixed.request)));
      const inspect = action('查看并导出此固定版本', () => { if (!canEdit() || busy) return; viewedSnapshot = fixed; loss = null; ack = false; render(); });
      inspect.disabled = disabled; block.append(inspect); historyRoot.append(block);
    }
    renderJobs();
    for (const row of rowViews.values()) row.update();
  }
  function beginNewDelivery() {
    if (!canEdit() || busy || state.intents.some(intent => intent.sending)) return;
    const archived = new Set(state.history.map(fixed => fixed.id));
    for (const fixed of state.snapshots.values()) if (!archived.has(fixed.id)) { state.history.push(fixed); archived.add(fixed.id); }
    // Only the editable selection draft is renewed; immutable history and all original receipts remain.
    state.ontology = ''; state.pages = []; state.pageIndex = 0; state.visited.clear(); state.choices = new Map();
    state.plan = null; state.planConfirmed = false; state.batch = 0; state.snapshots = new Map();
    viewedSnapshot = null; failedPage = null; invalidate(); freezeDetails.replaceChildren(); planRoot.replaceChildren();
    renderRows(); render(); ontology.focus();
  }
  const rowViews = new Map<string, { row: AssetAnnotationHead; node: HTMLTableRowElement; update(): void }>();
  function renderRows() {
    const page = state.pages[state.pageIndex]; const visible = new Set(page?.items.map(row => row.media.asset_revision_id) ?? []);
    for (const child of [...body.children]) if (!visible.has((child as HTMLElement).dataset.assetId!)) { if (child.contains(document.activeElement)) title.focus({ preventScroll: true }); child.remove(); }
    let position = body.firstElementChild;
    for (const row of page?.items ?? []) { let view = rowViews.get(row.media.asset_revision_id); if (!view) { view = createRow(row); rowViews.set(row.media.asset_revision_id, view); } else view.row = row; view.update(); if (view.node !== position) body.insertBefore(view.node, position); position = view.node.nextElementSibling; }
  }
  function createRow(row: AssetAnnotationHead) {
    const id = row.media.asset_revision_id, node = element('tr'); node.dataset.assetId = id; node.dataset.testid = `dataset-row-${id}`;
    const media = element('td'), revisionCell = element('td'), dispositionCell = element('td'), reasonCell = element('td'), splitCell = element('td'), links = element('td');
    const disposition = element('select'); disposition.dataset.testid = `dataset-disposition-${id}`; disposition.setAttribute('aria-label', row.media.original_name);
    const reason = element('input'); reason.setAttribute('aria-label', `排除理由 ${id}`);
    const split = element('select'); split.dataset.testid = `dataset-split-${id}`; split.setAttribute('aria-label', `数据划分 ${id}`); options(split, [{ value: 'train', text: '训练集' }, { value: 'val', text: '验证集' }, { value: 'test', text: '测试集' }], 'train');
    const open = action('打开此图片标注', () => { const value = view.row; context.onWorkbench({ projectId: context.projectId, assetRevisionId: id, ontologyVersionId: state.ontology, annotationRevisionId: value.head?.annotation_revision_id ?? null, mode: 'workbench' }); });
    const inspect = action('审核此固定版本', () => { const value = view.row; if (!value.head) return; context.onWorkbench({ projectId: context.projectId, assetRevisionId: id, ontologyVersionId: state.ontology, annotationRevisionId: value.head.annotation_revision_id, mode: 'review' }); });
    dispositionCell.append(disposition); reasonCell.append(reason); splitCell.append(split); links.append(inspect, open); node.append(media, revisionCell, dispositionCell, reasonCell, splitCell, links);
    const view = { row, node, update() {
      const value = view.row, choice = state.choices.get(id), disabled = !canEdit() || busy || state.snapshots.size > 0;
      media.textContent = `${value.media.original_name} · ${value.media.source_group_id}`; revisionCell.textContent = `${value.head?.annotation_revision_id ?? '没有标注版本'} · ${eligible(value, state.ontology) ? '已完成且已审批' : '未完成或未经审批，不能纳入'}`;
      options(disposition, [{ value: 'outside', text: '范围外（未选择）' }, { value: 'include', text: '纳入', disabled: !eligible(value, state.ontology) }, { value: 'exclude', text: '明确排除' }], choice?.disposition ?? 'outside'); disposition.disabled = split.disabled = reason.disabled = disabled;
      if (document.activeElement !== reason) reason.value = choice?.reason ?? ''; reason.hidden = choice?.disposition !== 'exclude'; split.value = choice?.split ?? 'train'; inspect.hidden = !value.head; node.dataset.selected = String(choice?.disposition === 'include');
    } };
    disposition.addEventListener('change', () => changeChoices([view.row], disposition.value as Choice['disposition']), { signal: life.signal });
    split.addEventListener('change', () => changeChoices([view.row], undefined, split.value as Choice['split']), { signal: life.signal });
    reason.addEventListener('input', () => changeChoices([view.row], undefined, undefined, reason.value), { signal: life.signal }); return view;
  }
  function changeChoices(rows: AssetAnnotationHead[], disposition?: Choice['disposition'], split?: Choice['split'], reason?: string) {
    if (!canEdit() || busy || state.snapshots.size) return; const choices = new Map(state.choices);
    if (disposition === 'include' && rows.some(row => !eligible(row, state.ontology))) { showError(new Error('本页包含未完成或未经审批标注，不能纳入。')); return; }
    const groupSplits = new Map<string, Choice['split']>();
    for (const choice of choices.values()) if (choice.disposition !== 'outside') groupSplits.set(choice.row.media.source_group_id, choice.split);
    for (const row of rows) {
      const groupSplit = groupSplits.get(row.media.source_group_id) ?? 'train';
      const previous = choices.get(row.media.asset_revision_id) ?? { disposition: 'outside' as const, split: groupSplit, reason: 'user_excluded', row };
      const next = { ...previous, row, ...(disposition ? { disposition } : {}), ...(disposition && disposition !== 'outside' ? { split: groupSplit } : {}), ...(split ? { split } : {}), ...(reason !== undefined ? { reason } : {}) };
      choices.set(row.media.asset_revision_id, next);
      if (next.disposition !== 'outside') groupSplits.set(row.media.source_group_id, next.split);
    }
    if (split) { const groups = new Set(rows.map(row => row.media.source_group_id)); for (const [id, choice] of choices) if (groups.has(choice.row.media.source_group_id)) choices.set(id, { ...choice, split }); }
    state.choices = choices; state.plan = null; state.planConfirmed = false; invalidate(); freezeDetails.replaceChildren(); render();
  }
  async function loadPage(cursor: string | null, index: number) {
    if (!canEdit() || busy || !state.ontology) return; const fixed = revision, fixedOntology = state.ontology; busy = true; render();
    try {
      const page = await api.projectAnnotationHeads(context.projectId, fixedOntology, cursor, reads.signal); if (!current() || fixed !== revision) return;
      if (page.items.some(row => row.media.project_id !== context.projectId || (row.head && row.head.ontology_version_id !== fixedOntology)) || (page.next_cursor !== null && (page.next_cursor === cursor || state.pages.some((value, previous) => previous < index && value.cursor === page.next_cursor)))) throw new Error('分页摘要范围无效。');
      for (const row of page.items) state.visited.add(row.media.asset_revision_id);
      state.pages = [...state.pages.slice(0, index), { cursor, items: page.items, next: page.next_cursor }]; state.pageIndex = index; failedPage = null; error.hidden = true; renderRows();
    } catch (cause) { if (current() && fixed === revision) { failedPage = { cursor, index }; showError(cause); } } finally { busy = false; render(); }
  }
  async function makePlan() {
    if (!canEdit() || busy || state.snapshots.size || !selected().length) return; const fixed = revision; busy = true; render();
    try { const plan = await planDelivery(selected().map(choice => ({ id: choice.row.media.asset_revision_id, group: choice.row.media.source_group_id, disposition: choice.disposition as 'include' | 'exclude' })), seed.value); if (!current() || fixed !== revision) return; state.plan = plan; state.planConfirmed = false; state.batch = 0; freezeConfirmed = false; }
    catch (cause) { if (current()) showError(cause); } finally { busy = false; render(); }
  }
  function renderFreezeDetails() {
    freezeDetails.replaceChildren(); const active = activeChoices(); if (!freezeConfirmed) return;
    const exact = element('table'); exact.setAttribute('aria-label', '本批完整固定范围');
    const head = element('thead'), header = element('tr');
    for (const name of ['图片 / 资产修订', '固定标注修订', '固定规范', '审核资格', '范围决定', '数据划分']) { const cell = element('th', name); cell.scope = 'col'; header.append(cell); }
    head.append(header); const tbody = element('tbody'); exact.append(head, tbody); let index = 0;
    const heading = element('p'), controls = element('div'); const prev = action('上一页固定范围', () => { if (index > 0) { index--; paint(); } }), next = action('下一页固定范围', () => { if ((index + 1) * 100 < active.length) { index++; paint(); } }); controls.append(prev, next);
    function paint() { tbody.replaceChildren(); for (const choice of active.slice(index * 100, (index + 1) * 100)) { const row = element('tr'); row.append(element('td', `${choice.row.media.original_name} · ${choice.row.media.asset_revision_id}`), element('td', choice.row.head?.annotation_revision_id ?? '无版本'), element('td', state.ontology), element('td', eligible(choice.row, state.ontology) ? '已批准' : '不符合纳入资格'), element('td', choice.disposition === 'include' ? '纳入' : `排除：${choice.reason}`), element('td', choice.split)); tbody.append(row); } heading.textContent = `${index * 100 + 1}–${Math.min(active.length, (index + 1) * 100)} / ${active.length}`; prev.disabled = index === 0; next.disabled = (index + 1) * 100 >= active.length; }
    const viewport = element('div', undefined, 'dataset-table-viewport'); viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', '本批固定范围表格（可滚动）'); viewport.tabIndex = 0; viewport.append(exact);
    freezeDetails.append(heading, viewport, controls); paint();
  }
  async function freezeSnapshot() {
    if (!canEdit() || busy || !state.ontology || state.snapshots.has(state.batch) || (state.plan && !state.planConfirmed)) return;
    const choices = activeChoices(), included = choices.filter(choice => choice.disposition === 'include');
    if (!included.length || choices.length > CAP || included.some(choice => !eligible(choice.row, state.ontology)) || choices.some(choice => choice.disposition === 'exclude' && !choice.reason.trim())) return;
    if (!freezeConfirmed) { freezeConfirmed = true; renderFreezeDetails(); render(); return; }
    const operationId = crypto.randomUUID(); const body = JSON.stringify({ operation_id: operationId, ontology_version_id: state.ontology, items: included.map(choice => ({ asset_revision_id: choice.row.media.asset_revision_id, annotation_revision_id: choice.row.head!.annotation_revision_id, split: choice.split })), excluded: choices.filter(choice => choice.disposition === 'exclude').map(choice => ({ asset_revision_id: choice.row.media.asset_revision_id, reason: choice.reason.trim() })), split_seed: state.plan?.seed ?? null, split_ratios: state.plan ? [80, 10, 10] : null });
    await send({ kind: 'snapshot', operationId, path: `/api/projects/${encodeURIComponent(context.projectId)}/dataset-versions`, body, uncertain: false, sending: false });
  }
  async function startExport(accepted: boolean) {
    const snapshot = viewedSnapshot ?? state.snapshots.get(state.batch); if (!canEdit() || busy || !snapshot || state.jobs.some(job => job.snapshot === snapshot.id && job.format === state.format) || (accepted && (!ack || !loss || loss.snapshot !== snapshot.id || loss.format !== state.format)) || (!accepted && loss)) return;
    const operationId = crypto.randomUUID(); await send({ kind: 'export', operationId, path: `/api/dataset-versions/${snapshot.id}/exports`, body: JSON.stringify({ format: state.format, loss_ack: accepted, operation_id: operationId }), uncertain: false, sending: false });
  }
  async function send(intent: Intent) {
    if (!canEdit() || busy) return; const fixed = revision, batchIndex = state.batch, fixedOntology = state.ontology, snapshot = viewedSnapshot ?? state.snapshots.get(batchIndex), selectedFormat = state.format;
    busy = true; intent.uncertain = true; intent.sending = true; state.intents.push(intent); error.hidden = true; render();
    try {
      const response = object(await api.request<unknown>(intent.path, { method: 'POST', body: intent.body }));
      if (intent.kind === 'snapshot') {
        if (!uuid(response.dataset_version_id) || !hash(response.manifest_sha256)) throw new Error('快照回执身份或manifest校验无效。');
        intent.uncertain = false; state.snapshots.set(batchIndex, { id: response.dataset_version_id, manifest: response.manifest_sha256, ontology: fixedOntology, batch: batchIndex, request: intent.body });
        viewedSnapshot = null;
      } else {
        if (!uuid(response.job_id) || !['queued', 'running', 'succeeded', 'failed'].includes(String(response.state)) || response.format !== selectedFormat || !strictReport(response.loss_report) || !snapshot) throw new Error('导出确认回执无效。');
        intent.uncertain = false; state.jobs.push({ id: response.job_id, snapshot: snapshot.id, format: selectedFormat, state: String(response.state), artifact: null, error: null, downloadConfirmed: false }); loss = null; ack = false;
      }
    } catch (cause) {
      intent.uncertain = isAmbiguous(cause);
      if (current() && fixed === revision) {
        if (!intent.uncertain && intent.kind === 'export' && cause instanceof ApiFailure && cause.status === 422 && cause.code === 'LOSS_ACK_REQUIRED' && snapshot) { const report = strictReport(cause.details?.loss_report); loss = report && report.losses.length ? { snapshot: snapshot.id, format: selectedFormat, report } : null; ack = false; showError(new Error(loss ? '请阅读实际损失报告，明确接受后再导出。' : '损失报告无效或未知，不能继续。')); }
        else showError(intent.uncertain ? new Error(`结果未知；原operation与载荷保留，只读核对，不重新发送。${failureText(cause)}`) : cause);
      }
    } finally { intent.sending = false; busy = false; for (const notify of state.listeners) notify(); }
  }
  function renderJobs() {
    jobsRoot.replaceChildren(element('h2', '导出作业与下载'));
    for (const job of state.jobs) { const block = element('section'); block.append(element('p', `已有作业 ${job.id} · 固定DatasetVersion ${job.snapshot} · ${job.format} · ${job.state}`));
      if (job.error) { const message = element('p', job.error); message.setAttribute('role', 'alert'); block.append(message); }
      if (job.downloadConfirmed) { const message = element('p', 'ZIP签名、字节数与SHA-256已校验，已发起下载。'); message.setAttribute('role', 'status'); block.append(message); }
      const check = action('重新检查已有作业状态', () => void poll(job), 'export-status-check'); check.disabled = busy || !current(); block.append(check);
      if (job.artifact) { block.append(element('p', `已就绪 · ${job.artifact.byte_size}字节 · SHA-256 ${job.artifact.object_sha256}`), lossView(job.artifact.loss_report)); const download = action('下载数据包', () => void downloadJob(job), 'export-download'); download.disabled = busy || !current(); download.className = 'primary'; block.append(download); }
      jobsRoot.append(block);
    }
  }
  async function poll(job: Job) {
    if (!current() || busy) return; busy = true; render();
    try { const status = await api.job(job.id, reads.signal); if (!current()) return;
      if (status.job_id !== job.id || status.kind !== 'dataset_export' || !['queued', 'running', 'succeeded', 'failed'].includes(status.state)) throw new Error('作业身份或状态无效。');
      job.state = status.state; job.error = null;
      if (status.state === 'succeeded') job.artifact = readArtifact(status.result, job.id, job.format);
      if (status.state === 'failed') job.error = `导出失败：${String(object(status.result).code ?? 'EXPORT_FAILED')}；已有作业保留，不重新创建。`;
    } catch (cause) { if (current()) job.error = `作业状态读取失败，原作业保留，仅重新检查。${failureText(cause)}`; }
    finally { busy = false; render(); schedulePoll(); }
  }
  function schedulePoll() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!current() || busy) return; const job = state.jobs.find(job => ['queued', 'running'].includes(job.state) && !job.error);
    if (job) timer = window.setTimeout(() => { timer = null; void poll(job); }, 500);
  }
  async function downloadJob(job: Job) {
    if (!current() || busy || !job.artifact || job.artifact.byte_size > ZIP_CAP) return; job.downloadConfirmed = false; busy = true; render();
    try { await downloadVerified(job.artifact, `dataset-${job.snapshot}-${job.format}.zip`, reads.signal, true, current); if (current()) { job.downloadConfirmed = true; job.error = null; } }
    catch (cause) { if (current()) job.error = `已有产物保留，重新下载不会创建新导出。${failureText(cause)}`; }
    finally { busy = false; render(); }
  }
  async function reconcile(intent: Intent) {
    if (!current() || busy || !intent.uncertain) return; busy = true; render();
    try { if (state.ontology) await api.projectAnnotationHeads(context.projectId, state.ontology, null, reads.signal); if (current()) showError(new Error(`只读状态已观察；当前API未提供operation ${intent.operationId}的快照/导出查询证明，保持原请求未知，不重发或声称成功。`)); }
    catch (cause) { if (current()) showError(cause); } finally { busy = false; render(); }
  }
  ontology.addEventListener('change', () => { if (!canEdit() || busy || state.snapshots.size) return; state.ontology = ontology.value; state.pages = []; state.pageIndex = 0; state.visited.clear(); state.choices = new Map(); state.plan = null; state.planConfirmed = false; state.batch = 0; failedPage = null; invalidate(); freezeDetails.replaceChildren(); renderRows(); render(); }, { signal: life.signal });
  seed.addEventListener('input', () => { if (!canEdit() || busy || state.snapshots.size) return; state.seed = seed.value; state.plan = null; state.planConfirmed = false; invalidate(); freezeDetails.replaceChildren(); render(); }, { signal: life.signal });
  batch.addEventListener('change', () => { if (!canEdit() || busy || !state.planConfirmed) return; state.batch = Number(batch.value); viewedSnapshot = null; invalidate(); freezeDetails.replaceChildren(); render(); }, { signal: life.signal });
  format.addEventListener('change', () => { if (!canEdit() || busy) return; state.format = format.value as Format; loss = null; ack = false; revision++; render(); }, { signal: life.signal });
  ackInput.addEventListener('change', () => { if (current() && !busy) ack = ackInput.checked; render(); }, { signal: life.signal });
  const reads = createAuthorizedReadScope(life.signal, context.session, context.projectId, () => {
    validScope = false; window.clearTimeout(timer ?? undefined); timer = null; render();
  });
  life.add(reads.dispose);
  const onSettlement = () => { if (current()) { render(); schedulePoll(); } };
  state.listeners.add(onSettlement); life.add(() => { state.listeners.delete(onSettlement); });
  life.add(() => { if (timer !== null) { clearTimeout(timer); timer = null; } main.remove(); });
  renderRows(); render(); schedulePoll();
  void api.ontologies(context.projectId, reads.signal).then(page => { if (!current()) return; options(ontology, [{ value: '', text: '明确选择固定规范版本' }, ...page.items.filter(item => item.project_id === context.projectId).map(item => ({ value: item.ontology_version_id, text: `第${item.version_no}版 · ${item.ontology_version_id}` }))], state.ontology); }).catch(cause => { if (current()) showError(cause); });
  return life.dispose;
}
