// T12 tool state and settings. The tool state is the single browser-side
// source for which tool is active (the C3 facade has no get_tool read-back),
// including the temporary space-pan override. The interaction policy below is
// normative and exercised by tests/e2e/t12_tools.spec.ts; its runtime homes are
// EditorHost (contextmenu, scroll-zoom, capture pairing) and Keyboard (keys).
import { useEffect, useState } from 'react';
import type { EditorCommand } from '../../../../../packages/contracts/generated/EditorCommand';
import type { EditorDelta } from '../../../../../packages/contracts/generated/EditorDelta';
import type { EditorTool } from '../../lib/editor/types';
import type { SelectionStore } from './SelectionLink';

/** The slice of the editor host the tool controls need. */
export interface ToolStateHost {
  setTool(tool: EditorTool): boolean;
}

/**
 * Native-acknowledged tool projection with a temporary space-pan override.
 * Rejected transitions leave the last effective/base tool intact. A rejected
 * keyup/blur records only release intent for explicit ready reconciliation.
 */
export class ToolState {
  private baseTool: EditorTool;
  private spacePanActive = false;
  // A release rejected while editing is fenced remains user intent, not a
  // fabricated native tool change. Only that release may reconcile on ready.
  private spaceReleasePending = false;
  private readonly host: ToolStateHost;
  private readonly listeners = new Set<(tool: EditorTool) => void>();

  constructor(host: ToolStateHost, initial: EditorTool = 'select') {
    this.host = host;
    this.baseTool = initial;
  }

  /** The effective tool (a held space key wins over the base tool). */
  current(): EditorTool {
    return this.spacePanActive ? 'pan' : this.baseTool;
  }

  /** The tool restored when the space key is released. */
  base(): EditorTool {
    return this.baseTool;
  }

  set(tool: EditorTool): void {
    if (!this.spacePanActive && tool === this.baseTool) return;
    if (!this.host.setTool(tool)) return;
    this.spacePanActive = false;
    this.spaceReleasePending = false;
    this.baseTool = tool;
    this.notify();
  }

  beginSpacePan(): void {
    if (this.spacePanActive) {
      this.spaceReleasePending = false;
      return;
    }
    if (this.baseTool === 'pan' || !this.host.setTool('pan')) return;
    this.spacePanActive = true;
    this.notify();
  }

  endSpacePan(): void {
    if (!this.spacePanActive) return;
    this.spaceReleasePending = true;
    if (!this.host.setTool(this.baseTool)) return;
    this.spacePanActive = false;
    this.spaceReleasePending = false;
    this.notify();
  }

  /** Reconcile only a recorded keyup/blur, never reset a retained native tool. */
  reconcileSpaceRelease(): void {
    if (this.spaceReleasePending) this.endSpacePan();
  }

  subscribe(listener: (tool: EditorTool) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const tool = this.current();
    for (const listener of this.listeners) listener(tool);
  }
}

/** The slice of the editor host the tool buttons need. */
export interface ToolSettingsHost {
  dispatch(command: EditorCommand): EditorDelta | null;
}

/**
 * Normative canvas interaction policy (T12). There is deliberately no
 * platform branch: whatever the macOS ctrl/meta conventions are, the Windows
 * defaults cannot be altered because every rule below applies identically on
 * every platform (EditorHost implements the pointer side).
 */
export const INTERACTION_POLICY = {
  contextmenu: '画布上的右键与 macOS ctrl+点击都只抑制系统菜单：不选择、不编辑、不开始手势',
  spacePan: '编辑表面按住空格临时平移并抑制滚动；松开恢复原工具；原生控件保留空格激活；设备阻塞时保留原生确认状态，仅在就绪后协调已记录的松开意图',
  scrollZoom: '滚轮以光标为锚点连续缩放（指数系数），缩放会取消进行中的手势，绝不修改文档',
  accelerators: 'Ctrl 与 Meta 在所有平台都同时触发撤销/重做/复制，Windows 的 Ctrl 默认行为不变',
  toolKeys: '无修饰键的 V/ B/ H 切换选择/矩形/平移工具',
  delete: '编辑表面 Delete 与 Backspace 删除原生当前选择；文本输入、输入法组合及工作区外控件不触发编辑快捷键',
} as const;

export function ToolSettings({
  tools,
  host,
  store,
}: {
  tools: ToolState;
  host: ToolSettingsHost;
  store: SelectionStore;
}) {
  const [tool, setToolState] = useState<EditorTool>(() => tools.current());
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });

  useEffect(() => tools.subscribe(setToolState), [tools]);
  useEffect(
    () =>
      store.subscribe((delta: EditorDelta) => {
        setHistory({ canUndo: delta.can_undo, canRedo: delta.can_redo });
      }),
    [store],
  );

  return (
    <div data-testid="tool-settings" role="toolbar" aria-label="工具设置">
      <button type="button" data-testid="tool-select" aria-pressed={tool === 'select'} onClick={() => tools.set('select')}>
        选择
      </button>
      <button type="button" data-testid="tool-box" aria-pressed={tool === 'box'} onClick={() => tools.set('box')}>
        矩形
      </button>
      <button type="button" data-testid="tool-pan" aria-pressed={tool === 'pan'} onClick={() => tools.set('pan')}>
        平移
      </button>
      <button type="button" data-testid="undo" disabled={!history.canUndo} onClick={() => host.dispatch({ kind: 'undo' })}>
        撤销
      </button>
      <button type="button" data-testid="redo" disabled={!history.canRedo} onClick={() => host.dispatch({ kind: 'redo' })}>
        重做
      </button>
    </div>
  );
}
