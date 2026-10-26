import { createDialog } from '../../ui/dialog';
import { categoryShortcuts } from './category-shortcuts';
import type { EditorPort } from './editor-port';
import { sessionCurrent, type WorkspaceState } from './workspace-state';
import { action, element, labeled } from './view-elements';

export function mountHelpView(root: HTMLElement, state: WorkspaceState, port: EditorPort, signal: AbortSignal): () => void {
  const dialog = createDialog({ id: 'r07-help', title: '帮助与休息设置', testId: 'shortcut-help', signal }); dialog.element.classList.add('r07-help');
  const table = element('table');
  for (const [key, text] of [['V', '选择与调整对象'], ['B', '绘制当前类别矩形'], ['H', '平移画布'], ['Space', '按住临时平移，松开恢复原工具'], ['Esc', '取消当前手势'], ['Ctrl / ⌘ + Z', '撤销'], ['Ctrl / ⌘ + Shift + Z 或 Y', '重做'], ['Ctrl / ⌘ + D', '复制原生当前选择'], ['Delete / Backspace', '删除原生当前选择'], ['滚轮', '以光标为锚点缩放，不修改文档']]) { const row = element('tr'); row.append(element('th', key), element('td', text)); table.append(row); }
  const scope = element('p'), categories = element('ul'), pause = action('暂停编辑', 'pause-editing', signal, () => {
    if (!sessionCurrent(state)) return;
    if (!state.paused && !port.getReadHost()) return;
    state.host?.cancelGesture(); state.paused = !state.paused; state.notify();
  });
  const reminder = element('input'); reminder.type = 'checkbox'; reminder.dataset.testid = 'comfort-opt-in'; const notice = element('p'); notice.setAttribute('role', 'status'); notice.dataset.testid = 'comfort-reminder';
  dialog.content.append(scope, table, element('p', '输入框、输入法组合、原生控件和帮助内不触发画布快捷键。Ctrl / ⌘ / Shift 点击列表增减多选；筛选不改变选择。'), element('h3', '类别快捷键'), categories,
    element('p', '类别键只选择绘制类别，不自动改类或保存；重复或与保留键冲突的绑定禁用。撤销历史最多 128 次操作、64 MiB，不是永久版本历史。'), pause,
    element('p', '暂停不释放任务、不停止保存、不延长 lease。'), labeled('每 45 分钟显示自愿休息提醒（仅本次页面，默认关闭）', reminder), element('p', '提醒不打断手势、不自动暂停、不抢焦点；不记录或上传活动。'));
  const open = action('帮助与休息设置', 'open-shortcut-help', signal, () => { if (sessionCurrent(state)) { port.cancelGesture(); state.modal = true; dialog.open(open); state.notify(); } });
  dialog.element.addEventListener('close', () => { state.modal = false; state.notify(); }, { signal });
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
    scope.textContent = '当前项目：' + (state.project?.name ?? state.projectId) + ' · 图片：' + (state.loaded?.media.original_name ?? '未选择') + ' · 固定规范：' + (state.loaded?.ontology.ontology_version_id ?? '未选择') + ' · 任务：' + (state.fixedTask?.task_id ?? '未关联');
    pause.textContent = state.paused ? '继续编辑' : '暂停编辑'; pause.setAttribute('aria-pressed', String(state.paused)); pause.disabled = open.disabled = !sessionCurrent(state);
    if (ontology !== state.loaded?.ontology || !categories.childElementCount) {
      ontology = state.loaded?.ontology; categories.replaceChildren();
      const shortcuts = categoryShortcuts(ontology ?? null);
      for (const [key, id] of Object.entries(shortcuts.bindings)) categories.append(element('li', key.toUpperCase() + '：' + ontology?.labels.find(label => label.label_id === id)?.name));
      for (const warning of shortcuts.warnings) categories.append(element('li', warning));
    }
  }
  const unsubscribe = state.subscribe(update); update();
  const dispose = () => { unsubscribe(); clearInterval(timer); dialog.dispose(); };
  signal.addEventListener('abort', dispose, { once: true }); return dispose;
}
