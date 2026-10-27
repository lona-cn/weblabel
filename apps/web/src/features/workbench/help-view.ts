import { createDialog } from '../../ui/dialog';
import { categoryShortcuts } from './category-shortcuts';
import type { EditorPort } from './editor-port';
import { sessionCurrent, type WorkspaceState } from './workspace-state';
import { action, element, labeled } from './view-elements';

export function mountHelpView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): () => void {
  const dialog = createDialog({ id: 'r07-help', title: '帮助与休息设置', testId: 'shortcut-help', signal }); dialog.element.classList.add('r07-help');
  const table = element('table'), tableHead = element('thead'), tableBody = element('tbody'), headers = element('tr');
  for (const text of ['快捷键', '操作', '说明']) { const cell = element('th', text); cell.scope = 'col'; headers.append(cell); }
  tableHead.append(headers); table.append(tableHead, tableBody);
  for (const [key, name, text] of [
    ['V', '选择', '选择与调整对象'], ['B', '矩形', '绘制当前类别矩形'], ['H', '平移', '平移画布'],
    ['Space', '临时平移', '按住临时平移，松开恢复原工具'], ['Esc', '取消手势', '取消当前手势'],
    ['Ctrl / ⌘ + Z', '撤销', '撤销上一步编辑'], ['Ctrl / ⌘ + Shift + Z 或 Y', '重做', '恢复已撤销的编辑'],
    ['Ctrl / ⌘ + D', '复制', '复制原生当前选择'], ['Delete / Backspace', '删除', '删除原生当前选择'],
    ['滚轮', '缩放', '以光标为锚点缩放，不修改文档'],
  ]) { const row = element('tr'), keyCell = element('th', key); keyCell.scope = 'row'; row.append(keyCell, element('td', name), element('td', text)); tableBody.append(row); }
  const scope = element('dl', undefined, 'r07-help-context'), project = element('dd'), image = element('dd'), ontologyVersion = element('dd'), task = element('dd'), activeLabel = element('dd');
  for (const [label, value] of [['当前项目', project], ['当前图片', image], ['固定规范', ontologyVersion], ['当前任务', task], ['绘制类别', activeLabel]] as const) scope.append(element('dt', label), value);
  const categories = element('ul'), editingStatus = element('p'), pause = action('暂停编辑', 'pause-editing', signal, () => {
    if (!sessionCurrent(state)) return;
    if (!state.paused && !port.getReadHost()) return;
    state.host?.cancelGesture(); state.paused = !state.paused; state.notify();
  });
  const reminder = element('input'); reminder.type = 'checkbox'; reminder.dataset.testid = 'comfort-opt-in'; const notice = element('p'); notice.setAttribute('role', 'status'); notice.dataset.testid = 'comfort-reminder';
  const main = element('div', undefined, 'r07-help-main'), shortcuts = element('section', undefined, 'r07-help-card'), categoryHelp = element('section', undefined, 'r07-help-card'), context = element('section', undefined, 'r07-help-card');
  shortcuts.append(element('h3', '工具与快捷键'), table, element('p', '输入框、输入法组合、原生控件和帮助内不触发画布快捷键。Ctrl / ⌘ / Shift 点击列表增减多选；筛选不改变选择。'));
  categoryHelp.append(element('h3', '类别快捷键'), categories, element('p', '类别键只选择绘制类别，不自动改类或保存；重复或与保留键冲突的绑定禁用。撤销历史最多 128 次操作、64 MiB，不是永久版本历史。'));
  editingStatus.setAttribute('role', 'status');
  context.append(element('h3', '工作上下文与休息'), scope, editingStatus, pause, element('p', '暂停不释放任务、不停止保存、不延长 lease。'), element('h3', '自愿休息'),
    labeled('每 45 分钟显示自愿休息提醒（仅本次页面，默认关闭）', reminder), element('p', '提醒不打断手势、不自动暂停、不抢焦点；不记录或上传活动。'));
  main.append(shortcuts, categoryHelp); dialog.content.classList.add('r07-help-grid'); dialog.content.append(main, context);
  const close = dialog.element.querySelector<HTMLButtonElement>('[data-testid="shortcut-help-close"]')!, footer = element('footer', undefined, 'r07-help-footer');
  close.textContent = '关闭帮助'; footer.append(element('p', '关闭后返回工作台并恢复焦点。'), close); dialog.element.append(footer);
  let returnScroll: { element: Element; top: number; left: number } | null = null;
  function restoreScroll() { if (!returnScroll) return; returnScroll.element.scrollTop = returnScroll.top; returnScroll.element.scrollLeft = returnScroll.left; returnScroll = null; }
  const open = action('帮助与休息设置', 'open-shortcut-help', signal, () => {
    if (!sessionCurrent(state)) return;
    const scrolling = document.scrollingElement;
    if (scrolling) { returnScroll = { element: scrolling, top: scrolling.scrollTop, left: scrolling.scrollLeft }; scrolling.scrollTop = 0; scrolling.scrollLeft = 0; }
    port.cancelGesture();
    try { dialog.open(open); } catch (cause) { restoreScroll(); throw cause; }
    state.modal = true; state.notify();
  });
  dialog.element.addEventListener('close', () => { state.modal = false; state.notify(); restoreScroll(); }, { signal });
  root.append(open, notice, dialog.element);
  let timer: number | undefined, due = false, pointers = new Set<number>();
  const showReminder = () => { if (!due || pointers.size || !reminder.checked) return; due = false; notice.textContent = '已工作 45 分钟；可以自愿休息。提醒不会暂停、释放任务或延长租约。'; };
  const start = () => { clearInterval(timer); timer = undefined; due = false; notice.textContent = ''; if (reminder.checked) timer = window.setInterval(() => { due = true; showReminder(); }, 45 * 60_000); };
  reminder.addEventListener('change', start, { signal });
  window.addEventListener('pointerdown', event => { pointers.add(event.pointerId); }, { capture: true, signal });
  for (const type of ['pointerup', 'pointercancel'] as const) window.addEventListener(type, event => { pointers.delete(event.pointerId); showReminder(); }, { capture: true, signal });
  window.addEventListener('blur', () => { pointers = new Set(); showReminder(); }, { signal });
  let ontology = state.loaded?.ontology;
  function update() {
    project.textContent = state.project?.name ?? state.projectId; image.textContent = state.loaded?.media.original_name ?? '未选择';
    ontologyVersion.textContent = state.loaded?.ontology.ontology_version_id ?? '未选择'; task.textContent = state.fixedTask?.task_id ?? '未关联';
    activeLabel.textContent = state.loaded?.ontology.labels.find(label => label.label_id === state.activeLabel)?.name ?? '未选择';
    editingStatus.textContent = state.paused ? '已暂停编辑' : '未暂停编辑';
    pause.textContent = state.paused ? '继续编辑' : '暂停编辑'; pause.setAttribute('aria-pressed', String(state.paused)); pause.disabled = open.disabled = !sessionCurrent(state);
    if (ontology !== state.loaded?.ontology || !categories.childElementCount) {
      ontology = state.loaded?.ontology; categories.replaceChildren();
      const shortcuts = categoryShortcuts(ontology ?? null);
      for (const [key, id] of Object.entries(shortcuts.bindings)) categories.append(element('li', key.toUpperCase() + '：' + ontology?.labels.find(label => label.label_id === id)?.name));
      for (const warning of shortcuts.warnings) categories.append(element('li', warning));
      if (!categories.childElementCount) categories.append(element('li', '没有可用的类别快捷键。'));
    }
  }
  const unsubscribe = state.subscribe(update); update();
  const dispose = () => { unsubscribe(); clearInterval(timer); dialog.dispose(); restoreScroll(); };
  signal.addEventListener('abort', dispose, { once: true }); return dispose;
}
